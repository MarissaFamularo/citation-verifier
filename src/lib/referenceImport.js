// lib/referenceImport.js — turn a pasted reference list into verified PubMed matches.
//
// Division of labor ("the model proposes, the code disposes"): the model only
// PARSES the pasted text into structured citations — copying what is printed,
// never completing an identifier. Code then resolves each citation against
// PubMed (and Crossref for non-indexed DOIs) and scores the candidate by
// title/year agreement, so a mistyped PMID in the bibliography or a wrong
// search hit reaches the reviewer labeled, never silently accepted.

import { extractStructured, getNcbiKey, MODELS } from './anthropic.js'
import { resolveDirectPaper, trimDoiEnd } from './directPaper.js'
import { arxivDoi, arxivIdFrom, openAlexByDoi, searchOpenAlexByTitle } from './openAlex.js'
import { fetchPubMedPapers, searchPubMed } from './pubmed.js'

// Bounds: a 100-entry bibliography is ~25k characters; beyond that the paste is
// probably a whole document, and the honest move is to say so rather than parse
// half of it.
export const PASTE_LIMIT = 60_000
export const REFERENCE_CAP = 100

// Spacing between per-reference PubMed lookups. Each reference can fire 2–3
// eutils requests and NCBI allows ~3 req/s without a key, so pace generously —
// a rate-limited response often surfaces in the browser as a bare
// "Failed to fetch" (the 429 lacks CORS headers).
export const RESOLVE_PACING_MS = 750

// Candidates read per PubMed title query. A prolific group's papers share
// most title words, so the right one can sit below the first few.
export const TITLE_SEARCH_LIMIT = 10

// An NCBI API key raises the ceiling to 10 req/s, so pacing can tighten.
export function resolvePacingMs() {
  return getNcbiKey() ? 250 : RESOLVE_PACING_MS
}

// JSON Schema per the output_config contract: additionalProperties:false and
// required on every object, nullable via anyOf.
export const REFERENCE_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['references'],
  properties: {
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['raw', 'title', 'firstAuthor', 'journal', 'year', 'pmid', 'doi'],
        properties: {
          raw: { type: 'string', description: 'The reference exactly as it appears in the pasted text, without its list number.' },
          title: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The article title as printed, or null if the reference has none.' },
          firstAuthor: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Family name of the first author only.' },
          journal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          year: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Publication year as printed.' },
          pmid: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'PubMed ID, ONLY if printed in the reference itself.' },
          doi: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'DOI, ONLY if printed in the reference itself.' },
        },
      },
    },
  },
}

const PARSE_SYSTEM = `You split an academic reference list into individual references and copy out their printed fields.

Rules:
- One output entry per reference in the pasted text, in order. Keep partial or malformed references — fill what is printed, null the rest.
- COPY, never infer: a PMID or DOI goes in the output only if those characters appear in the pasted text. Never complete, correct, or recall an identifier from memory.
- Strip list numbering (e.g. "12." or "[12]") from raw, but otherwise keep raw verbatim.
- The pasted text may contain stray headers or page numbers between references; skip anything that is not a reference.`

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

const CURRENT_YEAR = new Date().getFullYear()

// Post-validate the model's parse: this is the code's side of the contract, so
// a malformed identifier gets dropped here rather than sent to PubMed.
export function cleanParsedReferences(parsed) {
  const rows = Array.isArray(parsed?.references) ? parsed.references : []
  const seen = new Set()
  const cleaned = []
  for (const row of rows) {
    const raw = compact(row?.raw)
    const title = compact(row?.title) || null
    const pmidText = compact(row?.pmid).replace(/^PMID:?\s*/i, '')
    const pmid = /^[0-9]{1,10}$/.test(pmidText) ? pmidText : null
    const doiText = trimDoiEnd(compact(row?.doi)
      .replace(/^doi:\s*/i, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''))
    const doi = /^10\.\d{4,9}\/\S+$/.test(doiText) ? doiText : null
    const year = Number.isInteger(row?.year) && row.year >= 1800 && row.year <= CURRENT_YEAR + 1 ? row.year : null
    if (!raw || (!title && !pmid && !doi)) continue
    const key = pmid ? `pmid:${pmid}` : doi ? `doi:${doi.toLowerCase()}` : `title:${normalizeTitle(title)}`
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push({
      raw,
      title,
      firstAuthor: compact(row?.firstAuthor) || null,
      journal: compact(row?.journal) || null,
      year,
      pmid,
      doi,
    })
    if (cleaned.length >= REFERENCE_CAP) break
  }
  return cleaned
}

