import assert from 'node:assert/strict'
import test from 'node:test'
import {
  annotatePapersByConceptCoverage,
  buildConceptFilterQuery,
  buildConceptSearchQuery,
  normalizeSearchConcepts,
  rankPapersByPreferredConcepts,
} from './searchConcepts.js'

const CONCEPTS = [
  {
    id: 'cabg',
    label: 'Coronary bypass',
    importance: 'required',
    mesh_terms: [{ ui: 'D001026', label: 'Coronary Artery Bypass' }],
    keywords: ['CABG', 'coronary bypass'],
  },
  {
    id: 'access',
    label: 'Dialysis access',
    importance: 'required',
    mesh_terms: [{ ui: 'D001166', label: 'Arteriovenous Shunt, Surgical' }],
    keywords: ['AV fistula', 'dialysis access'],
  },
  {
    id: 'lima',
    label: 'Internal mammary graft',
    importance: 'preferred',
    mesh_terms: [{ ui: 'D007387', label: 'Internal Mammary-Coronary Artery Anastomosis' }],
    keywords: ['LIMA', 'internal thoracic artery'],
  },
]

test('normalizes persisted concept groups', () => {
  assert.equal(normalizeSearchConcepts(CONCEPTS).length, 3)
  assert.equal(normalizeSearchConcepts([{ label: '  CABG  ', importance: 'other' }])[0].importance, 'required')
})

test('builds PubMed query from required groups only', () => {
  assert.equal(
    buildConceptSearchQuery(CONCEPTS),
    '("Coronary Artery Bypass"[MeSH Terms] OR CABG[Title/Abstract] OR "coronary bypass"[Title/Abstract]) AND ("Arteriovenous Shunt, Surgical"[MeSH Terms] OR "AV fistula"[Title/Abstract] OR "dialysis access"[Title/Abstract])',
  )
})

test('builds plain project filter query from required groups only', () => {
  assert.equal(
    buildConceptFilterQuery(CONCEPTS),
    '(Coronary Artery Bypass OR CABG OR coronary bypass) AND (Arteriovenous Shunt, Surgical OR AV fistula OR dialysis access)',
  )
})

test('prioritizes preferred concepts without excluding other papers', () => {
  const ranked = rankPapersByPreferredConcepts([
    { pmid: '1', title: 'CABG outcomes in dialysis patients' },
    { pmid: '2', title: 'LIMA graft and dialysis fistula outcomes' },
  ], CONCEPTS)

  assert.deepEqual(ranked.map((paper) => paper.pmid), ['2', '1'])
  assert.deepEqual(ranked[0].preferredMatches, ['Internal mammary graft'])
})

test('separates strong project matches from broader related papers', () => {
  const annotated = annotatePapersByConceptCoverage([
    { pmid: '1', title: 'CABG with AV fistula and LIMA graft' },
    { pmid: '2', title: 'CABG with LIMA graft' },
  ], CONCEPTS)

  assert.equal(annotated[0].projectRelationTier, 'strong')
  assert.deepEqual(annotated[0].requiredMatches, ['Coronary bypass', 'Dialysis access'])
  assert.equal(annotated[1].projectRelationTier, 'broader')
  assert.deepEqual(annotated[1].requiredMissing, ['Dialysis access'])
})

test('keeps strong matches ahead of broader papers when applying preferred ranking', () => {
  const ranked = rankPapersByPreferredConcepts([
    { pmid: '1', title: 'CABG with AV fistula', projectRelationTier: 'strong', requiredMatches: ['Coronary bypass', 'Dialysis access'] },
    { pmid: '2', title: 'LIMA graft only', projectRelationTier: 'broader', requiredMatches: [] },
  ], CONCEPTS)

  assert.deepEqual(ranked.map((paper) => paper.pmid), ['1', '2'])
})
