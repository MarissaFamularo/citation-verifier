// lib/manuscriptCitations.js — the sentences from the team's manuscript that
// cite each collected paper, with verified support checks.
//
// Same division of labor as everywhere in PaperTrellis: the model only
// PROPOSES ("this paper supports the sentence, and here is the passage that
// proves it"); the app DISPOSES by locating that passage verbatim in the
// fetched source text before any Supported badge renders. A supported claim
// whose quote can't be located is shown as unproven, never as supported —
// and a Supported badge is clickable, opening the source with the passage
// highlighted (the same click-to-source contract as the evidence panel).

import { extractStructured, MODELS } from './anthropic.js'
import { buildSourceBlock, SOURCE_CHAR_CAP } from './sourceBlock.js'
import { stripCitationMarkers } from './manuscriptImport.js'
import { extractNumbers, extractNumbersWithIndex, normalize, numbersEqual } from './paperVerify.js'
import { findQuoteSpan } from './sourceLocate.js'

export const SUPPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supported', 'relation', 'reason', 'source_quote', 'quote_location'],
  properties: {
    supported: { type: 'boolean', description: 'True only when the source text itself backs the sentence as cited.' },
    relation: { type: 'string', enum: ['supports', 'contradicts', 'off_topic', 'silent'], description: 'supports: the source backs the claim. contradicts: the source states the opposite, or the sentence overstates what the source reports. off_topic: the source is about a different subject than the claim (a different intervention, exposure, or question), so reading more of it would not help. silent: the source is on the right subject but the provided text does not address this specific claim.' },
    reason: { type: 'string', description: 'One clause a teammate can act on.' },
    source_quote: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The verbatim passage from the source text that best backs the sentence, or null when unsupported.' },
    quote_location: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Where the quote is, e.g. "Results" or "Table 2".' },
  },
}

const SUPPORT_SYSTEM = `You audit one citation in a medical research manuscript. The team's manuscript cites ONE paper for a sentence; you get the sentence and that paper's source text. Judge ONLY whether the paper, as represented by its source text, supports citing it for that sentence.

Rules:
- The manuscript sentence is the team's own paraphrase. It will NOT appear in the source text and is not expected to — judge whether the source backs the CLAIM, never whether the wording matches.
- supported=true only when the source text itself backs the sentence's claim: the direction of effect, what is compared to what, the population, and any magnitude the sentence states. A sentence may bundle several claims backed by several citations; supported=true if the source backs the claim(s) this paper is plausibly cited for, even when it does not cover every clause.
- When supported, copy into source_quote the single passage from the source text that best backs the sentence — VERBATIM, an exact substring, character for character. Do not paraphrase, re-punctuate, or clean up numbers. quote_location names where it sits (e.g. "Results" or "Table 2").
- If you cannot find an exact supporting passage, set supported=false. Never fabricate or reconstruct a quote.
- supported=false when the source contradicts the sentence, does not address its claim, or the sentence overstates the source (the source's "may" cited as "does"; a non-significant result cited as a benefit).
- relation says WHY: "supports" exactly when supported=true; otherwise "contradicts" (the source says the opposite, or the sentence overstates it), "off_topic" (the source studies something else — e.g. cited for a drug effect but it is a trial of two surgical strategies that never involves that drug), or "silent" (right subject, but the provided text — often only an abstract — does not reach this specific claim). Silence is not contradiction.
- Never use outside knowledge about the paper, the field, or the manuscript. The provided source text is the whole universe.

The app will verify source_quote is an exact substring of the source text before showing any Supported badge; an unlocatable quote is discarded. When genuinely uncertain, refute — an unsupported citation shown as supported is the one fatal failure.`

function clean(value) {
  return String(value ?? '').trim()
}

// --- the sentence's own numbers, checked against the paper (deterministic) ---

