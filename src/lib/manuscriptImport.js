// lib/manuscriptImport.js — read a whole manuscript, pull out its reference
// list, and detect which sentence cites which reference.
//
// Division of labor, as everywhere: everything DETECTABLE is done by code —
// the .docx unzip, the body/references split, citation-marker matching
// (bracketed [12], superscript .12, parenthesized (12), and author–year), and
// printed DOI/PMID extraction. The model is only asked to transcribe the
// reference entries that lack a printed identifier (same contract as the
// reference-list importer), and every citing sentence stored is a verbatim
// span of the manuscript the user gave us — nothing is composed.

import { extractStructured, MODELS } from './anthropic.js'
import { trimDoiEnd } from './directPaper.js'
import { normalizeTitle } from './referenceImport.js'

export const MANUSCRIPT_CHAR_CAP = 600_000
export const REFERENCE_CAP = 100
export const CITATIONS_PER_REFERENCE_CAP = 12
export const SENTENCE_CHAR_CAP = 600

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

// --- .docx text extraction (dependency-free) ---------------------------------
//
// A .docx is a zip; the manuscript prose lives in word/document.xml. The walk
// below reads the zip central directory directly and inflates with the
// browser-native DecompressionStream, so no zip library ships with the app.

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function extractDocxText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const notDocx = 'This file does not look like a Word (.docx) document.'

  let eocd = -1
  const scanFloor = Math.max(0, bytes.length - 22 - 65_535)
  for (let i = bytes.length - 22; i >= scanFloor; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error(notDocx)

  const entryCount = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  let documentEntry = null
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIG) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (name === 'word/document.xml') {
      documentEntry = { method, compressedSize, localOffset }
      break
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (!documentEntry) throw new Error(notDocx)
  if (documentEntry.compressedSize === 0xffffffff) {
    throw new Error('This Word document is too large to read here.')
  }

  const { localOffset, method, compressedSize } = documentEntry
  if (view.getUint32(localOffset, true) !== LOCAL_SIG) throw new Error(notDocx)
  const nameLength = view.getUint16(localOffset + 26, true)
  const extraLength = view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const data = bytes.subarray(dataStart, dataStart + compressedSize)
  const xmlBytes = method === 0 ? data : method === 8 ? await inflateRaw(data) : null
  if (!xmlBytes) throw new Error(notDocx)
  return docxXmlToText(decoder.decode(xmlBytes))
}

export function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// word/document.xml → plain text: one line per paragraph, tabs and line
// breaks preserved as spacing. Regex-based on purpose — it runs in the
// browser and in node tests alike, and w:t content is simple character data.
//
// Superscript runs (w:vertAlign val="superscript" — how Word renders citation
// numbers) are preserved as ^{...} markers, because a superscript flattened
// to plain digits is indistinguishable from data. The citation detector
// matches these markers exactly; storage strips them back out.
export function docxXmlToText(xml) {
  return String(xml ?? '')
    .replace(/<w:tab\b[^>]*\/>/g, '<w:t> </w:t>')
    .replace(/<w:br\b[^>]*\/>/g, '<w:t> </w:t>')
    .split(/<\/w:p>/)
    .map((paragraph) => (
      [...paragraph.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)]
        .map((run) => {
          const text = [...run[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
            .map((match) => decodeXmlEntities(match[1]))
            .join('')
          const superscript = /<w:vertAlign\b[^>]*w:val="superscript"/.test(run[1])
          return superscript && text.trim() ? `^{${text.trim()}}` : text
        })
        .join('')
        // Word splits one visual superscript across runs arbitrarily —
        // merge adjacent markers back into one cluster: ^{1}^{,}^{2} → ^{1,2}
        .replace(/\}\^\{/g, '')
        .trim()
    ))
    .filter(Boolean)
    .join('\n')
}

// Remove the ^{...} superscript markers, keeping their content — applied to
// everything stored or shown, so sentences read as the manuscript does.
export function stripSuperscriptMarks(text) {
  return String(text ?? '').replace(/\^\{([^}]*)\}/g, '$1')
}

