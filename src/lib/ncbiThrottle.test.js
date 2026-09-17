import test from 'node:test'
import assert from 'node:assert/strict'
import { ncbiFetch, resetNcbiThrottle } from './ncbiThrottle.js'

test('requests fired together are spaced to stay under the eutils limit', async () => {
  resetNcbiThrottle()
  let clock = 1000
  const waits = []
  const opts = { now: () => clock, sleep: async (ms) => { waits.push(ms) }, fetchImpl: async (url) => url }
  const results = await Promise.all(['a', 'b', 'c'].map((url) => ncbiFetch(url, {}, opts)))
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.deepEqual(waits, [350, 700])
  resetNcbiThrottle()
  waits.length = 0
  await Promise.all(['a', 'b'].map((url) => ncbiFetch(url, {}, { ...opts, hasKey: true })))
  assert.deepEqual(waits, [110])
})
