import { useMemo, useRef, useState } from 'react'
import KeysPanel from './components/KeysPanel.jsx'
import ReviewRow from './components/ReviewRow.jsx'
import { hasApiKey } from './lib/anthropic.js'
import { readManuscriptFile } from './lib/manuscriptImport.js'
import { checkRow, createSourceCache, importManuscript } from './lib/pipeline.js'
import { parseReviewFile, rowsToCsv, serializeReview, setDecision, summarize } from './lib/review.js'
import { hasTypesafeKey } from './lib/typesafe.js'

const FILTERS = {
  all: () => true,
  attention: (row) => row.sentence && (row.error || row.claude?.verdict === 'refuted' || row.claude?.verdict === 'flagged' || (row.jev && (row.jev.relation !== 'supports' || row.jev.needsReview))),
  unreviewed: (row) => row.sentence && !row.review?.decision,
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [keysVersion, setKeysVersion] = useState(0)
  const [fileName, setFileName] = useState('')
  const [pasted, setPasted] = useState('')
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')
  const abortRef = useRef(null)
  const getSource = useMemo(() => createSourceCache(), [])

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
        onPhase: (phase) => setStatus(phase === 'references' ? 'Reading the reference list…' : 'Matching references to PubMed…'),
        onProgress: (done, total) => setStatus(`Matching references to PubMed… ${done}/${total}`),
      })
      setFileName(name)
      setRows(outcome.rows)
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

  function checkRows(targets) {
    return run(async (signal) => {
      let done = 0
      for (const target of targets) {
        if (signal.aborted) break
        setStatus(`Checking citations… ${done}/${targets.length}`)
        patchRow(await checkRow(target, { getSource, signal }))
        done += 1
      }
    })
  }

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">Citation Verifier</h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Does each cited paper actually support the sentence that cites it? Upload a manuscript, get a model-checked table, and record your own verdict on every citation.
        </p>
      </header>

      <KeysPanel onChange={() => setKeysVersion((v) => v + 1)} />

      <section className="panel space-y-3 p-4">
        <p className="label">Manuscript</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className={`btn btn-primary ${busy ? 'pointer-events-none opacity-50' : ''}`}>
            Upload .docx, .txt, or a saved review (.json)
            <input type="file" className="hidden" accept=".docx,.txt,.md,.json,text/plain,application/json" onChange={onFile} disabled={busy} />
          </label>
          {fileName && <span className="text-sm text-stone-600 dark:text-stone-400">{fileName}</span>}
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-stone-600 dark:text-stone-400">…or paste the manuscript text</summary>
          <textarea className="field mt-2 h-32" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Full text including the References section" />
          <button className="btn mt-2" disabled={busy || !pasted.trim()} onClick={() => importText(pasted, 'pasted-manuscript.txt')}>Read pasted text</button>
        </details>
        <p className="text-xs text-stone-500">
          Nothing is uploaded to this site. The manuscript stays in your browser; citing sentences and the cited papers' text are sent to Anthropic and TypeSafe under your own keys. Check a journal's confidentiality rules before using this on a manuscript under peer review.
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
              {summary.sentences} citing sentences · {summary.checked} checked · {summary.reviewed} reviewed
              {summary.uncited > 0 && ` · ${summary.uncited} references never cited in the text`}
            </span>
            <select className="field w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">Show all</option>
              <option value="attention">Needs attention</option>
              <option value="unreviewed">Not yet reviewed</option>
            </select>
            <button className="btn btn-primary" disabled={busy || !canCheck} title={canCheck ? '' : 'Add an API key first'} onClick={() => checkRows(rows.filter((row) => row.sentence && !row.claude && !row.jev))}>
              Check all unchecked
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
              onCheck={() => checkRows([row])}
              onDecision={(change) => setRows((current) => current.map((r) => (r.id === row.id ? setDecision(r, change) : r)))}
            />
          ))}
          {!visible.length && <p className="text-sm text-stone-500">Nothing matches this filter.</p>}
        </section>
      )}
    </main>
  )
}
