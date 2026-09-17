// lib/fullText.js — fetch the best available source text for a collected paper.
//
// Ported from Verastar's pipeline/sources.js + openaccess.js. Every endpoint is
// CORS-open, so the browser calls them directly. Preference order: PMC
// open-access full text (body prose + flattened tables, resolved live via
// idconv), falling back to the abstract for the majority of papers that are
// not open access. Verifying against the abstract is the point — analysis
// covers the whole collection, not just the OA subset — and the Unpaywall link
// gives the reader a legal path to the full paper in their own browser
// (fetching PDF bytes cross-origin is blocked; a clickable link is not).

import { getNcbiKey } from './anthropic.js'
import { openAlexByDoi } from './openAlex.js'
import { fetchPubMedPapers } from './pubmed.js'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const IDCONV = 'https://www.ncbi.nlm.nih.gov/pmc/tools/idconv/api/v1/articles'
const UNPAYWALL = 'https://api.unpaywall.org/v2'
// Unpaywall's politeness policy wants a contact email per request. Not a
// secret; a fork can point it at its own with VITE_CONTACT_EMAIL.
const CONTACT_EMAIL = import.meta.env?.VITE_CONTACT_EMAIL || 'statupfordocs@gmail.com'

function withNcbiParams(url) {
  let out = `${url}&tool=citation-verifier`
  const key = getNcbiKey()
  if (key) out += `&api_key=${encodeURIComponent(key)}`
  return out
}

// Retry with backoff — eutils rate-limits at 3 req/s without a key and a burst
// occasionally trips it.
async function withRetry(fn, { attempts = 3, delayMs = 600 } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
    }
  }
  throw lastError
}

async function getText(url) {
  return withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.text()
  })
}

async function getJson(url) {
  return withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json()
  })
}

// PMID -> PMCID via idconv. Returns e.g. "PMC11848676" or null (not in OA).
export async function pmidToPmcid(pmid) {
  const data = await getJson(`${IDCONV}/?ids=${encodeURIComponent(pmid)}&format=json`)
  return data?.records?.[0]?.pmcid ?? null
}

function nodeText(node) {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim()
}

// Flatten a JATS <table-wrap> WITH cell separators. textContent alone
// concatenates adjacent cells, merging neighbouring numbers, which makes the
// verifier false-flag values at cell boundaries. Joining cells with " | " and
// rows with newlines keeps every number boundary-delimited.
function flattenTable(tableWrap) {
  const rows = Array.from(tableWrap.querySelectorAll('tr'))
  if (rows.length === 0) return nodeText(tableWrap)
  const label = nodeText(tableWrap.querySelector('label, caption'))
  const body = rows
    .map((tr) =>
      Array.from(tr.querySelectorAll('th, td'))
        .map(nodeText)
        .filter(Boolean)
        .join(' | '),
    )
    .filter(Boolean)
    .join('\n')
  return label ? `${label}\n${body}` : body
}

// Fetch and parse a PMC OA full-text record. `text` is body prose with tables
// removed; `tables` is the flattened table cell text. No <body> means the
// article is not in the OA subset.
export async function fetchPmcFullText(pmcid) {
  const numeric = String(pmcid).replace(/^PMC/i, '')
  const xml = await getText(withNcbiParams(`${EUTILS}/efetch.fcgi?db=pmc&id=${numeric}&rettype=xml&retmode=xml`))
  const doc = new DOMParser().parseFromString(xml, 'text/xml')

  const body = doc.querySelector('body')
  if (!body) {
    return { hasBody: false, text: '', tables: '', tier: 'abstract_only' }
  }
  const tables = Array.from(body.querySelectorAll('table-wrap')).map(flattenTable).join('\n\n')
  const clone = body.cloneNode(true)
  clone.querySelectorAll('table-wrap').forEach((n) => n.remove())
  return { hasBody: true, text: nodeText(clone), tables, tier: 'full_text' }
}

// Pure: pick the best OA link out of an Unpaywall response. Prefers a direct
// PDF but keeps a landing-page-only location (some gold-OA publishers never
// expose a direct PDF URL); `isPdf` keeps the UI label honest.
export function pickOaLink(data) {
  if (!data || data.is_oa === false) return null
  const loc = data.best_oa_location
  if (!loc) return null
  if (loc.url_for_pdf) return { url: loc.url_for_pdf, isPdf: true }
  if (loc.url) return { url: loc.url, isPdf: false }
  return null
}

