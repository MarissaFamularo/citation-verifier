// Regression: a reference list set in three narrow columns with staggered
// baselines (JAMA's layout). The reader takes lines across columns, so the
// entries come out interleaved — each printed number followed by fragments
// of two or three other references. None of those entries may be matched
// to a paper: one that happens to read cleanly can still carry a
// neighbour's title. The fixture is positioned text modeled on that page.

import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutToText } from './pdfLayout.js'
import { entryProblems, gatherManuscriptReferences, numberReferenceEntries, splitManuscript } from './manuscriptImport.js'
import { importManuscript } from './pipeline.js'

const H = 7
const PITCH = 9
const COLUMNS = [
  { x: 72, y0: 446.8, entries: [
    ['1. de Weerd M, Greving JP, Hedblad B, et al.', 'Prevalence of asymptomatic carotid artery stenosis', 'in the general population. Stroke. 2010;41(6):1294-1297.'],
    ['2. Halliday A, Bulbulia R, Bonati LH, et al.', 'Second asymptomatic carotid surgery trial.', 'Lancet. 2021;398(10305):1065-1073.'],
    ['3. Reiff T, Eckstein HH, Mansmann U, et al.', 'Carotid endarterectomy or stenting for stenosis.', 'Lancet Neurol. 2022;21(10):877-888.'],
  ] },
  { x: 232, y0: 452.8, entries: [
    ['4. Fillenbaum GG, van Belle G, Morris JC, et al.', 'Consortium to Establish a Registry for Alzheimer’s', 'Disease. Alzheimers Dement. 2008;4(2):96-109.'],
    ['5. Wechsler D. WAIS III Administration and Scoring', 'Manual. The Psychological Corporation; 1997.'],
    ['6. Melchior LA, Huba GJ, Brown VB, Reback C.', 'A short depression index for women. Educ Psychol', 'Meas. 1993;53:1117-1125.'],
  ] },
  { x: 391.6, y0: 446.8, entries: [
    ['7. Lal BK, Dux MC, Sikdar S, et al. Asymptomatic', 'carotid stenosis is associated with cognitive', 'impairment. J Vasc Surg. 2017;66(4):1083-1092.'],
    ['8. Chang XL, Zhou HQ, Lei CY, et al. Association', 'between asymptomatic carotid stenosis and', 'cognition. Neurosci Biobehav Rev. 2013;37(8):1493-1499.'],
    ['9. Marshall RS, Lazar RM, Meschia JF, et al.', 'Revascularization in asymptomatic carotid stenosis.', 'JAMA. 2026;336(4):310-320.'],
  ] },
]

function threeColumnManuscript() {
  const items = [{ str: 'REFERENCES', x: 72, y: 470, w: 40, h: H }]
  for (const column of COLUMNS) {
    let y = column.y0
    for (const lines of column.entries) {
      for (const str of lines) {
        items.push({ str, x: column.x, y, w: Math.min(150, str.length * 3.1), h: H })
        y -= PITCH
      }
      y -= 3
    }
  }
  const sentence = 'Carotid stenosis was associated with cognitive decline in several cohorts [1,4,7].'
  const body = { width: 612, height: 792, items: Array.from({ length: 12 }, (_, i) => ({ str: sentence, x: 72, y: 700 - i * 9, w: 300, h: H })) }
  return layoutToText([body, { width: 612, height: 792, items }])
}

