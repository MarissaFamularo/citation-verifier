// lib/pdfLayout.js — turn positioned PDF text into manuscript text the
// importer can read. Pure: takes pages of { str, x, y, w, h } items (PDF
// coordinates, y up) and returns a string. No PDF library in here.
//
// Copy-pasting from a PDF viewer loses exactly what citation checking needs,
// so this works from geometry instead:
//   - superscript citation numbers are found by size and baseline, and kept as
//     ^{...} markers (the same marker the .docx reader emits) — a flattened
//     superscript is indistinguishable from data;
//   - two-column pages are read column by column, so a reference number in
//     its hanging indent stays on the line of the entry it numbers;
//   - running headers/footers are dropped, hard-wrapped lines are rejoined and
//     de-hyphenated, and headings / numbered reference entries start a new line.

const SUP_TEXT_RE = /^[\d,;–—‐-]+$/
const ENTRY_START_RE = /^(?:\[\d{1,3}\]|\d{1,3}[.)])\s+\S/
const HEADING_RE = /^\s*(?:\d+[.)]?\s*)?(abstract|introduction|background|methods|online methods|materials and methods|patients and methods|results|discussion|conclusions?|limitations|references|bibliography|literature cited|works cited|reference list|acknowledge?ments|data availability|code availability|author contributions|competing interests|funding|supplementary (?:information|material)|additional information|extended data|online content|reporting summary|ethics statement)\s*:?\s*$/i

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// The size most of the document's characters are set in.
export function bodyHeight(pages) {
  const weight = new Map()
  for (const page of pages) {
    for (const item of page.items) {
      if (!item.h || !item.str.trim()) continue
      const key = Math.round(item.h * 2) / 2
      weight.set(key, (weight.get(key) || 0) + item.str.length)
    }
  }
  let best = 0
  let bestWeight = -1
  for (const [height, total] of weight) if (total > bestWeight) { best = height; bestWeight = total }
  return best
}

// The x that splits a two-column page: the least-inked position in the middle
// band. On a single-column page nearly every line crosses it, which is fine —
// crossing lines are simply read top to bottom.
function gutterX(items, width) {
  const lo = Math.floor(width * 0.4)
  const hi = Math.ceil(width * 0.6)
  const ink = new Array(hi - lo + 1).fill(0)
  for (const item of items) {
    const from = Math.max(lo, Math.floor(item.x))
    const to = Math.min(hi, Math.ceil(item.x + item.w))
    for (let x = from; x <= to; x += 1) ink[x - lo] += 1
  }
  const center = width / 2
  let best = lo
  for (let x = lo; x <= hi; x += 1) {
    const better = ink[x - lo] < ink[best - lo]
      || (ink[x - lo] === ink[best - lo] && Math.abs(x - center) < Math.abs(best - center))
    if (better) best = x
  }
  return best
}

// Group items into lines by baseline. Small raised items (superscripts) join
// the line whose baseline sits just below them.
function buildLines(items, body) {
  const isSmall = (item) => item.h < body * 0.75
  const base = items.filter((item) => !isSmall(item)).sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const item of base) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= Math.max(2, item.h * 0.3))
    if (line) line.items.push(item)
    else lines.push({ y: item.y, items: [item] })
  }
  for (const item of items.filter(isSmall)) {
    let target = null
    for (const line of lines) {
      const rise = item.y - line.y
      if (rise < -1 || rise > body * 0.9) continue
      if (!target || Math.abs(rise) < Math.abs(item.y - target.y)) target = line
    }
    if (target) target.items.push({ ...item, small: true, raised: item.y - target.y > body * 0.2 })
    else lines.push({ y: item.y, items: [item] })
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x)
    line.x = line.items[0].x
    line.h = Math.max(...line.items.map((item) => item.h))
  }
  return lines.sort((a, b) => b.y - a.y)
}

// One line's text. A raised, digits-only item glued to the text before it is a
// citation superscript; anything else small (affiliation marks, footnote
// symbols) is kept as plain text.
function lineText(line, body) {
  let out = ''
  let prev = null
  let afterMarker = false
  for (const item of line.items) {
    const str = item.str
    if (!str) continue
    const gap = prev ? item.x - (prev.x + prev.w) : 0
    const glued = prev && gap < body * 0.12 && !/\s$/.test(out)
    const bodySized = Math.abs(line.h - body) <= body * 0.12
    if (item.small && item.raised && glued && bodySized && SUP_TEXT_RE.test(str.trim()) && /[\p{L}\p{N})\]”’"'.,;:]$/u.test(out)) {
      out += `^{${str.trim()}}`
      afterMarker = true
    } else {
      if (afterMarker && /^[\p{L}(]/u.test(str)) out += ' '
      afterMarker = false
      if (prev && gap > Math.min(body, prev.h || body) * 0.15 && !/\s$/.test(out) && !/^\s/.test(str)) out += ' '
      out += str
    }
    prev = item
  }
  return out.replace(/\}\^\{/g, '').replace(/\s+/g, ' ').trim()
}

