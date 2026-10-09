// Regression: a journal pre-proof PDF with manuscript line numbers in the
// margin and a diagonal "Journal Pre-proof" watermark on every page. The
// numbers once glued onto reference entries ("332 1. Simons…"), so the list
// split wrongly, entries 1–7 merged, later entries were renumbered, and a
// line number read as a PMID ("PMID: 384 40490161") attached an unrelated
// paper with only a "loose title match" caution.
//
// The fixture below is positioned text (pdf.js item geometry) modeled on that
// manuscript's layout — not the PDF itself. Set REGRESSION_PDF to a local
// copy of a line-numbered PDF to also run the full pdf.js extraction.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import process from 'node:process'
import { layoutToText } from './pdfLayout.js'
import { itemsFromTextContent } from './pdfText.js'
import {
  extractManuscriptCitations,
  gatherManuscriptReferences,
  numberReferenceEntries,
  splitManuscript,
} from './manuscriptImport.js'
import { resolveReference, scoreMatch } from './referenceImport.js'
import { resetNcbiThrottle } from './ncbiThrottle.js'

const MCNALLY = 'McNally MM, Scali ST, Feezor RJ, Neal D, Huber TS, Beck AW. Three-dimensional fusion computed tomography decreases radiation exposure, procedure time, and contrast use during fenestrated endovascular aortic repair. J Vasc Surg. 2015;61(2):309-316.'
const CLOSTRIDIUM = 'Effects of strong electrolyte upon the activity of Clostridium perfringens sialidase toward sialyllactose and sialoglycolipids.'

// --- fixture -----------------------------------------------------------------

const PAGE = { width: 612, height: 792 }
const NUMBER_RIGHT_EDGE = 61.2

// One page of lines; each line gets a right-aligned margin line number, as a
// separate text item, exactly as the pre-proof prints them.
function numberedPage(lines, firstNumber) {
  const items = []
  lines.forEach((line, index) => {
    const y = 720 - index * 20
    const { str, x = 79.2, h = 12 } = typeof line === 'string' ? { str: line } : line
    if (str) items.push({ str, x, y, w: str.length * 5.4, h })
    const label = String(firstNumber + index)
    items.push({ str: label, x: NUMBER_RIGHT_EDGE - label.length * 5, y, w: label.length * 5, h: 10 })
  })
  items.push({ str: 'Journal Pre-proof', x: 190.2, y: 294.5, w: 339.1, h: 43.9, rotated: true })
  return { ...PAGE, items, last: firstNumber + lines.length - 1 }
}

const hang = (str) => ({ str, x: 96.3, h: 11 })
const entry = (str) => ({ str, x: 79.2, h: 11 })

function preproofPages() {
  const body = numberedPage([
    { str: '1. Introduction', h: 13 },
    'Endovascular repair has become a standard treatment for complex aortic aneurysms [1,2].',
    'Fenestrated and branched repair increases radiation exposure, operative time, and',
    'iodinated contrast use relative to standard infrarenal repair [3].',
    'Three cohorts comprised 332 patients and reported a lower dose (MD −1435.85 mGy) [2–4].',
    'Earlier fusion studies from 2015 reported the same direction of effect [3,5].',
    'Contrast volumes above 100 mL were associated with kidney injury in 11.8% of patients [4].',
    '',
  ], 1)
  const references = numberedPage([
    { str: 'References', h: 13 },
    entry('1. Simons JP, Crawford AS, Flanagan CP, et al. Evolution of fenestrated/branched'),
    hang('endovascular aortic aneurysm repair complexity and outcomes. J Vasc Surg.'),
    hang('2021;73(4):1148-1155.e2.'),
    entry('2. Schanzer A, Simons JP, Flahive J, et al. Outcomes of fenestrated and branched'),
    hang('endovascular repair of complex abdominal and thoracoabdominal aortic aneurysms. J'),
    hang('Vasc Surg. 2017;66(3):687-694.'),
    entry('3. McNally MM, Scali ST, Feezor RJ, Neal D, Huber TS, Beck AW. Three-dimensional fusion'),
    hang('computed tomography decreases radiation exposure, procedure time, and contrast use during'),
    hang('fenestrated endovascular aortic repair. J Vasc Surg. 2015;61(2):309-316.'),
    entry('4. Bader JM, Li Y, Lee C, et al. Prediction model for safe contrast volume thresholds. J'),
    hang('Vasc Surg. 2025; published online June 6. https://doi.org/10.1016/j.jvs.2025.05.170. PMID:'),
  ], body.last + 1)
  // Entry 4 runs over the page break, so its PMID sits on the next page,
  // right after a margin line number.
  const next = numberedPage([
    hang('40490161.'),
    entry('5. Maurel B, Martin-Gonzalez T, Chong D, et al. A prospective observational trial of fusion'),
    hang('imaging in infrarenal aneurysms. J Vasc Surg. 2018;68(6):1706-'),
    hang('1713.e1.'),
    { str: 'Tables', h: 13 },
    'Table 1. Characteristics of included studies.',
  ], references.last + 1)
  return [body, references, next]
}

