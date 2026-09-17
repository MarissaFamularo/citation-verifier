import assert from 'node:assert/strict'
import test from 'node:test'
import { pickOaLink } from './fullText.js'

test('pickOaLink prefers a direct PDF, keeps landing-page-only OA, honest isPdf flag', () => {
  assert.deepEqual(
    pickOaLink({ is_oa: true, best_oa_location: { url_for_pdf: 'https://x.test/a.pdf', url: 'https://x.test/a' } }),
    { url: 'https://x.test/a.pdf', isPdf: true },
  )
  assert.deepEqual(
    pickOaLink({ is_oa: true, best_oa_location: { url: 'https://x.test/landing' } }),
    { url: 'https://x.test/landing', isPdf: false },
  )
  assert.equal(pickOaLink({ is_oa: false }), null)
  assert.equal(pickOaLink({ is_oa: true, best_oa_location: null }), null)
  assert.equal(pickOaLink(null), null)
})
