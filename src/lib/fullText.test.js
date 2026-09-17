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

test('pmcidFromElink reads the PMC id from an elink answer, or null when there is none', async () => {
  const { pmcidFromElink } = await import('./fullText.js')
  assert.equal(pmcidFromElink({ linksets: [{ linksetdbs: [{ linkname: 'pubmed_pmc_refs', links: ['1'] }, { linkname: 'pubmed_pmc', links: ['10991271'] }] }] }), 'PMC10991271')
  assert.equal(pmcidFromElink({ linksets: [{ ids: ['1'] }] }), null)
})