// Reading order for one page: lines that cross the gutter are read where they
// fall; between them, the left column is read before the right.
export function pageLines(page, body) {
  const items = page.items.filter((item) => item.str && item.str.trim())
  if (!items.length) return []
  const gutter = gutterX(items, page.width)
  const crosses = (item) => item.x < gutter - 3 && item.x + item.w > gutter + 3
  const ordered = []
  let zone = []
  const flushZone = () => {
    if (!zone.length) return
    const zoneItems = zone.flatMap((line) => line.items)
    const left = zoneItems.filter((item) => item.x + item.w / 2 < gutter)
    const right = zoneItems.filter((item) => item.x + item.w / 2 >= gutter)
    ordered.push(...buildLines(left, body), ...buildLines(right, body))
    zone = []
  }
  for (const line of buildLines(items, body)) {
    if (line.items.some(crosses)) {
      flushZone()
      ordered.push(line)
    } else {
      zone.push(line)
    }
  }
  flushZone()
  return ordered
    .map((line) => ({ text: lineText(line, body), y: line.y, x: line.x, h: line.h, top: 1 - line.y / page.height }))
    .filter((line) => line.text)
}

// Running headers and footers: the same line (digits aside) near the top or
// bottom edge of many pages.
function repeatedEdgeLines(pagesLines) {
  if (pagesLines.length < 3) return new Set()
  const counts = new Map()
  for (const lines of pagesLines) {
    const seen = new Set()
    for (const line of lines) {
      if (line.top > 0.1 && line.top < 0.92) continue
      const key = line.text.replace(/\d+/g, '#')
      if (!seen.has(key)) counts.set(key, (counts.get(key) || 0) + 1)
      seen.add(key)
    }
  }
  const repeated = new Set()
  for (const [key, count] of counts) if (count >= Math.max(3, pagesLines.length * 0.3)) repeated.add(key)
  return repeated
}

// Join lines into paragraphs. A new output line starts at a heading, at a
// numbered reference entry, after a larger-than-usual vertical gap, or where
// the type size changes; everything else is a hard wrap and is rejoined.
export function joinLines(lines, body) {
  const leading = median(lines.slice(1).map((line, i) => lines[i].y - line.y).filter((gap) => gap > 0 && gap < body * 3)) || body * 1.3
  const out = []
  let prev = null
  const sameSize = (a, b) => a && b && Math.abs(a.h - b.h) <= body * 0.06
  for (const [index, line] of lines.entries()) {
    // A larger line standing alone is a heading; a run of larger lines (a
    // title, a journal's large-type abstract) is ordinary wrapped text.
    const alone = !sameSize(line, lines[index - 1]) && !sameSize(line, lines[index + 1])
    const heading = HEADING_RE.test(line.text) || (alone && line.h > body * 1.15 && line.text.length < 80 && !/[.,;]$/.test(line.text))
    const gap = prev ? prev.y - line.y : 0
    const breaks = !prev
      || heading
      || prev.heading
      || ENTRY_START_RE.test(line.text)
      || (gap > leading * 1.6 && gap < body * 40)
      || Math.abs(line.h - prev.h) > body * 0.12
      // A finished reference entry does not run on into the next column or page.
      || (gap < 0 && ENTRY_START_RE.test(out[out.length - 1]) && /[.)]$/.test(out[out.length - 1]))
    if (breaks) {
      out.push(line.text)
    } else {
      const last = out[out.length - 1]
      // A URL or DOI broken across lines is glued back as printed (its
      // hyphens are real); a hyphenated word break loses its hyphen.
      const brokenLink = /(?:https?:\/\/|\b10\.\d{4,9}\/)\S*[/.\-_=]$/.test(last)
      const brokenWord = /[\p{L}]-$/u.test(last) && /^\p{Ll}/u.test(line.text)
      out[out.length - 1] = brokenLink
        ? last + line.text
        : brokenWord ? last.slice(0, -1) + line.text : `${last} ${line.text}`
    }
    prev = { ...line, heading }
  }
  return out.map(unmarkAffiliations)
}

// An author line ("Li Zhang^{1}, Georg Wölflein^{1,2}, …") is superscripts too,
// but they point at affiliations. Where most markers in a paragraph are
// followed by a comma or ampersand, none of them are citations.
function unmarkAffiliations(text) {
  const markers = [...text.matchAll(/\^\{[^}]*\}(\s*[,&])?/g)]
  if (markers.length < 3) return text
  const listed = markers.filter((match) => match[1]).length
  return listed / markers.length > 0.6 ? text.replace(/\^\{([^}]*)\}/g, '$1') : text
}

export function layoutToText(pages) {
  const body = bodyHeight(pages)
  if (!body) return ''
  const pagesLines = pages.map((page) => pageLines(page, body))
  const repeated = repeatedEdgeLines(pagesLines)
  const lines = pagesLines.flatMap((pageLinesList) => (
    pageLinesList.filter((line) => !((line.top <= 0.1 || line.top >= 0.92) && repeated.has(line.text.replace(/\d+/g, '#'))))
  ))
  return joinLines(lines, body).join('\n')
}