function importFixture() {
  const text = layoutToText(preproofPages())
  const { body, referenceText } = splitManuscript(text)
  const entries = numberReferenceEntries(referenceText)
  return { text, body, entries }
}

// --- extraction --------------------------------------------------------------

test('pre-proof PDF: margin line numbers and the watermark never reach the text', () => {
  const { text } = importFixture()
  assert.ok(!text.includes('Pre-proof'))
  for (const line of text.split('\n')) assert.doesNotMatch(line, /^\d{1,3} /, `line number left on: ${line}`)
  assert.ok(text.includes('Three cohorts comprised 332 patients and reported a lower dose (MD −1435.85 mGy) [2–4].'))
  assert.ok(text.includes('kidney injury in 11.8% of patients [4].'))
})

test('pre-proof PDF: references stay separate, numbered as printed, and complete across the page break', () => {
  const { entries } = importFixture()
  assert.deepEqual(entries.map((e) => e.number), [1, 2, 3, 4, 5])
  assert.equal(entries.find((e) => e.number === 3).raw, MCNALLY)
  const four = entries.find((e) => e.number === 4)
  assert.match(four.raw, /PMID: 40490161\.$/)
  assert.match(entries.find((e) => e.number === 5).raw, /2018;68\(6\):1706-1713\.e1\.$/)
  for (const e of entries) assert.equal(e.parseWarning, undefined, `unexpected warning on ${e.number}`)
})

test('pre-proof PDF: citation [3] maps to the McNally reference with a clean sentence', () => {
  const { body, entries } = importFixture()
  const { byNumber, styleUsed } = extractManuscriptCitations(body, entries)
  assert.equal(styleUsed, 'bracket')
  const three = byNumber.get(3).map((c) => c.sentence)
  assert.deepEqual(three, [
    'Fenestrated and branched repair increases radiation exposure, operative time, and iodinated contrast use relative to standard infrarenal repair [3].',
    'Three cohorts comprised 332 patients and reported a lower dose (MD −1435.85 mGy) [2–4].',
    'Earlier fusion studies from 2015 reported the same direction of effect [3,5].',
  ])
  // Groups and ranges expand; data numbers are never read as citations.
  assert.deepEqual([...byNumber.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5])
  assert.equal(byNumber.get(2).length, 2)
  assert.ok(![...byNumber.keys()].includes(332))
})

test('pdf geometry: a numeric column on one page is not mistaken for line numbers', () => {
  const rows = ['Study 1 Retrospective', 'Study 2 Retrospective', 'Study 3 Prospective', 'Study 4 Prospective', 'Study 5 Registry', 'Study 6 Registry']
  const items = rows.flatMap((str, i) => [
    { str: String(i + 1), x: 50, y: 700 - i * 20, w: 5, h: 12 },
    { str, x: 80, y: 700 - i * 20, w: str.length * 5.4, h: 12 },
  ])
  const text = layoutToText([{ ...PAGE, items }])
  assert.ok(text.includes('1 Study 1 Retrospective'))
  assert.ok(text.includes('6 Study 6 Registry'))
})

test('pdf geometry: rotated text that is most of the page (a sideways table) is kept', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ str: `Sideways table row ${i + 1} with values 12.5 and 40`, x: 100, y: 100 + i * 20, w: 200, h: 12, rotated: true }))
  assert.ok(layoutToText([{ ...PAGE, items }]).includes('Sideways table row 3'))
})