// Every substantive number the manuscript sentence states must be printed
// somewhere in the cited paper's text — the deterministic side of the check,
// no model involved. Citation-marker digits are stripped first; publication
// years and small prose counts ("two arms", "9-year") are skipped as noise.
export function checkSentenceNumbers(sentence, source) {
  const cleaned = stripCitationMarkers(clean(sentence))
  const normalizedSentence = normalize(cleaned)
  const corpus = normalize(`${clean(source?.text).slice(0, SOURCE_CHAR_CAP)}\n${clean(source?.tables)}`)
  const corpusNumbers = extractNumbers(corpus)
  const seen = new Set()
  const results = []
  for (const token of extractNumbersWithIndex(normalizedSentence)) {
    const raw = normalizedSentence.slice(token.start, token.end)
    const wholeNumber = Number.isInteger(token.value) && !raw.includes('.')
    if (wholeNumber && token.value >= 1900 && token.value <= 2035) continue // year
    if (wholeNumber && Math.abs(token.value) <= 12) continue // prose count
    if (seen.has(raw)) continue
    seen.add(raw)
    results.push({ token: raw, found: corpusNumbers.some((n) => numbersEqual(n, token.value)) })
  }
  return results
}

// --- verdict assembly (pure, tested) -----------------------------------------

// Turn the model's proposal into a storable verdict, with the app-side proof:
// 'supported' ONLY when the proposed quote is located verbatim in the corpus
// AND every substantive number the sentence states is printed in the paper.
export function buildSupportVerdict(result, source, numbers = []) {
  const tier = source?.tier === 'full_text' ? 'full_text' : 'abstract_only'
  if (!result?.supported) {
    // An abstract that is silent on the claim proves nothing either way: the
    // support may sit in the paper's body. Only a contradiction, or silence
    // from the full text, is a finding against the citation.
    const relation = result?.relation || (result?.contradicted ? 'contradicts' : 'silent')
    const unverified = tier === 'abstract_only' && relation === 'silent'
    return {
      verdict: unverified ? 'unverified' : 'refuted',
      relation,
      reason: unverified
        ? `Not found in the abstract — the full text is needed to judge this. ${clean(result?.reason)}`.trim()
        : clean(result?.reason) || 'The source audit could not support this sentence.',
      tier,
      numbers,
    }
  }
  const quote = clean(result.source_quote)
  if (!quote) {
    return {
      verdict: 'flagged',
      reason: 'The audit judged the sentence supported but could not point to the passage in the paper that proves it, so nothing could be proven.',
      numbers,
    }
  }
  const inText = findQuoteSpan(source?.text, quote)
  const inTables = inText ? null : findQuoteSpan(source?.tables, quote)
  if (!inText && !inTables) {
    return {
      verdict: 'flagged',
      reason: "The claimed supporting passage could not be located in the paper's text, so it was discarded.",
      numbers,
    }
  }
  const missing = numbers.filter((number) => !number.found)
  if (missing.length) {
    return {
      verdict: 'flagged',
      reason: `The prose is supported, but ${missing.map((number) => number.token).join(', ')} in your sentence ${missing.length === 1 ? 'was' : 'were'} not found anywhere in the paper's text — check the figure${missing.length === 1 ? '' : 's'}.`,
      quote,
      quote_location: clean(result.quote_location) || null,
      tier,
      numbers,
    }
  }
  return {
    verdict: 'supported',
    reason: clean(result.reason),
    quote,
    quote_location: clean(result.quote_location) || null,
    tier,
    numbers,
  }
}

export function buildSupportContent({ sentence, source }) {
  const { block } = buildSourceBlock(source)
  return `MANUSCRIPT SENTENCE (cites this paper):\n“${clean(sentence)}”\n\n${block}`
}

// --- the check ----------------------------------------------------------------

// One model call, then the deterministic gates: the supporting quote must be
// located in the paper, and the sentence's own numbers must be printed in it.
export async function checkCitationSupport({ sentence, source, model = MODELS.chat }) {
  const result = await extractStructured({
    model,
    system: SUPPORT_SYSTEM,
    content: buildSupportContent({ sentence, source }),
    schema: SUPPORT_SCHEMA,
    maxTokens: 2048,
  })
  return buildSupportVerdict(result, source, checkSentenceNumbers(sentence, source))
}

// Group rows for per-paper display. Map key is the literature row id.
export function groupCitationsByPaper(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const list = map.get(row.literature_id) || []
    list.push(row)
    map.set(row.literature_id, list)
  }
  return map
}

