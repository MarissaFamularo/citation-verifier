import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRows,
  claudeVerdictLabel,
  formatJevMark,
  isUncheckedSentence,
  needsAttention,
  paperMatchStatus,
  parseReviewFile,
  rowsToCsv,
  serializeReview,
  setDecision,
  summarize,
  uncheckedSentenceCount,
} from './review.js'

const REFS = [{ number: 1, raw: 'Smith J. Bypass. JVS 2020.' }, { number: 2, raw: 'Lee K. Stents. 2021.' }]
const BY_NUMBER = new Map([[1, [{ sentence: 'Bypass works [1].', marker: '[1]', locationHint: 'Introduction' }, { sentence: 'Again [1].', marker: '[1]' }]]])
const RESULTS = [{ reference: REFS[0], paper: { pmid: '123', title: 'Bypass' }, confidence: 'high' }]

test('buildRows makes one row per citing sentence and keeps uncited references', () => {
  const rows = buildRows(REFS, BY_NUMBER, RESULTS)
  assert.deepEqual(rows.map((row) => row.id), ['1:1', '1:2', '2:0'])
  assert.equal(rows[0].paper.pmid, '123')
  assert.equal(rows[2].sentence, '')
  assert.deepEqual(summarize(rows), { sentences: 2, checked: 0, reviewed: 0, uncited: 1, unreadable: 0, unmatched: 1, unmatchedSentences: 0, lookupFailed: 0 })
})

test('an unresolved cited reference is counted apart from a failed lookup', () => {
  const refs = [...REFS, { number: 3, raw: 'Thompson JR. Invented paper. 2019.' }]
  const byNumber = new Map([
    ...BY_NUMBER,
    [3, [{ sentence: 'Invented claim [3].', marker: '[3]', locationHint: 'Introduction' }]],
  ])
  const rows = buildRows(refs, byNumber, [
    RESULTS[0],
    { reference: REFS[1], paper: { pmid: '9', title: 'Stents' }, confidence: 'high' },
    { reference: refs[2], paper: null, method: 'none', confidence: 'none' },
  ])
  assert.equal(summarize(rows).unmatched, 1)
  assert.equal(summarize(rows).unmatchedSentences, 1)
  assert.equal(summarize(rows).sentences, 3)
  assert.equal(paperMatchStatus(rows.find((row) => row.refNumber === 3)), 'no matching paper found')
  assert.equal(needsAttention(rows.find((row) => row.refNumber === 3)), true)
  assert.equal(uncheckedSentenceCount(rows), 2)
  assert.equal(rows.filter(isUncheckedSentence).every((row) => row.paper), true)
  const csv = rowsToCsv(rows)
  assert.match(csv, /no matching paper found/)
  assert.doesNotMatch(csv, /fabricat/i)

  const failed = buildRows(REFS, BY_NUMBER, [
    RESULTS[0],
    { reference: REFS[1], paper: null, method: 'error', confidence: 'none', error: 'PubMed stopped answering' },
  ])
  const missed = failed.find((row) => row.refNumber === 2)
  assert.equal(missed.matchError, 'PubMed stopped answering')
  assert.equal(paperMatchStatus(missed), 'lookup failed')
  assert.equal(summarize(failed).unmatched, 0)
  assert.equal(summarize(failed).lookupFailed, 1)
})

test('unchecked sentences are counted per citing sentence, and a finished set is empty', () => {
  const rows = buildRows(REFS, BY_NUMBER, RESULTS)
  assert.equal(uncheckedSentenceCount(rows), 2)
  const done = rows.map((row) => (row.sentence ? { ...row, claude: { verdict: 'supported', relation: 'supports' } } : row))
  assert.equal(uncheckedSentenceCount(done), 0)
})

test('Claude export labels match the on-screen distinctions and saved reviews keep the raw codes', () => {
  assert.equal(claudeVerdictLabel({ verdict: 'refuted', relation: 'contradicts' }), 'contradicted or overstated')
  assert.equal(claudeVerdictLabel({ verdict: 'refuted', relation: 'off_topic' }), 'paper is about something else')
  assert.equal(claudeVerdictLabel({ verdict: 'refuted', relation: 'silent' }), 'not found in the full text')
  assert.equal(claudeVerdictLabel({ verdict: 'unverified', relation: 'silent' }), 'not in abstract — needs full text')
  assert.equal(claudeVerdictLabel({ verdict: 'supported', relation: 'supports' }), 'supported')

  const [row] = buildRows(REFS, BY_NUMBER, RESULTS)
  const reviewed = { ...row, claude: { verdict: 'refuted', relation: 'off_topic', reason: 'About rivaroxaban, not statins.' }, jev: { relation: 'says_nothing', reliability: 0, confidence: 0.74 } }
  const csv = rowsToCsv([reviewed])
  assert.match(csv, /paper is about something else/)
  assert.match(csv, /says nothing/)
  assert.match(csv, /Jev probability of support \(0-1\)/)
  assert.doesNotMatch(csv, /refuted/)
  assert.doesNotMatch(csv, /reliability/)

  const saved = JSON.parse(serializeReview({ fileName: 'paper.docx', rows: [reviewed] }))
  assert.equal(saved.rows[0].claude.verdict, 'refuted')
  assert.equal(saved.rows[0].claude.relation, 'off_topic')
  const reopened = parseReviewFile(JSON.stringify(saved))
  assert.equal(reopened.rows[0].claude.verdict, 'refuted')
  assert.equal(claudeVerdictLabel(reopened.rows[0].claude), 'paper is about something else')
})

test('Jev mark names the probability of support rather than reliability', () => {
  assert.equal(
    formatJevMark({ relation: 'says_nothing', reliability: 0, confidence: 1 }),
    'says nothing · probability of support 0% · confidence 1.00',
  )
  assert.doesNotMatch(formatJevMark({ relation: 'contradicts', reliability: 0, confidence: 1 }), /reliability/)
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