test('itemsFromTextContent marks rotated items from the text matrix', () => {
  const items = itemsFromTextContent({ items: [
    { str: 'Body', width: 20, height: 12, transform: [12, 0, 0, 12, 79, 700] },
    { str: 'Journal Pre-proof', width: 339, height: 43.9, transform: [31, 31, -31, 31, 190, 294] },
  ] })
  assert.deepEqual(items.map((item) => item.rotated), [false, true])
  // A synthetic italic is skewed, not rotated: still body text.
  const italic = itemsFromTextContent({ items: [{ str: 'FRED)', width: 30, height: 9, transform: [9, 0, 1.9, 9, 300, 400] }] })
  assert.equal(italic[0].rotated, false)
})

// --- reference splitting -----------------------------------------------------

test('numberReferenceEntries appends an unnumbered block to the entry before it instead of renumbering', () => {
  const entries = numberReferenceEntries('1. Alpha A. First paper. J One. 2020;1:1-\n2.\n2. Beta B. Second paper. J Two. 2021;2:2-3.')
  assert.deepEqual(entries.map((e) => e.number), [1, 2])
  const tail = numberReferenceEntries('1. Alpha A. First paper. J One. 2020;1:1-\n9.\n2. Beta B. Second paper. J Two. 2021;2:2-3.')
  assert.deepEqual(tail.map((e) => e.number), [1, 2])
  const wrapped = numberReferenceEntries('1. Alpha A. First paper. J One. 2020;\n1:1-9.\n2. Beta B. Second paper. J Two. 2021;2:2-3.')
  assert.deepEqual(wrapped.map((e) => [e.number, e.raw]), [[1, 'Alpha A. First paper. J One. 2020; 1:1-9.'], [2, 'Beta B. Second paper. J Two. 2021;2:2-3.']])
})

test('numberReferenceEntries splits entries whose line breaks were lost, at the next number only', () => {
  const entries = numberReferenceEntries('6. Goudeketting SR, Heinen SGH. Pros and cons of 3D image fusion. J Endovasc Ther. 2017;24(4):595-603. 7. Maurel B, Martin-Gonzalez T. A prospective trial of fusion imaging. J Vasc Surg. 2018;68(6):1706-1713.e1.')
  assert.deepEqual(entries.map((e) => e.number), [6, 7])
  assert.match(entries[0].raw, /595-603\.$/)
  assert.match(entries[1].raw, /^Maurel B/)
  // A number that is not the next one is data, not an entry start.
  const data = numberReferenceEntries('6. Smith J. Dose fell. 12. Jones K, Lee M reported it. J X. 2019;1:1-2.')
  assert.deepEqual(data.map((e) => e.number), [6])
})

test('numberReferenceEntries reads "1.." numbering and does not flag numbered phrases inside a title', () => {
  const entries = numberReferenceEntries('1.. Nixon R: Special message. Public Papers, 18; 1971. 2.. Hartman M, Martin AB: National spending. Health Aff 2026;45:1-9.\n3.. OECD: Health at a Glance 2025.')
  assert.deepEqual(entries.map((e) => e.number), [1, 2, 3])
  const guide = numberReferenceEntries('15. Khan KZ, Ramachandran S. The OSCE: AMEE Guide No. 81. Part I: An historical perspective. Med Teach. 2013;35(9):e1437-e1446.')
  assert.equal(guide[0].parseWarning, undefined)
})

test('a bracketed citation printed after the period stays with its sentence', () => {
  const { byNumber } = extractManuscriptCitations(
    'Abstractors disagree even when trained.[1] In other domains, algorithms outperform experts.[2,3]',
    [1, 2, 3].map((number) => ({ number, raw: `Ref ${number}` })),
  )
  assert.deepEqual(byNumber.get(1).map((c) => c.sentence), ['Abstractors disagree even when trained.[1]'])
  assert.deepEqual(byNumber.get(2).map((c) => c.sentence), ['In other domains, algorithms outperform experts.[2,3]'])
})

test('the built-in TXT sample still yields four citing sentences and three DOI references', () => {
  const { body, referenceText } = splitManuscript(fs.readFileSync(new URL('../../public/sample-manuscript.txt', import.meta.url), 'utf8'))
  const entries = numberReferenceEntries(referenceText)
  assert.deepEqual(entries.map((e) => e.number), [1, 2, 3])
  for (const e of entries) assert.equal(e.parseWarning, undefined)
  const { linkedSentences } = extractManuscriptCitations(body, entries)
  assert.equal(linkedSentences, 4)
})

