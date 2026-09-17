// lib/ncbiThrottle.js — one queue for every request to NCBI eutils.
//
// eutils allows 3 requests a second without an API key and 10 with one. Past
// that it answers 429 without a CORS header, which a browser reports as a bare
// network failure — and a failed full-text lookup used to fall back to the
// abstract silently. Spacing the requests here keeps the whole app (reference
// matching, PMC lookups, several citation checks running at once) under the
// limit.

let nextSlot = 0

export function ncbiIntervalMs(hasKey) {
  return hasKey ? 110 : 350
}

export async function ncbiFetch(url, options, { hasKey = false, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const start = Math.max(now(), nextSlot)
  nextSlot = start + ncbiIntervalMs(hasKey)
  const wait = start - now()
  if (wait > 0) await sleep(wait)
  return fetchImpl(url, options)
}

export function resetNcbiThrottle() {
  nextSlot = 0
}
