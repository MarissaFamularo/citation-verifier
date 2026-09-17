// lib/sourceLocate.js — find a verified quote inside the fetched source text
// so the UI can show it highlighted in context (Verastar's click-to-source,
// ported for PaperTrellis).
//
// Deterministic, display-side only: verification verdicts come from
// paperVerify.js; this locates the already-verified quote in the ORIGINAL
// (un-normalized) corpus for highlighting. Matching is therefore tolerant of
// exactly the variations paperVerify normalizes — whitespace reflow, dash
// variants, middle-dot decimals, casing — and nothing else.

const DASH_CHARS = '‐‑‒–—−－-'
const MIDDLE_DOT_CHARS = '·‧⋅∙•'

// Build a regex source string that matches the quote with tolerant whitespace,
// dashes, and middle-dot decimals. Pure string → string, no flags.
export function tolerantQuotePattern(quote) {
  let out = ''
  for (const ch of String(quote ?? '').trim()) {
    if (/\s/.test(ch)) {
      out += '\\s+'
    } else if (DASH_CHARS.includes(ch)) {
      out += `[${DASH_CHARS}]`
    } else if (ch === '.' || MIDDLE_DOT_CHARS.includes(ch)) {
      // A period and a middle-dot decimal (0.84 vs 0·84) match either way.
      out += `[${MIDDLE_DOT_CHARS}.]`
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out.replace(/(?:\\s\+)+/g, '\\s+')
}

// Locate the quote span [start, end) in the original corpus. Exact substring
// first, then tolerant, then tolerant case-insensitive. null if unfound.
export function findQuoteSpan(corpus, quote) {
  const text = String(corpus ?? '')
  const q = String(quote ?? '').trim()
  if (!q || !text) return null

  const exact = text.indexOf(q)
  if (exact !== -1) return [exact, exact + q.length]

  const pattern = tolerantQuotePattern(q)
  for (const flags of ['', 'i']) {
    try {
      const m = new RegExp(pattern, flags).exec(text)
      if (m) return [m.index, m.index + m[0].length]
    } catch {
      /* pathological quote — fall through to no-highlight */
    }
  }
  return null
}

// Pick which corpus (prose or tables) the quote lives in. Always returns a
// viewable result: when the quote can't be aligned anywhere, the prose corpus
// is returned with found:false so the viewer can still show the source with an
// honest "couldn't align the highlight" note.
export function locateQuote(source, quote) {
  const corpora = [
    { corpusLabel: 'text', corpusText: String(source?.text ?? '') },
    { corpusLabel: 'tables', corpusText: String(source?.tables ?? '') },
  ]
  for (const corpus of corpora) {
    if (!corpus.corpusText.trim()) continue
    const span = findQuoteSpan(corpus.corpusText, quote)
    if (span) return { ...corpus, span, found: true }
  }
  return { ...corpora[0], span: null, found: false }
}
