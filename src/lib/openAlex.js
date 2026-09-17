// lib/openAlex.js — the second place a reference is looked up, after PubMed.
//
// OpenAlex indexes almost all scholarly work — arXiv and other preprints,
// conference papers, engineering and computer-science journals — with
// abstracts, and answers browser requests without a key. arXiv's own search
// API does not allow browser requests, but its PDFs do, so an arXiv paper is
// matched through OpenAlex and read in full from arxiv.org.

const OPENALEX = 'https://api.openalex.org/works'
const SELECT = 'id,doi,title,publication_year,publication_date,authorships,primary_location,best_oa_location,locations,abstract_inverted_index,ids'
const CONTACT_EMAIL = import.meta.env?.VITE_CONTACT_EMAIL || 'statupfordocs@gmail.com'

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

// "arXiv:2508.06471", "arxiv.org/abs/2508.06471v2", "10.48550/arXiv.2508.06471",
// and the pre-2007 form "hep-th/9901001". The version suffix is dropped.
export function arxivIdFrom(text) {
  const source = String(text ?? '')
  const modern = source.match(/arxiv(?:\.org\/(?:abs|pdf)\/|[.:]\s*)(\d{4}\.\d{4,5})(?:v\d+)?/i)
  if (modern) return modern[1]
  const legacy = source.match(/arxiv(?:\.org\/(?:abs|pdf)\/|[.:]\s*)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i)
  return legacy ? legacy[1] : null
}

export function arxivDoi(arxivId) {
  return `10.48550/arXiv.${arxivId}`
}

// OpenAlex stores abstracts as { word: [positions] }.
export function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== 'object') return ''
  const words = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions || []) words[position] = word
  }
  return compact(words.filter((word) => word != null).join(' '))
}

export function mapOpenAlexWork(work = {}) {
  const title = compact(work.title)
  if (!title) return null
  const doi = compact(work.doi).replace(/^https?:\/\/doi\.org\//i, '') || null
  const locations = [work.primary_location, work.best_oa_location, ...(work.locations || [])].filter(Boolean)
  const arxivId = arxivIdFrom(doi) || locations.map((location) => arxivIdFrom(location.landing_page_url) || arxivIdFrom(location.pdf_url)).find(Boolean) || null
  const pmid = compact(work.ids?.pmid).replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, '').replace(/\/$/, '') || null
  return {
    pmid,
    doi,
    arxivId,
    title,
    authors: (work.authorships || []).slice(0, 12).map((entry) => compact(entry?.author?.display_name)).filter(Boolean),
    journal: compact(work.primary_location?.source?.display_name),
    publicationDate: compact(work.publication_date) || String(work.publication_year || ''),
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    meshTerms: [],
    pubmedUrl: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
    sourceUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : compact(work.primary_location?.landing_page_url) || (doi ? `https://doi.org/${doi}` : compact(work.id)),
    sourceType: arxivId ? 'arxiv' : 'openalex',
    oaPdfUrl: locations.map((location) => compact(location.pdf_url)).find((url) => /^https:\/\//.test(url)) || null,
  }
}

async function getJson(url, { signal, fetchImpl = fetch } = {}) {
  const joiner = url.includes('?') ? '&' : '?'
  const response = await fetchImpl(`${url}${joiner}mailto=${encodeURIComponent(CONTACT_EMAIL)}`, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`OpenAlex request failed (${response.status}).`)
  return response.json()
}

export async function openAlexByDoi(doi, options) {
  const work = await getJson(`${OPENALEX}/doi:${encodeURIComponent(doi)}?select=${SELECT}`, options)
  return work ? mapOpenAlexWork(work) : null
}

// Commas and colons are query syntax to OpenAlex; a title search wants words.
export async function searchOpenAlexByTitle(title, options) {
  const query = compact(String(title ?? '').replace(/[^\p{L}\p{N}\s-]/gu, ' '))
  if (!query) return []
  const data = await getJson(`${OPENALEX}?filter=title.search:${encodeURIComponent(query)}&per-page=5&select=${SELECT}`, options)
  return (data?.results || []).map(mapOpenAlexWork).filter(Boolean)
}
