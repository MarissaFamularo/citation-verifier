function clean(value, maxLength = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function uniqueStrings(values, maxItems = 20) {
  const seen = new Set()
  return values
    .map((value) => clean(value, 160))
    .filter((value) => {
      const key = value.toLowerCase()
      if (!value || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, maxItems)
}

export function normalizeSearchConcepts(concepts = []) {
  if (!Array.isArray(concepts)) return []
  return concepts
    .map((concept, index) => {
      const label = clean(concept?.label, 120)
      if (!label) return null
      const meshTerms = Array.isArray(concept?.mesh_terms)
        ? concept.mesh_terms
            .map((term) => ({
              ui: clean(term?.ui, 32) || null,
              label: clean(term?.label, 160),
            }))
            .filter((term) => term.label)
            .slice(0, 12)
        : []
      return {
        id: clean(concept?.id, 80) || 'concept-' + (index + 1),
        label,
        importance: concept?.importance === 'preferred' ? 'preferred' : 'required',
        mesh_terms: meshTerms,
        keywords: uniqueStrings(Array.isArray(concept?.keywords) ? concept.keywords : []),
      }
    })
    .filter(Boolean)
    .slice(0, 12)
}

function taggedPhrase(value, field) {
  const cleaned = clean(value, 160).replace(/"/g, '')
  if (!cleaned) return ''
  const term = /\s/.test(cleaned) ? '"' + cleaned + '"' : cleaned
  return term + '[' + field + ']'
}

function conceptTerms(concept, formatter) {
  const terms = [
    ...(concept.mesh_terms || []).map((term) => formatter(term.label, 'MeSH Terms')),
    ...(concept.keywords || []).map((keyword) => formatter(keyword, 'Title/Abstract')),
  ].filter(Boolean)
  return uniqueStrings(terms)
}

export function buildConceptSearchQuery(concepts = []) {
  return normalizeSearchConcepts(concepts)
    .filter((concept) => concept.importance === 'required')
    .map((concept) => {
      const terms = conceptTerms(concept, taggedPhrase)
      if (!terms.length) return ''
      return terms.length === 1 ? terms[0] : '(' + terms.join(' OR ') + ')'
    })
    .filter(Boolean)
    .join(' AND ')
}

export function buildConceptFilterQuery(concepts = []) {
  return normalizeSearchConcepts(concepts)
    .filter((concept) => concept.importance === 'required')
    .map((concept) => {
      const terms = uniqueStrings([
        ...(concept.mesh_terms || []).map((term) => term.label),
        ...(concept.keywords || []),
      ])
      if (!terms.length) return ''
      return terms.length === 1 ? terms[0] : '(' + terms.join(' OR ') + ')'
    })
    .filter(Boolean)
    .join(' AND ')
}

function paperText(paper = {}) {
  return clean([
    paper.title,
    paper.abstract,
    ...(paper.meshTerms || []).map((term) => term?.label),
  ].filter(Boolean).join(' '), 50000).toLowerCase()
}

function phraseAppears(text, value) {
  const words = clean(value, 160)
    .toLowerCase()
    .replace(/[()[\]"]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1)
  return words.length > 0 && words.every((word) => text.includes(word))
}

function conceptAppears(text, concept) {
  return [
    ...(concept.mesh_terms || []).map((term) => term.label),
    ...(concept.keywords || []),
  ].some((term) => phraseAppears(text, term))
}

export function annotatePapersByConceptCoverage(papers = [], concepts = []) {
  const normalized = normalizeSearchConcepts(concepts)
  const required = normalized.filter((concept) => concept.importance === 'required')
  const preferred = normalized.filter((concept) => concept.importance === 'preferred')

  return papers.map((paper) => {
    const text = paperText(paper)
    const requiredMatches = uniqueStrings(required.filter((concept) => conceptAppears(text, concept)).map((concept) => concept.label))
    const requiredMissing = uniqueStrings(required.filter((concept) => !conceptAppears(text, concept)).map((concept) => concept.label))
    const preferredMatches = uniqueStrings(preferred.filter((concept) => conceptAppears(text, concept)).map((concept) => concept.label))
    return {
      ...paper,
      projectRelationTier: requiredMissing.length > 0 ? 'broader' : 'strong',
      requiredMatches,
      requiredMissing,
      preferredMatches,
    }
  })
}

export function rankPapersByPreferredConcepts(papers = [], concepts = []) {
  const preferred = normalizeSearchConcepts(concepts).filter((concept) => concept.importance === 'preferred')
  if (!preferred.length) return papers

  return papers
    .map((paper, index) => {
      const text = paperText(paper)
      const preferredMatches = uniqueStrings(preferred.filter((concept) => conceptAppears(text, concept)).map((concept) => concept.label))
      return {
        paper: { ...paper, preferredMatches },
        index,
        preferredScore: preferredMatches.length,
        requiredScore: paper.requiredMatches?.length || 0,
        relationTier: paper.projectRelationTier === 'broader' ? 1 : 0,
      }
    })
    .sort((left, right) => (
      left.relationTier - right.relationTier
      || right.requiredScore - left.requiredScore
      || right.preferredScore - left.preferredScore
      || left.index - right.index
    ))
    .map(({ paper }) => paper)
}

export function searchConceptSnapshot(concepts = []) {
  return normalizeSearchConcepts(concepts).map((concept) => ({
    label: concept.label,
    importance: concept.importance,
    mesh_terms: concept.mesh_terms,
    keywords: concept.keywords,
  }))
}
