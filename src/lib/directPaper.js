import { ncbiFetch } from './ncbiThrottle.js'
import { fetchPubMedPapers } from './pubmed.js'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const CROSSREF = 'https://api.crossref.org/works'

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function cleanDoi(value) {
  return compact(value)
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/[).,;]+$/, '')
}

export function parseDirectPaperInput(value) {
  const input = compact(value)
  if (!input) throw new Error('Enter a PMID, DOI, or article webpage.')

  const pubmedMatch = input.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)
  if (pubmedMatch) return { type: 'pmid', value: pubmedMatch[1] }

  const pmidMatch = input.match(/^PMID\s*:?\s*(\d+)$/i) || input.match(/^(\d+)$/)
  if (pmidMatch) return { type: 'pmid', value: pmidMatch[1] }

  const doiMatch = input.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[^\s?#]+)/i)
  if (doiMatch) return { type: 'doi', value: cleanDoi(doiMatch[1]) }

  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    return { type: 'website', value: url.toString() }
  } catch {
    throw new Error('Enter a valid PMID, DOI, PubMed link, DOI link, or article webpage.')
  }
}

function crossrefDate(message = {}) {
  const parts = message.published?.['date-parts']?.[0]
    || message['published-print']?.['date-parts']?.[0]
    || message['published-online']?.['date-parts']?.[0]
  return Array.isArray(parts) ? parts.filter(Boolean).join('-') : ''
}

export function mapCrossrefPaper(message = {}) {
  const doi = cleanDoi(message.DOI)
  const title = compact(message.title?.[0])
  if (!doi || !title) throw new Error('Crossref did not return enough citation details for this DOI.')
  return {
    pmid: null,
    doi,
    title,
    authors: (message.author || []).map((author) => compact([author.given, author.family].filter(Boolean).join(' '))).filter(Boolean),
    journal: compact(message['container-title']?.[0]),
    publicationDate: crossrefDate(message),
    abstract: '',
    meshTerms: [],
    pubmedUrl: null,
    sourceUrl: compact(message.URL) || `https://doi.org/${doi}`,
    sourceType: 'doi',
  }
}

async function pubMedPaperByDoi(doi, { signal } = {}) {
  const search = new URLSearchParams({
    db: 'pubmed',
    retmode: 'json',
    retmax: '1',
    term: `${doi}[AID]`,
    tool: 'citation-verifier',
  })
  const response = await ncbiFetch(`${EUTILS}/esearch.fcgi?${search}`, { signal })
  if (!response.ok) throw new Error(`PubMed request failed (${response.status}).`)
  const json = await response.json()
  const pmid = json?.esearchresult?.idlist?.[0]
  if (!pmid) return null
  const [paper] = await fetchPubMedPapers([pmid], { signal })
  return paper || null
}

async function crossrefPaperByDoi(doi, { signal } = {}) {
  const response = await fetch(`${CROSSREF}/${encodeURIComponent(doi)}`, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Crossref request failed (${response.status}).`)
  const json = await response.json()
  return mapCrossrefPaper(json?.message)
}

export async function resolveDirectPaper(value, { signal } = {}) {
  const identifier = parseDirectPaperInput(value)
  if (identifier.type === 'website') {
    return { inputType: 'website', sourceUrl: identifier.value, needsTitle: true }
  }

  if (identifier.type === 'pmid') {
    const [paper] = await fetchPubMedPapers([identifier.value], { signal })
    if (!paper) throw new Error('No PubMed paper was found for that PMID.')
    return {
      inputType: 'pmid',
      paper: { ...paper, sourceUrl: paper.pubmedUrl, sourceType: 'pubmed' },
    }
  }

  const pubmedPaper = await pubMedPaperByDoi(identifier.value, { signal })
  if (pubmedPaper) {
    return {
      inputType: 'doi',
      paper: { ...pubmedPaper, sourceUrl: pubmedPaper.pubmedUrl, sourceType: 'pubmed' },
    }
  }
  const crossrefPaper = await crossrefPaperByDoi(identifier.value, { signal })
  if (!crossrefPaper) throw new Error('No paper was found for that DOI.')
  return { inputType: 'doi', paper: crossrefPaper }
}
