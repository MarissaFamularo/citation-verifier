// lib/sourceBlock.js — compose a fetched paper source into one prompt string.

// ~40k tokens of source. Beyond this the text is truncated with an honest
// marker so the model treats coverage as partial.
export const SOURCE_CHAR_CAP = 150_000

function clean(value) {
  return String(value ?? '').trim()
}

// One source string for the model; the verifier gets prose and tables as
// separate corpora, so this composition is prompt-only.
export function buildSourceBlock(source) {
  const text = clean(source?.text).slice(0, SOURCE_CHAR_CAP)
  const remaining = Math.max(0, SOURCE_CHAR_CAP - text.length)
  const tables = clean(source?.tables).slice(0, remaining)
  const truncated = clean(source?.text).length > SOURCE_CHAR_CAP || clean(source?.tables).length > remaining
  const parts = [`SOURCE TEXT (${source?.tier === 'full_text' ? 'open-access full text' : 'abstract only'}):`, text]
  if (tables) parts.push(`TABLES:\n${tables}`)
  if (truncated) parts.push('(Source text was truncated to fit; treat coverage as partial.)')
  return { block: parts.join('\n\n'), truncated }
}
