import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSupportContent,
  buildSupportVerdict,
  checkSentenceNumbers,
  groupCitationsByPaper,
} from './manuscriptCitations.js'

const SOURCE = {
  tier: 'full_text',
  text: 'Background. The trial randomized 500 patients. Revascularization reduced major amputation at one year (HR 0.62, 95% CI 0.45-0.86).',
  tables: 'Table 2: amputation-free survival 78% vs 65%',
}

test('an unsupported audit becomes refuted with its reason', () => {
  const verdict = buildSupportVerdict({ supported: false, reason: 'the source reports no difference' }, SOURCE)
  assert.equal(verdict.verdict, 'refuted')
  assert.equal(verdict.reason, 'the source reports no difference')
})

test('a supported audit with a locatable quote becomes supported with tier', () => {
  const verdict = buildSupportVerdict({
    supported: true,
    reason: 'matches the primary outcome',
    source_quote: 'Revascularization reduced major amputation at one year (HR 0.62, 95% CI 0.45-0.86)',
    quote_location: 'Results',
  }, SOURCE)
  assert.equal(verdict.verdict, 'supported')
  assert.equal(verdict.tier, 'full_text')
  assert.equal(verdict.quote_location, 'Results')
  assert.ok(verdict.quote.includes('HR 0.62'))
})

test('a quote found only in tables still proves support', () => {
  const verdict = buildSupportVerdict({
    supported: true,
    reason: 'table backs it',
    source_quote: 'amputation-free survival 78% vs 65%',
    quote_location: 'Table 2',
  }, SOURCE)
  assert.equal(verdict.verdict, 'supported')
})

test('a supported audit with an unlocatable quote is flagged, never supported', () => {
  const verdict = buildSupportVerdict({
    supported: true,
    reason: 'sounds right',
    source_quote: 'this passage does not exist in the source',
    quote_location: 'Results',
  }, SOURCE)
  assert.equal(verdict.verdict, 'flagged')
  assert.match(verdict.reason, /could not be located/)
})

test('a supported audit with no quote at all is flagged', () => {
  const verdict = buildSupportVerdict({ supported: true, reason: 'trust me', source_quote: null, quote_location: null }, SOURCE)
  assert.equal(verdict.verdict, 'flagged')
})

test('abstract-only sources verify at the abstract tier', () => {
  const verdict = buildSupportVerdict({
    supported: true,
    reason: '',
    source_quote: 'The trial randomized 500 patients.',
    quote_location: null,
  }, { ...SOURCE, tier: 'abstract_only' })
  assert.equal(verdict.verdict, 'supported')
  assert.equal(verdict.tier, 'abstract_only')
})

test('checkSentenceNumbers verifies the sentence\'s own numbers against the paper', () => {
  const source = {
    tier: 'abstract_only',
    text: 'CAS plus IMM reduced the composite of stroke or death compared to IMM alone (2.8% vs 6.0%). The cohort included 503,842 adults.',
    tables: '',
  }
  const checked = checkSentenceNumbers(
    'Stenting reduced stroke or death versus medical management alone (2.8% vs 6.0%) in a cohort of 503,842 adults4,5.',
    source,
  )
  assert.deepEqual(checked, [
    { token: '2.8', found: true },
    { token: '6.0', found: true },
    { token: '503842', found: true },
  ])
})

test('checkSentenceNumbers flags a figure the paper never prints', () => {
  const source = { tier: 'abstract_only', text: 'The rate was 2.8% in the stenting arm.', tables: '' }
  const checked = checkSentenceNumbers('The stenting arm rate was 3.1%.', source)
  assert.deepEqual(checked, [{ token: '3.1', found: false }])
})

test('checkSentenceNumbers skips years, prose counts, and citation-marker digits', () => {
  const source = { tier: 'abstract_only', text: 'Nothing numeric here at all.', tables: '' }
  const checked = checkSentenceNumbers(
    'A 2025 systematic review of two trials over 9 years confirmed this.6 It was reported before [7].',
    source,
  )
  assert.deepEqual(checked, [])
})

test('a supported claim with a missing number is flagged, never supported', () => {
  const verdict = buildSupportVerdict({
    supported: true,
    reason: 'direction matches',
    source_quote: 'The trial randomized 500 patients.',
    quote_location: 'Methods',
  }, SOURCE, [{ token: '3.1', found: false }, { token: '500', found: true }])
  assert.equal(verdict.verdict, 'flagged')
  assert.match(verdict.reason, /3\.1/)
  assert.ok(verdict.quote, 'keeps the located quote for click-through')
  assert.deepEqual(verdict.numbers.map((n) => n.found), [false, true])
})

test('a supported claim with all numbers found stays supported', () => {
  const verdict = buildSupportVerdict({
    supported: true,
    reason: '',
    source_quote: 'The trial randomized 500 patients.',
    quote_location: 'Methods',
  }, SOURCE, [{ token: '500', found: true }])
  assert.equal(verdict.verdict, 'supported')
})

test('buildSupportContent carries the sentence and the source block', () => {
  const content = buildSupportContent({ sentence: 'Revascularization reduces amputation.', source: SOURCE })
  assert.match(content, /MANUSCRIPT SENTENCE/)
  assert.match(content, /Revascularization reduces amputation\./)
  assert.match(content, /SOURCE TEXT \(open-access full text\)/)
})

test('groupCitationsByPaper groups rows by literature id in order', () => {
  const grouped = groupCitationsByPaper([
    { id: 'a', literature_id: 'p1' },
    { id: 'b', literature_id: 'p2' },
    { id: 'c', literature_id: 'p1' },
  ])
  assert.deepEqual(grouped.get('p1').map((row) => row.id), ['a', 'c'])
  assert.deepEqual(grouped.get('p2').map((row) => row.id), ['b'])
})

test('an abstract that is silent on the claim is unverified, not refuted', () => {
  const abstract = { tier: 'abstract_only', text: 'We studied bypass surgery outcomes.', tables: '' }
  assert.equal(buildSupportVerdict({ supported: false, relation: 'silent', reason: 'Not addressed.' }, abstract).verdict, 'unverified')
  assert.equal(buildSupportVerdict({ supported: false, relation: 'contradicts', reason: 'Says the opposite.' }, abstract).verdict, 'refuted')
  assert.equal(buildSupportVerdict({ supported: false, relation: 'off_topic', reason: 'A surgical trial; never involves statins.' }, abstract).verdict, 'refuted')
  assert.equal(buildSupportVerdict({ supported: false, relation: 'silent', reason: 'Not addressed.' }, { ...abstract, tier: 'full_text' }).verdict, 'refuted')
})
