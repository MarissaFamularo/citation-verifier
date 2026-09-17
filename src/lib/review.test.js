import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, parseReviewFile, rowsToCsv, serializeReview, setDecision, summarize } from './review.js'

const REFS = [{ number: 1, raw: 'Smith J. Bypass. JVS 2020.' }, { number: 2, raw: 'Lee K. Stents. 2021.' }]
const BY_NUMBER = new Map([[1, [{ sentence: 'Bypass works [1].', marker: '[1]', locationHint: 'Introduction' }, { sentence: 'Again [1].', marker: '[1]' }]]])
const RESULTS = [{ reference: REFS[0], paper: { pmid: '123', title: 'Bypass' }, confidence: 'high' }]

test('buildRows makes one row per citing sentence and keeps uncited references', () => {
  const rows = buildRows(REFS, BY_NUMBER, RESULTS)
  assert.deepEqual(rows.map((row) => row.id), ['1:1', '1:2', '2:0'])
  assert.equal(rows[0].paper.pmid, '123')
  assert.equal(rows[2].sentence, '')
  assert.deepEqual(summarize(rows), { sentences: 2, checked: 0, reviewed: 0, uncited: 1 })
})

test('setDecision records the human verdict and rejects unknown decisions', () => {
  const [row] = buildRows(REFS, BY_NUMBER, RESULTS)
  const now = new Date('2026-09-17T12:00:00Z')
  assert.deepEqual(setDecision(row, { decision: 'reject', notes: 'wrong population' }, now).review, { decision: 'reject', notes: 'wrong population', reviewedAt: now.toISOString() })
  assert.equal(setDecision(row, { decision: 'maybe', notes: '' }, now).review.decision, null)
})

test('a review survives a save and re-open', () => {
  const rows = buildRows(REFS, BY_NUMBER, RESULTS).map((row) => setDecision(row, { decision: 'accept', notes: 'ok' }))
  const reopened = parseReviewFile(serializeReview({ fileName: 'paper.docx', rows }))
  assert.equal(reopened.fileName, 'paper.docx')
  assert.deepEqual(reopened.rows, rows)
  assert.throws(() => parseReviewFile('{"rows":[]}'), /not a saved review/)
  assert.throws(() => parseReviewFile('nope'), /not a saved review/)
})

test('rowsToCsv escapes quotes, newlines and formula-looking cells', () => {
  const [row] = buildRows(REFS, new Map([[1, [{ sentence: '=SUM(A1) said "yes",\nthen no' }]]]), RESULTS)
  const csv = rowsToCsv([{ ...row, jev: { relation: 'supports', reliability: 0.912, confidence: 0.8 } }])
  assert.ok(csv.includes(`"'=SUM(A1) said ""yes"",\nthen no"`))
  assert.ok(csv.includes('0.91'))
})
