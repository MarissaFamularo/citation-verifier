import { getNcbiKey } from './anthropic.js'
import { annotatePapersByConceptCoverage, normalizeSearchConcepts } from './searchConcepts.js'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

export const PUBMED_PAGE_SIZE = 25
export const MAX_PUBMED_PAGE_SIZE = 100
export const MAX_PUBMED_WINDOW = 10000

const PROJECT_CONCEPT_RULES = [
  {
    trigger: /\b(?:AV access|arteriovenous (?:access|fistula|shunt)|vascular access|(?:hemo)?dialysis (?:access|fistula|shunt))\b/i,
    matches: /\b(?:AV access|arteriovenous (?:access|fistula|shunt)|vascular access|(?:hemo)?dialysis (?:access|fistula|shunt)|arteriovenous hemodialysis (?:fistula|shunt))\b/i,
  },
  {
    trigger: /\b(?:internal mammary|internal thoracic|LIMA|IMA)\b/i,
    matches: /\b(?:internal mammary|internal thoracic|LIMA|IMA)\b/i,
  },
]

const QUERY_STOP_WORDS = new Set(['and', 'or', 'not', 'the', 'with', 'from', 'into', 'after', 'before'])

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function journalClause(value) {
  const journals = compact(value)
    .split(',')
    .map((journal) => compact(journal).replace(/"/g, ''))
    .filter(Boolean)
  if (!journals.length) return ''
  return journals.map((journal) => `"${journal}"[Journal]`).join(' OR ')
}

function paperSearchText(paper = {}) {
  return compact([
    paper.title,
    paper.abstract,
    ...(paper.meshTerms || []).map((term) => term?.label),
  ].filter(Boolean).join(' '))
}

function phraseMatches(text, phrase) {
  const terms = queryTerms(phrase)
  return terms.length > 0 && terms.every((term) => text.includes(term))
}

function queryTerms(value) {
  return compact(value)
    .toLowerCase()
    .replace(/[()"]/g, ' ')
    .replace(/\[/g, ' ')
    .replace(/\]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 2 && !QUERY_STOP_WORDS.has(term))
}

function queryConceptMatchers(projectQuery) {
  const query = compact(projectQuery)
  const structuredClauses = query.split(/\s+AND\s+/i).map(compact).filter(Boolean)
  if (structuredClauses.length > 1) {
    return structuredClauses.map((clause) => {
      const alternatives = clause.replace(/^\(|\)$/g, '').split(/\s+OR\s+/i).map(compact).filter(Boolean)
      return (text) => alternatives.some((alternative) => phraseMatches(text, alternative))
    })
  }

  return PROJECT_CONCEPT_RULES
    .filter((rule) => rule.trigger.test(query))
    .map((rule) => (text) => rule.matches.test(text))
}

export function filterProjectRelatedPapers(papers = [], projectQuery = '') {
  const matchers = queryConceptMatchers(projectQuery)
  if (matchers.length < 2) {
    const terms = [...new Set(queryTerms(projectQuery))]
    if (terms.length < 2) return papers
    const minimumMatches = Math.max(2, Math.ceil(terms.length * 0.6))
    return papers.filter((paper) => {
      const text = paperSearchText(paper).toLowerCase()
      return terms.filter((term) => text.includes(term)).length >= minimumMatches
    })
  }
  return papers.filter((paper) => {
    const text = paperSearchText(paper).toLowerCase()
    return matchers.every((matches) => matches(text))
  })
}

function articleDoi(articleIds = []) {
  return articleIds.find((item) => item?.idtype === 'doi')?.value || null
}

function parseArticleDetails(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (xml.querySelector('parsererror')) throw new Error('PubMed returned an unreadable abstract response.')

  const details = new Map()
  xml.querySelectorAll('PubmedArticle').forEach((article) => {
    const pmid = compact(article.querySelector('PMID')?.textContent)
    const sections = [...article.querySelectorAll('AbstractText')]
      .map((node) => {
        const text = compact(node.textContent)
        const label = compact(node.getAttribute('Label'))
        return text ? `${label ? `${label}: ` : ''}${text}` : ''
      })
      .filter(Boolean)
    const meshByUi = new Map()
    article.querySelectorAll('MeshHeading').forEach((heading) => {
      const descriptor = heading.querySelector('DescriptorName')
      const label = compact(descriptor?.textContent)
      const ui = compact(descriptor?.getAttribute('UI'))
      if (!label) return
      const term = {
        label,
        ui: ui || null,
        majorTopic: descriptor?.getAttribute('MajorTopicYN') === 'Y',
      }
      const key = ui || label.toLowerCase()
      const existing = meshByUi.get(key)
      if (!existing || term.majorTopic) meshByUi.set(key, term)
    })
    const meshTerms = [...meshByUi.values()].sort((left, right) => {
      if (left.majorTopic !== right.majorTopic) return left.majorTopic ? -1 : 1
      return left.label.localeCompare(right.label)
    })
    if (pmid) details.set(pmid, { abstract: sections.join('\n\n'), meshTerms })
  })
  return details
}

// Single fetch choke point for eutils: the optional NCBI API key (3 -> 10
// req/s) is appended here so every PubMed call in the app benefits without the
// pure URL builders knowing about credentials.
async function fetchOk(url, options = {}) {
  const key = getNcbiKey()
  const keyed = key && url.startsWith(EUTILS) ? `${url}&api_key=${encodeURIComponent(key)}` : url
  const response = await fetch(keyed, options)
  if (!response.ok) throw new Error(`PubMed request failed (${response.status}).`)
  return response
}

export function buildPubMedSearchUrl({
  query,
  startYear,
  endYear,
  journal,
  limit = PUBMED_PAGE_SIZE,
  offset = 0,
  sort = 'relevance',
  currentYear = new Date().getFullYear(),
} = {}) {
  const baseTerm = compact(query)
  if (!baseTerm) throw new Error('Describe what you want to find.')
  const journalSearch = journalClause(journal)
  const term = journalSearch ? `${baseTerm} AND (${journalSearch})` : baseTerm

  const firstYear = startYear ? Number(startYear) : null
  const lastYear = endYear ? Number(endYear) : null
  if (firstYear && (firstYear < 1800 || firstYear > currentYear)) throw new Error('Choose a valid start year.')
  if (lastYear && (lastYear < 1800 || lastYear > currentYear)) throw new Error('Choose a valid end year.')
  if (firstYear && lastYear && firstYear > lastYear) throw new Error('The start year must be before the end year.')

  const resultOffset = Math.max(Number(offset) || 0, 0)
  if (resultOffset >= MAX_PUBMED_WINDOW) throw new Error('Refine this search to continue beyond 10,000 PubMed results.')
  const pageSize = Math.min(
    Math.max(Number(limit) || PUBMED_PAGE_SIZE, 1),
    MAX_PUBMED_PAGE_SIZE,
    MAX_PUBMED_WINDOW - resultOffset,
  )

  const search = new URLSearchParams({
    db: 'pubmed',
    retmode: 'json',
    retmax: String(pageSize),
    retstart: String(resultOffset),
    sort: sort === 'pub_date' ? 'pub_date' : 'relevance',
    term,
    tool: 'citation-verifier',
  })
  if (firstYear || lastYear) {
    search.set('datetype', 'pdat')
    search.set('mindate', `${firstYear || 1800}/01/01`)
    search.set('maxdate', `${lastYear || currentYear}/12/31`)
  }

  return `${EUTILS}/esearch.fcgi?${search}`
}

export function relatedPubMedIds(linkJson, seedPmid) {
  const linkSets = linkJson?.linksets || []
  const related = linkSets
    .flatMap((linkSet) => linkSet?.linksetdbs || [])
    .find((linkSet) => linkSet?.linkname === 'pubmed_pubmed')
  return (related?.links || [])
    .map((link) => compact(link?.id))
    .filter((pmid) => pmid && pmid !== String(seedPmid))
}

export async function fetchPubMedPapers(ids, { signal } = {}) {
  if (!ids.length) return []

  const idsParam = ids.join(',')
  const common = `db=pubmed&id=${encodeURIComponent(idsParam)}&tool=citation-verifier`
  const [summaryResponse, abstractResponse] = await Promise.all([
    fetchOk(`${EUTILS}/esummary.fcgi?${common}&retmode=json`, { signal }),
    fetchOk(`${EUTILS}/efetch.fcgi?${common}&rettype=abstract&retmode=xml`, { signal }),
  ])
  const [summaryJson, abstractXml] = await Promise.all([
    summaryResponse.json(),
    abstractResponse.text(),
  ])
  const details = parseArticleDetails(abstractXml)

  return ids
    .map((pmid) => {
      const item = summaryJson?.result?.[pmid]
      if (!item?.title) return null
      const publicationDate = compact(item.pubdate || item.sortpubdate)
      const articleDetails = details.get(pmid) || {}
      return {
        pmid,
        doi: articleDoi(item.articleids),
        title: compact(item.title),
        authors: (item.authors || []).map((author) => compact(author?.name)).filter(Boolean),
        journal: compact(item.fulljournalname || item.source),
        publicationDate,
        abstract: articleDetails.abstract || '',
        meshTerms: articleDetails.meshTerms || [],
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      }
    })
    .filter(Boolean)
}

export async function searchPubMed({
  query,
  startYear,
  endYear,
  journal,
  limit = PUBMED_PAGE_SIZE,
  offset = 0,
  sort = 'relevance',
  signal,
} = {}) {
  const searchUrl = buildPubMedSearchUrl({ query, startYear, endYear, journal, limit, offset, sort })

  const searchResponse = await fetchOk(searchUrl, { signal })
  const searchJson = await searchResponse.json()
  const searchResult = searchJson?.esearchresult || {}
  const ids = searchResult.idlist || []
  const total = Number(searchResult.count) || 0
  const translatedQuery = compact(searchResult.querytranslation)
  if (!ids.length) {
    return {
      papers: [],
      total,
      translatedQuery,
      hasMore: false,
    }
  }
  const papers = await fetchPubMedPapers(ids, { signal })

  const nextOffset = Math.max(Number(offset) || 0, 0) + ids.length
  return {
    papers,
    total,
    translatedQuery,
    hasMore: nextOffset < Math.min(total, MAX_PUBMED_WINDOW),
  }
}

export async function findRelatedPubMed({ pmid, projectQuery, projectConcepts, limit = PUBMED_PAGE_SIZE, signal } = {}) {
  const seedPmid = compact(pmid)
  if (!/^\d+$/.test(seedPmid)) throw new Error('Choose a valid PubMed paper to find similar articles.')

  const search = new URLSearchParams({
    dbfrom: 'pubmed',
    db: 'pubmed',
    id: seedPmid,
    cmd: 'neighbor_score',
    retmode: 'json',
    tool: 'citation-verifier',
  })
  const response = await fetchOk(`${EUTILS}/elink.fcgi?${search}`, { signal })
  const linkJson = await response.json()
  const relatedIds = relatedPubMedIds(linkJson, seedPmid)
  const pageSize = Math.min(Math.max(Number(limit) || PUBMED_PAGE_SIZE, 1), MAX_PUBMED_PAGE_SIZE)
  const candidateLimit = Math.min(Math.max(pageSize * 4, 50), MAX_PUBMED_PAGE_SIZE)
  const candidates = await fetchPubMedPapers(relatedIds.slice(0, candidateLimit), { signal })
  const concepts = normalizeSearchConcepts(projectConcepts)
  const annotated = concepts.length > 0
    ? annotatePapersByConceptCoverage(candidates, concepts)
    : (() => {
        const strongPmids = new Set(filterProjectRelatedPapers(candidates, projectQuery).map((paper) => paper.pmid))
        return candidates.map((paper) => ({
          ...paper,
          projectRelationTier: strongPmids.has(paper.pmid) ? 'strong' : 'broader',
          requiredMatches: [],
          requiredMissing: [],
          preferredMatches: [],
        }))
      })()
  const strong = annotated.filter((paper) => paper.projectRelationTier === 'strong')
  const broader = annotated
    .map((paper, index) => ({ paper, index }))
    .filter(({ paper }) => paper.projectRelationTier === 'broader')
    .sort((left, right) => (
      (right.paper.requiredMatches?.length || 0) - (left.paper.requiredMatches?.length || 0)
      || left.index - right.index
    ))
    .map(({ paper }) => paper)
  const papers = [
    ...strong.slice(0, pageSize),
    ...broader.slice(0, pageSize),
  ]

  return {
    papers,
    total: candidates.length,
    strongTotal: strong.length,
    broaderTotal: broader.length,
    candidateTotal: relatedIds.length,
    reviewedCandidates: candidates.length,
    translatedQuery: '',
    hasMore: false,
  }
}
