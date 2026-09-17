// Anonymous usage counts (netlify/functions/count.mts): the event name and the
// referring site, nothing about the visitor or the manuscript. Counting must
// never get in the way, so every failure is swallowed.
const ENDPOINT = '/api/count'

function send(event) {
  if (!import.meta.env.PROD) return
  try {
    const body = JSON.stringify({ event, ref: document.referrer })
    fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {})
  } catch { /* not worth surfacing */ }
}

// When storage is blocked, a visit still counts but is never called new.
function once(storage, key, whenBlocked) {
  try {
    if (storage.getItem(key)) return false
    storage.setItem(key, '1')
    return true
  } catch {
    return whenBlocked
  }
}

// One visit per tab session; "new" the first time this browser ever opens it.
export function countVisit() {
  if (!once(sessionStorage, 'cv-visit-counted', true)) return
  send('visit')
  if (once(localStorage, 'cv-seen', false)) send('new')
}

export const countEvent = send
