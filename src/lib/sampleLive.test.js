// The built-in sample against the live, free PubMed and Crossref APIs — no
// keys, no model calls. Parsing tests alone missed a matcher regression that
// refused the sample's BASIL-2 citation (a shortened printed title), so the
// sample's lookups are checked end to end before a deploy:
//
//   LIVE_LOOKUPS=1 node --test src/lib/sampleLive.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import process from 'node:process'
import { importManuscript } from './pipeline.js'

const live = process.env.LIVE_LOOKUPS === '1'

test('the sample resolves all three references in PubMed and keeps its four citing sentences', { skip: !live && 'set LIVE_LOOKUPS=1 to run (network)' }, async () => {
  const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} })
  globalThis.sessionStorage ??= store()
  globalThis.localStorage ??= store()
  if (!globalThis.DOMParser) {
    // Abstract XML is not needed to resolve a match.
    globalThis.DOMParser = class { parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] } } }
  }
  const text = fs.readFileSync(new URL('../../public/sample-manuscript.txt', import.meta.url), 'utf8')
  const { rows, referenceCount } = await importManuscript(text)
  assert.equal(referenceCount, 3)
  assert.equal(rows.filter((row) => row.sentence).length, 4)
  const byRef = new Map(rows.map((row) => [row.refNumber, row]))
  for (const number of [1, 2, 3]) {
    const row = byRef.get(number)
    assert.ok(row.paper?.pmid, `reference ${number} did not resolve`)
    assert.equal(row.matchConfidence, 'match', `reference ${number}: ${row.matchConfidence}`)
  }
  assert.equal(byRef.get(2).paper.pmid, '37116524')
})
