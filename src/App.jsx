import { useEffect, useMemo, useRef, useState } from 'react'
import KeysPanel from './components/KeysPanel.jsx'
import ReviewRow from './components/ReviewRow.jsx'
import { hasApiKey } from './lib/anthropic.js'
import { readManuscriptFile } from './lib/manuscriptImport.js'
import { sourceFromPdf } from './lib/fullText.js'
import { checkRow, createSourceCache, importManuscript, paperKey } from './lib/pipeline.js'
import { parseReviewFile, rowsToCsv, serializeReview, setDecision, summarize } from './lib/review.js'
import { hasTypesafeKey } from './lib/typesafe.js'
import { countEvent } from './lib/usage.js'

const CHECK_CONCURRENCY = 4

const FILTERS = {
  all: () => true,
  attention: (row) => row.sentence && (row.error || ['refuted', 'flagged', 'unverified'].includes(row.claude?.verdict) || (row.jev && (row.jev.relation !== 'supports' || row.jev.needsReview))),
  unreviewed: (row) => row.sentence && !row.review?.decision,
  abstractOnly: (row) => row.sentence && (row.sourceTier === 'abstract_only' || row.needsPdf),
}

const AUTOSAVE_KEY = 'citationverifier.session.v1'

// The table survives a reload (this tab only; gone when the tab closes).
function loadAutosave() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(AUTOSAVE_KEY) || 'null')
    return Array.isArray(saved?.rows) ? saved : null
  } catch {
    return null
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [keysVersion, setKeysVersion] = useState(0)
  const [fileName, setFileName] = useState(() => loadAutosave()?.fileName || '')
  const [pasted, setPasted] = useState('')
  const [rows, setRows] = useState(() => loadAutosave()?.rows || [])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')
  const abortRef = useRef(null)
  const getSource = useMemo(() => createSourceCache(), [])

  useEffect(() => {
    try {
      sessionStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ fileName, rows }))
    } catch {
      /* storage full or unavailable — the Save review file still works */
    }
  }, [fileName, rows])

  const canCheck = (hasApiKey() || hasTypesafeKey()) && keysVersion >= 0
  const summary = summarize(rows)
  const visible = rows.filter(FILTERS[filter])
  const baseName = (fileName || 'manuscript').replace(/\.[^.]+$/, '')

  function patchRow(next) {
    setRows((current) => current.map((row) => (row.id === next.id ? { ...next, review: row.review } : row)))
  }

  async function run(work) {
    setError('')
    setBusy(true)
    abortRef.current = new AbortController()
    try {
      await work(abortRef.current.signal)
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err?.message || 'Something went wrong.')
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  function importText(text, name) {
    return run(async (signal) => {
      setStatus('Reading the manuscript…')
      const outcome = await importManuscript(text, {
        signal,
        onPhase: (phase) => setStatus(phase === 'references' ? 'Reading the reference list…' : 'Matching references to papers…'),
        onProgress: (done, total) => setStatus(`Matching references to papers… ${done}/${total}`),
      })
      setFileName(name)
      setRows(outcome.rows)
      countEvent('import')
    })
  }

  async function onFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.name.toLowerCase().endsWith('.json')) {
      try {
        const review = parseReviewFile(await file.text())
        setRows(review.rows)
        setFileName(review.fileName)
        setError('')
      } catch (err) {
        setError(err.message)
      }
      return
    }
    try {
      await importText(await readManuscriptFile(file), file.name)
    } catch (err) {
      setError(err.message)
    }
  }

  // Several rows at a time: each check is mostly waiting on a model, and rows
  // citing the same paper share one fetched source. Kept modest so PubMed's
  // 3-requests-a-second limit (without an NCBI key) is not tripped.
  function checkRows(targets) {
    countEvent('check')
    return run(async (signal) => {
      let done = 0
      const queue = [...targets]
      const worker = async () => {
        while (queue.length && !signal.aborted) {
          const target = queue.shift()
          patchRow(await checkRow(target, { getSource, signal }))
          done += 1
          setStatus(`Checking citations… ${done}/${targets.length}`)
        }
      }
      setStatus(`Checking citations… 0/${targets.length}`)
      await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, targets.length) }, worker))
    })
  }

  // The reviewer's own PDF of a cited paper replaces its source, and every
  // sentence citing that paper is checked again against the full text.
  async function addPaperPdf(row, file) {
    setError('')
    try {
      getSource.set(row.paper, await sourceFromPdf(await file.arrayBuffer()))
    } catch (err) {
      setError(err?.message || 'That PDF could not be read.')
      return
    }
    const key = paperKey(row.paper)
    await checkRows(rows.filter((candidate) => candidate.sentence && candidate.paper && paperKey(candidate.paper) === key))
  }

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">
          <a className="underline decoration-teal-600 decoration-2 underline-offset-4 hover:text-teal-700 dark:hover:text-teal-400" href="https://papertrellis.com" target="_blank" rel="noreferrer">Paper Trellis</a>
          {' '}Citation Verifier
        </h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Does each cited paper actually support the sentence that cites it? Upload a manuscript, get a model-checked table, and record your own verdict on every citation.
        </p>
      </header>

      <KeysPanel onChange={() => setKeysVersion((v) => v + 1)} />

      <section className="panel space-y-3 p-4">
        <p className="label">Manuscript</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className={`btn btn-primary ${busy ? 'pointer-events-none opacity-50' : ''}`}>
            Upload .docx, .pdf, .txt, or a saved review (.json)
            <input type="file" className="hidden" accept=".docx,.pdf,.txt,.md,.json,text/plain,application/json,application/pdf" onChange={onFile} disabled={busy} />
          </label>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => importText(await (await fetch('/sample-manuscript.txt')).text(), 'sample-manuscript.txt')}
          >Try a sample (one citation is deliberately wrong)</button>
          {fileName && <span className="text-sm text-stone-600 dark:text-stone-400">{fileName}</span>}
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-stone-600 dark:text-stone-400">…or paste the manuscript text (from Word — text copied out of a PDF loses its citation numbers; upload the PDF instead)</summary>
          <textarea className="field mt-2 h-32" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Full text including the References section" />
          <button className="btn mt-2" disabled={busy || !pasted.trim()} onClick={() => importText(pasted, 'pasted-manuscript.txt')}>Read pasted text</button>
        </details>
        <p className="text-xs text-stone-500">
          Nothing about you or your manuscript is stored by this site; it keeps only an anonymous count of visits and checks. The manuscript is read in your browser; citing sentences and passages from the cited papers are sent to Anthropic and TypeSafe under your own keys (TypeSafe requests are relayed through this site's host, which keeps nothing). Check a journal's confidentiality rules before using this on a manuscript under peer review.
        </p>
      </section>

      {(status || error) && (
        <div className={`panel flex items-center justify-between p-3 text-sm ${error ? 'border-red-300 text-red-700 dark:border-red-900 dark:text-red-300' : ''}`}>
          <span>{error || status}</span>
          {busy && <button className="btn" onClick={() => abortRef.current?.abort()}>Stop</button>}
        </div>
      )}

      {rows.length > 0 && (
        <section className="space-y-3">
          <div className="panel flex flex-wrap items-center gap-2 p-3 text-sm">
            <span className="mr-auto">
              {summary.sentences} citing sentences · {summary.checked} checked ({rows.filter((row) => row.sourceTier === 'full_text').length} on full text) · {summary.reviewed} reviewed
              {summary.uncited > 0 && ` · ${summary.uncited} references never cited in the text`}
            </span>
            <select className="field w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">Show all</option>
              <option value="attention">Needs attention</option>
              <option value="unreviewed">Not yet reviewed</option>
              <option value="abstractOnly">Checked on abstract only</option>
            </select>
            <button className="btn btn-primary" disabled={busy || !canCheck} title={canCheck ? '' : 'Add an API key first'} onClick={() => checkRows(rows.filter((row) => row.sentence && row.paper && !row.claude && !row.jev))}>
              Check all unchecked ({rows.filter((row) => row.sentence && row.paper && !row.claude && !row.jev).length})
            </button>
            <button className="btn" onClick={() => download(`${baseName}.review.json`, serializeReview({ fileName, rows }), 'application/json')}>Save review</button>
            <button className="btn" onClick={() => download(`${baseName}.citations.csv`, rowsToCsv(rows), 'text/csv')}>Export CSV</button>
          </div>
          {visible.map((row) => (
            <ReviewRow
              key={row.id}
              row={row}
              busy={busy}
              canCheck={canCheck}
              getSource={getSource}
              onCheck={() => { getSource.forget(row.paper); return checkRows([row]) }}
              onAddPdf={(file) => addPaperPdf(row, file)}
              onDecision={(change) => setRows((current) => current.map((r) => (r.id === row.id ? setDecision(r, change) : r)))}
            />
          ))}
          {!visible.length && <p className="text-sm text-stone-500">Nothing matches this filter.</p>}
        </section>
      )}
      <footer className="border-t border-stone-200 pt-4 text-xs text-stone-500 dark:border-stone-800">
        Part of <a className="underline" href="https://papertrellis.com" target="_blank" rel="noreferrer">Paper Trellis</a>, which tracks research projects from idea to publication
        {' · '}Built by <a className="underline" href="https://www.marissafamularo.com" target="_blank" rel="noreferrer">Marissa Famularo</a>
        {' · '}<a className="underline" href="https://github.com/MarissaFamularo/citation-verifier" target="_blank" rel="noreferrer">Source on GitHub</a>
        {' · '}Model verdicts are a triage aid, not a finding.
      </footer>
    </main>
  )
}
