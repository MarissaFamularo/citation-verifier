# Paper Trellis Citation Verifier — Codex plugin

An initial skills-based port of [Paper Trellis Citation Verifier](https://github.com/MarissaFamularo/citation-verifier).
Ask Codex: **“Check whether the citations in this manuscript support its claims.”**

The host model maps citing sentences to references. Two fresh native reviewer
subagents evaluate identical source-only inputs without inheriting the parent chat.
Python helpers extract documents, fetch papers, validate evidence, and export JSON/CSV.
Native agents use the current product session, with no separate provider API key.
The adapter records `runtime-inherited`; it does not claim a verified model snapshot.

## Install for testing

Requires Python 3.10+, writable review output storage, and native subagent tools
that support fresh contexts (`collaboration.spawn_agent` with `fork_turns="none"`
and `collaboration.list_agents` completion snapshots). Inspect the host tools first:
installing the plugin does not add these execution capabilities to every Work surface.
The installed runtime itself can remain read-only. Do not retry the old runtime
permission workaround. Missing native execution leaves review pending; it must not
trigger nested CLI execution or a same-context second reading. A separate API/hosted
service would require credentials, possible charges, and manuscript transfer; explain
that requirement before changing the architecture.

PDF extraction needs Poppler's `pdftotext`; inspect column reading order and retain
page/column locations when preparing claims. Public source retrieval needs network.

In the ChatGPT desktop app, choose **Plugins → Add → Add a marketplace**. Enter:

- Source: `MarissaFamularo/citation-verifier`
- Git ref: `codex-citation-plugin`
- Sparse paths: leave blank

Install Paper Trellis Citation Verifier from the Paper Trellis marketplace, then
start a new Work chat. Refresh the marketplace/reinstall after version changes.
Alternatively, with Codex CLI:

```bash
codex plugin marketplace add /absolute/path/to/citation-verifier
```

Open the plugin browser (`/plugins` in a supported Codex CLI), choose **Paper
Trellis**, install **Paper Trellis Citation Verifier**, and start a new session.
The package uses the supported `.codex-plugin/plugin.json` compatibility format.
Version 0.1 was installed in ChatGPT desktop. Version 0.2 nested CLI startup failed
in the read-only Work runtime. Version 0.3 uses host-native review handoffs. Public
directory submission is a separate step; this marketplace is for testing/sharing.

## What the first version supports

- Text/Markdown, DOCX with explicit superscript markers, and selectable-text PDFs.
- Codex-led reference mapping and identifier resolution; Europe PMC helper retrieval
  by DOI/PMID, with full-text-to-abstract fallback. Codex can resolve other sources
  through available public APIs and supply source JSON in the documented format.
- Source quotations validated after Unicode/whitespace normalization; a missing
  or invented passage cannot produce a supported result.
- Silent abstracts or partial sources require full text. Unmatched papers stay unresolved.
- Conservative numerical-token presence checks, source hashes/URLs, and separate
  human verdicts and notes in JSON/CSV exports.
- Two recorded OpenAI reviewer executions with distinct native agent identities. Each input
  excludes both earlier judgments. Same-context notes cannot produce a confirmed
  result. Both exact quotations, surrounding context, source hashes, and execution
  records survive export. Missing calls, disagreement, or uncertainty remain pending.
- `check-export` detects missing quotations and rechecks local execution records
  and source files. Keep `model_runs/` and source JSON files with the report.

This is a new Codex workflow, not a full port of the browser app's parsing and
retrieval engine. PDF reading order, superscript detection, author–year ambiguity,
and reference matching require model inspection. Scanned PDFs need external OCR.
The source helper covers Europe PMC; arXiv/OpenAlex/Crossref retrieval is not bundled
in the helper. Source identity and semantic support still require judgment.
Numeric presence is not proof of correct statistics, units, or effect attribution.
Fresh contexts do not eliminate correlated errors. Execution records describe what
the local runner observed; they are not signed provider attestations. Native records retain exact spawn arguments/results and completion snapshots, not
fabricated CLI events. Fresh context is requested explicitly. Only the designated source-only input read is
instructed, not independently attested: native snapshots do not expose tool traces.
Historical CLI records retain their stricter trace-based tool-use check. Native
model selection is inherited from the runtime and is not an exact backend ID.

## Privacy and files

Manuscript and evidence text enter the user's OpenAI session under their account's
terms. Public APIs receive identifiers/search terms; the helper does not send them
manuscript prose. Review files stay in the chosen workspace; there is no application
database or analytics. Reports contain manuscript excerpts, so store them accordingly.
The plugin never supplies a human verdict or modifies the original document.

## Development

```bash
python3 -m unittest discover -s plugins/citation-verifier/tests -v
```

The plugin is self-contained and needs no npm packages. The original browser app
continues to use its existing providers and dependencies. This plugin uses the
repository's MIT license.

Validation results are recorded in `validation/live-five-claim.md`. Automated
fixtures are regression tests, never evidence that live reviewer calls succeeded.
The legacy `model-review` command is retained only as an explicitly chosen CLI
option in an environment already known to support it; Work must not auto-fallback.

### Continuing an audit (0.3.1)

The plugin explicitly requests native reviewer subagents on every batch and
continuation turn. Its Try now prompt includes that requirement. Native tools
must be checked directly; their absence from a deferred-tool registry is not
evidence that the host lacks them. Record an actual dispatch error separately
from a tool that is not exposed at all. If the host does not expose the tools,
preserve results and continue extraction/source preparation, saving a resumable
checkpoint. Reinstalling cannot supply a native host capability.

This instruction change does not control the desktop host's tool exposure.
See `validation/continuation-live-five-claim.md` for the live continuation test
and its limits.
