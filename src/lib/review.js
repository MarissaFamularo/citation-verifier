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
      // Why a reference was left unresolved: the entry looked mis-split, or a
      // printed identifier pointed at a different paper and was refused.
      parseWarning: reference.parseWarning || result?.warning || null,
      rejectedCandidates: result?.rejected || [],
      // A lookup that errored (PubMed down, rate limit) is not "no paper found".
      matchError: result?.error || null,
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

// Looked up, and neither index returned a paper. A mis-split reference or a
// lookup that never finished is a different status.
export function isUnmatchedPaper(row) {
  return !row?.paper && !row?.parseWarning && !row?.matchError
}

export function paperMatchStatus(row) {
  if (row?.paper) return 'matched'
  if (row?.matchError) return 'lookup failed'
  if (row?.parseWarning) return 'not looked up'
  return 'no matching paper found'
}

// Same headline as the row warning. The Paper match column is a short status;
// Reference warning is where a spreadsheet reader looks for the finding.
export const UNMATCHED_WARNING = 'No matching paper found — check this one by hand'

export function referenceWarning(row) {
  const parts = []
  if (row?.parseWarning) parts.push(row.parseWarning)
  for (const item of row?.rejectedCandidates || []) {
    parts.push(item.reason
      ? `closest search result not used (${item.reason}): ${item.title}`
      : `${item.via} is a different paper: ${item.title}`)
  }
  if (isUnmatchedPaper(row)) parts.push(UNMATCHED_WARNING)
  else if (!row?.paper && row?.matchError) parts.push(row.matchError)
  return parts.filter(Boolean).join(' · ')
}

// Citing sentences the Check button can still send to a model. A sentence
// whose reference never matched a paper is not waiting in this queue — it is
// reported on its own, because there is no source to check it against.
export function isUncheckedSentence(row) {
  return Boolean(row?.sentence && row?.paper && !row?.claude && !row?.jev)
}

export function uncheckedSentenceCount(rows) {
  return rows.filter(isUncheckedSentence).length
}

export function needsAttention(row) {
  if (isUnmatchedPaper(row) || (row?.matchError && !row?.paper)) return true
  if (!row?.sentence) return false
  return Boolean(
    row.error
    || row.parseWarning
    || row.rejectedCandidates?.length
    || ['refuted', 'flagged', 'unverified'].includes(row.claude?.verdict)
    || (row.jev && (row.jev.relation !== 'supports' || row.jev.needsReview)),
  )
}

export function summarize(rows) {
  const checkable = rows.filter((row) => row.sentence)
  const unmatchedRows = rows.filter(isUnmatchedPaper)
  return {
    sentences: checkable.length,
    checked: checkable.filter((row) => row.claude || row.jev).length,
    reviewed: checkable.filter((row) => row.review?.decision).length,
    uncited: rows.length - checkable.length,
    // References whose printed text could not be read reliably — never matched.
    unreadable: new Set(rows.filter((row) => row.parseWarning).map((row) => row.refNumber)).size,
    // References searched in PubMed and OpenAlex with no paper returned.
    unmatched: new Set(unmatchedRows.map((row) => row.refNumber)).size,
    unmatchedSentences: unmatchedRows.filter((row) => row.sentence).length,
    lookupFailed: new Set(rows.filter((row) => row.matchError && !row.paper).map((row) => row.refNumber)).size,
  }
}

// --- labels shared by the table and the CSV ---------------------------------
//
// Saved reviews keep the raw codes (verdict "refuted", relation "off_topic",
// jev.reliability). These strings are display only, so an older review file
// still loads and then renders with the same words as a new one.

export const CLAUDE_REFUTED_LABEL = {
  contradicts: 'contradicted or overstated',
  off_topic: 'paper is about something else',
  silent: 'not found in the full text',
}

export const CLAUDE_VERDICT_LABEL = {
  supported: 'supported',
  flagged: 'flagged',
  refuted: 'not supported',
  unverified: 'not in abstract — needs full text',
}

export function claudeVerdictLabel(claude) {
  if (!claude?.verdict) return ''
  if (claude.verdict === 'refuted' && CLAUDE_REFUTED_LABEL[claude.relation]) return CLAUDE_REFUTED_LABEL[claude.relation]
  return CLAUDE_VERDICT_LABEL[claude.verdict] || claude.verdict
}

export const JEV_RELATION_LABEL = {
  supports: 'supports',
  contradicts: 'contradicts',
  says_nothing: 'says nothing',
}

// Shown on the Jev badge. "Reliability 0%" read as "the model is broken" next
// to "confidence 1.00"; the number is the probability the passage supports
// the sentence, which is low precisely when Jev is sure it does not.
export const JEV_MARK_HELP = 'Probability of support is Jev\'s estimate that the passage supports the citing sentence. 0% means Jev thinks the passage does not support it. Confidence is how sure Jev is of its own call: 0% support with confidence 1.00 means Jev is sure the passage does not support the sentence. Low confidence means Jev is unsure, so read the passage yourself.'

export function jevRelationLabel(relation) {
  return JEV_RELATION_LABEL[relation] || relation || ''
}

export function formatJevMark(jev) {
  if (!jev) return ''
  const support = Math.round(Number(jev.reliability || 0) * 100)
  const confidence = Number(jev.confidence)
  const confidenceText = Number.isFinite(confidence) ? confidence.toFixed(2) : '—'
  return `${jevRelationLabel(jev.relation)} · probability of support ${Number.isFinite(support) ? support : 0}% · confidence ${confidenceText}`
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
  ['Reference warning', (row) => referenceWarning(row)],
  ['Paper match', (row) => paperMatchStatus(row)],
  ['PMID', (row) => row.paper?.pmid || ''],
  ['DOI', (row) => row.paper?.doi || ''],
  ['Section', (row) => row.section || ''],
  ['Citing sentence', (row) => row.sentence],
  ['Source checked', (row) => (row.sourceTier === 'full_text' ? 'full text' : row.sourceTier === 'abstract_only' ? 'abstract only' : '')],
  ['Claude verdict', (row) => claudeVerdictLabel(row.claude)],
  ['Claude reason', (row) => row.claude?.reason || ''],
  ['Supporting quote', (row) => row.claude?.quote || ''],
  ['Jev relation', (row) => (row.jev ? jevRelationLabel(row.jev.relation) : '')],
  ['Jev probability of support (0-1)', (row) => (row.jev ? Number(row.jev.reliability).toFixed(2) : '')],
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
