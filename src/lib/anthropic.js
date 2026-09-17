// lib/anthropic.js — BYOK Anthropic client for the project bot.
//
// Adapted from Verastar's lib/anthropic.js so both apps keep the same key
// doctrine: the API key lives in browser storage ONLY (never repo, file,
// IndexedDB, logs, or a server). Default is sessionStorage — cleared when the
// tab closes. "Remember on this device" opts into localStorage instead. Every
// model call in PaperTrellis goes through this module so there is exactly one
// place that touches the key.
//
// Facts carried over from Verastar's docs/FACTS.md:
//   - new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
//   - current models REJECT temperature / top_p / top_k (400)
//   - adaptive thinking can truncate long outputs — the bot doesn't enable it
//   - structured output: output_config: { format: { type: "json_schema", schema } }
//   - do NOT combine citations with output_config.format (400) -> separate calls

import Anthropic from '@anthropic-ai/sdk'

const KEY_STORAGE = 'citationverifier.anthropic_key'
const NCBI_KEY_STORAGE = 'citationverifier.ncbi_key'
const USAGE_STORAGE = 'citationverifier.anthropic_usage.v1'

export const MODELS = {
  chat: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5-20251001',
}

// Browser-local spend ledger. Anthropic returns token usage on every successful
// response, so record it before anything else can fail. Prices are USD per
// million tokens; Sonnet 5's introductory rate ends after 2026-08-31.
export function modelRates(model, now = new Date()) {
  if (String(model).includes('haiku-4-5')) return { input: 1, output: 5 }
  if (String(model).includes('sonnet-5')) {
    return now < new Date('2026-09-01T00:00:00Z') ? { input: 2, output: 10 } : { input: 3, output: 15 }
  }
  return { input: 3, output: 15 }
}

function readUsage() {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : { calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }
  } catch {
    return { calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }
  }
}

export function recordUsage(model, usage, now = new Date()) {
  const input = Number(usage?.input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0)
  const cached = Number(usage?.cache_read_input_tokens || 0)
  const output = Number(usage?.output_tokens || 0)
  const rates = modelRates(model, now)
  const cost = ((input * rates.input) + (cached * rates.input * 0.1) + (output * rates.output)) / 1_000_000
  const prev = readUsage()
  const next = {
    calls: Number(prev.calls || 0) + 1,
    inputTokens: Number(prev.inputTokens || 0) + input + cached,
    outputTokens: Number(prev.outputTokens || 0) + output,
    estimatedUsd: Number(prev.estimatedUsd || 0) + cost,
    updatedAt: now.toISOString(),
  }
  try { localStorage.setItem(USAGE_STORAGE, JSON.stringify(next)) } catch { /* private mode */ }
  return next
}

export function getUsageSummary() {
  return readUsage()
}

// --- credential management (session-backed by default, localStorage when remembered) ---

// The key lives in exactly ONE of the two stores at a time: remember=true moves
// it to localStorage (survives tab close, this device only), remember=false
// keeps it in sessionStorage (gone on tab close).
export function setApiKey(key, { remember = false } = {}) {
  const trimmed = String(key || '').trim()
  if (!trimmed) {
    sessionStorage.removeItem(KEY_STORAGE)
    localStorage.removeItem(KEY_STORAGE)
    return
  }
  if (remember) {
    localStorage.setItem(KEY_STORAGE, trimmed)
    sessionStorage.removeItem(KEY_STORAGE)
  } else {
    sessionStorage.setItem(KEY_STORAGE, trimmed)
    localStorage.removeItem(KEY_STORAGE)
  }
}

export function getApiKey() {
  return sessionStorage.getItem(KEY_STORAGE) || localStorage.getItem(KEY_STORAGE) || ''
}

export function hasApiKey() {
  return getApiKey().length > 0
}

export function isKeyRemembered() {
  return !!localStorage.getItem(KEY_STORAGE)
}

export function clearApiKey() {
  sessionStorage.removeItem(KEY_STORAGE)
  localStorage.removeItem(KEY_STORAGE)
  sessionStorage.removeItem(NCBI_KEY_STORAGE)
  localStorage.removeItem(NCBI_KEY_STORAGE)
}

