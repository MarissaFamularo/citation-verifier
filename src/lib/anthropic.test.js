// Reference transcription runs on Claude Haiku 5.5 at low effort, and the
// browser-local spend ledger prices it on the right rate card. The request is
// captured from a stubbed fetch with a placeholder key — nothing leaves the
// machine and no real key is involved.

import test from 'node:test'
import assert from 'node:assert/strict'
import { HAIKU_5_5_LONG_PROMPT, MODELS, modelRates, recordUsage, setApiKey } from './anthropic.js'
import { parseNumberedReferences } from './manuscriptImport.js'
import { parseReferenceList } from './referenceImport.js'

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
}

// A streamed Messages API response whose text block is `json`.
function streamedJson(json, usage = { input_tokens: 900, output_tokens: 400 }) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: MODELS.fast, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(json) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function captureRequests(t, json) {
  globalThis.sessionStorage = memoryStorage()
  globalThis.localStorage = memoryStorage()
  setApiKey(`placeholder-${Math.random()}`)
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const bodies = []
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/v1\/messages/)
    bodies.push(JSON.parse(init.body))
    return streamedJson(json)
  }
  return bodies
}

test('reference transcription uses Claude Haiku 5.5', () => {
  assert.equal(MODELS.fast, 'claude-haiku-5-5')
})

test('numbered-reference transcription sends Haiku 5.5 at low effort and nothing Haiku 5.5 rejects', async (t) => {
  const bodies = captureRequests(t, { references: [{ number: 3, title: 'Three-dimensional fusion computed tomography decreases radiation exposure', firstAuthor: 'McNally', journal: 'J Vasc Surg', year: 2015, pmid: null, doi: null }] })
  const refs = await parseNumberedReferences([{ number: 3, raw: 'McNally MM, Scali ST. Three-dimensional fusion computed tomography decreases radiation exposure. J Vasc Surg. 2015;61(2):309-316.' }])
  assert.equal(refs[0].title, 'Three-dimensional fusion computed tomography decreases radiation exposure')
  assert.equal(bodies.length, 1)
  const [body] = bodies
  assert.equal(body.model, 'claude-haiku-5-5')
  assert.equal(body.output_config.effort, 'low')
  assert.equal(body.output_config.format.type, 'json_schema')
  assert.equal(body.max_tokens, 32_000)
  // Haiku 5.5 returns 400 on a thinking budget, sampling parameters, or a prefill.
  assert.equal(body.thinking, undefined)
  for (const field of ['temperature', 'top_p', 'top_k']) assert.equal(body[field], undefined)
  assert.equal(body.messages.at(-1).role, 'user')
})

test('pasted reference-list transcription uses the same model and effort', async (t) => {
  const bodies = captureRequests(t, { references: [{ raw: 'Smith J. Bypass outcomes. J Vasc Surg. 2020.', title: 'Bypass outcomes', firstAuthor: 'Smith', journal: 'J Vasc Surg', year: 2020, pmid: null, doi: null }] })
  await parseReferenceList('Smith J. Bypass outcomes. J Vasc Surg. 2020.')
  assert.equal(bodies[0].model, 'claude-haiku-5-5')
  assert.equal(bodies[0].output_config.effort, 'low')
})

test('modelRates: Haiku 5.5 has two rate cards split at a 100,000-token prompt', () => {
  assert.deepEqual(modelRates('claude-haiku-5-5', 2_000), { input: 0.1, output: 0.5 })
  assert.deepEqual(modelRates('claude-haiku-5-5', HAIKU_5_5_LONG_PROMPT), { input: 0.1, output: 0.5 })
  assert.deepEqual(modelRates('claude-haiku-5-5', HAIKU_5_5_LONG_PROMPT + 1), { input: 0.5, output: 2.5 })
  assert.deepEqual(modelRates('claude-haiku-4-5'), { input: 1, output: 5 })
  // Sonnet 5 kept its $2/$10 price after 2026-08-31.
  assert.deepEqual(modelRates('claude-sonnet-5'), { input: 2, output: 10 })
})

test('recordUsage prices a typical transcription call at a fraction of a cent', () => {
  globalThis.localStorage = memoryStorage()
  const ledger = recordUsage('claude-haiku-5-5', { input_tokens: 2_000, output_tokens: 1_500 })
  // 2,000 × $0.10/M + 1,500 × $0.50/M = $0.00095
  assert.ok(Math.abs(ledger.estimatedUsd - 0.00095) < 1e-12)
  const long = recordUsage('claude-haiku-5-5', { input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 1_000 })
  // Over the threshold on input + cache reads: 90,000 × $0.50 + 20,000 × $0.05 + 1,000 × $2.50, per million.
  assert.ok(Math.abs(long.estimatedUsd - 0.00095 - 0.0485) < 1e-12)
})
