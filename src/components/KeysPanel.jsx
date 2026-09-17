import { useState } from 'react'
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
          <KeyHelp href="https://console.anthropic.com/settings/keys">Get a key: console.anthropic.com → API keys (paid per use; a long manuscript with many full-text papers can cost a few dollars)</KeyHelp>
        </label>
        <label className="text-sm">TypeSafe (Jev's reliability mark)
          <input type="password" autoComplete="off" className="field mt-1" value={typesafe} onChange={(e) => { setTypesafe(e.target.value); setSaved(false) }} />
          <KeyHelp href="https://console.typesafe.ai/home">Get a key: console.typesafe.ai (early access; includes free credit)</KeyHelp>
        </label>
        <label className="text-sm">NCBI (optional, faster PubMed)
          <input type="password" autoComplete="off" className="field mt-1" value={ncbi} onChange={(e) => { setNcbi(e.target.value); setSaved(false) }} />
          <KeyHelp href="https://account.ncbi.nlm.nih.gov/settings/">Free: sign in at account.ncbi.nlm.nih.gov → Account settings → API Key Management</KeyHelp>
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
