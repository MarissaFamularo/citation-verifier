// lib/pipeline.js — manuscript in, review rows out; then one row checked at a time.
//
// Code does everything detectable (file read, reference split, marker
// matching, PubMed lookup, source fetch). Claude is asked only to transcribe
// references that print no DOI/PMID and to propose a supporting quote, which
// the app then proves. Jev scores the sentence against that passage.

import { hasApiKey } from './anthropic.js'
import { fetchPaperSource } from './fullText.js'
import { checkCitationSupport } from './manuscriptCitations.js'
import {
  extractManuscriptCitations,
  gatherManuscriptReferences,
  manuscriptNeedsModel,
  splitManuscript,
} from './manuscriptImport.js'
import { resolveReferences } from './referenceImport.js'
import { buildRows } from './review.js'
import { hasTypesafeKey, scoreCitationSupport } from './typesafe.js'

export async function importManuscript(text, { onPhase, onProgress, signal } = {}) {
  const { body, referenceText } = splitManuscript(text)
  if (manuscriptNeedsModel(referenceText) && !hasApiKey()) {
    throw new Error('Some references print no DOI or PMID, so reading them needs Claude — add an Anthropic API key first.')
  }
  onPhase?.('references')
  const { references } = await gatherManuscriptReferences(referenceText)
  const { byNumber, styleUsed, linkedSentences } = extractManuscriptCitations(body, references)
  onPhase?.('resolving')
  const results = await resolveReferences(references, { onProgress, signal })
  return { rows: buildRows(references, byNumber, results), styleUsed, linkedSentences, referenceCount: references.length }
}

// Sources are fetched once per paper and shared by every sentence citing it.
export function createSourceCache() {
  const cache = new Map()
  return (paper) => {
    const key = paper.pmid || paper.doi || paper.title
    if (!cache.has(key)) cache.set(key, fetchPaperSource(paper).catch((err) => { cache.delete(key); throw err }))
    return cache.get(key)
  }
}

// Check one row. Returns the updated row; the human review field is untouched.
// The fetched source stays in the cache, not the row, so review files stay small.
export async function checkRow(row, { getSource, signal } = {}) {
  if (!row.sentence) return row
  if (!row.paper) return { ...row, error: 'This reference could not be matched to a paper, so there is nothing to check it against.' }
  try {
    const source = await getSource(row.paper)
    const claude = hasApiKey() ? await checkCitationSupport({ sentence: row.sentence, source }) : null
    const jev = hasTypesafeKey()
      ? await scoreCitationSupport({ sentence: row.sentence, source, quote: claude?.quote || null, signal })
      : null
    return { ...row, sourceTier: source.tier, claude, jev, error: null }
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return { ...row, error: err?.message || 'The check failed.' }
  }
}
