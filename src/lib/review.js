// lib/review.js — the review table's rows and the review file.
//
// Nothing is stored on a server. A review lives in the browser tab and in a
// JSON file the reviewer downloads and can re-open later; the CSV export is
// the hand-off (opens in Excel). The human decision is the only field a person
// owns — model output never overwrites it.

export const REVIEW_FILE_VERSION = 1
export const DECISIONS = ['accept', 'reject', 'other']

function clean(value) {
  return String(value ?? '').trim()
}

// One row per (citing sentence, cited reference) pair. A reference nobody
// cites in the body still gets one sentence-less row so it shows in the table.
export function buildRows(references, byNumber, results = []) {
  const resultByNumber = new Map(results.map((result) => [result.reference?.number, result]))
  const rows = []
  for (const reference of references) {
    const result = resultByNumber.get(reference.number)
    const base = {
      refNumber: reference.number,
      referenceRaw: clean(reference.raw),
      paper: result?.paper || null,
      matchConfidence: result?.confidence || null,
      sourceTier: null,
      claude: null,
      jev: null,
      error: null,
      review: { decision: null, notes: '', reviewedAt: null },
    }
    const citations = byNumber.get(reference.number) || []
    if (!citations.length) {
      rows.push({ ...base, id: `${reference.number}:0`, sentence: '', marker: null, section: null })
      continue
    }
    citations.forEach((citation, index) => {
      rows.push({
        ...base,
        id: `${reference.number}:${index + 1}`,
        sentence: citation.sentence,
        marker: citation.marker || null,
        section: citation.locationHint || null,
      })
    })
  }
  return rows
}

export function setDecision(row, { decision, notes }, now = new Date()) {
  const next = DECISIONS.includes(decision) ? decision : null
  return { ...row, review: { decision: next, notes: String(notes ?? ''), reviewedAt: next || clean(notes) ? now.toISOString() : null } }
}

export function summarize(rows) {
  const checkable = rows.filter((row) => row.sentence)
  return {
    sentences: checkable.length,
    checked: checkable.filter((row) => row.claude || row.jev).length,
    reviewed: checkable.filter((row) => row.review?.decision).length,
    uncited: rows.length - checkable.length,
  }
}

// --- review file -------------------------------------------------------------

export function serializeReview({ fileName, rows }, now = new Date()) {
  return JSON.stringify({ app: 'citation-verifier', version: REVIEW_FILE_VERSION, savedAt: now.toISOString(), fileName: fileName || null, rows }, null, 2)
}

export function parseReviewFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not a saved review.')
  }
  if (parsed?.app !== 'citation-verifier' || !Array.isArray(parsed.rows)) throw new Error('That file is not a saved review.')
  if (parsed.version > REVIEW_FILE_VERSION) throw new Error('That review was saved by a newer version of this tool.')
  return { fileName: parsed.fileName || '', rows: parsed.rows }
}

// --- CSV ---------------------------------------------------------------------

// Cells starting with = + - @ are prefixed so a spreadsheet never runs
// manuscript text as a formula.
function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const CSV_COLUMNS = [
  ['Ref #', (row) => row.refNumber],
  ['Reference', (row) => row.referenceRaw],
  ['PMID', (row) => row.paper?.pmid || ''],
  ['DOI', (row) => row.paper?.doi || ''],
  ['Section', (row) => row.section || ''],
  ['Citing sentence', (row) => row.sentence],
  ['Source checked', (row) => (row.sourceTier === 'full_text' ? 'full text' : row.sourceTier === 'abstract_only' ? 'abstract only' : '')],
  ['Claude verdict', (row) => row.claude?.verdict || ''],
  ['Claude reason', (row) => row.claude?.reason || ''],
  ['Supporting quote', (row) => row.claude?.quote || ''],
  ['Jev relation', (row) => row.jev?.relation || ''],
  ['Jev reliability (P supports)', (row) => (row.jev ? row.jev.reliability.toFixed(2) : '')],
  ['Jev confidence', (row) => (row.jev ? row.jev.confidence.toFixed(2) : '')],
  ['Reviewer decision', (row) => row.review?.decision || ''],
  ['Reviewer notes', (row) => row.review?.notes || ''],
  ['Error', (row) => row.error || ''],
]

export function rowsToCsv(rows) {
  const lines = [CSV_COLUMNS.map(([header]) => csvCell(header)).join(',')]
  for (const row of rows) lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(row))).join(','))
  return `\uFEFF${lines.join('\r\n')}`
}
