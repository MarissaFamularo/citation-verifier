// Regression: reference 2 of an Annals of Vascular Surgery pre-proof —
// "Schanzer A, Simons JP, … Outcomes of fenestrated and branched endovascular
// repair of complex abdominal and thoracoabdominal aortic aneurysms. J Vasc
// Surg. 2017;66(3):687-694." — was attached to Timaran CH et al. 2021
// ("Expanded Use of Preloaded Branched and Fenestrated Endografts…").
//
// The transcription was right. Candidate selection was not: PubMed's
// author-constrained title search returned recent papers the same group
// co-authored, the real 2017 paper was below the five candidates read, and the
// best stranger (title similarity 0.69) was accepted as a "check" although its
// first author and year contradicted the citation.
//
// PubMed is stubbed: each query gets the result list it returned live on
// 2026-10-09, in the same order, so the test pins the selection logic, not
// PubMed's ranking.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTitleQueries,
  firstAuthorAgreement,
  matchConflicts,
  printedFirstAuthor,
  printedYear,
  resolveReference,
  scoreMatch,
} from './referenceImport.js'
import { resetNcbiThrottle } from './ncbiThrottle.js'

const RAW = 'Schanzer A, Simons JP, Flahive J, Durgin J, Aiello FA, Doucet D, et al. Outcomes of fenestrated and branched endovascular repair of complex abdominal and thoracoabdominal aortic aneurysms. J Vasc Surg. 2017;66(3):687-694.'
const TITLE = 'Outcomes of fenestrated and branched endovascular repair of complex abdominal and thoracoabdominal aortic aneurysms'
const TRANSCRIBED = { number: 2, raw: RAW, title: TITLE, firstAuthor: 'Schanzer', journal: 'J Vasc Surg', year: 2017, pmid: null, doi: null }

const PAPERS = {
  28259577: { title: `${TITLE}.`, pubdate: '2017 Sep', authors: ['Schanzer A', 'Simons JP', 'Flahive J'] },
  33262091: { title: 'Expanded Use of Preloaded Branched and Fenestrated Endografts for Endovascular Repair of Complex Aortic Aneurysms.', pubdate: '2021 Feb', authors: ['Timaran CH', 'Oderich GS', 'Tenorio ER'] },
  37051912: { title: 'Mid-term Renal and Mesenteric Artery Outcomes During Fenestrated and Branched Endovascular Aortic Repair.', pubdate: '2023 Oct 1', authors: ['Tenorio ER', 'Oderich GS', 'Schanzer A'] },
  36257344: { title: 'Comparison of upper extremity and transfemoral access for fenestrated-branched endovascular aortic repair.', pubdate: '2023 Mar', authors: ['Chamseddin K', 'Timaran CH', 'Schanzer A'] },
  36889609: { title: 'Characterization and management of type II and complex endoleaks after fenestrated-branched endovascular aortic repair.', pubdate: '2023 Jul', authors: ['Marecki HL', 'Schanzer A'] },
  39098559: { title: 'Outcomes using inverted iliac limb bifurcate components in fenestrated-branched endovascular aortic repair.', pubdate: '2024 Dec', authors: ['Khoury MK', 'Schanzer A'] },
  40814684: { title: 'Outcomes of fenestrated-branched endovascular aortic repair of thoracoabdominal aortic aneurysms.', pubdate: '2025 Aug', authors: ['Ribé L', 'Garcia M'] },
}
// The author-only query, as PubMed ranked it: the 2017 paper is not in the top five.
const AUTHOR_ONLY_RESULTS = ['37051912', '36257344', '36889609', '33262091', '39098559']

function stubBrowser() {
  const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} })
  globalThis.sessionStorage ??= store()
  globalThis.localStorage ??= store()
  globalThis.DOMParser ??= class {
    parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] } }
  }
}

