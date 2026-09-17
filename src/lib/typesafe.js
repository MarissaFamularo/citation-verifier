// lib/typesafe.js — the second opinion: TypeSafe's System One model (Jev)
// scores how well a passage from the cited paper supports the citing sentence.
//
// Jev does not generate text; it answers one typed Choice question and returns
// a probability for every option. Claude finds and proves the quote; Jev reads
// the sentence next to the passage and says how sure it is. The reliability
// mark shown in the review table is P(supports).
//
// Same key doctrine as lib/anthropic.js: the key lives in browser storage only
// (sessionStorage by default, localStorage on "remember"). Every TypeSafe call
// goes through callSystemOne.
//
// TypeSafe's API refuses browser requests (no CORS header), so the call goes to
// a same-origin path that the host forwards untouched to api.typesafe.ai — a
// Netlify rewrite in production (netlify.toml), the Vite proxy in development
// (vite.config.js). The pass-through stores and logs nothing; the key still
// comes from this browser on every request.

import { stripCitationMarkers } from './manuscriptImport.js'
import { findQuoteSpan } from './sourceLocate.js'

const KEY_STORAGE = 'citationverifier.typesafe_key'
const ENDPOINT = import.meta.env?.VITE_TYPESAFE_ENDPOINT || '/api/typesafe/systemone'

// Pinned, not `jev-latest`: review thresholds are tuned against one version,
// and the response reports which model answered so every mark is attributable.
export const JEV_MODEL = 'jev-1.13.0'

// Jev's accuracy falls as state fills with irrelevant text, so it never gets
// the whole paper: a window around Claude's proven quote, or the opening of
// the source (the abstract) when there is no quote to anchor on.
export const PASSAGE_WINDOW_CHARS = 1_500
export const PASSAGE_FALLBACK_CHARS = 6_000

export const AUTO_CONFIDENCE = 0.8

export function setTypesafeKey(key, { remember = false } = {}) {
  const trimmed = String(key || '').trim()
  sessionStorage.removeItem(KEY_STORAGE)
  localStorage.removeItem(KEY_STORAGE)
  if (!trimmed) return
  ;(remember ? localStorage : sessionStorage).setItem(KEY_STORAGE, trimmed)
}

export function getTypesafeKey() {
  return sessionStorage.getItem(KEY_STORAGE) || localStorage.getItem(KEY_STORAGE) || ''
}

export function hasTypesafeKey() {
  return getTypesafeKey().length > 0
}

// --- the question (pure) -------------------------------------------------------

// Jev reads literally, so the instruction states the exact condition and the
// criteria carry the boundary cases (paraphrase is fine; overstatement is not).
export const SUPPORT_QUESTION = {
  type: 'choice',
  instructions: 'A manuscript cites a paper for `sentence`. `passage` is text from that cited paper. The sentence is a paraphrase and will not match the passage word for word. How does `passage` relate to the claim made in `sentence`?',
  criteria: {
    supports: 'The passage states the claim or directly implies it is true, with the same direction of effect, comparison, and population.',
    contradicts: 'The passage states the opposite of the claim, reports no significant effect where the sentence claims one, or the sentence overstates what the passage says.',
    says_nothing: 'The passage does not address what the sentence claims, either way.',
  },
}

// The passage Jev reads. With a proven quote: the quote plus surrounding
// context. Without one: the opening of the source text.
export function selectPassage(source, quote) {
  const text = String(source?.text ?? '')
  const span = quote ? findQuoteSpan(text, quote) : null
  if (span) {
    const start = Math.max(0, span[0] - PASSAGE_WINDOW_CHARS)
    const end = Math.min(text.length, span[1] + PASSAGE_WINDOW_CHARS)
    return { passage: text.slice(start, end).trim(), anchored: true }
  }
  if (quote) return { passage: String(quote).trim(), anchored: true }
  return { passage: text.slice(0, PASSAGE_FALLBACK_CHARS).trim(), anchored: false }
}

// Marker removal leaves "risk ." behind; close the gap so Jev reads prose.
export function cleanSentence(sentence) {
  return stripCitationMarkers(String(sentence ?? '')).replace(/\s+([.,;:?!])/g, '$1').replace(/\s+/g, ' ').trim()
}

export function buildJevRequest({ sentence, passage, model = JEV_MODEL }) {
  return {
    model,
    state: { sentence: cleanSentence(sentence), passage },
    questions: { relation: SUPPORT_QUESTION },
  }
}

// Fold the raw answer into what the table shows. `reliability` is P(supports);
// `confidence` is how concentrated the distribution is — low means Jev itself
// is unsure and a human should look regardless of the verdict.
export function interpretJev(response, { anchored = false } = {}) {
  const answer = response?.answers?.relation
  if (!answer || answer.type !== 'choice') throw new Error('TypeSafe returned no answer for this citation.')
  const probabilities = answer.probabilities || {}
  return {
    relation: answer.choice,
    reliability: Number(probabilities.supports ?? 0),
    probabilities,
    confidence: Number(answer.confidence ?? 0),
    needsReview: Number(answer.confidence ?? 0) < AUTO_CONFIDENCE,
    anchored,
    model: response.model || null,
    inputTokens: Number(response?.usage?.input_tokens || 0),
  }
}

// --- the call ------------------------------------------------------------------

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

export async function callSystemOne(body, { signal, fetchImpl = fetch, retries = 3 } = {}) {
  const key = getTypesafeKey()
  if (!key) throw new Error('No TypeSafe API key set.')
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (res.ok) return res.json()
    if (RETRY_STATUSES.has(res.status) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      continue
    }
    const detail = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new Error('TypeSafe rejected the API key.')
    throw new Error(`TypeSafe request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
}

export async function scoreCitationSupport({ sentence, source, quote = null, signal }) {
  const { passage, anchored } = selectPassage(source, quote)
  if (!passage) throw new Error('No passage text is available to score.')
  const response = await callSystemOne(buildJevRequest({ sentence, passage }), { signal })
  return interpretJev(response, { anchored })
}
