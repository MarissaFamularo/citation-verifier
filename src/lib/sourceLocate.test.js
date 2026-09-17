import test from 'node:test'
import assert from 'node:assert/strict'
import { findQuoteSpan, locateQuote, tolerantQuotePattern } from './sourceLocate.js'

test('findQuoteSpan finds an exact substring', () => {
  const corpus = 'Intro. The hazard ratio was 0.84 (95% CI 0.71-0.99). Done.'
  const span = findQuoteSpan(corpus, 'hazard ratio was 0.84')
  assert.deepEqual(span, [11, 32])
})

test('findQuoteSpan tolerates whitespace reflow', () => {
  const corpus = 'The hazard\n  ratio was\t0.84 overall.'
  const span = findQuoteSpan(corpus, 'The hazard ratio was 0.84')
  assert.ok(span)
  assert.equal(corpus.slice(span[0], span[1]).replace(/\s+/g, ' '), 'The hazard ratio was 0.84')
})

test('findQuoteSpan tolerates dash and middle-dot variants', () => {
  const corpus = 'Mortality was 0·84 (95% CI 0·71–0·99) at follow-up.'
  const span = findQuoteSpan(corpus, 'Mortality was 0.84 (95% CI 0.71-0.99)')
  assert.ok(span)
  assert.equal(corpus.slice(span[0], span[1]), 'Mortality was 0·84 (95% CI 0·71–0·99)')
})

test('findQuoteSpan falls back to case-insensitive matching', () => {
  const corpus = 'RESULTS: THE PRIMARY OUTCOME OCCURRED IN 12% OF PATIENTS.'
  const span = findQuoteSpan(corpus, 'The primary outcome occurred in 12%')
  assert.ok(span)
})

test('findQuoteSpan returns null when the quote is absent', () => {
  assert.equal(findQuoteSpan('Some text here.', 'not in the corpus'), null)
  assert.equal(findQuoteSpan('', 'quote'), null)
  assert.equal(findQuoteSpan('corpus', ''), null)
})

test('tolerantQuotePattern escapes regex metacharacters', () => {
  const pattern = tolerantQuotePattern('p=0.05 (n=42) [primary]')
  assert.ok(new RegExp(pattern).test('p=0.05 (n=42) [primary]'))
  assert.ok(!new RegExp(pattern).test('p=0X05 (n=42) [primary]'))
})

test('locateQuote picks the prose corpus first, then tables', () => {
  const source = { text: 'Prose with the answer 42 here.', tables: 'Table: answer 42 | other 7' }
  const inProse = locateQuote(source, 'answer 42')
  assert.equal(inProse.corpusLabel, 'text')
  assert.equal(inProse.found, true)

  const inTables = locateQuote(source, 'other 7')
  assert.equal(inTables.corpusLabel, 'tables')
  assert.equal(inTables.found, true)
})

test('locateQuote returns the prose corpus unfound when nowhere aligned', () => {
  const source = { text: 'Prose only.', tables: '' }
  const result = locateQuote(source, 'missing quote')
  assert.equal(result.found, false)
  assert.equal(result.corpusLabel, 'text')
  assert.equal(result.corpusText, 'Prose only.')
  assert.equal(result.span, null)
})