// Optional free NCBI API key: raises eutils from 3 -> 10 req/s, which speeds up
// reference imports and full-text fetches. Same storage policy as the
// Anthropic key (session by default, localStorage on remember), and cleared
// together with it.
export function setNcbiKey(key, { remember = false } = {}) {
  const trimmed = String(key || '').trim()
  if (!trimmed) {
    sessionStorage.removeItem(NCBI_KEY_STORAGE)
    localStorage.removeItem(NCBI_KEY_STORAGE)
    return
  }
  if (remember) {
    localStorage.setItem(NCBI_KEY_STORAGE, trimmed)
    sessionStorage.removeItem(NCBI_KEY_STORAGE)
  } else {
    sessionStorage.setItem(NCBI_KEY_STORAGE, trimmed)
    localStorage.removeItem(NCBI_KEY_STORAGE)
  }
}

export function getNcbiKey() {
  return sessionStorage.getItem(NCBI_KEY_STORAGE) || localStorage.getItem(NCBI_KEY_STORAGE) || ''
}

// --- client ---

let _client = null
let _clientKey = null

// Returns a memoized Anthropic client bound to the current key. Rebuilds if the
// key changed. Throws if no key is set — callers should gate on hasApiKey().
export function getClient() {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Anthropic API key set.')
  }
  if (!_client || _clientKey !== apiKey) {
    _client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
    _clientKey = apiKey
  }
  return _client
}

// One multi-turn chat call. `messages` is [{ role: 'user'|'assistant', content }].
// Returns { text, usage, model, stopReason } — a max_tokens stop means the reply
// was cut off, which the UI surfaces rather than hiding.
export async function chatCompletion({ system, messages, model = MODELS.chat, maxTokens = 2048 }) {
  const client = getClient()
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
  })
  recordUsage(model, res.usage)
  const text = (res.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
  return { text, usage: res.usage, model, stopReason: res.stop_reason || null }
}

// --- structured output (ported from Verastar's lib/anthropic.js) ---

export class StructuredOutputError extends Error {
  constructor(message, { stopReason = null, retryable = false } = {}) {
    super(message)
    this.name = 'StructuredOutputError'
    this.stopReason = stopReason
    this.retryable = retryable
  }
}

// A 200 response is not necessarily complete. Structured output can still be
// cut off at the output or context limit, and parsing that partial text only
// reports a misleading raw SyntaxError. Classify the response first so callers
// can retry the right failures.
export function parseStructuredResponse(res) {
  const stopReason = res?.stop_reason || null
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    throw new StructuredOutputError('The assistant\'s structured output was incomplete.', { stopReason, retryable: true })
  }
  if (stopReason === 'refusal') {
    throw new StructuredOutputError('The assistant declined this structured-output request.', { stopReason })
  }
  if (stopReason && stopReason !== 'end_turn') {
    throw new StructuredOutputError(`The assistant stopped structured output early (${stopReason}).`, { stopReason })
  }

  const text = (res?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (!text.trim()) {
    throw new StructuredOutputError('The assistant returned no structured output.', { stopReason, retryable: true })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new StructuredOutputError('The assistant returned incomplete structured output.', { stopReason, retryable: true })
  }
}

// Structured-output call. `schema` is a JSON Schema per the output_config
// contract (additionalProperties:false + required on every object; nullable
// via anyOf; no minimum/maximum/minLength/recursion). Returns the parsed object.
//
// Streamed, not create(): with a large maxTokens budget the SDK refuses a
// non-streaming request ("Streaming is required for operations that may take
// longer than 10 minutes"). finalMessage() yields the same response shape a
// non-streaming call returns, so nothing downstream changes.
export async function extractStructured({ model = MODELS.fast, system, content, schema, maxTokens = 4096, thinking }) {
  const client = getClient()
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(thinking ? { thinking } : {}),
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
  })
  const res = await stream.finalMessage()
  recordUsage(model, res.usage)
  return parseStructuredResponse(res)
}
