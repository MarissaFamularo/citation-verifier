// lib/referenceImport.js — turn a pasted reference list into verified PubMed matches.
//
// Division of labor ("the model proposes, the code disposes"): the model only
// PARSES the pasted text into structured citations — copying what is printed,
// never completing an identifier. Code then resolves each citation against
// PubMed (and Crossref for non-indexed DOIs) and scores the candidate by
// title/year agreement, so a mistyped PMID in the bibliography or a wrong
// search hit reaches the reviewer labeled, never silently accepted.

import { extractStructured, getNcbiKey, MODELS } from './anthropic.js'
import { resolveDirectPaper } from './directPaper.js'
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
    const doiText = compact(row?.doi)
      .replace(/^doi:\s*/i, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/[).,;]+$/, '')
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
    const doi = doiMatch ? doiMatch[1].replace(/[).,;]+$/, '') : null
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

// 'match'  — add with confidence; 'check' — show the reviewer a caution badge;
// 'reject' — wrong paper, keep looking. With no parsed title, verification
// falls back to checking the resolved title against the raw citation text; a
// bare-identifier paste has nothing to check against and stays 'check'.
export function scoreMatch(reference, paper) {
  if (!reference?.title) {
    const containment = titleContainment(reference?.raw, paper?.title)
    return containment >= 0.7 ? 'match' : 'check'
  }
  const similarity = titleSimilarity(reference.title, paper?.title)
  const refYear = reference.year ?? null
  const paperYear = extractYear(paper?.publicationDate ?? paper?.publication_date)
  // Print vs epub years routinely differ by one; more than that is suspicious.
  const yearOk = refYear === null || paperYear === null || Math.abs(refYear - paperYear) <= 1
  if (similarity >= 0.7) return yearOk ? 'match' : 'check'
  if (similarity >= 0.5) return 'check'
  return 'reject'
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
  let lookupError = null
  if (reference.pmid) {
    try {
      const [paper] = await withRetry(() => fetchPubMedPapers([reference.pmid], { signal }), { signal })
      if (paper) {
        const confidence = scoreMatch(reference, paper)
        if (confidence !== 'reject') {
          return { reference, paper: shapePaper(paper), method: 'pmid', confidence }
        }
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
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      if (!NOT_FOUND_RE.test(err?.message || '')) lookupError = err
    }
  }
  if (reference.title) {
    // Author-constrained first; a mis-parsed surname would sink that search,
    // so an empty round falls back to the bare title.
    const queries = [buildTitleQuery(reference)]
    const bare = buildTitleQuery({ title: reference.title })
    if (bare && bare !== queries[0]) queries.push(bare)
    for (const query of queries) {
      try {
        const { papers } = await withRetry(() => searchPubMed({ query, limit: 5, signal }), { signal })
        let best = null
        let bestConfidence = 'reject'
        let bestSimilarity = 0
        for (const paper of papers || []) {
          const confidence = scoreMatch(reference, paper)
          if (confidence === 'reject') continue
          const similarity = titleSimilarity(reference.title, paper.title)
          const better = (confidence === 'match' && bestConfidence !== 'match')
            || (confidence === bestConfidence && similarity > bestSimilarity)
          if (!best || better) {
            best = paper
            bestConfidence = confidence
            bestSimilarity = similarity
          }
        }
        if (best) {
          return { reference, paper: shapePaper(best), method: 'title', confidence: bestConfidence }
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        lookupError = err
      }
    }
  }
  if (lookupError) {
    return { reference, paper: null, method: 'error', confidence: 'none', error: lookupFailureMessage(lookupError) }
  }
  return { reference, paper: null, method: 'none', confidence: 'none' }
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
    if (index < references.length - 1) await pause(resolvePacingMs(), signal)
  }
  onProgress?.(references.length, references.length, null)
  return results
}
