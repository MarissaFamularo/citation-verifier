import { useState } from 'react'
import { locateQuote } from '../lib/sourceLocate.js'
import { DECISIONS, JEV_MARK_HELP, UNMATCHED_WARNING, claudeVerdictLabel, formatJevMark, isUnmatchedPaper } from '../lib/review.js'
import { cleanSentence } from '../lib/typesafe.js'

const VERDICT_STYLE = {
  supported: 'bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200',
  flagged: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  refuted: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  unverified: 'bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-100',
}

function Badge({ className = '', title, children }) {
  return <span title={title} className={`rounded px-1.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>
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

export default function ReviewRow({ row, busy, canCheck, getSource, onCheck, onAddPdf, onDecision }) {
  const { paper, claude, jev, review } = row
  const unmatched = isUnmatchedPaper(row)
  const paperUrl = paper ? (row.oaUrl || (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : paper.sourceUrl || (paper.doi ? `https://doi.org/${paper.doi}` : null))) : null
  const wantsPdf = paper && row.sentence && (row.sourceTier === 'abstract_only' || row.needsPdf)
  const settled = claude ? claude.verdict === 'supported' : jev?.relation === 'supports' && !jev.needsReview
  const tier = row.sourceTier === 'full_text' ? (row.userSupplied ? 'full text checked (your PDF)' : 'full text checked') : row.sourceTier === 'abstract_only' ? 'abstract only checked' : null

  return (
    <article className={`panel space-y-3 p-4 ${unmatched ? 'border-amber-500 ring-1 ring-amber-300 dark:border-amber-600 dark:ring-amber-800' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-semibold">[{row.refNumber ?? '–'}]</span>
        {paper
          ? <a className="underline decoration-stone-400" href={paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : paper.sourceUrl || `https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">{paper.title}</a>
          : <span className="text-stone-600 dark:text-stone-400">{row.referenceRaw}</span>}
        {!paper && row.parseWarning && <Badge className={VERDICT_STYLE.flagged}>reference not looked up — {row.parseWarning}; check it by hand</Badge>}
        {paper && !paper.pmid && <span className="text-xs text-stone-500">{paper.sourceType === 'arxiv' ? 'arXiv' : 'via OpenAlex'}</span>}
        {row.matchConfidence === 'check' && <Badge className={VERDICT_STYLE.flagged}>loose title match — confirm it is the right paper</Badge>}
        {row.section && <span className="text-xs text-stone-500">{row.section}</span>}
      </div>
      {unmatched && (
        <div className="rounded-md border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-100" role="status">
          <p className="font-medium">{UNMATCHED_WARNING}</p>
          <p className="mt-1">PubMed and OpenAlex returned no paper, so {row.sentence ? 'this citing sentence was not checked against a source' : 'there is no source to check'}. Leave it unresolved until you look it up yourself. It may be a misprint, a paper those indexes do not carry, or a citation with no real paper behind it.</p>
        </div>
      )}
      {!paper && !row.parseWarning && row.matchError && (
        <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" role="status">
          <p className="font-medium">Lookup failed — this reference was not matched</p>
          <p className="mt-1">{row.matchError} The search did not finish, so there is no finding yet about whether a paper exists. Try the manuscript again in a moment.</p>
        </div>
      )}
      {(row.rejectedCandidates || []).map((item) => (
        <p key={item.via} className="text-xs text-amber-800 dark:text-amber-300">
          {item.reason
            ? <>The closest search result (“{item.title}”) was not used: {item.reason}.</>
            : <>The printed {item.via} leads to a different paper (“{item.title}”), so it was not used.</>}
        </p>
      ))}
      {paper && row.referenceRaw && (
        <details className="text-xs text-stone-500">
          <summary className="cursor-pointer">Reference as printed</summary>
          <p className="mt-1">{row.referenceRaw}</p>
        </details>
      )}

      {row.sentence
        ? <blockquote className="border-l-2 border-stone-300 pl-3 text-sm dark:border-stone-700" title={row.sentence}>{cleanSentence(row.sentence)}</blockquote>
        : <p className="text-sm text-stone-500">This reference is listed but no sentence in the text cites it.</p>}

      {row.sentence && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {claude && <Badge className={VERDICT_STYLE[claude.verdict]}>Claude: {claudeVerdictLabel(claude)}</Badge>}
            {jev && (
              <Badge title={JEV_MARK_HELP} className={jev.relation === 'supports' && !jev.needsReview ? VERDICT_STYLE.supported : jev.relation === 'contradicts' ? VERDICT_STYLE.refuted : VERDICT_STYLE.flagged}>
                Jev: {formatJevMark(jev)}
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
          {wantsPdf && settled && (
            <label className={`inline-block cursor-pointer text-xs text-stone-500 underline ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              Check against the full text instead (add the paper's PDF)
              <input type="file" className="hidden" accept=".pdf,application/pdf" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onAddPdf(file) }} />
            </label>
          )}
          {wantsPdf && !settled && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-dashed border-stone-300 p-2 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-400">
              <span className="min-w-48 flex-1">{row.fullTextNote || 'Only the abstract could be checked.'}</span>
              {paperUrl && <a className="btn" href={paperUrl} target="_blank" rel="noreferrer">Open the paper</a>}
              <label className={`btn ${busy ? 'pointer-events-none opacity-50' : ''}`}>
                Add its PDF and re-check
                <input type="file" className="hidden" accept=".pdf,application/pdf" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onAddPdf(file) }} />
              </label>
            </div>
          )}
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
