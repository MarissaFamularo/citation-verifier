import test from 'node:test'
import assert from 'node:assert/strict'
import { mapCrossrefPaper, parseDirectPaperInput } from './directPaper.js'

test('recognizes PMID values and PubMed links', () => {
  assert.deepEqual(parseDirectPaperInput('PMID: 35840512'), { type: 'pmid', value: '35840512' })
  assert.deepEqual(
    parseDirectPaperInput('https://pubmed.ncbi.nlm.nih.gov/35840512/'),
    { type: 'pmid', value: '35840512' },
  )
})

test('recognizes DOI values and DOI links', () => {
  assert.deepEqual(parseDirectPaperInput('10.1016/j.jvs.2024.01.015'), { type: 'doi', value: '10.1016/j.jvs.2024.01.015' })
  assert.deepEqual(
    parseDirectPaperInput('https://doi.org/10.1016/j.jvs.2024.01.015'),
    { type: 'doi', value: '10.1016/j.jvs.2024.01.015' },
  )
})

test('keeps an article webpage for title confirmation', () => {
  assert.deepEqual(
    parseDirectPaperInput('https://example.org/article/vascular-access'),
    { type: 'website', value: 'https://example.org/article/vascular-access' },
  )
})

test('maps a Crossref record into a savable paper', () => {
  assert.deepEqual(mapCrossrefPaper({
    DOI: '10.1000/example',
    title: ['An example paper'],
    author: [{ given: 'Alex', family: 'Smith' }],
    'container-title': ['Example Journal'],
    published: { 'date-parts': [[2025, 4, 2]] },
    URL: 'https://doi.org/10.1000/example',
  }), {
    pmid: null,
    doi: '10.1000/example',
    title: 'An example paper',
    authors: ['Alex Smith'],
    journal: 'Example Journal',
    publicationDate: '2025-4-2',
    abstract: '',
    meshTerms: [],
    pubmedUrl: null,
    sourceUrl: 'https://doi.org/10.1000/example',
    sourceType: 'doi',
  })
})
