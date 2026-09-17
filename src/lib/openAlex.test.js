import test from 'node:test'
import assert from 'node:assert/strict'
import { abstractFromInvertedIndex, arxivIdFrom, mapOpenAlexWork, openAlexByDoi, searchOpenAlexByTitle } from './openAlex.js'

test('arxivIdFrom reads every way a reference prints an arXiv id', () => {
  assert.equal(arxivIdFrom('Preprint at https://doi.org/10.48550/arXiv.2508.06471 (2025).'), '2508.06471')
  assert.equal(arxivIdFrom('arXiv:2601.18901v3 [cs.CL]'), '2601.18901')
  assert.equal(arxivIdFrom('https://arxiv.org/abs/1706.03762'), '1706.03762')
  assert.equal(arxivIdFrom('arXiv:hep-th/9901001'), 'hep-th/9901001')
  assert.equal(arxivIdFrom('Nat. Med. 30, 2613–2622 (2024).'), null)
})

test('abstractFromInvertedIndex rebuilds the abstract in order', () => {
  assert.equal(abstractFromInvertedIndex({ models: [2], Large: [0], language: [1], hallucinate: [3] }), 'Large language models hallucinate')
  assert.equal(abstractFromInvertedIndex(null), '')
})

test('mapOpenAlexWork recognises an arXiv paper and keeps a PMID when there is one', () => {
  const paper = mapOpenAlexWork({
    title: 'GLM-4.5', doi: 'https://doi.org/10.48550/arxiv.2508.06471', publication_year: 2025,
    primary_location: { landing_page_url: 'http://arxiv.org/abs/2508.06471', source: { display_name: 'arXiv' } },
    abstract_inverted_index: { We: [0], present: [1] },
  })
  assert.deepEqual([paper.arxivId, paper.sourceType, paper.sourceUrl, paper.abstract], ['2508.06471', 'arxiv', 'https://arxiv.org/abs/2508.06471', 'We present'])
  assert.equal(mapOpenAlexWork({ title: 'T', ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/123' } }).pmid, '123')
  assert.equal(mapOpenAlexWork({}), null)
})

test('lookups treat 404 as not found and strip query syntax from titles', async () => {
  assert.equal(await openAlexByDoi('10.1/x', { fetchImpl: async () => ({ status: 404, ok: false }) }), null)
  let asked = ''
  const fetchImpl = async (url) => { asked = url; return { status: 200, ok: true, json: async () => ({ results: [{ title: 'Self-consistency improves reasoning' }] }) } }
  const papers = await searchOpenAlexByTitle('Self-consistency improves chain-of-thought reasoning, in: LLMs', { fetchImpl })
  assert.equal(papers[0].title, 'Self-consistency improves reasoning')
  assert.ok(!decodeURIComponent(asked.split('title.search:')[1].split('&')[0]).includes(','))
})
