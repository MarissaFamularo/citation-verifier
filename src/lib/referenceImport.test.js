import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTitleQuery,
  cleanParsedReferences,
  extractYear,
  normalizeTitle,
  partitionPastedReferences,
  pasteNeedsModel,
  REFERENCE_CAP,
  REFERENCE_LIST_SCHEMA,
  scoreMatch,
  splitReferenceEntries,
  titleContainment,
  titleSimilarity,
} from './referenceImport.js'

const parsedRef = (overrides = {}) => ({
  raw: 'Smith J, Jones K. Endovascular repair outcomes. J Vasc Surg. 2024;79(1):1-9.',
  title: 'Endovascular repair outcomes',
  firstAuthor: 'Smith',
  journal: 'J Vasc Surg',
  year: 2024,
  pmid: null,
  doi: null,
  ...overrides,
})

test('schema requires every field on each reference and forbids extras', () => {
  const item = REFERENCE_LIST_SCHEMA.properties.references.items
  assert.equal(item.additionalProperties, false)
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort())
})

test('cleanParsedReferences keeps valid identifiers and drops malformed ones', () => {
  const cleaned = cleanParsedReferences({
    references: [
      parsedRef({ pmid: 'PMID: 12345678', doi: 'https://doi.org/10.1016/j.jvs.2024.01.001' }),
      parsedRef({ raw: 'Another ref', title: 'Another paper', pmid: 'not-a-pmid', doi: '11.999/bad' }),
    ],
  })
  assert.equal(cleaned.length, 2)
  assert.equal(cleaned[0].pmid, '12345678')
  assert.equal(cleaned[0].doi, '10.1016/j.jvs.2024.01.001')
  assert.equal(cleaned[1].pmid, null)
  assert.equal(cleaned[1].doi, null)
})

test('cleanParsedReferences drops rows with no title and no identifier', () => {
  const cleaned = cleanParsedReferences({
    references: [
      parsedRef({ title: null, pmid: null, doi: null }),
      parsedRef({ raw: '', title: 'Orphan title' }),
      parsedRef(),
    ],
  })
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0].title, 'Endovascular repair outcomes')
})

test('cleanParsedReferences dedupes repeated references and rejects far-future years', () => {
  const cleaned = cleanParsedReferences({
    references: [
      parsedRef({ pmid: '111' }),
      parsedRef({ pmid: '111', raw: 'Same paper cited twice' }),
      parsedRef({ pmid: null, title: 'Different paper', year: 2999 }),
    ],
  })
  assert.equal(cleaned.length, 2)
  assert.equal(cleaned[1].year, null)
})

test('cleanParsedReferences caps the batch', () => {
  const references = Array.from({ length: REFERENCE_CAP + 20 }, (_, i) => parsedRef({ title: `Paper number ${i}`, raw: `Ref ${i}` }))
  assert.equal(cleanParsedReferences({ references }).length, REFERENCE_CAP)
})

test('normalizeTitle strips punctuation, case, and diacritics', () => {
  assert.equal(normalizeTitle('  Endovascular Repair: Outcomes at 5 Years?  '), 'endovascular repair outcomes at 5 years')
  assert.equal(normalizeTitle('Étude française'), 'etude francaise')
})

test('titleSimilarity is 1 for style-only differences and low for different papers', () => {
  assert.equal(titleSimilarity('Endovascular repair outcomes.', 'endovascular REPAIR outcomes'), 1)
  assert.ok(titleSimilarity('Open surgical bypass in diabetics', 'Endovascular repair outcomes') < 0.5)
  assert.equal(titleSimilarity('', 'anything'), 0)
})

test('extractYear reads a year out of PubMed-style dates', () => {
  assert.equal(extractYear('2024 Jan 15'), 2024)
  assert.equal(extractYear('1998'), 1998)
  assert.equal(extractYear('n.d.'), null)
})

test('scoreMatch accepts close titles, flags weak or year-shifted ones, rejects strangers', () => {
  const reference = parsedRef()
  assert.equal(scoreMatch(reference, { title: 'Endovascular repair outcomes', publicationDate: '2024 Mar' }), 'match')
  // Epub-vs-print one-year drift still matches.
  assert.equal(scoreMatch(reference, { title: 'Endovascular repair outcomes', publicationDate: '2023 Dec' }), 'match')
  assert.equal(scoreMatch(reference, { title: 'Endovascular repair outcomes', publicationDate: '2020' }), 'check')
  assert.equal(scoreMatch(reference, { title: 'A completely unrelated cardiology paper', publicationDate: '2024' }), 'reject')
  // No printed title means the match cannot be verified.
  assert.equal(scoreMatch(parsedRef({ title: null }), { title: 'Whatever came back', publicationDate: '2024' }), 'check')
})

