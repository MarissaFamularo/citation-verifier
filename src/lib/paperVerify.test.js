// Adversarial verify suite — EVAL source #1 (docs/EVAL.md).
//
// The metric is PRECISION, not accuracy: a false-verify (green badge on a wrong value)
// is fatal and must be zero; a false-flag (flagging a correct value) is tolerable. Each
// case is (claimed number(s), source_quote, source_text) -> expected verdict. Run:
//   npm test
//
// Cases marked [false-verify guard] exist specifically to prove a wrong value can never
// earn a verified tier. If any of those regress, the product is broken.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { verify, normalize, extractNumbers, numbersEqual, plausibilityWarnings, TIERS } from './paperVerify.js'

// Minimal vitest-compat `expect` over node:assert, covering exactly the
// matchers this ported suite uses (including expect.objectContaining).
const CONTAINING = Symbol('objectContaining')

function matches(actual, expected) {
  if (expected && typeof expected === 'object' && expected[CONTAINING]) {
    return Object.entries(expected[CONTAINING]).every(([key, value]) => matches(actual?.[key], value))
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((item, index) => matches(actual[index], item))
  }
  try {
    assert.deepEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function expect(actual) {
  return {
    toBe: (expected) => assert.equal(actual, expected),
    toEqual: (expected) => assert.ok(matches(actual, expected), `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`),
    toContain: (expected) => {
      if (typeof actual === 'string') assert.ok(actual.includes(expected), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`)
      else assert.ok([...actual].some((item) => matches(item, expected)), `expected collection to contain ${JSON.stringify(expected)}`)
    },
    toMatch: (re) => assert.match(actual, re),
    toBeGreaterThanOrEqual: (expected) => assert.ok(actual >= expected, `expected ${actual} >= ${expected}`),
  }
}
expect.objectContaining = (fields) => ({ [CONTAINING]: fields })

// Convenience: build a quantity.
const q = (fields) => ({ location_hint: '', ...fields })

describe('normalization primitives', () => {
  it('maps interpunct decimals to a period', () => {
    expect(normalize('HR 0·84')).toBe('hr 0.84')
  })
  it('unifies dash variants to ASCII hyphen', () => {
    expect(normalize('0.61–1.16')).toBe('0.61-1.16') // en-dash
    expect(normalize('−0.5')).toBe('-0.5') // minus sign
  })
  it('collapses whitespace and lowercases', () => {
    expect(normalize('  Hazard\n  Ratio  ')).toBe('hazard ratio')
  })
  it('strips strict thousands separators but leaves a decimal comma alone', () => {
    expect(normalize('502,157 participants')).toBe('502157 participants')
    expect(normalize('1,234,567')).toBe('1234567')
    expect(normalize('1,234.56')).toBe('1234.56') // trailing decimal preserved
    expect(normalize('0,84')).toBe('0,84') // 2-digit group -> not thousands, untouched
  })
})

describe('numeric tokenization (boundary-delimited)', () => {
  it('does not split a longer number into fragments', () => {
    expect(extractNumbers('1984')).toEqual([1984]) // not [1, 9, 8, 4] or 84
    expect(extractNumbers('0.028')).toEqual([0.028]) // not 0.02
  })
  it('captures a leading-dot decimal', () => {
    expect(extractNumbers('.90')).toEqual([0.9])
  })
  it('captures an integer that ends a sentence', () => {
    expect(extractNumbers('n=84. The next')).toEqual([84])
  })
  it('captures a negative sign but treats a range dash as positive', () => {
    // "difference, -0.4" -> negative; "1.26-2.90" -> the dash is a range, second bound positive.
    expect(extractNumbers('difference, -0.4 mg/dL')).toEqual([-0.4])
    expect(extractNumbers('CI, 1.26-2.90')).toEqual([1.26, 2.9])
    expect(extractNumbers('CI, -0.7 to -0.07')).toEqual([-0.7, -0.07])
  })
})

describe('representation-equality', () => {
  it('treats 0.84 = .84 = 0.840 and 8 = 8.0 as equal', () => {
    expect(numbersEqual(0.84, 0.84)).toBe(true)
    expect(numbersEqual(8, 8.0)).toBe(true)
  })
  it('never absorbs rounding', () => {
    expect(numbersEqual(0.84, 0.847)).toBe(false)
    expect(numbersEqual(0.02, 0.028)).toBe(false)
  })
})

describe('statistical plausibility warnings', () => {
  it('warns on a P value outside 0–1 without conflating source verification', () => {
    const source = 'The estimated effect was 2.0 (P=1.2).'
    const verified = verify(q({ value: 2, p_value: 1.2, source_quote: 'effect was 2.0 (P=1.2)' }), source)
    expect(verified.tier).toBe(TIERS.FULL_TEXT)
    expect(verified.warnings).toEqual([
      expect.objectContaining({ kind: 'impossible-p-value', status: 'verified-as-printed' }),
    ])

    const unverified = verify(q({ value: 9, p_value: 1.2, source_quote: 'effect was 2.0 (P=1.2)' }), source)
    expect(unverified.tier).toBe(TIERS.FLAGGED)
    expect(unverified.warnings[0]).toEqual(expect.objectContaining({ status: 'unverified' }))
  })

  it('warns when the point estimate lies outside its CI or the CI is reversed', () => {
    expect(plausibilityWarnings(q({ value: 3, ci_low: 1, ci_high: 2 }))[0].kind)
      .toBe('estimate-outside-confidence-interval')
    expect(plausibilityWarnings(q({ value: 2, ci_low: 4, ci_high: 1 }))[0].kind)
      .toBe('reversed-confidence-interval')
  })

  it('warns on percentages above 100 only when the unit explicitly says percentage', () => {
    expect(plausibilityWarnings(q({ value: 101, unit: '%' }))[0].kind).toBe('percentage-over-100')
    expect(plausibilityWarnings(q({ value: 101, unit: 'patients' }))).toEqual([])
  })

  it('warns on reliably inferable 95% ratio CI/P incoherence', () => {
    const warnings = plausibilityWarnings(q({
      name: 'hazard ratio',
      value: 1.5,
      ci_low: 1.2,
      ci_high: 1.8,
      p_value: 0.2,
      source_quote: 'hazard ratio 1.5 (95% CI 1.2–1.8; P=0.20)',
    }))
    expect(warnings).toEqual([expect.objectContaining({ kind: 'ci-p-incoherence' })])
  })

  it('warns on reliably inferable 95% difference CI/P incoherence', () => {
    const warnings = plausibilityWarnings(q({
      name: 'mean difference',
      value: 0.2,
      ci_low: -0.1,
      ci_high: 0.4,
      p_value: 0.01,
      source_quote: 'mean difference 0.2 (95% CI -0.1 to 0.4; P=0.01)',
    }))
    expect(warnings).toEqual([expect.objectContaining({ kind: 'ci-p-incoherence' })])
  })

  it('does not infer CI/P coherence without an explicit 95% CI and known null scale', () => {
    expect(plausibilityWarnings(q({
      name: 'score', value: 1.5, ci_low: 1.2, ci_high: 1.8, p_value: 0.2,
      source_quote: 'score 1.5 (CI 1.2–1.8; P=0.20)',
    }))).toEqual([])
  })

  it('preserves rounded P=0.00 but marks it questionable', () => {
    const warnings = plausibilityWarnings(q({ p_value: 0, source_quote: 'P=0.00' }), { verifiedAsPrinted: true })
    expect(warnings).toEqual([
      expect.objectContaining({ kind: 'zero-p-value', status: 'verified-as-printed' }),
    ])
  })
})

// ---------------------------------------------------------------------------
// The verdict cases from EVAL §1
// ---------------------------------------------------------------------------

describe('verify — EVAL adversarial triples', () => {
  it('interpunct decimal: quote 0·84, claim 0.84 -> verified', () => {
    const source = 'The primary hazard ratio was 0·84 in the endovascular group.'
    const v = verify(q({ value: 0.84, source_quote: 'hazard ratio was 0·84' }), source)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.flagged).toBe(false)
  })

  it('[false-verify guard] number-inside-a-number: claim 0.02, quote 0.028 -> flagged', () => {
    const source = 'The difference did not reach significance (p=0.028).'
    const v = verify(q({ value: 0.02, source_quote: 'significance (p=0.028)' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.found).toBe(true) // quote located
    expect(v.consistent).toBe(false) // but 0.02 is not a source number
  })

  it('leading-zero variant: claim 0.9, quote .90 -> verified', () => {
    const source = 'Sensitivity reached .90 across the cohort.'
    const v = verify(q({ value: 0.9, source_quote: 'reached .90 across' }), source)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })

  it('trailing-zero: claim 8, quote 8.0 -> verified (float-equal)', () => {
    const source = 'Mean lesion length was 8.0 cm.'
    const v = verify(q({ value: 8, source_quote: 'length was 8.0 cm' }), source)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })

  it('unicode dash in CI: en-dash range parses, claim CI -> verified', () => {
    const source = 'HR 0.84 (95% CI 0.61–1.16).'
    const v = verify(
      q({ value: 0.84, ci_low: 0.61, ci_high: 1.16, source_quote: 'HR 0.84 (95% CI 0.61–1.16)' }),
      source,
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.badNums).toEqual([])
  })

  it('reported estimate range: both endpoints verify as the result rather than a CI', () => {
    const source = 'The mean posterior probability ranged from 0.823–0.855 across models.'
    const v = verify(
      q({ value: null, range_low: 0.823, range_high: 0.855, source_quote: 'mean posterior probability ranged from 0.823–0.855' }),
      source,
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.badNums).toEqual([])
  })

  it('[false-verify guard] one wrong reported-range endpoint flags the whole quantity', () => {
    const source = 'Adjusted Cox models yielded HR 3.43–3.52.'
    const v = verify(
      q({ value: null, range_low: 3.43, range_high: 3.53, unit: 'HR', source_quote: 'HR 3.43–3.52' }),
      source,
    )
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.badNums).toContain(3.53)
  })

  it('[false-verify guard] rejects a partial range or a range collapsed beside a scalar', () => {
    const source = 'Adjusted Cox models yielded HR 3.43–3.52.'
    const partial = verify(
      q({ value: null, range_low: 3.43, range_high: null, source_quote: 'HR 3.43–3.52' }),
      source,
    )
    const collapsed = verify(
      q({ value: 3.43, range_low: 3.43, range_high: 3.52, source_quote: 'HR 3.43–3.52' }),
      source,
    )
    expect(partial.tier).toBe(TIERS.FLAGGED)
    expect(collapsed.tier).toBe(TIERS.FLAGGED)
    expect(partial.shapeError).toMatch(/exactly one declared shape/)
  })

  it('verifies a directional change without misclassifying it as a range', () => {
    const source = 'DCD HTx has increased from 2.4% to 9.5% during the study period.'
    const v = verify(q({
      quantity_type: 'change',
      value: null,
      range_low: null,
      range_high: null,
      first_label: null,
      first_value: 2.4,
      second_label: null,
      second_value: 9.5,
      source_quote: 'DCD HTx has increased from 2.4% to 9.5%',
    }), source)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.badNums).toEqual([])
  })

  it('verifies a comparison only when each value retains its source group label', () => {
    const source = 'Period 2 had a shorter median waitlist than period 1 (24 versus 40 days).'
    const quantity = {
      quantity_type: 'comparison',
      value: null,
      range_low: null,
      range_high: null,
      first_label: 'Period 2',
      first_value: 24,
      second_label: 'period 1',
      second_value: 40,
      source_quote: 'Period 2 had a shorter median waitlist than period 1 (24 versus 40 days)',
    }
    expect(verify(q(quantity), source).tier).toBe(TIERS.FULL_TEXT)
    expect(verify(q({ ...quantity, first_label: null }), source).tier).toBe(TIERS.FLAGGED)
    expect(verify(q({ ...quantity, first_label: 'Later cohort' }), source).tier).toBe(TIERS.FLAGGED)
  })

  it('[false-verify guard] rejects change or comparison values stored as a range', () => {
    const source = 'The rate increased from 2.4% to 9.5%.'
    const v = verify(q({
      quantity_type: 'change', value: null, range_low: 2.4, range_high: 9.5,
      first_label: null, first_value: null, second_label: null, second_value: null,
      source_quote: 'increased from 2.4% to 9.5%',
    }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.shapeError).toMatch(/labeled change/i)
  })

  it('[false-verify guard] integer collision: claim 84 (an N), quote has 1984 only -> flagged', () => {
    const source = 'The registry was first established in 1984 for vascular outcomes.'
    const v = verify(q({ value: 84, source_quote: 'established in 1984 for' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.consistent).toBe(false)
  })

  it('[false-verify guard] faithful quote, corrupted value: real sentence, value off by a digit -> flagged', () => {
    const source = 'The adjusted hazard ratio was 0.84 (P=0.22).'
    const v = verify(q({ value: 0.94, source_quote: 'hazard ratio was 0.84' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.found).toBe(true)
    expect(v.consistent).toBe(false)
    expect(v.badNums).toContain(0.94)
  })

  it('[false-verify guard] hallucinated quote not in text at all -> flagged', () => {
    const source = 'The adjusted hazard ratio was 0.84 (P=0.22).'
    const v = verify(
      q({ value: 0.55, source_quote: 'mortality was reduced by fifty-five percent overall' }),
      source,
    )
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.found).toBe(false)
  })

  it('table-cell value: location_hint names a table, value only in a table cell -> verified', () => {
    const prose = 'Outcomes are summarized in Table 2.'
    const tables = 'Table 2 Primary outcome | Endovascular | 12.5 | Surgery | 14.1'
    const v = verify(
      q({ value: 12.5, source_quote: 'Endovascular | 12.5', location_hint: 'Table 2' }),
      { text: prose, tables },
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.matched.corpus).toBe('tables')
  })

  it('p-value form: claim 0.001, quote P<0·001 -> verified (magnitude match; operator not enforced)', () => {
    const source = 'The effect was highly significant (P<0·001).'
    const v = verify(q({ value: 0.001, source_quote: 'significant (P<0·001)' }), source)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })
})

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

describe('verify — tier assignment', () => {
  it('BASIL-3-like full match -> verified-full-text', () => {
    const source =
      'For amputation-free survival the hazard ratio was 0.84 (97.5% CI 0.61 to 1.16, P=0.22).'
    const v = verify(
      q({
        value: 0.84,
        ci_low: 0.61,
        ci_high: 1.16,
        p_value: 0.22,
        source_quote: 'hazard ratio was 0.84 (97.5% CI 0.61 to 1.16, P=0.22)',
      }),
      source,
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.flagged).toBe(false)
  })

  it('registry triple-match (value + both CI bounds) -> verified-registry, reason names the measure', () => {
    const source = 'The between-group difference in TcPO2 was 11.2 mmHg (95% CI 8.0–14.5).'
    const v = verify(
      q({ value: 11.2, ci_low: 8.0, ci_high: 14.5, source_quote: 'difference in TcPO2 was 11.2 mmHg (95% CI 8.0–14.5)' }),
      source,
      { registry: [{ measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 11.2, ci_low: 8.0, ci_high: 14.5 }] },
    )
    expect(v.tier).toBe(TIERS.REGISTRY)
    expect(v.reason).toContain('Peripheral Transcutaneous Oxygen Pressure')
    expect(v.reason).toContain('95% CI')
  })

  it('registry value-only posted (no CI) + value match -> verified-registry', () => {
    // When the registry row posts no CI, the value-only gate applies.
    const source = 'The between-group difference in TcPO2 was 11.2 mmHg.'
    const v = verify(
      q({ value: 11.2, source_quote: 'difference in TcPO2 was 11.2 mmHg' }),
      source,
      { registry: [{ measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 11.2, ci_low: null, ci_high: null }] },
    )
    expect(v.tier).toBe(TIERS.REGISTRY)
    expect(v.reason).toContain('Peripheral Transcutaneous Oxygen Pressure')
  })

  it('registry triple-match against ANY of several posted rows -> verified-registry', () => {
    // A trial posts many analyses; the quantity need match only one of them.
    const source = 'The risk ratio for the primary end point was 1.91 (95% CI 1.26–2.90).'
    const v = verify(
      q({ value: 1.91, ci_low: 1.26, ci_high: 2.9, source_quote: 'risk ratio for the primary end point was 1.91 (95% CI 1.26–2.90)' }),
      source,
      {
        registry: [
          { measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 11.2, ci_low: 8.0, ci_high: 14.5 },
          { measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 1.91, ci_low: 1.26, ci_high: 2.9 },
        ],
      },
    )
    expect(v.tier).toBe(TIERS.REGISTRY)
  })

  it('[false-verify guard] value matches a CI-bearing registry row but quantity has NO CI -> full-text, not registry', () => {
    // A "mean follow-up 11.2 months" row would numerically equal the TcPO2 outcome value.
    // The registry row posts a CI, so a bare value must NOT earn the strongest badge.
    const source = 'The mean follow-up was 11.2 months across the cohort.'
    const v = verify(
      q({ value: 11.2, source_quote: 'mean follow-up was 11.2 months' }),
      source,
      { registry: [{ measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 11.2, ci_low: 8.0, ci_high: 14.5 }] },
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })

  it('[false-verify guard] value matches but one CI bound differs -> full-text, not registry', () => {
    const source = 'The between-group difference in TcPO2 was 11.2 mmHg (95% CI 8.0–14.9).'
    const v = verify(
      q({ value: 11.2, ci_low: 8.0, ci_high: 14.9, source_quote: 'difference in TcPO2 was 11.2 mmHg (95% CI 8.0–14.9)' }),
      source,
      { registry: [{ measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 11.2, ci_low: 8.0, ci_high: 14.5 }] },
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })

  it('registry provided but value differs from every posted outcome -> falls back to full-text', () => {
    const source = 'The between-group difference in TcPO2 was 11.2 mmHg.'
    const v = verify(
      q({ value: 11.2, source_quote: 'difference in TcPO2 was 11.2 mmHg' }),
      source,
      { registry: [{ measure: 'Some Other Outcome', value: 9.9, ci_low: null, ci_high: null }] },
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })

  it('found & consistent but abstract-only source -> abstract-only tier', () => {
    const source = 'In this abstract, the hazard ratio was 0.84.'
    const v = verify(
      q({ value: 0.84, source_quote: 'hazard ratio was 0.84' }),
      source,
      { sourceTier: 'abstract_only' },
    )
    expect(v.tier).toBe(TIERS.ABSTRACT)
  })
})

// ---------------------------------------------------------------------------
// Extra false-verify guards (not in EVAL, but the precision floor depends on them)
// ---------------------------------------------------------------------------

describe('verify — extra precision guards', () => {
  it('[false-verify guard] degenerate 1-char quote "8" inside "2008" -> flagged', () => {
    // Exact substring "8" is found inside 2008, but the source token 2008 is not
    // contained in the 1-char span, so no number is credited.
    const source = 'The cohort was assembled in 2008 from three centers.'
    const v = verify(q({ value: 8, source_quote: '8' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.consistent).toBe(false)
  })

  it('fuzzy match tolerates stray punctuation / reflow', () => {
    const source = 'The result, HR was 0.84, overall favorable.'
    // Quote omits the comma the source has -> exact fails, fuzzy (len>6) succeeds.
    const v = verify(q({ value: 0.84, source_quote: 'HR was 0.84 overall' }), source)
    expect(v.found).toBe(true)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })

  it('[false-verify guard] fuzzy match on a truncated value: source 0.842, quote 0.84 -> flagged', () => {
    // Exact fails on the comma; stripped-alnum containment holds ("hrwas084" in
    // "hrwas0842"). The source token 0.842 extends past the mapped span, so it is not
    // credited and the truncated 0.84 never verifies.
    const source = 'HR, was 0.842'
    const v = verify(q({ value: 0.84, source_quote: 'HR was 0.84' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.consistent).toBe(false)
    expect(v.badNums).toContain(0.84)
  })

  it('[false-verify guard] fuzzy match on a re-punctuated value: source 84, quote 8.4 -> flagged', () => {
    // Alnum-stripped forms are identical; the numbers must come from the SOURCE span,
    // where the token is 84, not the quote, where it is 8.4.
    const source = 'rate of 84 overall'
    const v = verify(q({ value: 8.4, source_quote: 'rate of 8.4 overall' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.consistent).toBe(false)
    expect(v.badNums).toContain(8.4)
  })

  it('fuzzy match still credits CI bounds inside the matched source span', () => {
    // Quote drops the comma after "CI" -> exact fails, fuzzy locates a real span that
    // fully contains all three source tokens.
    const source = 'HR 0.84 (95% CI, 0.61–1.16), overall favorable.'
    const v = verify(
      q({ value: 0.84, ci_low: 0.61, ci_high: 1.16, source_quote: 'HR 0.84 (95% CI 0.61–1.16) overall' }),
      source,
    )
    expect(v.matched.fuzzy).toBe(true)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.badNums).toEqual([])
  })

  it('fuzzy match recovers a real corpus offset for highlighting', () => {
    const source = 'The result, HR was 0.84, overall favorable.'
    const v = verify(q({ value: 0.84, source_quote: 'HR was 0.84 overall' }), source)
    expect(v.matched.fuzzy).toBe(true)
    expect(v.matched.index).toBeGreaterThanOrEqual(0)
    // The mapped span must actually contain the value in source text.
    const norm = 'the result, hr was 0.84, overall favorable.'
    expect(norm.slice(v.matched.index, v.matched.index + v.matched.length)).toContain('0.84')
  })

  it('[false-verify guard] one bad CI bound flags the whole tuple', () => {
    const source = 'HR 0.84 (95% CI 0.61–1.16).'
    const v = verify(
      q({ value: 0.84, ci_low: 0.61, ci_high: 1.99, source_quote: 'HR 0.84 (95% CI 0.61–1.16)' }),
      source,
    )
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.badNums).toContain(1.99)
  })

  it('[false-verify guard] empty / missing quote -> flagged, never crashes', () => {
    const v = verify(q({ value: 0.84, source_quote: '' }), 'HR was 0.84.')
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.found).toBe(false)
  })

  it('p-value inequality "P<0.001" with claim 0.001 does not over-credit a different magnitude', () => {
    const source = 'The effect was significant (P<0.001).'
    const v = verify(q({ value: 0.005, source_quote: 'significant (P<0.001)' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
  })

  it('thousands separator: quote "502,157", claim 502157 -> verified (regression: live UK Biobank N)', () => {
    const source = 'We used data from 502,157 UKBB participants for the external validation in the primary analysis.'
    const v = verify(q({ value: 502157, source_quote: 'data from 502,157 UKBB participants' }), source)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.flagged).toBe(false)
  })

  it('multi-group thousands: quote "1,234,567", claim 1234567 -> verified', () => {
    const source = 'The database held 1,234,567 records at baseline.'
    const v = verify(q({ value: 1234567, source_quote: 'held 1,234,567 records' }), source)
    expect(v.tier).toBe(TIERS.FULL_TEXT)
  })

  it('[false-verify guard] thousands value off by one: claim 502158, source "502,157" -> flagged', () => {
    const source = 'We used data from 502,157 UKBB participants.'
    const v = verify(q({ value: 502158, source_quote: 'data from 502,157 UKBB participants' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.badNums).toContain(502158)
  })

  it('[false-verify guard] thousands does not resurrect the degenerate quote: "8" inside "2,008" -> flagged', () => {
    const source = 'The cohort of 2,008 patients was assembled across three centers.'
    const v = verify(q({ value: 8, source_quote: '8' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.consistent).toBe(false)
  })

  it('negative effect difference with negative CI bounds -> verified (regression: live STARDUST CRP)', () => {
    const source = 'a significant reduction in levels of CRP (difference, −0.4 mg/dL; 95% CI, −0.7 to −0.07 mg/dL; P = .02)'
    const v = verify(
      q({
        value: -0.4,
        ci_low: -0.7,
        ci_high: -0.07,
        p_value: 0.02,
        source_quote: 'difference, −0.4 mg/dL; 95% CI, −0.7 to −0.07 mg/dL; P = .02',
      }),
      source,
    )
    expect(v.tier).toBe(TIERS.FULL_TEXT)
    expect(v.badNums).toEqual([])
  })

  it('[false-verify guard] a sign flip is still caught: claim +0.4 where source says -0.4 -> flagged', () => {
    const source = 'the treatment difference was -0.4 mg/dL overall'
    const v = verify(q({ value: 0.4, source_quote: 'difference was -0.4 mg/dL' }), source)
    expect(v.tier).toBe(TIERS.FLAGGED)
    expect(v.badNums).toContain(0.4)
  })
})
