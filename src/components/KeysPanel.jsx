import { useEffect, useRef, useState } from 'react'
import { getApiKey, getNcbiKey, isKeyRemembered, setApiKey, setNcbiKey } from '../lib/anthropic.js'
import { getTypesafeKey, setTypesafeKey } from '../lib/typesafe.js'

// Bring-your-own keys. They live in this browser only — session storage by
// default, local storage when "remember" is ticked — and go nowhere except the
// provider each one belongs to.
function KeyHelp({ href, children }) {
  return (
    <span className="mt-1 block text-xs text-stone-500">
      <a className="underline" href={href} target="_blank" rel="noreferrer">{children}</a>
    </span>
  )
}

export default function KeysPanel({ onChange, anthropicError = '' }) {
  const [anthropic, setAnthropic] = useState(getApiKey())
  const [typesafe, setTypesafe] = useState(getTypesafeKey())
  const [ncbi, setNcbi] = useState(getNcbiKey())
  const [remember, setRemember] = useState(isKeyRemembered())
  const [saved, setSaved] = useState(false)
  const detailsRef = useRef(null)
  const anthropicSet = Boolean(getApiKey())
  const ready = anthropicSet || Boolean(getTypesafeKey())

  useEffect(() => {
    if (anthropicError && detailsRef.current) detailsRef.current.open = true
  }, [anthropicError])

  function save() {
    setApiKey(anthropic, { remember })
    setTypesafeKey(typesafe, { remember })
    setNcbiKey(ncbi, { remember })
    setSaved(true)
    onChange?.()
  }

  const summary = anthropicSet
    ? 'API keys · set'
    : ready
      ? 'API keys · Anthropic key still needed for references without a DOI or PMID'
      : 'API keys · needed'

  return (
    <details ref={detailsRef} className="panel p-4" open={!ready || Boolean(anthropicError)}>
      <summary className="label cursor-pointer">{summary}</summary>
      <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); save() }}>
        {anthropicError && (
          <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
            {anthropicError} Save an Anthropic key here, then upload the manuscript again.
          </p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-sm">Anthropic (Claude finds and proves the quote)
            <input name="anthropic-key" type="password" autoComplete="off" className="field mt-1" value={anthropic} onChange={(e) => { setAnthropic(e.target.value); setSaved(false) }} />
            {!anthropic.trim() && <span className="mt-1 block text-xs text-amber-800 dark:text-amber-300">Required to read references that do not print a DOI or PMID, and to have Claude check a citation.</span>}
            <KeyHelp href="https://console.anthropic.com/settings/keys">Get a key: console.anthropic.com → API keys (paid per use)</KeyHelp>
          </label>
          <label className="text-sm">TypeSafe (Jev&apos;s support probability)
            <input name="typesafe-key" type="password" autoComplete="off" className="field mt-1" value={typesafe} onChange={(e) => { setTypesafe(e.target.value); setSaved(false) }} />
            <KeyHelp href="https://console.typesafe.ai/home">Get a key: console.typesafe.ai (early access; includes free credit)</KeyHelp>
          </label>
          <label className="text-sm">NCBI (optional, faster PubMed)
            <input name="ncbi-key" type="password" autoComplete="off" className="field mt-1" value={ncbi} onChange={(e) => { setNcbi(e.target.value); setSaved(false) }} />
            <KeyHelp href="https://account.ncbi.nlm.nih.gov/settings/">Free: sign in at account.ncbi.nlm.nih.gov → Account settings → API Key Management</KeyHelp>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <button type="submit" className="btn btn-primary">Save keys</button>
          <label className="flex items-center gap-1"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device</label>
          {saved && <span className="text-teal-700 dark:text-teal-400">Saved in this browser only.</span>}
        </div>
        <p className="mt-2 text-xs text-stone-500">Either key works on its own; with both, Claude&apos;s proven quote is what Jev scores.</p>
      </form>
    </details>
  )
}
