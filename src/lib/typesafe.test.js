import test from 'node:test'
import assert from 'node:assert/strict'
import { buildJevRequest, callSystemOne, interpretJev, selectPassage, PASSAGE_FALLBACK_CHARS } from './typesafe.js'

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) } }
globalThis.sessionStorage = store()
globalThis.localStorage = store()

const FILLER = 'Unrelated methods detail. '.repeat(200)
const QUOTE = 'Revascularization reduced major amputation at one year (HR 0.62).'
const SOURCE = { text: `${FILLER}${QUOTE} ${FILLER}`, tables: '' }

test('selectPassage windows around a located quote', () => {
  const { passage, anchored } = selectPassage(SOURCE, QUOTE)
  assert.equal(anchored, true)
  assert.ok(passage.includes(QUOTE))
  assert.ok(passage.length < SOURCE.text.length)
})

test('selectPassage falls back to the opening of the source without a quote', () => {
  const { passage, anchored } = selectPassage(SOURCE, null)
  assert.equal(anchored, false)
  assert.ok(passage.length <= PASSAGE_FALLBACK_CHARS)
})

test('selectPassage uses a table-only quote as its own passage', () => {
  const { passage, anchored } = selectPassage(SOURCE, 'Amputation 12% vs 19%')
  assert.deepEqual({ passage, anchored }, { passage: 'Amputation 12% vs 19%', anchored: true })
})

test('buildJevRequest strips citation markers from the sentence', () => {
  const body = buildJevRequest({ sentence: 'Bypass lowers amputation risk [12].', passage: 'p' })
  assert.equal(body.state.sentence, 'Bypass lowers amputation risk.')
  assert.equal(body.questions.relation.type, 'choice')
})

test('interpretJev reports P(supports) and flags low confidence', () => {
  const out = interpretJev({
    model: 'jev-1.13.0',
    answers: { relation: { type: 'choice', choice: 'says_nothing', probabilities: { supports: 0.3, contradicts: 0.1, says_nothing: 0.6 }, confidence: 0.4 } },
    usage: { input_tokens: 900 },
  })
  assert.equal(out.relation, 'says_nothing')
  assert.equal(out.reliability, 0.3)
  assert.equal(out.needsReview, true)
  assert.equal(out.inputTokens, 900)
})

test('interpretJev throws when the answer is missing', () => {
  assert.throws(() => interpretJev({ answers: {} }))
})

test('callSystemOne retries a 429 then succeeds, and refuses without a key', async () => {
  await assert.rejects(() => callSystemOne({}), /No TypeSafe API key/)
  sessionStorage.setItem('citationverifier.typesafe_key', 'k')
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0.01' }, text: async () => '' }
    return { ok: true, json: async () => ({ ok: 1 }) }
  }
  assert.deepEqual(await callSystemOne({}, { fetchImpl }), { ok: 1 })
  assert.equal(calls, 2)
})
