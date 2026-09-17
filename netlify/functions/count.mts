import type { Config, Context } from '@netlify/functions'
import { getStore, getDeployStore } from '@netlify/blobs'

// Anonymous usage counter. One empty blob per event, keyed
// hits/<day>/<event>/<referring site>/<random id>, so nothing has to be
// read-modified-written (no lost counts when visits arrive together) and the
// totals are just a listing. No IP address, cookie, user agent or visitor id
// is kept — only the day, the event name and the site the visitor came from.
const EVENTS = ['visit', 'new', 'import', 'check']

function store() {
  // Preview and branch deploys must not add to the production numbers.
  return Netlify.context?.deploy?.context === 'production' ? getStore('usage') : getDeployStore('usage')
}

function referrerHost(value: unknown) {
  try {
    const host = new URL(String(value)).hostname.replace(/^www\./, '').toLowerCase()
    return /^[a-z0-9.-]{1,80}$/.test(host) ? host : 'direct'
  } catch {
    return 'direct'
  }
}

async function record(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (!EVENTS.includes(body?.event)) return new Response(null, { status: 400 })
  const day = new Date().toISOString().slice(0, 10)
  await store().set(`hits/${day}/${body.event}/${referrerHost(body.ref)}/${crypto.randomUUID()}`, '')
  return new Response(null, { status: 204 })
}

async function report(req: Request) {
  const wantJson = new URL(req.url).searchParams.get('format') === 'json'
  const days: Record<string, Record<string, number>> = {}
  const referrers: Record<string, number> = {}
  const totals: Record<string, number> = Object.fromEntries(EVENTS.map((event) => [event, 0]))
  const { blobs } = await store().list({ prefix: 'hits/' })
  for (const { key } of blobs) {
    const [, day, event, ref] = key.split('/')
    if (!EVENTS.includes(event)) continue
    days[day] ??= Object.fromEntries(EVENTS.map((name) => [name, 0]))
    days[day][event] += 1
    totals[event] += 1
    if (event === 'visit') referrers[ref] = (referrers[ref] || 0) + 1
  }
  if (wantJson) return Response.json({ totals, days, referrers })

  const dayRows = Object.keys(days).sort().reverse()
    .map((day) => `<tr><td>${day}</td>${EVENTS.map((event) => `<td>${days[day][event]}</td>`).join('')}</tr>`).join('')
  const refRows = Object.entries(referrers).sort((a, b) => b[1] - a[1])
    .map(([ref, count]) => `<tr><td>${ref}</td><td>${count}</td></tr>`).join('')
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Citation Verifier usage</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1c1917;background:#fafaf9}
@media(prefers-color-scheme:dark){body{color:#e7e5e4;background:#1c1917}}
table{border-collapse:collapse;width:100%;margin:.5rem 0 2rem}td,th{text-align:right;padding:.3rem .6rem;border-bottom:1px solid #a8a29e55}
td:first-child,th:first-child{text-align:left}p{color:#78716c}</style>
<h1>Citation Verifier usage</h1>
<p>Visits = a tab opening the page. New = first time on that browser. Imports = a manuscript was read. Checks = a citation check was started. Days are UTC. Bots that do not run JavaScript are not counted.</p>
<table><tr><th>Day</th><th>Visits</th><th>New</th><th>Imports</th><th>Checks</th></tr>
<tr><th>All time</th>${EVENTS.map((event) => `<th>${totals[event]}</th>`).join('')}</tr>${dayRows}</table>
<h2>Where visits came from</h2><table><tr><th>Site</th><th>Visits</th></tr>${refRows || '<tr><td>none yet</td><td></td></tr>'}</table>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

export default async (req: Request, _context: Context) => {
  if (req.method === 'POST') return record(req)
  if (req.method === 'GET') return report(req)
  return new Response(null, { status: 405 })
}

export const config: Config = { path: '/api/count' }
