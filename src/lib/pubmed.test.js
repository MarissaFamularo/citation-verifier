import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPubMedSearchUrl,
  filterProjectRelatedPapers,
  MAX_PUBMED_PAGE_SIZE,
  relatedPubMedIds,
} from './pubmed.js'

test('builds an unbounded PubMed relevance search by default', () => {
  const url = new URL(buildPubMedSearchUrl({ query: 'carotid stenosis', currentYear: 2026 }))

  assert.equal(url.searchParams.get('db'), 'pubmed')
  assert.equal(url.searchParams.get('term'), 'carotid stenosis')
  assert.equal(url.searchParams.get('sort'), 'relevance')
  assert.equal(url.searchParams.get('retmax'), '25')
  assert.equal(url.searchParams.get('retstart'), '0')
  assert.equal(url.searchParams.has('mindate'), false)
})

test('applies an explicit publication-date range and clamps one page', () => {
  const url = new URL(buildPubMedSearchUrl({
    query: 'carotid revascularization',
    startYear: 1995,
    endYear: 2020,
    limit: 500,
    currentYear: 2026,
  }))

  assert.equal(url.searchParams.get('datetype'), 'pdat')
  assert.equal(url.searchParams.get('mindate'), '1995/01/01')
  assert.equal(url.searchParams.get('maxdate'), '2020/12/31')
  assert.equal(url.searchParams.get('retmax'), String(MAX_PUBMED_PAGE_SIZE))
})

test('limits a search to one or more optional journals', () => {
  const url = new URL(buildPubMedSearchUrl({
    query: 'carotid',
    journal: 'Journal of Vascular Surgery, Circulation',
    currentYear: 2026,
  }))

  assert.equal(
    url.searchParams.get('term'),
    'carotid AND ("Journal of Vascular Surgery"[Journal] OR "Circulation"[Journal])',
  )
})

test('supports paging and newest-first sorting beyond the first 50 results', () => {
  const url = new URL(buildPubMedSearchUrl({
    query: 'popliteal artery aneurysm',
    offset: 75,
    limit: 25,
    sort: 'pub_date',
    currentYear: 2026,
  }))

  assert.equal(url.searchParams.get('retstart'), '75')
  assert.equal(url.searchParams.get('retmax'), '25')
  assert.equal(url.searchParams.get('sort'), 'pub_date')
})

test('rejects an inverted publication-date range', () => {
  assert.throws(
    () => buildPubMedSearchUrl({ query: 'carotid', startYear: 2021, endYear: 2020, currentYear: 2026 }),
    /start year must be before the end year/i,
  )
})

test('selects scored PubMed neighbors and excludes the seed paper', () => {
  const ids = relatedPubMedIds({
    linksets: [{
      linksetdbs: [
        { linkname: 'pubmed_pubmed_citedin', links: [{ id: '99' }] },
        { linkname: 'pubmed_pubmed', links: [{ id: '42', score: 20 }, { id: '7', score: 10 }] },
      ],
    }],
  }, '42')

  assert.deepEqual(ids, ['7'])
})

test('filters PubMed neighbors that match only one side of the project question', () => {
  const papers = [
    { pmid: '1', title: 'In situ right internal mammary artery bypass grafting' },
    { pmid: '2', title: 'Hemodialysis access and cardiac events after bypass using an internal thoracic artery' },
    { pmid: '3', title: 'Coronary steal from an internal mammary graft by an arteriovenous fistula' },
  ]

  assert.deepEqual(
    filterProjectRelatedPapers(papers, 'AV access internal mammary artery').map((paper) => paper.pmid),
    ['2', '3'],
  )
})

test('uses structured query clauses as project relevance requirements', () => {
  const papers = [
    { pmid: '1', title: 'Endovascular repair of popliteal artery aneurysm' },
    { pmid: '2', title: 'Open repair of popliteal artery aneurysm' },
  ]

  assert.deepEqual(
    filterProjectRelatedPapers(papers, 'popliteal artery aneurysm AND (endovascular repair OR stent graft)').map((paper) => paper.pmid),
    ['1'],
  )
})

test('applies a general relevance threshold to plain project queries', () => {
  const papers = [
    { pmid: '1', title: 'Carotid artery stenosis after stenting' },
    { pmid: '2', title: 'Carotid endarterectomy outcomes' },
    { pmid: '3', title: 'Coronary stenting for acute myocardial infarction' },
  ]

  assert.deepEqual(
    filterProjectRelatedPapers(papers, 'carotid stenosis stenting').map((paper) => paper.pmid),
    ['1'],
  )
})