// --- deterministic identifier pre-pass (no model) ---
//
// A printed DOI or PMID makes a reference resolvable by plain code, so those
// never touch the model: split the paste into entries, regex out identifiers,
// and only hand the model the entries that lack one. A paste where every
// reference carries an identifier imports with no AI involved at all.

const ENTRY_NUMBER_RE = /^\s*(?:\[\d{1,3}\]|\d{1,3}[.)])\s*/
const DOI_IN_TEXT_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/
const PMID_IN_TEXT_RE = /\bPMID:?\s*(\d{1,10})\b/i

export function splitReferenceEntries(text) {
  const paste = String(text ?? '').replace(/\r/g, '').trim()
  if (!paste) return []
  // Numbered bibliography ("12." / "12)" / "[12]" at line starts) is the
  // reliable case; blank-line separation next; single lines as a last resort
  // (wrapped citations may fragment there — fragments without identifiers
  // fall through to the model, which re-reads the original paste).
  const numbered = paste.split(/\n(?=\s*(?:\[\d{1,3}\]|\d{1,3}[.)])\s+)/)
  const blocks = numbered.length > 1
    ? numbered
    : paste.includes('\n\n')
      ? paste.split(/\n\s*\n/)
      : paste.split('\n')
  return blocks
    .map((entry) => compact(entry.replace(ENTRY_NUMBER_RE, '')))
    .filter(Boolean)
}