// Remove citation markers from a sentence ENTIRELY (digits included), so the
// numbers that remain are the sentence's own data — what the support check
// verifies against the cited paper. Mirrors the marker shapes the detector
// reads: ^{...}, [n,n-n], digits glued after punctuation, digits glued to a
// word before punctuation.
export function stripCitationMarkers(sentence) {
  return String(sentence ?? '')
    .replace(/\^\{[^}]*\}/g, '')
    .replace(/\[\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*\]/g, '')
    .replace(/([A-Za-z”’"')\]][.,;:])\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*(?=\s|$)/g, '$1')
    .replace(/(?<=[A-Za-z)\]”’"'])\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*(?=[.,;:?!])/g, '')
}

// Dispatch by file type. Anything that isn't .docx is read as plain text.
export async function readManuscriptFile(file) {
  const name = String(file?.name || '').toLowerCase()
  if (name.endsWith('.docx')) return extractDocxText(await file.arrayBuffer())
  if (name.endsWith('.doc')) {
    throw new Error('Old .doc files cannot be read here — save the manuscript as .docx, or paste its text.')
  }
  if (name.endsWith('.pdf')) {
    const { extractPdfText } = await import('./pdfText.js')
    return extractPdfText(await file.arrayBuffer())
  }
  return file.text()
}

// --- body / reference-list split ---------------------------------------------

const SECTION_HEADING_RE = /^\s*(?:\d+[.)]?\s*)?(abstract|introduction|background|methods|materials and methods|patients and methods|results|discussion|conclusion|conclusions|limitations|case report|case presentation)\s*:?\s*$/i
// "12." / "12)" / "[12]" — and "12.." as some publishers print it.
const ENTRY_NUMBER_RE = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})(?:\.\.?|\)))\s+/
const REFERENCE_HEADING_RE = /^\s*(?:\d+[.)]?\s*)?(references|bibliography|literature cited|works cited|reference list)\s*:?\s*$/i

export function splitManuscript(text) {
  const manuscript = String(text ?? '').replace(/\r/g, '').trim()
  if (!manuscript) throw new Error('Paste or upload the manuscript first.')
  if (manuscript.length > MANUSCRIPT_CHAR_CAP) {
    throw new Error(`That manuscript is too long (${manuscript.length.toLocaleString()} characters) to read here.`)
  }
  const lines = manuscript.split('\n')
  const headings = []
  lines.forEach((line, index) => { if (REFERENCE_HEADING_RE.test(line)) headings.push(index) })
  if (!headings.length) {
    throw new Error('No reference list was found — the manuscript needs a heading such as "References" or "Bibliography" above its reference list.')
  }
  // Journals may print more than one list (main text, then Methods). A
  // numbered list ends at the first line that does not start an entry, so the
  // text between and after the lists stays in the body. An unnumbered list
  // runs to the next References heading or the end, as before.
  const inReferences = new Array(lines.length).fill(false)
  headings.forEach((heading, position) => {
    const limit = headings[position + 1] ?? lines.length
    let first = heading + 1
    while (first < limit && !lines[first].trim()) first += 1
    const numbered = first < limit && ENTRY_NUMBER_RE.test(lines[first])
    inReferences[heading] = true
    if (!numbered) {
      for (let i = heading + 1; i < limit; i += 1) inReferences[i] = true
      return
    }
    let lastEntry = first
    let wrapped = false
    for (let i = first; i < limit; i += 1) {
      if (ENTRY_NUMBER_RE.test(lines[i])) lastEntry = i
    }
    for (let i = first; i < lastEntry; i += 1) if (lines[i].trim() && !ENTRY_NUMBER_RE.test(lines[i])) wrapped = true
    // Entries hard-wrapped over several lines: the last entry keeps its
    // continuation lines, up to the next blank line.
    let end = lastEntry
    if (wrapped) {
      while (end + 1 < limit && end - lastEntry < 4 && lines[end + 1].trim() && !SECTION_HEADING_RE.test(lines[end + 1])) end += 1
    }
    for (let i = heading + 1; i <= end; i += 1) inReferences[i] = true
  })
  const body = lines.filter((line, index) => !inReferences[index]).join('\n').trim()
  const referenceText = lines
    .filter((line, index) => inReferences[index] && !headings.includes(index))
    .join('\n')
    .trim()
  if (!referenceText) throw new Error('The References heading was found, but no references follow it.')
  if (!body) throw new Error('No manuscript text was found above the reference list.')
  return { body, referenceText }
}

// --- reference entries, numbering preserved ----------------------------------


