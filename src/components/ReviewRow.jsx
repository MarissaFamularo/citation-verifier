import { useState } from 'react'
import { locateQuote } from '../lib/sourceLocate.js'
import { DECISIONS } from '../lib/review.js'
import { cleanSentence } from '../lib/typesafe.js'

const VERDICT_STYLE = {
  supported: 'bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200',
  flagged: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  refuted: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
}
const RELATION_LABEL = { supports: 'supports', contradicts: 'contradicts', says_nothing: 'says nothing' }

function Badge({ className = '', children }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>
}

function SourceContext({ row, getSource }) {
  const [view, setView] = useState(null)
  async function open() {
    try {
      const source = await getSource(row.paper)
      const { corpusText, span, found } = locateQuote(source, row.claude.quote)
      if (!found) return setView({ note: "The quote was proven, but its highlight couldn't be aligned for display." })
      const start = Math.max(0, span[0] - 600)
      setView({ before: corpusText.slice(start, span[0]), hit: corpusText.slice(span[0], span[1]), after: corpusText.slice(span[1], span[1] + 600) })
    } catch (err) {
      setView({ note: err.message })
    }
  }
  if (!view) return <button className="text-xs text-teal-700 underline dark:text-teal-400" onClick={open}>Show in context</button>
  if (view.note) return <p className="text-xs text-stone-500">{view.note}</p>
  return <p className="mt-1 whitespace-pre-wrap text-xs text-stone-600 dark:text-stone-400">…{view.before}<mark>{view.hit}</mark>{view.after}…</p>
}

export default function ReviewRow({ row, busy, canCheck, getSource, onCheck, onDecision }) {
  const { paper, claude, jev, review } = row
  const tier = row.sourceTier === 'full_text' ? 'full text checked' : row.sourceTier === 'abstract_only' ? 'abstract only checked' : null

  return (
    <article className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-semibold">[{row.refNumber}]</span>
        {paper
          ? <a className="underline decoration-stone-400" href={paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : `https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">{paper.title}</a>
          : <span className="text-stone-600 dark:text-stone-400">{row.referenceRaw}</span>}
        {!paper && <Badge className={VERDICT_STYLE.flagged}>not matched in PubMed — check this one by hand</Badge>}
        {row.section && <span className="text-xs text-stone-500">{row.section}</span>}
      </div>

      {row.sentence
        ? <blockquote className="border-l-2 border-stone-300 pl-3 text-sm dark:border-stone-700" title={row.sentence}>{cleanSentence(row.sentence)}</blockquote>
        : <p className="text-sm text-stone-500">This reference is listed but no sentence in the text cites it.</p>}

      {row.sentence && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {claude && <Badge className={VERDICT_STYLE[claude.verdict]}>Claude: {claude.verdict}</Badge>}
            {jev && (
              <Badge className={jev.relation === 'supports' && !jev.needsReview ? VERDICT_STYLE.supported : jev.relation === 'contradicts' ? VERDICT_STYLE.refuted : VERDICT_STYLE.flagged}>
                Jev: {RELATION_LABEL[jev.relation] || jev.relation} · reliability {Math.round(jev.reliability * 100)}% · confidence {jev.confidence.toFixed(2)}
              </Badge>
            )}
            {jev?.needsReview && <Badge className="border border-amber-400 text-amber-800 dark:text-amber-300">Jev is unsure — look closely</Badge>}
            {tier && <span className="text-xs text-stone-500">{tier}</span>}
            {paper && (
              <button className="btn ml-auto" disabled={busy || !canCheck} onClick={onCheck}>{claude || jev ? 'Re-check' : 'Check'}</button>
            )}
          </div>
          {claude?.reason && <p className="text-stone-700 dark:text-stone-300">{claude.reason}</p>}
          {claude?.quote && (
            <div className="rounded bg-stone-100 p-2 dark:bg-stone-800/60">
              <p className="text-xs italic">“{claude.quote}”{claude.quote_location ? ` — ${claude.quote_location}` : ''}</p>
              <SourceContext row={row} getSource={getSource} />
            </div>
          )}
          {jev && !jev.anchored && <p className="text-xs text-stone-500">No proven quote to anchor on, so Jev scored the sentence against the opening of the source text.</p>}
          {row.error && <p className="text-red-700 dark:text-red-300">{row.error}</p>}
        </div>
      )}

      {row.sentence && (
        <div className="flex flex-wrap items-start gap-2 border-t border-stone-200 pt-3 dark:border-stone-800">
          <span className="label pt-2">Your review</span>
          {DECISIONS.map((decision) => (
            <button
              key={decision}
              className={`btn capitalize ${review.decision === decision ? 'btn-primary' : ''}`}
              onClick={() => onDecision({ decision: review.decision === decision ? null : decision, notes: review.notes })}
            >{decision}</button>
          ))}
          <textarea
            className="field min-w-60 flex-1"
            rows={1}
            placeholder="Notes"
            value={review.notes}
            onChange={(e) => onDecision({ decision: review.decision, notes: e.target.value })}
          />
        </div>
      )}
    </article>
  )
}