export function partitionPastedReferences(text) {
  const identified = []
  const unidentified = []
  const seen = new Set()
  for (const raw of splitReferenceEntries(text)) {
    const doiMatch = raw.match(DOI_IN_TEXT_RE)
    const doi = doiMatch ? trimDoiEnd(doiMatch[1]) : null
    const pmidMatch = raw.match(PMID_IN_TEXT_RE) || (/^\d{1,10}$/.test(raw) ? [raw, raw] : null)
    const pmid = pmidMatch ? pmidMatch[1] : null
    if (!doi && !pmid) {
      unidentified.push(raw)
      continue
    }
    const key = pmid ? `pmid:${pmid}` : `doi:${doi.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    identified.push({ raw, title: null, firstAuthor: null, journal: null, year: null, pmid, doi })
  }
  return { identified, unidentified }
}

// One structured-output call on the fast model — reference parsing is
// transcription, not judgment. Output budget covers ~100 references with their
// raw text echoed back.
export async function parseReferenceList(text) {
  const paste = String(text ?? '').trim()
  if (!paste) throw new Error('Paste a reference list first.')
  if (paste.length > PASTE_LIMIT) {
    throw new Error(`That paste is too long (${paste.length.toLocaleString()} characters). Paste just the reference list, up to ${REFERENCE_CAP} references.`)
  }
  const parsed = await extractStructured({
    model: MODELS.fast,
    system: PARSE_SYSTEM,
    content: paste,
    schema: REFERENCE_LIST_SCHEMA,
    maxTokens: 32_000,
    // Copying printed fields needs little thinking; low effort keeps it cheap.
    effort: 'low',
  })
  return cleanParsedReferences(parsed)
}

// True when a paste cannot be fully handled by the identifier pre-pass, i.e.
// the model (and therefore an API key) is needed for at least one entry.
export function pasteNeedsModel(text) {
  const { identified, unidentified } = partitionPastedReferences(text)
  return identified.length === 0 || unidentified.length > 0
}

// Full gather: deterministic identifier references first, then the model reads
// whatever is left (or the whole paste when nothing was deterministic — the
// model handles wrapped lines the splitter can't). Model output is deduped
// against the identifier pre-pass.
export async function gatherReferences(text) {
  const { identified, unidentified } = partitionPastedReferences(text)
  let modelReferences = []
  let usedModel = false
  if (identified.length === 0) {
    modelReferences = await parseReferenceList(text)
    usedModel = true
  } else if (unidentified.length > 0) {
    modelReferences = await parseReferenceList(unidentified.join('\n'))
    usedModel = true
  }
  const seen = new Set(identified.map((ref) => (ref.pmid ? `pmid:${ref.pmid}` : `doi:${ref.doi.toLowerCase()}`)))
  const references = [...identified]
  for (const ref of modelReferences) {
    const key = ref.pmid ? `pmid:${ref.pmid}` : ref.doi ? `doi:${ref.doi.toLowerCase()}` : `title:${normalizeTitle(ref.title)}`
    if (seen.has(key)) continue
    seen.add(key)
    references.push(ref)
  }
  return { references: references.slice(0, REFERENCE_CAP), usedModel }
}

// --- match scoring (pure) ---

export function normalizeTitle(value) {
  return compact(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Dice coefficient over word sets — robust to punctuation, casing, and small
// truncations, which is what citation styles vary on.
export function titleSimilarity(a, b) {
  const wordsA = new Set(normalizeTitle(a).split(' ').filter(Boolean))
  const wordsB = new Set(normalizeTitle(b).split(' ').filter(Boolean))
  if (!wordsA.size || !wordsB.size) return 0
  let shared = 0
  for (const word of wordsA) if (wordsB.has(word)) shared += 1
  return (2 * shared) / (wordsA.size + wordsB.size)
}

export function extractYear(value) {
  const match = String(value ?? '').match(/\b(1[89]\d{2}|20\d{2})\b/)
  return match ? Number(match[1]) : null
}

// What share of the paper title's words appear in the raw citation text —
// the deterministic verification for identifier-resolved references, where no
// parsed title exists but the citation itself usually prints one.
export function titleContainment(rawText, title) {
  const rawWords = new Set(normalizeTitle(rawText).split(' ').filter(Boolean))
  const titleWords = normalizeTitle(title).split(' ').filter(Boolean)
  if (!rawWords.size || !titleWords.length) return 0
  let present = 0
  for (const word of titleWords) if (rawWords.has(word)) present += 1
  return present / titleWords.length
}

// Words that carry a title's meaning: no stopwords, no bare numbers.
const TITLE_STOPWORDS = new Set('a an and are as at by during for from in into is its of on or than that the their to toward towards upon versus vs with within without'.split(' '))
function contentWords(text) {
  return normalizeTitle(text).split(' ').filter((word) => word && !TITLE_STOPWORDS.has(word) && !/^\d+$/.test(word))
}

// The printed citation with its identifiers and links removed — what is left
// is authors, title, journal and pages: something to check a candidate against.
function printedWords(raw) {
  return contentWords(String(raw ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b10\.\d{4,9}\/\S+/g, ' ')
    .replace(/\b(?:PMID|PMCID|doi)\s*:?\s*\S+/gi, ' '))
}

function contentContainment(rawText, title, { leading = Infinity } = {}) {
  const rawWords = new Set(printedWords(rawText))
  const titleWords = contentWords(title).slice(0, leading)
  if (!rawWords.size || !titleWords.length) return 0
  return titleWords.filter((word) => rawWords.has(word)).length / titleWords.length
}

// Bibliographies often print a shortened title: "A vein bypass first versus
// a best endovascular treatment first revascularisation strategy for
// patients with chronic limb threatening ischaemia (BASIL-2)" for a record
// whose full title runs on with the trial's design. The opening words of the
// full title still appear in the citation.
const LEADING_TITLE_WORDS = 8

function printedTitleFits(rawText, title) {
  return contentContainment(rawText, title) >= 0.5
    || contentContainment(rawText, title, { leading: LEADING_TITLE_WORDS }) >= 0.8
}

// The fewest printed words that make a citation checkable. Below this the
// reference is a bare identifier and the candidate cannot be second-guessed.
const PRINTED_WORDS_MIN = 4

// --- bibliographic agreement ------------------------------------------------
//
// A title alone does not identify a paper: one research group publishes many
// papers with near-identical titles ("Outcomes of fenestrated and branched
// endovascular repair…"). The printed first author and year are checked too,
// and a candidate that contradicts either is a different paper however close
// its title.

function nameTokens(name) {
  return normalizeTitle(name).split(' ').filter((word) => word.length > 1)
}

// The family name a printed citation starts with: "Schanzer A, Simons JP, …",
// "de Weerd M, …", "El-Sayed T, …". Organizations ("US Food and Drug
// Administration.") have no initials after them and yield null.
// Only the Vancouver shape "Family Initials," counts: "David S. Resch …"
// (given names first, ACM style) or a lone "Davis FD." is left unknown, and
// an unknown author never blocks a match.
const PRINTED_FIRST_AUTHOR_RE = /^\s*(\p{L}[\p{L}'’-]*(?:\s+\p{L}[\p{L}'’-]*){0,3}?)\s+\p{Lu}{1,3}\b\.?\s*[,;]/u

export function printedFirstAuthor(raw) {
  return String(raw ?? '').match(PRINTED_FIRST_AUTHOR_RE)?.[1] ?? null
}

// 'agree' | 'conflict' | 'unknown'. The surname's longest part must appear in
// the candidate's first listed author (PubMed "Schanzer A", Crossref and
// OpenAlex "Andres Schanzer"); diacritics and hyphens are ignored.
// PubMed often lists a trial group ahead of its people ("EINSTEIN–PE
// Investigators", "Büller HR", …); the comparison uses the first person.
const COLLECTIVE_AUTHOR_RE = /\b(?:investigators|group|consortium|collaborat\w*|committee|society|association|trialists|network|team|council|study|writing)\b/i

function firstPersonAuthor(authors) {
  if (!Array.isArray(authors)) return null
  return authors.find((name) => name && !COLLECTIVE_AUTHOR_RE.test(name) && String(name).trim().split(/\s+/).length <= 4) || null
}

export function firstAuthorAgreement(printedFamily, paperAuthors) {
  const printed = nameTokens(printedFamily)
  const first = firstPersonAuthor(paperAuthors)
  if (!printed.length || !first) return 'unknown'
  const key = printed.reduce((longest, word) => (word.length > longest.length ? word : longest), '')
  return new Set(nameTokens(first)).has(key) ? 'agree' : 'conflict'
}

// Print and epub years routinely differ by one; more than that is a conflict.
export function yearAgreement(printedYear, paper) {
  const paperYear = extractYear(paper?.publicationDate ?? paper?.publication_date)
  if (!printedYear || !paperYear) return 'unknown'
  return Math.abs(printedYear - paperYear) <= 1 ? 'agree' : 'conflict'
}

// The publication year where citation styles print it: "2017;66(3):687" /
// "2016;5:e38" (Vancouver, AMA) or "(2020)" (APA, Nature). Any other year in
// the text may belong to the title ("…trends 2010–2020", "…by 2030"), so it
// is not used, and an unknown year never conflicts.
export function printedYear(raw) {
  const text = String(raw ?? '').replace(/https?:\/\/\S+/gi, ' ').replace(/\b10\.\d{4,9}\/\S+/g, ' ')
  const match = text.match(/\b((?:19|20)\d{2})[a-z]?\s*;/) || text.match(/\(((?:19|20)\d{2})[a-z]?\)/)
  return match ? Number(match[1]) : null
}

// Why a candidate cannot be this reference, or [] when nothing contradicts it.
export function matchConflicts(reference, paper) {
  const family = reference?.firstAuthor || printedFirstAuthor(reference?.raw)
  const year = reference?.year ?? printedYear(reference?.raw)
  const conflicts = []
  if (firstAuthorAgreement(family, paper?.authors) === 'conflict') {
    conflicts.push(`first author ${firstPersonAuthor(paper.authors)}, not ${family}`)
  }
  if (yearAgreement(year, paper) === 'conflict') {
    conflicts.push(`published ${extractYear(paper?.publicationDate ?? paper?.publication_date)}, not ${year}`)
  }
  return conflicts
}

function agreements(reference, paper) {
  const family = reference?.firstAuthor || printedFirstAuthor(reference?.raw)
  const year = reference?.year ?? printedYear(reference?.raw)
  return [firstAuthorAgreement(family, paper?.authors), yearAgreement(year, paper)].filter((value) => value === 'agree').length
}

// 'match'  — add with confidence; 'check' — show the reviewer a caution badge;
// 'reject' — wrong paper, keep looking (and, if nothing better turns up,
// leave the reference unresolved). A first author or year that contradicts
// the printed citation rejects outright. Below a near-exact title, a match
// needs the author or year to agree; a loose title with nothing agreeing is
// too uncertain to attach. With no parsed title, the candidate's title is
// checked against the raw citation text instead. A bare-identifier paste has
// nothing to check against and stays 'check'.
export function scoreMatch(reference, paper) {
  if (!reference?.title) {
    if (printedWords(reference?.raw).length < PRINTED_WORDS_MIN) return 'check'
    if (!printedTitleFits(reference?.raw, paper?.title) || matchConflicts(reference, paper).length) return 'reject'
    const wholeTitle = titleContainment(reference?.raw, paper?.title) >= 0.7
    const shortened = contentContainment(reference?.raw, paper?.title, { leading: LEADING_TITLE_WORDS }) >= 0.8 && agreements(reference, paper) >= 1
    return wholeTitle || shortened ? 'match' : 'check'
  }
  const similarity = titleSimilarity(reference.title, paper?.title)
  if (similarity < 0.5 || matchConflicts(reference, paper).length) return 'reject'
  const agreed = agreements(reference, paper)
  if (similarity >= 0.9 || (similarity >= 0.7 && agreed >= 1)) return 'match'
  if (agreed >= 1) return 'check'
  return 'reject'
}

// PubMed title searches, most specific first. The printed first author and
// year (±1 for print vs epub) narrow a prolific group's near-identical titles
// to the right one; each later query relaxes a constraint in case the
// transcription got that detail wrong.
export function buildTitleQueries(reference) {
  const title = compact(reference?.title).replace(/[.?!]+$/, '')
  if (!title) return []
  const author = compact(reference?.firstAuthor)
  const year = Number.isInteger(reference?.year) ? reference.year : null
  const queries = [
    author && year ? `${title} AND ${author}[au] AND ${year - 1}:${year + 1}[dp]` : null,
    author ? `${title} AND ${author}[au]` : null,
    year ? `${title} AND ${year - 1}:${year + 1}[dp]` : null,
    title,
  ]
  return [...new Set(queries.filter(Boolean))]
}

export function buildTitleQuery(reference) {
  const title = compact(reference?.title).replace(/[.?!]+$/, '')
  if (!title) return ''
  const author = compact(reference?.firstAuthor)
  return author ? `${title} AND ${author}[au]` : title
}

// --- resolution against PubMed/Crossref ---

function shapePaper(paper, extra = {}) {
  return {
    pmid: paper.pmid ?? null,
    doi: paper.doi ?? null,
    title: paper.title,
    authors: paper.authors || [],
    journal: paper.journal || '',
    publicationDate: paper.publicationDate || '',
    abstract: paper.abstract || '',
    meshTerms: paper.meshTerms || [],
    pubmedUrl: paper.pubmedUrl || null,
    sourceUrl: paper.sourceUrl || paper.pubmedUrl || null,
    sourceType: paper.sourceType || (paper.pmid ? 'pubmed' : 'doi'),
    arxivId: paper.arxivId || null,
    oaPdfUrl: paper.oaPdfUrl || null,
    ...extra,
  }
}

// A "not found" thrown by the resolver is a real answer, never worth a retry;
// everything else (429s, dropped connections, CORS-masked rate limits) is.
const NOT_FOUND_RE = /^No (PubMed )?paper was found/

async function withRetry(fn, { attempts = 3, delayMs = 1200, signal } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await fn()
    } catch (err) {
      if (err?.name === 'AbortError' || NOT_FOUND_RE.test(err?.message || '')) throw err
      lastError = err
      if (attempt < attempts - 1) await pause(delayMs * (attempt + 1), signal)
    }
  }
  throw lastError
}

function lookupFailureMessage(err) {
  const message = err?.message || 'The lookup failed.'
  return message === 'Failed to fetch'
    ? 'PubMed stopped answering — likely rate-limited. Use "Try these again" in a moment.'
    : message
}

// Resolve one parsed reference. Printed identifiers are tried first but still
// verified against the printed title — a wrong PMID/DOI in a bibliography
// falls through to title search instead of importing a stranger's paper.
// A lookup that errors out (rather than answering "not found") is reported as
// method 'error' so the UI can offer a retry instead of claiming "not found".
export async function resolveReference(reference, { signal } = {}) {
  if (reference.parseWarning) {
    return { reference, paper: null, method: 'unparsed', confidence: 'none', warning: reference.parseWarning }
  }
  let lookupError = null
  // Printed identifiers that led to a different paper — shown to the
  // reviewer so a misprinted or misread identifier is visible, not silent.
  const rejected = []
  if (reference.pmid) {
    try {
      const [paper] = await withRetry(() => fetchPubMedPapers([reference.pmid], { signal }), { signal })
      if (paper) {
        const confidence = scoreMatch(reference, paper)
        if (confidence !== 'reject') {
          return { reference, paper: shapePaper(paper), method: 'pmid', confidence }
        }
        rejected.push({ via: `PMID ${reference.pmid}`, title: paper.title })
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      if (!NOT_FOUND_RE.test(err?.message || '')) lookupError = err
    }
  }
  if (reference.doi) {
    try {
      const resolved = await withRetry(() => resolveDirectPaper(reference.doi, { signal }), { signal })
      if (resolved?.paper) {
        const confidence = scoreMatch(reference, resolved.paper)
        if (confidence !== 'reject') {
          return { reference, paper: shapePaper(resolved.paper), method: 'doi', confidence }
        }
        rejected.push({ via: `DOI ${reference.doi}`, title: resolved.paper.title })
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      if (!NOT_FOUND_RE.test(err?.message || '')) lookupError = err
    }
  }
  if (reference.title) {
    // Most specific query first; stop at the first confident match. A
    // cautious 'check' is kept only if no later query finds a match, and the
    // closest candidate refused for a contradiction is reported.
    let fallback = null
    let nearMiss = null
    for (const query of buildTitleQueries(reference)) {
      try {
        const { papers } = await withRetry(() => searchPubMed({ query, limit: TITLE_SEARCH_LIMIT, signal }), { signal })
        let best = null
        for (const paper of papers || []) {
          const confidence = scoreMatch(reference, paper)
          const similarity = titleSimilarity(reference.title, paper.title)
          if (confidence === 'reject') {
            const conflicts = matchConflicts(reference, paper)
            if (conflicts.length && similarity >= 0.5 && (!nearMiss || similarity > nearMiss.similarity)) {
              nearMiss = { paper, similarity, conflicts }
            }
            continue
          }
          const better = !best
            || (confidence === 'match' && best.confidence !== 'match')
            || (confidence === best.confidence && similarity > best.similarity)
          if (better) best = { paper, confidence, similarity }
        }
        if (best?.confidence === 'match') {
          return { reference, paper: shapePaper(best.paper), method: 'title', confidence: 'match' }
        }
        if (best && (!fallback || best.similarity > fallback.similarity)) fallback = best
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        lookupError = err
      }
    }
    if (fallback) return { reference, paper: shapePaper(fallback.paper), method: 'title', confidence: fallback.confidence }
    if (nearMiss) {
      rejected.push({
        via: 'Title search',
        title: nearMiss.paper.title,
        reason: nearMiss.conflicts.join('; '),
      })
    }
  }
  // Not in PubMed: preprints, conference papers, and non-biomedical journals
  // are looked up in OpenAlex — by arXiv id or DOI first, then by title.
  try {
    const found = await resolveViaOpenAlex(reference, { signal, rejected })
    if (found) return found
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    lookupError = lookupError || err
  }
  const extra = rejected.length ? { rejected } : {}
  if (lookupError) {
    return { reference, paper: null, method: 'error', confidence: 'none', error: lookupFailureMessage(lookupError), ...extra }
  }
  return { reference, paper: null, method: 'none', confidence: 'none', ...extra }
}

async function resolveViaOpenAlex(reference, { signal, rejected = [] } = {}) {
  const arxivId = arxivIdFrom(reference.doi) || arxivIdFrom(reference.raw)
  const dois = [...new Set([arxivId ? arxivDoi(arxivId) : null, reference.doi].filter(Boolean))]
  for (const doi of dois) {
    const paper = await withRetry(() => openAlexByDoi(doi, { signal }), { signal })
    if (!paper) continue
    const confidence = scoreMatch(reference, paper)
    if (confidence !== 'reject') {
      return { reference, paper: shapePaper({ ...paper, arxivId: paper.arxivId || arxivId }), method: arxivId ? 'arxiv' : 'doi', confidence }
    }
    if (!rejected.some((item) => item.title === paper.title)) rejected.push({ via: `DOI ${doi}`, title: paper.title })
  }
  if (!reference.title) return null
  const papers = await withRetry(() => searchOpenAlexByTitle(reference.title, { signal }), { signal })
  let best = null
  for (const paper of papers) {
    const confidence = scoreMatch(reference, paper)
    if (confidence === 'reject') continue
    const similarity = titleSimilarity(reference.title, paper.title)
    if (!best || (confidence === 'match' && best.confidence !== 'match') || (confidence === best.confidence && similarity > best.similarity)) {
      best = { paper, confidence, similarity }
    }
  }
  return best ? { reference, paper: shapePaper(best.paper), method: 'title', confidence: best.confidence } : null
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

// Sequentially resolve every parsed reference. `isSaved(paperLike)` lets the
// caller short-circuit references already in the collection (checked on the
// printed identifiers before the lookup, and on the resolved paper after).
export async function resolveReferences(references, { isSaved, onProgress, signal } = {}) {
  const results = []
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.(index, references.length, reference)
    if (isSaved?.({ pmid: reference.pmid, doi: reference.doi, title: reference.title })) {
      results.push({ reference, paper: null, method: 'already', confidence: 'already' })
      continue
    }
    const result = await resolveReference(reference, { signal })
    if (result.paper && isSaved?.(result.paper)) {
      results.push({ reference, paper: result.paper, method: 'already', confidence: 'already' })
    } else {
      results.push(result)
    }
    // A reference refused without a lookup costs no request, so no wait.
    if (index < references.length - 1 && result.method !== 'unparsed') await pause(resolvePacingMs(), signal)
  }
  onProgress?.(references.length, references.length, null)
  return results
}