// Split the reference section into entries and keep each entry's number.
// Printed numbers win; a list without printed numbers (Word's auto-numbered
// lists lose them in the saved text) is numbered sequentially in order.
//
// In a printed list, a block that starts without a number is the tail of the
// entry before it (an entry wrapped across a page or column break), never a
// reference of its own — giving it the next free number would shift every
// citation after it onto the wrong paper. An entry whose text still looks
// like several references run together keeps a parseWarning, and is reported
// unresolved instead of being looked up.
export const REFERENCE_ENTRY_CHAR_CAP = 2000
// "…595-603. 7. Maurel B, …" / "…00290-3 18. Gorelick PB, …" — an entry
// start (a number, then a surname and initials) inside an entry's text. A
// number after "No." / "Vol." / "Pt." is part of the citation itself.
const EMBEDDED_ENTRY_RE = /(?<!\b(?:No|NO|no|Nos|Vol|vol|Pt|Ch|Suppl|Issue))[.)\]\d]\s+(?:\[(\d{1,3})\]|(\d{1,3})(?:\.\.?|\)))\s+\p{Lu}[\p{L}'’-]+,?\s+\p{Lu}{1,3}[,.]/gu
// A journal locus: "2015;61(2):309-316", "2016;5:e38", "2024;190:111423".
const LOCUS_RE = /\b(?:19|20)\d{2}\s*;\s*\d+(?:\s*\([^)]{1,12}\))?\s*:\s*[eS]?\d+/g
const DOI_ALL_RE = /\b10\.\d{4,9}\/[^\s"'<>]+/g
// A year, or "n.d." for an undated source.
const YEAR_RE = /\b(?:1[89]|20)\d{2}\b|\bn\.\s?d\./i

// Why one entry's text cannot be trusted, judged on the entry alone. These
// are the marks of a list read in the wrong order — lines of neighbouring
// references interleaved (a multi-column layout read across), or an entry
// cut short where its remainder went to another one.
export function entryProblems(entry) {
  const raw = entry.raw
  const problems = []
  const embedded = [...raw.matchAll(EMBEDDED_ENTRY_RE)].some((match) => Number(match[1] ?? match[2]) !== entry.number)
  if (embedded || raw.length > REFERENCE_ENTRY_CHAR_CAP) problems.push('this entry may contain more than one reference')
  const loci = new Set([...raw.matchAll(LOCUS_RE)].map((match) => match[0].replace(/\s+/g, '')))
  if (loci.size > 1) problems.push('it contains two journal citations')
  const dois = new Set([...raw.matchAll(DOI_ALL_RE)].map((match) => trimDoiEnd(match[0]).toLowerCase()))
  if (dois.size > 1) problems.push('it contains two DOIs')
  const linked = /https?:\/\/|\b10\.\d{4,9}\//.test(raw)
  if (/(?:[-–:;,(]|\bet al\.|\bdoi:\s*10\.)$/.test(raw) || (!YEAR_RE.test(raw) && !linked)) {
    problems.push('it looks cut off')
  }
  return problems
}

// Problems only the whole list shows. Printed numbers that run backwards
// more than once mean the reading order itself is wrong, and then no entry's
// text is trustworthy — even one that looks complete may carry a
// neighbour's title. A number missing from the middle of the list most
// likely sits inside the entry before the gap.
function listProblems(entries) {
  const numbered = entries.filter((entry) => Number.isInteger(entry.number))
  const problems = new Map(entries.map((entry) => [entry, []]))
  let descents = 0
  for (let i = 1; i < numbered.length; i += 1) if (numbered[i].number < numbered[i - 1].number) descents += 1
  if (descents >= 2) {
    for (const entry of numbered) problems.get(entry).push('the reference list was read out of order (likely a multi-column layout), so its entries may be mixed together')
    return problems
  }
  const present = new Set(numbered.map((entry) => entry.number))
  const highest = Math.max(0, ...present)
  for (const entry of numbered) {
    let missing = entry.number + 1
    while (missing < highest && !present.has(missing)) missing += 1
    if (missing > entry.number + 1 && missing <= highest) {
      const gap = missing - 1 === entry.number + 1 ? `${entry.number + 1} is` : `${entry.number + 1}–${missing - 1} are`
      problems.get(entry).push(`reference ${gap} missing from the list and may be inside this entry`)
    }
  }
  return problems
}

// Text lost the line breaks between entries: cut where the NEXT number starts
// an entry after a finished one. Only the very next number counts, and only
// when that number is not printed as an entry of its own elsewhere.
function splitRunOn(entry, printedNumbers) {
  const out = [entry]
  for (;;) {
    const last = out[out.length - 1]
    const next = last.number + 1
    if (printedNumbers.has(next)) break
    const re = new RegExp(`[.)\\]]\\s+(?:\\[${next}\\]|${next}(?:\\.\\.?|\\)))\\s+(?=\\p{Lu})`, 'u')
    const match = last.raw.match(re)
    if (!match) break
    const cut = match.index + 1
    out[out.length - 1] = { ...last, raw: last.raw.slice(0, cut).trim() }
    out.push({ number: next, raw: last.raw.slice(cut + match[0].length - 1).trim() })
    printedNumbers.add(next)
  }
  return out
}

export function numberReferenceEntries(referenceText) {
  const text = stripSuperscriptMarks(String(referenceText ?? '')).replace(/\r/g, '').trim()
  if (!text) return []
  const numberedBlocks = text.split(/\n(?=\s*(?:\[\d{1,3}\]|\d{1,3}(?:\.\.?|\)))\s+)/)
  const usePrinted = numberedBlocks.length > 1 || ENTRY_NUMBER_RE.test(text)
  if (!usePrinted) {
    const blocks = text.includes('\n\n') ? text.split(/\n\s*\n/) : text.split('\n')
    const entries = []
    for (const block of blocks) {
      const raw = compact(block)
      if (raw) entries.push({ number: entries.length + 1, raw })
      if (entries.length >= REFERENCE_CAP) break
    }
    return entries
  }

  const printed = []
  for (const block of numberedBlocks) {
    const match = block.match(ENTRY_NUMBER_RE)
    const raw = compact(block.replace(ENTRY_NUMBER_RE, ''))
    if (!raw) continue
    if (match) {
      printed.push({ number: Number(match[1] ?? match[2]), raw })
    } else if (printed.length) {
      const last = printed[printed.length - 1]
      last.raw = compact(`${last.raw} ${raw}`)
    } else {
      // Text before the first numbered entry: kept for inspection, unnumbered
      // entries cannot be cited by number, so it is flagged rather than guessed.
      printed.push({ number: null, raw })
    }
  }
  const printedNumbers = new Set(printed.map((entry) => entry.number).filter(Number.isInteger))
  const entries = []
  const seen = new Set()
  for (const entry of printed.flatMap((item) => (Number.isInteger(item.number) ? splitRunOn(item, printedNumbers) : [item]))) {
    const warnings = []
    if (!Number.isInteger(entry.number)) {
      warnings.push('text before the first numbered reference')
    } else if (seen.has(entry.number)) {
      warnings.push(`reference number ${entry.number} appears more than once`)
    }
    seen.add(entry.number)
    entries.push({ number: entry.number, raw: entry.raw, warnings: [...warnings, ...entryProblems(entry)] })
    if (entries.length >= REFERENCE_CAP) break
  }
  const fromList = listProblems(entries)
  return entries
    // An entry without a number cannot be attached to any citation.
    .filter((entry) => Number.isInteger(entry.number) || entry.warnings.length)
    .map((entry) => {
      const warnings = [...fromList.get(entry), ...entry.warnings]
      return { number: entry.number, raw: entry.raw, ...(warnings.length ? { parseWarning: warnings.join('; ') } : {}) }
    })
}

// --- printed identifiers (deterministic, no model) ---------------------------

const DOI_IN_TEXT_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/
const PMID_IN_TEXT_RE = /\bPMID:?\s*(\d{1,10})\b/i

export function entryIdentifiers(raw) {
  const doiMatch = String(raw ?? '').match(DOI_IN_TEXT_RE)
  const doi = doiMatch ? trimDoiEnd(doiMatch[1]) : null
  const pmidMatch = String(raw ?? '').match(PMID_IN_TEXT_RE)
  const pmid = pmidMatch ? pmidMatch[1] : null
  return { pmid, doi }
}

// --- model transcription of unidentified entries -----------------------------

const NUMBERED_REFERENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['references'],
  properties: {
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title', 'firstAuthor', 'journal', 'year', 'pmid', 'doi'],
        properties: {
          number: { type: 'integer', description: 'The list number printed before this reference in the input. Echo it exactly.' },
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

const NUMBERED_PARSE_SYSTEM = `You transcribe an academic reference list into structured fields. Each input line starts with its list number.

Rules:
- One output entry per input reference, echoing its printed list number in number.
- COPY, never infer: a PMID or DOI goes in the output only if those characters appear in the input. Never complete, correct, or recall an identifier from memory.
- Keep partial or malformed references — fill what is printed, null the rest.
- Skip anything that is not a reference (stray headers, page numbers).`

const CURRENT_YEAR = new Date().getFullYear()

export function cleanNumberedParse(parsed, entriesByNumber) {
  const rows = Array.isArray(parsed?.references) ? parsed.references : []
  const cleaned = []
  const seen = new Set()
  for (const row of rows) {
    const number = Number.isInteger(row?.number) ? row.number : null
    const entry = number != null ? entriesByNumber.get(number) : null
    if (!entry || seen.has(number)) continue
    seen.add(number)
    const title = compact(row?.title) || null
    const pmidText = compact(row?.pmid).replace(/^PMID:?\s*/i, '')
    // An identifier is kept only if it is printed in the entry itself: the
    // model is told to copy, and the code makes sure it did.
    const printed = entry.raw.toLowerCase()
    const pmid = /^[0-9]{1,10}$/.test(pmidText) && new RegExp(`(?<!\\d)${pmidText}(?!\\d)`).test(printed) ? pmidText : null
    const doiText = trimDoiEnd(compact(row?.doi)
      .replace(/^doi:\s*/i, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''))
    const doi = /^10\.\d{4,9}\/\S+$/.test(doiText) && printed.includes(doiText.toLowerCase()) ? doiText : null
    if (!title && !pmid && !doi) continue
    cleaned.push({
      number,
      raw: entry.raw,
      ...(entry.parseWarning ? { parseWarning: entry.parseWarning } : {}),
      title,
      firstAuthor: compact(row?.firstAuthor) || null,
      journal: compact(row?.journal) || null,
      year: Number.isInteger(row?.year) && row.year >= 1800 && row.year <= CURRENT_YEAR + 1 ? row.year : null,
      pmid,
      doi,
    })
  }
  return cleaned
}

export async function parseNumberedReferences(entries) {
  if (!entries.length) return []
  const content = entries.map((entry) => `${entry.number}. ${entry.raw}`).join('\n')
  const parsed = await extractStructured({
    model: MODELS.fast,
    system: NUMBERED_PARSE_SYSTEM,
    content,
    schema: NUMBERED_REFERENCE_SCHEMA,
    maxTokens: 32_000,
    // Copying printed fields needs little thinking; low effort keeps it cheap.
    effort: 'low',
  })
  return cleanNumberedParse(parsed, new Map(entries.map((entry) => [entry.number, entry])))
}

// True when at least one reference entry lacks a printed identifier, i.e. the
// model (and therefore an API key) is needed to read the reference list.
// Entries flagged as mis-split are reported, never transcribed.
export function manuscriptNeedsModel(referenceText) {
  const entries = numberReferenceEntries(referenceText)
  return entries.length === 0 || entries.some((entry) => {
    if (entry.parseWarning) return false
    const { pmid, doi } = entryIdentifiers(entry.raw)
    return !pmid && !doi
  })
}

function unresolvedEntry(entry) {
  return { ...entry, title: null, firstAuthor: null, journal: null, year: null, pmid: null, doi: null }
}

// The full reference gather for a manuscript: printed identifiers first (no
// model), then one transcription call for whatever lacks one. Every result
// keeps its list number so citing sentences can be attached. Every entry
// comes back, with its printed text: one the model could not read, or that
// looks mis-split, is returned unresolved instead of being dropped.
export async function gatherManuscriptReferences(referenceText) {
  const entries = numberReferenceEntries(referenceText)
  if (!entries.length) throw new Error('No references were recognized under the References heading.')
  const identified = []
  const flagged = []
  const needModel = []
  for (const entry of entries) {
    if (entry.parseWarning) {
      flagged.push(unresolvedEntry(entry))
      continue
    }
    const { pmid, doi } = entryIdentifiers(entry.raw)
    if (pmid || doi) {
      identified.push({ ...entry, title: null, firstAuthor: null, journal: null, year: null, pmid, doi })
    } else {
      needModel.push(entry)
    }
  }
  const transcribed = needModel.length ? await parseNumberedReferences(needModel) : []
  const transcribedNumbers = new Set(transcribed.map((ref) => ref.number))
  const unread = needModel.filter((entry) => !transcribedNumbers.has(entry.number)).map(unresolvedEntry)
  const references = [...identified, ...transcribed, ...unread, ...flagged]
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
  return { references, usedModel: needModel.length > 0, entryCount: entries.length }
}

// --- citing sentences --------------------------------------------------------


// Break after terminal punctuation (plus trailing quotes/brackets and any
// glued superscript citation digits) when the next word starts a sentence.
// "(" is deliberately NOT a sentence starter: it would split "et al. (2020)"
// away from its citing sentence.
// A bracketed citation printed after the period (".[3] Next…") belongs to
// the sentence it follows.
const SENTENCE_BREAK_RE = /([.?!][”’"')\]]*(?:\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*)?(?:\^\{[^}]*\})?(?:\[\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*\])?)\s+(?=[A-Z0-9“"‘])/g

// Abbreviations whose period is not a sentence end: always ("vs.", "e.g."),
// or when a number follows ("Fig. 2", "(ref. 29)", "no. 4").
const ABBREVIATION_END_RE = /(?:\b(?:vs|e\.g|i\.e|cf|approx)\.|\((?:e\.g|i\.e)\.)$/i
const NUMBERED_ABBREVIATION_END_RE = /\b(?:refs?|figs?|eqs?|nos?|tables?|supplementary (?:figs?|tables?))\.$/i

export function splitSentences(text) {
  const pieces = String(text ?? '')
    .replace(SENTENCE_BREAK_RE, '$1\u0000')
    .split('\u0000')
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  const sentences = []
  for (const piece of pieces) {
    const last = sentences[sentences.length - 1]
    const joins = last && (ABBREVIATION_END_RE.test(last) || (NUMBERED_ABBREVIATION_END_RE.test(last) && /^\d/.test(piece)))
    if (joins) sentences[sentences.length - 1] = `${last} ${piece}`
    else sentences.push(piece)
  }
  return sentences
}

export function splitBodySentences(body) {
  const out = []
  let section = null
  for (const paragraph of String(body ?? '').split(/\n+/)) {
    const line = paragraph.trim()
    if (!line) continue
    const heading = line.match(SECTION_HEADING_RE)
    if (heading) {
      section = heading[1].charAt(0).toUpperCase() + heading[1].slice(1).toLowerCase()
      continue
    }
    for (const sentence of splitSentences(line)) out.push({ sentence, section })
  }
  return out
}

const RANGE_EXPANSION_CAP = 25

export function expandNumberList(text) {
  const numbers = []
  for (const part of String(text ?? '').split(/[,;]/)) {
    const match = part.match(/^\s*(\d{1,3})\s*(?:[–—-]\s*(\d{1,3})\s*)?$/)
    if (!match) continue
    const start = Number(match[1])
    const end = match[2] ? Number(match[2]) : start
    if (end < start || end - start > RANGE_EXPANSION_CAP) {
      numbers.push(start)
      continue
    }
    for (let n = start; n <= end; n += 1) numbers.push(n)
  }
  return numbers
}

const BRACKET_CITE_RE = /\[(\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*)\]/g
const PAREN_CITE_RE = /\((\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*)\)/g
// Superscript preserved by the .docx extractor as an explicit marker — the
// exact case, no guessing needed.
const MARKED_SUP_RE = /\^\{\s*(\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*)\s*\}/g
// Digits glued to the punctuation after a word — how a superscript citation
// survives text extraction: "…improved outcomes.12,13"
const SUPERSCRIPT_CITE_RE = /[A-Za-z”’"')\]]([.,;:])(\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*)(?=\s|$)/g
// Digits glued to the END of a word, right before the sentence punctuation —
// the other way a flattened superscript reads: "…on duplex or CT1." /
// "…(3.7% vs 5.3%)4,5."
const TRAILING_SUP_RE = /(?<=[A-Za-z)\]”’"'])(\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*)(?=[.,;:?!])/g
const REF_WORD_CITE_RE = /\(refs?\.\s*(\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*)\)/gi
// Words whose trailing number is data, not a citation.
const NON_CITE_WORD_RE = /\b(?:fig|figure|figures|table|tables|eq|equation|ref|reference|no|nos|v|vs|vol|chapter|section|version|day|week|month|year|grade|type|stage|phase|class)\.?$/i

// All numeric citation markers in one sentence, labeled by style so the
// caller can keep only the manuscript's dominant style.
export function detectNumericMarkers(sentence, maxNumber) {
  if (!maxNumber) return []
  const found = []
  const keep = (numbers) => numbers.filter((n) => n >= 1 && n <= maxNumber)

  for (const match of sentence.matchAll(BRACKET_CITE_RE)) {
    const numbers = keep(expandNumberList(match[1]))
    if (numbers.length) found.push({ style: 'bracket', numbers, marker: match[0] })
  }

  // Parenthesized numbers, with an enumeration guard: a sentence that
  // contains both "(1)" and "(2)" is a numbered list ("(1) …; (2) …"), not
  // citations — skip every parenthesized match in it.
  const parenMatches = []
  for (const match of sentence.matchAll(PAREN_CITE_RE)) {
    const before = sentence.slice(0, match.index).trimEnd()
    if (/[\d=<>]$/.test(before) || NON_CITE_WORD_RE.test(before)) continue
    parenMatches.push(match)
  }
  const parenSingles = parenMatches
    .map((match) => expandNumberList(match[1]))
    .filter((numbers) => numbers.length === 1)
    .map((numbers) => numbers[0])
  if (!(parenSingles.includes(1) && parenSingles.includes(2))) {
    for (const match of parenMatches) {
      const numbers = keep(expandNumberList(match[1]))
      if (numbers.length) found.push({ style: 'paren', numbers, marker: match[0] })
    }
  }

  for (const match of sentence.matchAll(MARKED_SUP_RE)) {
    const numbers = keep(expandNumberList(match[1]))
    if (numbers.length) found.push({ style: 'superscript', marked: true, numbers, marker: `^${match[1].replace(/\s+/g, '')}` })
  }
  // "(ref. 29)" / "(refs. 3,4)" — how journals cite where a superscript would
  // read as part of a number or name ("GLM-5 (ref. 37)"). Unambiguous, so it
  // counts as a marked superscript.
  for (const match of sentence.matchAll(REF_WORD_CITE_RE)) {
    const numbers = keep(expandNumberList(match[1]))
    if (numbers.length) found.push({ style: 'superscript', marked: true, numbers, marker: match[0] })
  }
  for (const match of sentence.matchAll(SUPERSCRIPT_CITE_RE)) {
    const before = sentence.slice(0, match.index + 1)
    const lastWord = before.match(/[A-Za-z][\w'’-]*$/)?.[0] ?? ''
    if (NON_CITE_WORD_RE.test(lastWord)) continue
    const numbers = keep(expandNumberList(match[2]))
    if (numbers.length) found.push({ style: 'superscript', numbers, marker: `${match[1]}${match[2]}` })
  }
  // Trailing pattern keeps only a tiny blocklist: unlike "Fig. 2" or
  // "grade 2", data is written with a space, so a GLUED number before
  // punctuation ("grade2.") is a flattened superscript, not a measurement.
  for (const match of sentence.matchAll(TRAILING_SUP_RE)) {
    const before = sentence.slice(0, match.index)
    const lastWord = before.match(/[A-Za-z][A-Za-z'’-]*$/)?.[0] ?? ''
    if (/^(?:v|ver|version|no)$/i.test(lastWord)) continue
    const numbers = keep(expandNumberList(match[1]))
    if (numbers.length) found.push({ style: 'superscript', numbers, marker: match[1].replace(/\s+/g, '') })
  }
  return found
}

const AUTHOR_YEAR_PAREN_RE = /\(([^()]*\b(?:19|20)\d{2}[a-z]?[^()]*)\)/g
const NARRATIVE_CITE_RE = /\b([A-Z][A-Za-z'’-]+)(?:\s+et\s+al\.?|\s+and\s+[A-Z][A-Za-z'’-]+)?\s*\(\s*((?:19|20)\d{2})[a-z]?\s*\)/g

// Author–year citations, matched deterministically against the parsed
// reference list (family name + year must both agree).
export function detectAuthorYearMarkers(sentence, references) {
  const candidates = references.filter((ref) => ref.firstAuthor && ref.year)
  if (!candidates.length) return []
  const hits = []
  const push = (author, year, marker) => {
    const ref = candidates.find((candidate) =>
      String(candidate.year) === year
      && candidate.firstAuthor.toLowerCase() === author.toLowerCase())
    if (ref) hits.push({ number: ref.number, marker })
  }
  for (const match of sentence.matchAll(AUTHOR_YEAR_PAREN_RE)) {
    for (const segment of match[1].split(';')) {
      const author = segment.match(/[A-Z][A-Za-z'’-]+/)?.[0]
      const year = segment.match(/\b(?:19|20)\d{2}\b/)?.[0]
      if (author && year) push(author, year, `(${author}, ${year})`)
    }
  }
  for (const match of sentence.matchAll(NARRATIVE_CITE_RE)) {
    push(match[1], match[2], `${match[1]} (${match[2]})`)
  }
  return hits
}

function clampSentence(sentence) {
  const text = compact(stripSuperscriptMarks(sentence))
  return text.length > SENTENCE_CHAR_CAP ? `${text.slice(0, SENTENCE_CHAR_CAP - 1)}…` : text
}

// Walk the body once and link every citing sentence to its reference number.
// Numeric markers are filtered to the manuscript's dominant style (a paper
// uses one; cross-style matches are usually data misreads); author–year
// matches apply independently.
export function extractManuscriptCitations(body, references) {
  const numbers = references.map((ref) => ref.number).filter(Number.isInteger)
  const maxNumber = numbers.length ? Math.max(...numbers) : 0
  const sentences = splitBodySentences(body)

  const perSentence = sentences.map(({ sentence, section }) => ({
    sentence,
    section,
    numeric: detectNumericMarkers(sentence, maxNumber),
    authorYear: detectAuthorYearMarkers(sentence, references),
  }))

  // A manuscript whose superscripts arrived explicitly marked (.docx runs, PDF
  // geometry) needs no guessing: glued digits there are data ("MIRA-v2."),
  // so only the marked ones count.
  const markedCount = perSentence.reduce((sum, item) => sum + item.numeric.filter((hit) => hit.marked).length, 0)
  if (markedCount >= 3) {
    for (const item of perSentence) item.numeric = item.numeric.filter((hit) => hit.style !== 'superscript' || hit.marked)
  }

  const styleCounts = { bracket: 0, paren: 0, superscript: 0 }
  for (const item of perSentence) {
    for (const hit of item.numeric) styleCounts[hit.style] += 1
  }
  const dominantStyle = ['bracket', 'superscript', 'paren']
    .reduce((best, style) => (styleCounts[style] > (styleCounts[best] || 0) ? style : best), null)
  const styleUsed = dominantStyle && styleCounts[dominantStyle] > 0 ? dominantStyle : null

  const byNumber = new Map()
  let linkedSentences = 0
  for (const item of perSentence) {
    const hits = [
      ...(styleUsed ? item.numeric.filter((hit) => hit.style === styleUsed) : []),
      ...item.authorYear.map((hit) => ({ numbers: [hit.number], marker: hit.marker })),
    ]
    if (!hits.length) continue
    let linkedThisSentence = false
    for (const hit of hits) {
      for (const number of hit.numbers) {
        const list = byNumber.get(number) || []
        if (list.length >= CITATIONS_PER_REFERENCE_CAP) continue
        const sentence = clampSentence(item.sentence)
        if (list.some((existing) => existing.sentence === sentence)) continue
        list.push({ sentence, marker: hit.marker, locationHint: item.section })
        byNumber.set(number, list)
        linkedThisSentence = true
      }
    }
    if (linkedThisSentence) linkedSentences += 1
  }
  return { byNumber, styleUsed, linkedSentences }
}

// Key for deduping a citing sentence against rows already stored.
export function citationKey(literatureId, sentence) {
  return `${literatureId}\u0000${normalizeTitle(sentence)}`
}

// --- the manuscript's reference map ------------------------------------------
//
// Stored on the project_manuscripts row and REPLACED on every import, so the
// collection can always be numbered the way the current manuscript cites its
// papers. Each entry keeps the reference's printed number plus every
// identifier that can recognize the collected paper it points to.

export function buildReferenceMap(references, results = []) {
  const resolvedByNumber = new Map()
  for (const result of results) {
    const number = result?.reference?.number
    if (Number.isInteger(number) && result?.paper) resolvedByNumber.set(number, result.paper)
  }
  return (references || [])
    .filter((reference) => Number.isInteger(reference?.number))
    .map((reference) => {
      const paper = resolvedByNumber.get(reference.number)
      return {
        number: reference.number,
        pmid: paper?.pmid || reference.pmid || null,
        doi: paper?.doi || reference.doi || null,
        title: paper?.title || reference.title || null,
        // The printed citation itself — it contains the paper's title even
        // when no identifier or transcription is available, so matching
        // falls back to "this entry's text contains the paper title".
        raw: reference.raw || null,
      }
    })
}

// The number the current manuscript cites this collected paper under, or null
// when the manuscript does not reference it. Identifiers win outright; then
// an exact normalized-title match; then the printed reference entry whose
// text contains the paper's title (guarded to real titles, not short ones).
export function paperReferenceNumber(paper, referenceMap) {
  if (!paper || !Array.isArray(referenceMap) || !referenceMap.length) return null
  const doi = paper.doi ? String(paper.doi).toLowerCase() : null
  const number = (entry) => (Number.isInteger(entry?.number) ? entry.number : null)

  const byIdentifier = referenceMap.find((item) =>
    (paper.pmid && item?.pmid && String(item.pmid) === String(paper.pmid))
    || (doi && item?.doi && String(item.doi).toLowerCase() === doi))
  if (byIdentifier) return number(byIdentifier)

  const title = normalizeTitle(paper.title)
  if (!title) return null
  const byTitle = referenceMap.find((item) => item?.title && normalizeTitle(item.title) === title)
  if (byTitle) return number(byTitle)
  if (title.length >= 15) {
    const byRaw = referenceMap.find((item) => item?.raw && normalizeTitle(item.raw).includes(title))
    if (byRaw) return number(byRaw)
  }
  return null
}

// --- stored sentences vs the current manuscript ------------------------------
//
// On every manuscript import, each ALREADY-STORED citing sentence is checked
// against the new body and flagged, never deleted — a re-upload must not
// silently discard a sentence a teammate linked or a support verdict the team
// already ran. Deterministic, like all detection here: exact normalized match
// means current; a high word-overlap near-miss means the sentence was edited
// (its current wording is carried along); anything else means it is gone.

const SENTENCE_MATCH_THRESHOLD = 0.55

function sentenceMatchNorm(text) {
  return normalizeTitle(stripCitationMarkers(stripSuperscriptMarks(text)))
}

function clampDisplaySentence(sentence) {
  const text = compact(stripSuperscriptMarks(sentence))
  return text.length > SENTENCE_CHAR_CAP ? `${text.slice(0, SENTENCE_CHAR_CAP - 1)}…` : text
}

// Classify every stored citation row against the new manuscript body.
// Returns [{ row, match }] where match is
//   { status: 'current' } | { status: 'edited', current_sentence } | { status: 'removed' }.
export function classifyStoredCitations(rows, body) {
  const bodyEntries = []
  const bodyNorms = new Set()
  for (const { sentence } of splitBodySentences(body)) {
    const norm = sentenceMatchNorm(sentence)
    if (!norm) continue
    bodyNorms.add(norm)
    bodyEntries.push({ display: clampDisplaySentence(sentence), norm, tokens: new Set(norm.split(' ')) })
  }

  return (rows || []).map((row) => {
    const stored = String(row?.sentence ?? '')
    const norm = sentenceMatchNorm(stored)
    if (!norm || bodyNorms.has(norm)) return { row, match: { status: 'current' } }

    // A stored sentence clamped at import time ends in '…' — its
    // normalization is a prefix of the full body sentence's.
    if (stored.endsWith('…')) {
      const prefix = norm.split(' ').slice(0, -1).join(' ')
      if (prefix && bodyEntries.some((entry) => entry.norm.startsWith(prefix))) {
        return { row, match: { status: 'current' } }
      }
    }

    const tokens = new Set(norm.split(' '))
    let best = null
    let bestScore = 0
    for (const entry of bodyEntries) {
      let shared = 0
      for (const token of tokens) if (entry.tokens.has(token)) shared += 1
      const union = tokens.size + entry.tokens.size - shared
      const score = union ? shared / union : 0
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    if (best && bestScore >= SENTENCE_MATCH_THRESHOLD) {
      return { row, match: { status: 'edited', current_sentence: best.display } }
    }
    return { row, match: { status: 'removed' } }
  })
}

// Turn classifications into the store writes actually needed: flags are set
// when a sentence stops matching, updated when its current wording moves
// again, and cleared (back to NULL) when the sentence returns. Unchanged
// rows produce no write.
export function citationMatchUpdates(classified, checkedAt) {
  const updates = []
  for (const { row, match } of classified) {
    const previous = row?.manuscript_match || null
    if (match.status === 'current') {
      if (previous) updates.push({ id: row.id, manuscript_match: null })
      continue
    }
    const unchanged = previous
      && previous.status === match.status
      && (match.status !== 'edited' || previous.current_sentence === match.current_sentence)
    if (unchanged) continue
    updates.push({
      id: row.id,
      manuscript_match: {
        status: match.status,
        ...(match.status === 'edited' ? { current_sentence: match.current_sentence } : {}),
        checked_at: checkedAt,
      },
    })
  }
  return updates
}