test('numberReferenceEntries flags duplicated numbers and run-together entries rather than guessing', () => {
  const entries = numberReferenceEntries('1. Alpha A. First. J One. 2020;1:1-2.\n1. Beta B. Second. J Two. 2021;2:2-3.')
  assert.match(entries[1].parseWarning, /appears more than once/)
  const merged = numberReferenceEntries('1. Alpha A. First. J One. 2020;1:1-2. 5. Simons JP, Crawford AS. Third. J Three. 2021;3:3-4.')
  assert.match(merged[0].parseWarning, /more than one reference/)
})

test('gatherManuscriptReferences returns flagged entries unresolved with their printed text', async () => {
  const text = '1. Alpha A. First. https://doi.org/10.1000/a1.\n1. Beta B. Second. https://doi.org/10.1000/b2.'
  const { references } = await gatherManuscriptReferences(text)
  assert.equal(references.length, 2)
  const flagged = references.find((ref) => ref.parseWarning)
  assert.equal(flagged.doi, null)
  assert.match(flagged.raw, /^Beta B\./)
})

// --- matching ----------------------------------------------------------------

test('scoreMatch rejects an unrelated paper for a printed citation and accepts the right one', () => {
  const reference = { raw: MCNALLY, title: null, pmid: '384', doi: null, year: null }
  assert.equal(scoreMatch(reference, { title: CLOSTRIDIUM, publicationDate: '1976' }), 'reject')
  assert.equal(scoreMatch(reference, { title: 'Three-dimensional fusion computed tomography decreases radiation exposure, procedure time, and contrast use during fenestrated endovascular aortic repair.', publicationDate: '2015 Feb' }), 'match')
  // Right words, wrong decade: a conflicting year rejects.
  assert.equal(scoreMatch(reference, { title: 'Three-dimensional fusion computed tomography decreases radiation exposure, procedure time, and contrast use during fenestrated endovascular aortic repair.', publicationDate: '1995' }), 'reject')
})

// Browser globals the PubMed client touches; the abstract XML is empty here.
function stubBrowser() {
  const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} })
  globalThis.sessionStorage ??= store()
  globalThis.localStorage ??= store()
  globalThis.DOMParser ??= class {
    parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] } }
  }
}

test('resolveReference refuses a printed PMID that leads to a different paper and says so', async (t) => {
  stubBrowser()
  resetNcbiThrottle()
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('esummary')) {
      return new Response(JSON.stringify({ result: { 384: { title: CLOSTRIDIUM, pubdate: '1976 Jan' } } }), { status: 200 })
    }
    if (String(url).includes('efetch')) return new Response('<PubmedArticleSet></PubmedArticleSet>', { status: 200 })
    throw new Error(`unexpected request ${url}`)
  }
  const result = await resolveReference({ number: 3, raw: MCNALLY, title: null, pmid: '384', doi: null })
  assert.equal(result.paper, null)
  assert.equal(result.method, 'none')
  assert.deepEqual(result.rejected, [{ via: 'PMID 384', title: CLOSTRIDIUM }])
  assert.equal(calls.length, 2)
})

test('resolveReference does not look up an entry flagged as mis-split', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => { throw new Error('no lookup expected') }
  const result = await resolveReference({ number: 1, raw: 'merged text', title: null, pmid: '384', doi: null, parseWarning: 'this entry may contain more than one reference' })
  assert.equal(result.paper, null)
  assert.equal(result.method, 'unparsed')
  assert.match(result.warning, /more than one reference/)
})

// --- the real file, when available locally ------------------------------------

test('full pdf.js extraction of a local line-numbered PDF', { skip: !process.env.REGRESSION_PDF && 'set REGRESSION_PDF to run' }, async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(process.env.REGRESSION_PDF)), verbosity: 0 }).promise
  const pages = []
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: 1 })
    pages.push({ width: viewport.width, height: viewport.height, items: itemsFromTextContent(await page.getTextContent()) })
  }
  const { body, referenceText } = splitManuscript(layoutToText(pages))
  const entries = numberReferenceEntries(referenceText)
  const numbers = entries.map((e) => e.number)
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1))
  for (const e of entries) assert.equal(e.parseWarning, undefined, `warning on ${e.number}: ${e.parseWarning}`)
  const expect = process.env.REGRESSION_REF3
  if (expect) assert.match(entries.find((e) => e.number === 3).raw, new RegExp(expect))
  const { byNumber } = extractManuscriptCitations(body, entries)
  for (const list of byNumber.values()) for (const c of list) assert.doesNotMatch(c.sentence, /Pre-proof/)
})
