import { useState } from 'react'
import { getApiKey, getNcbiKey, isKeyRemembered, setApiKey, setNcbiKey } from '../lib/anthropic.js'
import { getTypesafeKey, setTypesafeKey } from '../lib/typesafe.js'

// Bring-your-own keys. They live in this browser only — session storage by
// default, local storage when "remember" is ticked — and go nowhere except the
// provider each one belongs to.
export default function KeysPanel({ onChange }) {
  const [anthropic, setAnthropic] = useState(getApiKey())
  const [typesafe, setTypesafe] = useState(getTypesafeKey())
  const [ncbi, setNcbi] = useState(getNcbiKey())
  const [remember, setRemember] = useState(isKeyRemembered())
  const [saved, setSaved] = useState(false)
  const ready = getApiKey() || getTypesafeKey()

  function save() {
    setApiKey(anthropic, { remember })
    setTypesafeKey(typesafe, { remember })
    setNcbiKey(ncbi, { remember })
    setSaved(true)
    onChange?.()
  }

  return (
    <details className="panel p-4" open={!ready}>
      <summary className="label cursor-pointer">API keys {ready ? '· set' : '· needed'}</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">Anthropic (Claude finds and proves the quote)
          <input type="password" autoComplete="off" className="field mt-1" value={anthropic} onChange={(e) => { setAnthropic(e.target.value); setSaved(false) }} />
        </label>
        <label className="text-sm">TypeSafe (Jev's reliability mark)
          <input type="password" autoComplete="off" className="field mt-1" value={typesafe} onChange={(e) => { setTypesafe(e.target.value); setSaved(false) }} />
        </label>
        <label className="text-sm">NCBI (optional, faster PubMed)
          <input type="password" autoComplete="off" className="field mt-1" value={ncbi} onChange={(e) => { setNcbi(e.target.value); setSaved(false) }} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button className="btn btn-primary" onClick={save}>Save keys</button>
        <label className="flex items-center gap-1"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device</label>
        {saved && <span className="text-teal-700 dark:text-teal-400">Saved in this browser only.</span>}
      </div>
      <p className="mt-2 text-xs text-stone-500">Either key works on its own; with both, Claude's proven quote is what Jev scores.</p>
    </details>
  )
}