const NUMBERED_PASTE = `1.  AbuRahma AF, Avgerinos ED, Chang RW, et al. Society for Vascular Surgery clinical
practice guidelines for management of extracranial cerebrovascular disease. Journal of
Vascular Surgery. 2022;75(1):4S-22S. doi:10.1016/j.jvs.2021.04.073
2.  Kamtchum-Tatuene J, Noubiap JJ. Prevalence of High-risk Plaques. JAMA Neurol. 2020;77(12):1524-1535.
3.  Smith J. An older citation with no identifier at all. J Vasc Surg. 1999;30(2):100-110.`

test('splitReferenceEntries splits numbered bibliographies and strips numbering', () => {
  const entries = splitReferenceEntries(NUMBERED_PASTE)
  assert.equal(entries.length, 3)
  assert.match(entries[0], /^AbuRahma AF/)
  assert.match(entries[0], /doi:10\.1016\/j\.jvs\.2021\.04\.073$/)
  assert.match(entries[2], /^Smith J/)
})

test('splitReferenceEntries falls back to blank-line, then single-line separation', () => {
  assert.equal(splitReferenceEntries('First ref line one\ncontinued\n\nSecond ref').length, 2)
  assert.equal(splitReferenceEntries('10.1000/a\n10.1000/b\n10.1000/c').length, 3)
  assert.deepEqual(splitReferenceEntries(''), [])
})

test('partitionPastedReferences pulls printed DOIs and PMIDs out deterministically', () => {
  const { identified, unidentified } = partitionPastedReferences(NUMBERED_PASTE)
  assert.equal(identified.length, 1)
  assert.equal(identified[0].doi, '10.1016/j.jvs.2021.04.073')
  assert.equal(identified[0].title, null)
  assert.equal(unidentified.length, 2)
})

test('partitionPastedReferences reads bare PMIDs and PMID-labeled lines', () => {
  const { identified, unidentified } = partitionPastedReferences('12345678\nSmith J. Some paper. PMID: 87654321\nNo identifier here')
  assert.deepEqual(identified.map((ref) => ref.pmid), ['12345678', '87654321'])
  assert.equal(unidentified.length, 1)
})

test('pasteNeedsModel is false only when every entry carries an identifier', () => {
  assert.equal(pasteNeedsModel('doi:10.1016/j.jvs.2021.04.073\nPMID: 12345678'), false)
  assert.equal(pasteNeedsModel(NUMBERED_PASTE), true)
  assert.equal(pasteNeedsModel('Just a title, no identifier'), true)
})

test('titleContainment verifies a resolved title against the raw citation', () => {
  const raw = 'AbuRahma AF, et al. Society for Vascular Surgery clinical practice guidelines. J Vasc Surg. 2022. doi:10.1016/j.jvs.2021.04.073'
  assert.ok(titleContainment(raw, 'Society for Vascular Surgery clinical practice guidelines') >= 0.9)
  assert.ok(titleContainment('doi:10.1016/j.jvs.2021.04.073', 'Some unrelated resolved title') < 0.4)
})

test('scoreMatch on an identifier-only reference uses the raw citation text', () => {
  const raw = 'Kamtchum-Tatuene J. Prevalence of High-risk Plaques and Risk of Stroke. JAMA Neurol. 2020. doi:10.1001/jamaneurol.2020.2658'
  const reference = { raw, title: null, pmid: null, doi: '10.1001/jamaneurol.2020.2658', year: null }
  assert.equal(scoreMatch(reference, { title: 'Prevalence of High-risk Plaques and Risk of Stroke' }), 'match')
  assert.equal(scoreMatch(reference, { title: 'A totally different resolved paper' }), 'check')
  // A bare identifier has nothing to verify against — human checks.
  assert.equal(scoreMatch({ raw: '10.1001/jamaneurol.2020.2658', title: null }, { title: 'Whatever resolved' }), 'check')
})

test('buildTitleQuery constrains by first author when one was printed', () => {
  assert.equal(buildTitleQuery(parsedRef()), 'Endovascular repair outcomes AND Smith[au]')
  assert.equal(buildTitleQuery(parsedRef({ firstAuthor: null, title: 'Endovascular repair outcomes.' })), 'Endovascular repair outcomes')
  assert.equal(buildTitleQuery({ title: null }), '')
})