// Resolve a legal open-access link for a DOI via Unpaywall. Never throws —
// a missing link is normal, not an error.
export async function resolveOaLink(doi) {
  if (!doi || !CONTACT_EMAIL) return null
  try {
    const data = await getJson(`${UNPAYWALL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(CONTACT_EMAIL)}`)
    return pickOaLink(data)
  } catch {
    return null
  }
}

// An abstract shorter than this is usually not one — indexes sometimes hold a
// byline or a proceedings title in that field, and checking a sentence against
// that would wrongly read as "unsupported".
export const MIN_ABSTRACT_CHARS = 300

async function fetchPdfFullText(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Full-text request failed (${response.status}).`)
  const { extractPdfText } = await import('./pdfText.js')
  // Superscript markers matter in the manuscript, not in the cited paper.
  const text = (await extractPdfText(await response.arrayBuffer())).replace(/\^\{([^}]*)\}/g, '$1')
  return { hasBody: true, text, tables: '', tier: 'full_text' }
}

// Fetch the best source for a collected paper row ({ pmid, doi, abstract }).
// Returns { tier, text, tables, pmcid, oaUrl, oaIsPdf }. Throws only when no
// text of any kind is available (a website-only entry with no abstract).
export async function fetchPaperSource(paper) {
  let pmcid = null
  if (paper.pmid) {
    try {
      pmcid = await pmidToPmcid(paper.pmid)
    } catch {
      /* no OA mapping — abstract it is */
    }
  }

  let source = null
  if (pmcid) {
    try {
      const full = await fetchPmcFullText(pmcid)
      if (full.hasBody) source = full
    } catch {
      /* fall back to the abstract */
    }
  }

  // arXiv serves its PDFs to browsers, so a preprint is read in full with the
  // same PDF reader the manuscript upload uses.
  // Other open-access PDFs are tried too; most hosts refuse browser requests,
  // in which case the abstract is used.
  // A paper matched through Crossref arrives with no abstract and no links;
  // OpenAlex usually knows its abstract and whether a preprint copy exists.
  if (!source && !paper.pmid && !paper.arxivId && paper.doi) {
    try {
      const indexed = await openAlexByDoi(paper.doi)
      if (indexed) {
        paper = {
          ...paper,
          arxivId: indexed.arxivId,
          oaPdfUrl: paper.oaPdfUrl || indexed.oaPdfUrl,
          abstract: String(paper.abstract || '').length >= indexed.abstract.length ? paper.abstract : indexed.abstract,
        }
      }
    } catch {
      /* keep what we had */
    }
  }
  const pdfUrls = [paper.arxivId ? `https://arxiv.org/pdf/${paper.arxivId}` : null, paper.oaPdfUrl].filter(Boolean)
  for (const url of source ? [] : pdfUrls) {
    try {
      source = await fetchPdfFullText(url)
      break
    } catch {
      /* fall back to the next source */
    }
  }

  if (!source) {
    let abstract = String(paper.abstract || '').trim()
    if (!abstract && paper.pmid) {
      try {
        const [fetched] = await fetchPubMedPapers([paper.pmid])
        abstract = String(fetched?.abstract || '').trim()
      } catch {
        /* keep whatever we had */
      }
    }
    if (abstract.length < MIN_ABSTRACT_CHARS && paper.doi) {
      try {
        const indexed = String((await openAlexByDoi(paper.doi))?.abstract || '').trim()
        if (indexed.length > abstract.length) abstract = indexed
      } catch {
        /* keep whatever we had */
      }
    }
    if (abstract.length < MIN_ABSTRACT_CHARS && !paper.pmid) abstract = ''
    if (!abstract) {
      throw new Error('No text is available for this paper — it has no open-access full text and no abstract on record.')
    }
    source = { hasBody: false, text: abstract, tables: '', tier: 'abstract_only' }
  }

  const oa = await resolveOaLink(paper.doi)
  return {
    tier: source.tier,
    text: source.text,
    tables: source.tables,
    pmcid: pmcid || null,
    oaUrl: oa?.url || null,
    oaIsPdf: oa ? !!oa.isPdf : null,
  }
}