test('three-column reference list: every entry is flagged, including one that reads cleanly', () => {
  const { referenceText } = splitManuscript(threeColumnManuscript())
  const entries = numberReferenceEntries(referenceText)
  assert.deepEqual([...entries.map((e) => e.number)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (const entry of entries) assert.match(entry.parseWarning, /read out of order/, `entry ${entry.number} not flagged`)
  // Entry 9 came out whole — only the list-level evidence catches it.
  const nine = entries.find((e) => e.number === 9)
  assert.deepEqual(entryProblems(nine), [])
})

test('three-column reference list: flagged entries are never transcribed or looked up', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async (url) => { throw new Error(`no request expected: ${url}`) }
  const text = threeColumnManuscript()
  // No API key is set: a model call would throw, so this also proves none is made.
  const { references, usedModel } = await gatherManuscriptReferences(splitManuscript(text).referenceText)
  assert.equal(usedModel, false)
  assert.equal(references.length, 9)
  for (const ref of references) {
    assert.equal(ref.title, null)
    assert.equal(ref.pmid, null)
    assert.equal(ref.doi, null)
  }
  const { rows } = await importManuscript(text)
  assert.equal(rows.filter((row) => row.paper).length, 0)
  for (const row of rows) assert.match(row.parseWarning, /read out of order/)
  // The citing sentence and the printed text stay visible for the reviewer.
  assert.ok(rows.some((row) => row.refNumber === 1 && row.sentence.includes('[1,4,7]')))
  assert.ok(rows.every((row) => row.referenceRaw))
})

// --- per-entry evidence ------------------------------------------------------

test('entryProblems: a clean entry has none', () => {
  for (const raw of [
    'McNally MM, Scali ST, Feezor RJ, et al. Three-dimensional fusion computed tomography. J Vasc Surg. 2015;61(2):309-316.',
    'Page MJ, McKenzie JE. The PRISMA 2020 statement. BMJ. 2021;372:n71. https://doi.org/10.1136/bmj.n71.',
    'Khan KZ. The OSCE: AMEE Guide No. 81. Part I. Med Teach. 2013;35(9):e1437-e1446. https://doi.org/10.3109/0142159X.2013.818634 arXiv:https://doi.org/10.3109/0142159X.2013.818634 PMID: 23968323.',
    'Socratic methods and medical students’ learning: a randomised controlled trial. ([n. d.]).',
    'Health Level Seven International. FHIR Specification https://hl7.org/fhir/',
    'Wechsler D. WAIS III Administration and Scoring Manual. The Psychological Corporation; 1997.',
  ]) assert.deepEqual(entryProblems({ number: 4, raw }), [], raw)
})

test('entryProblems: two journal citations, two DOIs, an embedded entry, or a cut-off end', () => {
  assert.deepEqual(entryProblems({ number: 4, raw: 'Paraskevas KI. Carotid stenosis and cognition. J Alzheimers Dis. 2016;54(2):497-503. Eur J Vasc Endovasc Surg. 2021;61(6):888-899.' }), ['it contains two journal citations'])
  assert.deepEqual(entryProblems({ number: 5, raw: 'Naylor R, et al. ESVS guidelines. 2023. doi:10.3233/JAD-160328 doi:10.1016/j.ejvs.2022.04.011' }), ['it contains two DOIs'])
  // An earlier number counts too: "29. … 18. Gorelick PB, …"
  assert.deepEqual(entryProblems({ number: 29, raw: 'Cushman M, Callas PW. S1474-4422(22)00290-3 18. Gorelick PB, Scuteri A. Vascular contributions. Stroke. 2011.' }), ['this entry may contain more than one reference'])
  for (const raw of ['Fillenbaum GG, van Belle G, Morris JC, et al.', 'Zhu W, Howard VJ. Physical activity and cognition. J Am Geriatr Soc. 2015;63(12):2447-', 'Chang XL, Zhou HQ, Lei CY, et al. Association']) {
    assert.deepEqual(entryProblems({ number: 3, raw }), ['it looks cut off'], raw)
  }
})

// --- list-level evidence -----------------------------------------------------

test('a number missing from the middle flags the entry before the gap only', () => {
  const entries = numberReferenceEntries([
    '1. Alpha A. First. J One. 2020;1:1-2.',
    '2. Beta B. Second. J Two. 2021;2:2-3. Gamma C. Third. J Three. 2019;3:3-4.',
    '4. Delta D. Fourth. J Four. 2018;4:4-5.',
  ].join('\n'))
  assert.equal(entries[0].parseWarning, undefined)
  assert.match(entries[1].parseWarning, /reference 3 is missing from the list and may be inside this entry/)
  assert.equal(entries[2].parseWarning, undefined)
})

test('a single step backwards (two lists, or one column read early) does not condemn the whole list', () => {
  const entries = numberReferenceEntries([
    '3. Gamma C. Third. J Three. 2019;3:3-4.',
    '4. Delta D. Fourth. J Four. 2018;4:4-5.',
    '1. Alpha A. First. J One. 2020;1:1-2.',
    '2. Beta B. Second. J Two. 2021;2:2-3.',
  ].join('\n'))
  for (const entry of entries) assert.equal(entry.parseWarning, undefined)
})