// searchFor(term) -> list of PMIDs PubMed returns for that query.
function stubPubMed(t, searchFor) {
  stubBrowser()
  resetNcbiThrottle()
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const queries = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('esearch.fcgi')) {
      const term = url.searchParams.get('term')
      queries.push(term)
      const ids = searchFor(term)
      return Response.json({ esearchresult: { idlist: ids, count: String(ids.length), querytranslation: term } })
    }
    if (url.pathname.endsWith('esummary.fcgi')) {
      const ids = url.searchParams.get('id').split(',')
      const result = Object.fromEntries(ids.map((id) => [id, { uid: id, ...PAPERS[id], authors: (PAPERS[id]?.authors || []).map((name) => ({ name })) }]))
      return Response.json({ result: { uids: ids, ...result } })
    }
    if (url.pathname.endsWith('efetch.fcgi')) return new Response('<PubmedArticleSet></PubmedArticleSet>')
    if (url.hostname.includes('openalex')) return Response.json({ results: [] })
    throw new Error(`unexpected request ${url}`)
  }
  return queries
}

// --- the scorer ----------------------------------------------------------------

test('a near-identical title from another first author and year is rejected, not cautioned', () => {
  const timaran = { title: PAPERS[33262091].title, publicationDate: '2021 Feb', authors: PAPERS[33262091].authors }
  assert.equal(scoreMatch(TRANSCRIBED, timaran), 'reject')
  assert.deepEqual(matchConflicts(TRANSCRIBED, timaran), ['first author Timaran CH, not Schanzer', 'published 2021, not 2017'])
  const schanzer = { title: PAPERS[28259577].title, publicationDate: '2017 Sep', authors: PAPERS[28259577].authors }
  assert.equal(scoreMatch(TRANSCRIBED, schanzer), 'match')
})

test('either conflict alone is enough to reject', () => {
  const sameTitle = PAPERS[28259577].title
  assert.equal(scoreMatch(TRANSCRIBED, { title: sameTitle, publicationDate: '2017', authors: ['Timaran CH'] }), 'reject')
  assert.equal(scoreMatch(TRANSCRIBED, { title: sameTitle, publicationDate: '2021', authors: ['Schanzer A'] }), 'reject')
  // Print-vs-epub drift of one year is not a conflict.
  assert.equal(scoreMatch(TRANSCRIBED, { title: sameTitle, publicationDate: '2016 Dec', authors: ['Schanzer A'] }), 'match')
})

test('a loose title needs the author or year to agree; with nothing agreeing it stays unresolved', () => {
  const loose = { title: 'Outcomes of fenestrated and branched repair in a regional series', publicationDate: '2017', authors: ['Schanzer A'] }
  assert.equal(scoreMatch(TRANSCRIBED, loose), 'check')
  assert.equal(scoreMatch({ ...TRANSCRIBED, firstAuthor: null, year: null, raw: 'Outcomes of fenestrated and branched endovascular repair.' }, { ...loose, authors: [] }), 'reject')
})

test('the identifier path applies the same conflicts: a misprinted PMID for a real-looking paper is refused', () => {
  const reference = { raw: RAW, title: null, pmid: '33262091', doi: null }
  const wrongButSimilar = { title: TITLE, publicationDate: '2021 Feb', authors: ['Timaran CH'] }
  assert.equal(scoreMatch(reference, wrongButSimilar), 'reject')
})

test('first-author agreement reads every citation format the lookups return', () => {
  assert.equal(printedFirstAuthor(RAW), 'Schanzer')
  assert.equal(printedFirstAuthor('de Weerd M, Greving JP. Prevalence. Stroke. 2010.'), 'de Weerd')
  assert.equal(printedFirstAuthor('El-Sayed T, Patel AS. Radiation. Circulation. 2017.'), 'El-Sayed')
  assert.equal(printedFirstAuthor('US Food and Drug Administration. 510(k) premarket notification.'), null)
  // Given names first (ACM) or a lone author ending in a period: unknown, never a conflict.
  assert.equal(printedFirstAuthor('David S. Resch Heeyoung Han and Regina A. Kovach. 2013. Educational Technology in Medical Education.'), null)
  assert.equal(printedFirstAuthor('Davis FD. User acceptance of information technology.'), null)
  assert.equal(firstAuthorAgreement('Schanzer', ['Schanzer A']), 'agree')
  assert.equal(firstAuthorAgreement('Schanzer', ['Andres S. Schanzer']), 'agree')
  assert.equal(firstAuthorAgreement('Neri Júnior', ['Neri Junior JCS']), 'agree')
  assert.equal(firstAuthorAgreement('Schanzer', ['Timaran CH', 'Schanzer A']), 'conflict')
  assert.equal(firstAuthorAgreement('Schanzer', []), 'unknown')
  assert.equal(firstAuthorAgreement(null, ['Schanzer A']), 'unknown')
})

