# Paper Trellis Citation Verifier — Codex plugin

An initial skills-based port of [Paper Trellis Citation Verifier](https://github.com/MarissaFamularo/citation-verifier).
Ask Codex: **“Check whether the citations in this manuscript support its claims.”**

Codex reads references and maps citing sentences to papers. A recorded model runner
evaluates each batch in two fresh OpenAI model sessions using an existing Codex login.
Local Python helpers extract documents, fetch papers, check quotations and numbers,
and export JSON/CSV. No Anthropic or TypeSafe account and no separate OpenAI API key
are required. Usage follows your Codex plan and limits.
This does not reproduce Jev's probability outputs or claim calibrated confidence.

## Install for testing

Requires a Codex/Work surface with Python 3.10+ and script execution. The execution
environment must also have an authenticated `codex` executable capable of starting
fresh sessions. Installing this plugin does not install that runtime. If it is
missing or blocked, reports retain `needs_second_pass`; a rereading in the original
chat does not count. The user's Mac does not need the CLI when execution is cloud-hosted.
PDF extraction
also needs Poppler's `pdftotext`. Public paper retrieval needs network access.

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
Version 0.1 was installed and exercised in the ChatGPT desktop app. Version 0.2
still requires a successful live trial of its separate-session runner. Public
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
- Two recorded, source-only OpenAI executions with distinct session IDs. Each input
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
the local runner observed; they are not signed provider attestations. The model
label is the explicitly requested model ID, not a verified backend snapshot.

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

Current validation: 25 tests pass, including a five-claim, two-session pipeline
fixture; missing quotes, changed inputs/judgments/traces, tool use, same-context
notes, model failures, export integrity, and human-review preservation are covered.
The five-claim fixture uses simulated model responses, not live accuracy results.
A live trial was attempted but Codex failed before a model call with a read-only
filesystem error during app-server initialization. No live judgment was accepted.
This runtime integration check remains open; do not present it as a successful
repeat audit of the ACC statement.
