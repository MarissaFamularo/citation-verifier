import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import {
  buildReferenceMap,
  citationMatchUpdates,
  classifyStoredCitations,
  cleanNumberedParse,
  decodeXmlEntities,
  detectAuthorYearMarkers,
  detectNumericMarkers,
  docxXmlToText,
  entryIdentifiers,
  expandNumberList,
  extractDocxText,
  extractManuscriptCitations,
  manuscriptNeedsModel,
  numberReferenceEntries,
  paperReferenceNumber,
  splitBodySentences,
  splitManuscript,
  splitSentences,
} from './manuscriptImport.js'

// --- zip fixture builder (stored and deflated entries) -----------------------

function buildZip(entries) {
  const encoder = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = encoder.encode(entry.content)
    const method = entry.method ?? 0
    const comp = method === 8 ? new Uint8Array(zlib.deflateRawSync(data)) : data
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, comp.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    parts.push(local, comp)

    const record = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(record.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, comp.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    record.set(nameBytes, 46)
    central.push(record)
    offset += local.length + comp.length
  }
  const centralSize = central.reduce((sum, record) => sum + record.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const total = [...parts, ...central, eocd]
  const out = new Uint8Array(total.reduce((sum, part) => sum + part.length, 0))
  let cursor = 0
  for (const part of total) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out.buffer
}

const DOCUMENT_XML = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>Introduction</w:t></w:r></w:p>
<w:p><w:r><w:t>CLTI carries high risk.</w:t></w:r><w:r><w:t xml:space="preserve">1 Amputation-free survival differs [2].</w:t></w:r></w:p>
<w:p><w:r><w:t>References</w:t></w:r></w:p>
<w:p><w:r><w:t>1. Smith J. Outcomes of CLTI. J Vasc Surg. 2024. PMID: 12345678</w:t></w:r></w:p>
<w:p><w:r><w:t>2. Jones K. Bypass &amp; stenting compared. doi:10.1000/xyz123</w:t></w:r></w:p>
</w:body></w:document>`

test('extractDocxText reads a stored-entry docx', async () => {
  const buffer = buildZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'word/document.xml', content: DOCUMENT_XML },
  ])
  const text = await extractDocxText(buffer)
  assert.match(text, /Introduction\n/)
  assert.match(text, /CLTI carries high risk\.1 Amputation-free survival differs \[2\]\./)
  assert.match(text, /References\n1\. Smith J\./)
})

test('extractDocxText reads a deflated docx', async () => {
  const buffer = buildZip([
    { name: 'word/document.xml', content: DOCUMENT_XML, method: 8 },
  ])
  const text = await extractDocxText(buffer)
  assert.match(text, /Bypass & stenting compared/)
})

test('extractDocxText rejects a non-zip file', async () => {
  await assert.rejects(
    () => extractDocxText(new TextEncoder().encode('plain text, not a zip').buffer),
    /does not look like a Word/,
  )
})

test('docxXmlToText joins runs, decodes entities, keeps paragraphs', () => {
  const text = docxXmlToText('<w:p><w:r><w:t>A &amp; B</w:t></w:r><w:r><w:t xml:space="preserve"> continues</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p>')
  assert.equal(text, 'A & B continues\nNext')
})

test('decodeXmlEntities handles named and numeric entities', () => {
  assert.equal(decodeXmlEntities('&lt;p&gt; &#65; &#x2013; &amp;'), '<p> A – &')
})

test('splitManuscript splits on the last References heading', () => {
  const { body, referenceText } = splitManuscript('Intro text.\nMore text.\nReferences\n1. Ref one.\n2. Ref two.')
  assert.equal(body, 'Intro text.\nMore text.')
  assert.equal(referenceText, '1. Ref one.\n2. Ref two.')
})

test('splitManuscript reports a missing reference list honestly', () => {
  assert.throws(() => splitManuscript('Just body text with no list.'), /No reference list was found/)
})

test('numberReferenceEntries keeps printed numbers, including bracketed', () => {
  const entries = numberReferenceEntries('1. First ref.\n2) Second ref.\n[3] Third ref.')
  assert.deepEqual(entries.map((entry) => entry.number), [1, 2, 3])
  assert.equal(entries[2].raw, 'Third ref.')
})

test('numberReferenceEntries numbers unnumbered per-line lists sequentially', () => {
  const entries = numberReferenceEntries('Smith J. One. 2024.\nJones K. Two. 2023.')
  assert.deepEqual(entries.map((entry) => entry.number), [1, 2])
  assert.equal(entries[0].raw, 'Smith J. One. 2024.')
})

test('entryIdentifiers pulls printed DOI and PMID only', () => {
  assert.deepEqual(entryIdentifiers('Smith J. Title. PMID: 12345678'), { pmid: '12345678', doi: null })
  assert.deepEqual(entryIdentifiers('Jones K. doi:10.1000/abc12.'), { pmid: null, doi: '10.1000/abc12' })
  assert.deepEqual(entryIdentifiers('No identifiers here 2024;79(1):1-9.'), { pmid: null, doi: null })
})

test('manuscriptNeedsModel is false when every entry prints an identifier', () => {
  assert.equal(manuscriptNeedsModel('1. A. PMID: 111\n2. B. doi:10.1000/x'), false)
  assert.equal(manuscriptNeedsModel('1. A. PMID: 111\n2. B has no id. 2024.'), true)
})

test('cleanNumberedParse validates identifiers and realigns to entries', () => {
  const entries = new Map([[1, { number: 1, raw: 'raw one' }], [2, { number: 2, raw: 'raw two' }]])
  const cleaned = cleanNumberedParse({
    references: [
      { number: 1, title: 'Good title', firstAuthor: 'Smith', journal: 'JVS', year: 2024, pmid: 'PMID: 999', doi: null },
      { number: 2, title: null, firstAuthor: null, journal: null, year: null, pmid: null, doi: 'https://doi.org/10.1000/x' },
      { number: 9, title: 'Unknown number', firstAuthor: null, journal: null, year: null, pmid: null, doi: null },
    ],
  }, entries)
  assert.equal(cleaned.length, 2)
  assert.equal(cleaned[0].pmid, '999')
  assert.equal(cleaned[0].raw, 'raw one')
  assert.equal(cleaned[1].doi, '10.1000/x')
})

test('splitSentences keeps glued superscript citations with their sentence', () => {
  const sentences = splitSentences('Outcomes improved.12,13 A second sentence follows. Third one?')
  assert.equal(sentences.length, 3)
  assert.equal(sentences[0], 'Outcomes improved.12,13')
})

test('expandNumberList expands ranges and lists', () => {
  assert.deepEqual(expandNumberList('3, 5-7'), [3, 5, 6, 7])
  assert.deepEqual(expandNumberList('12'), [12])
})

test('detectNumericMarkers finds bracketed citations', () => {
  const hits = detectNumericMarkers('This was shown before [3,5-7].', 40)
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].numbers, [3, 5, 6, 7])
  assert.equal(hits[0].style, 'bracket')
})

test('detectNumericMarkers finds superscript-style citations after punctuation', () => {
  const hits = detectNumericMarkers('Rates improved over time.12,13', 40)
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].numbers, [12, 13])
  assert.equal(hits[0].style, 'superscript')
})

test('docxXmlToText preserves superscript runs as ^{} markers, merging split runs', () => {
  const xml = '<w:p><w:r><w:t>on duplex or CT</w:t></w:r>'
    + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>1</w:t></w:r>'
    + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>,</w:t></w:r>'
    + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r>'
    + '<w:r><w:t>. But stenosis grade alone is insufficient.</w:t></w:r></w:p>'
  assert.equal(docxXmlToText(xml), 'on duplex or CT^{1,2}. But stenosis grade alone is insufficient.')
})

test('detectNumericMarkers reads ^{} superscript markers exactly', () => {
  const hits = detectNumericMarkers('Stroke risk is stratified by stenosis.^{1,3-5}', 40)
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].numbers, [1, 3, 4, 5])
  assert.equal(hits[0].style, 'superscript')
})

test('detectNumericMarkers reads flattened trailing superscripts (word1.)', () => {
  const one = detectNumericMarkers('The risk is stratified by percent stenosis on duplex or CT1.', 40)
  assert.deepEqual(one.map((hit) => hit.numbers).flat(), [1])
  assert.equal(one[0].style, 'superscript')

  const pair = detectNumericMarkers('CEA did not significantly improve outcomes over IMM alone (3.7% vs 5.3%)4,5.', 40)
  assert.deepEqual(pair.map((hit) => hit.numbers).flat(), [4, 5])

  const mid = detectNumericMarkers('Ultrasound is difficult to reproduce due to operator variability3.', 40)
  assert.deepEqual(mid.map((hit) => hit.numbers).flat(), [3])

  // Glued digits are a citation even after words like "grade" — data would
  // be written with a space ("grade 2"), and spaced numbers never match.
  const glued = detectNumericMarkers('Plaque features increased stroke risk independent of stenosis grade2.', 40)
  assert.deepEqual(glued.map((hit) => hit.numbers).flat(), [2])
  assert.equal(detectNumericMarkers('Most wounds were classified as grade 2.', 40).length, 0)
  assert.equal(detectNumericMarkers('Analysis used SPSS v29.', 40).length, 0)
})

test('a numbered methods list is not read as parenthesized citations', () => {
  const hits = detectNumericMarkers(
    'We performed three analyses: (1) cluster stability across five seeds; (2) the k-selection discrimination analysis; and (3) a complete-case re-derivation.',
    40,
  )
  assert.equal(hits.length, 0)
})

test('extractManuscriptCitations strips ^{} markers from stored sentences', () => {
  const references = [{ number: 1, firstAuthor: null, year: null }, { number: 2, firstAuthor: null, year: null }]
  const body = 'Introduction\nStroke risk is stratified by stenosis.^{1} Plaque features add independent risk.^{2}'
  const { byNumber, styleUsed } = extractManuscriptCitations(body, references)
  assert.equal(styleUsed, 'superscript')
  assert.equal(byNumber.get(1)[0].sentence, 'Stroke risk is stratified by stenosis.1')
  assert.equal(byNumber.get(1)[0].marker, '^1')
  assert.equal(byNumber.get(2)[0].sentence, 'Plaque features add independent risk.2')
})

test('detectNumericMarkers ignores data that only looks like a citation', () => {
  assert.equal(detectNumericMarkers('The p value was 0.05 in COVID-19 patients (n=12).', 40).length, 0)
  assert.equal(detectNumericMarkers('As shown in Fig. 2 and Table 3.', 40).length, 0)
  assert.equal(detectNumericMarkers('The median was 8 (12) days.', 40).length, 0)
  assert.equal(detectNumericMarkers('Reference [55] is out of range.', 40).length, 0)
})

test('detectAuthorYearMarkers matches parsed references by name and year', () => {
  const references = [
    { number: 1, firstAuthor: 'Smith', year: 2020 },
    { number: 2, firstAuthor: 'Jones', year: 2019 },
  ]
  const parenthetical = detectAuthorYearMarkers('This was reported (Smith et al., 2020; Brown, 2018).', references)
  assert.deepEqual(parenthetical.map((hit) => hit.number), [1])
  const narrative = detectAuthorYearMarkers('Jones (2019) reported similar findings.', references)
  assert.deepEqual(narrative.map((hit) => hit.number), [2])
})

test('splitBodySentences tracks the section each sentence sits in', () => {
  const sentences = splitBodySentences('Introduction\nFirst point. Second point.\nDiscussion\nThird point.')
  assert.deepEqual(sentences.map((item) => item.section), ['Introduction', 'Introduction', 'Discussion'])
})

test('extractManuscriptCitations links sentences by the dominant numeric style', () => {
  const references = [
    { number: 1, firstAuthor: 'Smith', year: 2020 },
    { number: 2, firstAuthor: 'Jones', year: 2019 },
    { number: 3, firstAuthor: null, year: null },
  ]
  const body = [
    'Introduction',
    'CLTI carries a high amputation risk [1]. Bypass and stenting differ [2,3]. A value of (2) percent was seen.',
    'Discussion',
    'Earlier work agrees [1].',
  ].join('\n')
  const { byNumber, styleUsed, linkedSentences } = extractManuscriptCitations(body, references)
  assert.equal(styleUsed, 'bracket')
  assert.equal(linkedSentences, 3)
  assert.equal(byNumber.get(1).length, 2)
  assert.equal(byNumber.get(1)[0].locationHint, 'Introduction')
  assert.equal(byNumber.get(1)[1].locationHint, 'Discussion')
  assert.deepEqual(byNumber.get(2).map((c) => c.sentence), ['Bypass and stenting differ [2,3].'])
  assert.ok(byNumber.get(3))
})

test('extractManuscriptCitations still links author-year alongside numeric', () => {
  const references = [
    { number: 1, firstAuthor: 'Smith', year: 2020 },
    { number: 2, firstAuthor: 'Jones', year: 2019 },
  ]
  const body = 'Findings were mixed [2]. Smith et al. (2020) disagreed.'
  const { byNumber } = extractManuscriptCitations(body, references)
  assert.deepEqual(byNumber.get(2).map((c) => c.marker), ['[2]'])
  assert.deepEqual(byNumber.get(1).map((c) => c.marker), ['Smith (2020)'])
})

test('buildReferenceMap keeps numbers and prefers resolved identifiers', () => {
  const references = [
    { number: 1, raw: 'Smith...', title: 'Outcomes of bypass', pmid: null, doi: null },
    { number: 2, raw: 'Jones...', title: null, pmid: '123456', doi: null },
  ]
  const results = [
    { reference: references[0], paper: { pmid: '999', doi: '10.1000/xyz', title: 'Outcomes of Bypass.' } },
  ]
  const map = buildReferenceMap(references, results)
  assert.deepEqual(map, [
    { number: 1, pmid: '999', doi: '10.1000/xyz', title: 'Outcomes of Bypass.', raw: 'Smith...' },
    { number: 2, pmid: '123456', doi: null, title: null, raw: 'Jones...' },
  ])
})

test('paperReferenceNumber matches by pmid, doi, then normalized title', () => {
  const map = [
    { number: 4, pmid: '111', doi: null, title: null },
    { number: 7, pmid: null, doi: '10.1000/ABC', title: null },
    { number: 9, pmid: null, doi: null, title: 'The Cosmos Collaborative: a platform.' },
  ]
  assert.equal(paperReferenceNumber({ pmid: '111' }, map), 4)
  assert.equal(paperReferenceNumber({ pmid: '222', doi: '10.1000/abc' }, map), 7)
  assert.equal(paperReferenceNumber({ title: 'the cosmos collaborative a platform' }, map), 9)
  assert.equal(paperReferenceNumber({ pmid: '333', title: 'Unrelated' }, map), null)
  assert.equal(paperReferenceNumber({ pmid: '111' }, []), null)
  assert.equal(paperReferenceNumber({ pmid: '111' }, null), null)
})

test('paperReferenceNumber falls back to the printed entry containing the title', () => {
  const map = [
    { number: 8, pmid: null, doi: null, title: null, raw: 'Tarabichi Y, Frees A. The Cosmos Collaborative: A Vendor-Facilitated Electronic Health Record Data Aggregation Platform. ACI open. 2021;5(1):e36-e46.' },
  ]
  assert.equal(
    paperReferenceNumber({ title: 'The Cosmos Collaborative: A Vendor-Facilitated Electronic Health Record Data Aggregation Platform.' }, map),
    8,
  )
  // Short titles never match by containment — too easy to false-positive.
  assert.equal(paperReferenceNumber({ title: 'Cosmos' }, map), null)
  // Identifier matches beat raw-text containment even when both could hit.
  const both = [
    { number: 2, pmid: null, doi: null, title: null, raw: 'Something citing the exact carotid stenosis phenotype paper title here.' },
    { number: 5, pmid: '777', doi: null, title: null, raw: 'unrelated' },
  ]
  assert.equal(
    paperReferenceNumber({ pmid: '777', title: 'the exact carotid stenosis phenotype paper title' }, both),
    5,
  )
})

test('classifyStoredCitations flags removed and reworded sentences, keeps current ones', () => {
  const body = [
    'Introduction',
    'CLTI carries a high amputation risk without revascularization.1,2 Endovascular-first strategies remain debated in this population.3',
    'Discussion',
    'Cosmos aggregates de-identified records from more than 60 million patients across participating health systems.8,9',
  ].join('\n')
  const rows = [
    // Unchanged (marker digits differ in formatting but strip out).
    { id: 'a', sentence: 'CLTI carries a high amputation risk without revascularization.1,2', manuscript_match: null },
    // Edited: 300 million became 60 million.
    { id: 'b', sentence: 'Cosmos aggregates de-identified records from more than 300 million patients across participating health systems.8,9', manuscript_match: null },
    // Deleted outright.
    { id: 'c', sentence: 'Open bypass remains the gold standard for young patients with long occlusions.4', manuscript_match: null },
  ]
  const classified = classifyStoredCitations(rows, body)
  assert.equal(classified[0].match.status, 'current')
  assert.equal(classified[1].match.status, 'edited')
  assert.ok(classified[1].match.current_sentence.includes('60 million'))
  assert.equal(classified[2].match.status, 'removed')
})

test('citationMatchUpdates writes only real changes and clears returning sentences', () => {
  const classified = [
    // Current and never flagged: no write.
    { row: { id: 'a', manuscript_match: null }, match: { status: 'current' } },
    // Current again after being flagged: cleared back to null.
    { row: { id: 'b', manuscript_match: { status: 'removed', checked_at: 'x' } }, match: { status: 'current' } },
    // Already flagged removed: no rewrite (keeps first flag date).
    { row: { id: 'c', manuscript_match: { status: 'removed', checked_at: 'x' } }, match: { status: 'removed' } },
    // Newly removed: flagged.
    { row: { id: 'd', manuscript_match: null }, match: { status: 'removed' } },
    // Edited with new wording since last flag: rewritten.
    { row: { id: 'e', manuscript_match: { status: 'edited', current_sentence: 'old', checked_at: 'x' } }, match: { status: 'edited', current_sentence: 'new' } },
  ]
  const updates = citationMatchUpdates(classified, '2026-08-24T00:00:00Z')
  assert.deepEqual(updates.map((u) => u.id), ['b', 'd', 'e'])
  assert.equal(updates[0].manuscript_match, null)
  assert.equal(updates[1].manuscript_match.status, 'removed')
  assert.equal(updates[1].manuscript_match.checked_at, '2026-08-24T00:00:00Z')
  assert.equal(updates[2].manuscript_match.current_sentence, 'new')
})

// --- PDF-shaped manuscripts ---------------------------------------------------

test('splitManuscript merges a main and a Methods reference list and keeps the text between them in the body', () => {
  const { body, referenceText } = splitManuscript([
    'Intro sentence^{1}.', 'References', '1. First ref. 2020.', '2. Second ref. 2021.',
    'Publisher’s note Springer stays neutral.', 'Methods', 'We used a tool^{3}.',
    'References', '3. Third ref. 2022.',
  ].join('\n'))
  assert.deepEqual(numberReferenceEntries(referenceText).map((entry) => entry.number), [1, 2, 3])
  assert.ok(body.includes('We used a tool') && body.includes('Publisher’s note'))
  assert.ok(!body.includes('First ref'))
})

test('splitManuscript keeps hard-wrapped continuation lines with their entry', () => {
  const { referenceText } = splitManuscript('Body text [1].\nReferences\n1. Smith J. A long\ntitle wraps. 2020.\n2. Lee K. Another\nwrapped one. 2021.')
  assert.deepEqual(numberReferenceEntries(referenceText).map((entry) => entry.raw), ['Smith J. A long title wraps. 2020.', 'Lee K. Another wrapped one. 2021.'])
})

test('marked superscripts switch off digit guessing, and "(ref. N)" counts as a citation', () => {
  const references = [1, 2, 3, 4].map((number) => ({ number, raw: `Ref ${number}` }))
  const body = 'We evaluated MIRA-v2. Agents help^{1}. Trust matters^{3,4}. Reliance varies^{1}. We used GLM-5 (ref. 2) as well. See Fig. 3 for details^{4}.'
  const { byNumber } = extractManuscriptCitations(body, references)
  assert.deepEqual([...byNumber.keys()].sort(), [1, 2, 3, 4])
  assert.ok(byNumber.get(2).every((citation) => citation.sentence.includes('GLM-5 (ref. 2) as well.')))
  assert.ok(!byNumber.get(2).some((citation) => citation.sentence.includes('MIRA-v2')))
  assert.ok(byNumber.get(4).some((citation) => citation.sentence.startsWith('See Fig. 3 for details')))
})