test('a trial group listed first in PubMed is skipped for the first-person author', () => {
  assert.equal(firstAuthorAgreement('Büller', ['EINSTEIN–PE Investigators', 'Büller HR', 'Prins MH']), 'agree')
  assert.equal(firstAuthorAgreement('Halliday', ['Halliday A', 'ACST-2 Collaborative Group']), 'agree')
  assert.equal(firstAuthorAgreement('Smith', ['Writing Group Members']), 'unknown')
})

test('the printed year is read only where citations print it, not from the title', () => {
  assert.equal(printedYear(RAW), 2017)
  assert.equal(printedYear('Ko D, Lin KJ. Trends in use of oral anticoagulants in older adults with atrial fibrillation, 2010-2020. JAMA Netw Open. 2022;5:e2242964.'), 2022)
  assert.equal(printedYear('Creager MA, et al. Reducing amputations by 2030: a call to action. Circulation. 2021;143:e875-e891.'), 2021)
  assert.equal(printedYear('Smith, J. & Lee, K. Bypass outcomes in 1998 cohorts. Nature 1, 2 (2020).'), 2020)
  assert.equal(printedYear('Health Level Seven International. FHIR Specification 2023 edition https://hl7.org/fhir/'), null)
})

test('a title year never contradicts the right paper', () => {
  const raw = 'Ko D, Lin KJ, Bessette LG. Trends in use of oral anticoagulants in older adults with newly diagnosed atrial fibrillation, 2010-2020. JAMA Netw Open. 2022;5(11):e2242964. doi: 10.1001/jamanetworkopen.2022.42964'
  const paper = { title: 'Trends in Use of Oral Anticoagulants in Older Adults With Newly Diagnosed Atrial Fibrillation, 2010-2020.', publicationDate: '2022 Nov 1', authors: ['Ko D', 'Lin KJ'] }
  assert.equal(scoreMatch({ raw, title: null }, paper), 'match')
})

test('title queries run from most to least specific', () => {
  assert.deepEqual(buildTitleQueries(TRANSCRIBED), [
    `${TITLE} AND Schanzer[au] AND 2016:2018[dp]`,
    `${TITLE} AND Schanzer[au]`,
    `${TITLE} AND 2016:2018[dp]`,
    TITLE,
  ])
  assert.deepEqual(buildTitleQueries({ title: `${TITLE}.` }), [TITLE])
  assert.deepEqual(buildTitleQueries({ title: null }), [])
})

// --- end to end, PubMed stubbed ------------------------------------------------

test('reference 2 resolves to the 2017 Schanzer paper, found by the author+year query', async (t) => {
  const queries = stubPubMed(t, (term) => {
    if (term.includes('Schanzer[au]') && term.includes('2016:2018[dp]')) return ['28259577']
    if (term.includes('Schanzer[au]')) return AUTHOR_ONLY_RESULTS
    return ['40814684']
  })
  const result = await resolveReference(TRANSCRIBED)
  assert.equal(result.paper.pmid, '28259577')
  assert.equal(result.confidence, 'match')
  assert.equal(queries.length, 1)
})

test('when only conflicting candidates come back, the reference is left unresolved with the reason', async (t) => {
  // PubMed never returns the real paper: every query yields the strangers.
  stubPubMed(t, () => AUTHOR_ONLY_RESULTS.concat(['40814684']))
  const result = await resolveReference(TRANSCRIBED)
  assert.equal(result.paper, null)
  assert.equal(result.method, 'none')
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].via, 'Title search')
  // The refused candidate shown is the one with the closest title.
  assert.equal(result.rejected[0].title, PAPERS[40814684].title)
  assert.equal(result.rejected[0].reason, 'first author Ribé L, not Schanzer; published 2025, not 2017')
})

test('a transcription with no author still cannot pick a stranger', async (t) => {
  stubPubMed(t, () => AUTHOR_ONLY_RESULTS)
  const result = await resolveReference({ ...TRANSCRIBED, firstAuthor: null })
  // The printed citation still names Schanzer first, so the 2021–2024 papers by others conflict.
  assert.equal(result.paper, null)
})
