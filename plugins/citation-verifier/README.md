# Paper Trellis Citation Verifier — Codex plugin

An initial skills-based port of [Paper Trellis Citation Verifier](https://github.com/MarissaFamularo/citation-verifier).
Ask Codex: **“Check whether the citations in this manuscript support its claims.”**

The active OpenAI model in Codex reads references, maps citing sentences to papers,
and evaluates source evidence. Local Python helpers extract documents, fetch papers,
check quotations and numbers, and export JSON/CSV. No Anthropic or TypeSafe account
and no separate OpenAI API key are required. Usage follows your Codex plan and limits.
This does not reproduce Jev's probability outputs or claim calibrated confidence.

## Install for testing

Requires a Codex/Work surface with Python 3.10+ and script execution. PDF extraction
also needs Poppler's `pdftotext`. Public paper retrieval needs network access.

From the cloned repository, register its repository marketplace:

```bash
codex plugin marketplace add /absolute/path/to/citation-verifier
```

Open the plugin browser (`/plugins` in a supported Codex CLI), choose **Paper
Trellis**, install **Paper Trellis Citation Verifier**, and start a new session.
The package uses the supported `.codex-plugin/plugin.json` compatibility format.
It has not been installed or tested in the Codex plugin UI yet. Public directory
submission is a separate step; this repository marketplace is for testing/sharing.

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
- Two OpenAI readings, with both judgments retained in JSON. Agreement and validated
  evidence are required for a supported result. Missing second passes, disagreement,
  and uncertainty are flagged. A review in the same context is explicitly recorded
  as non-blind; the plugin cannot guarantee model independence.

This is a new Codex workflow, not a full port of the browser app's parsing and
retrieval engine. PDF reading order, superscript detection, author–year ambiguity,
and reference matching require model inspection. Scanned PDFs need external OCR.
The source helper covers Europe PMC; arXiv/OpenAlex/Crossref retrieval is not bundled
in the helper. Source identity and semantic support still require judgment.
Numeric presence is not proof of correct statistics, units, or effect attribution.

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

Current validation: 15 automated tests pass, covering quote provenance, source
coverage, numerical mismatches, DOCX superscripts, retrieval/fallback fixtures,
exports, human-review preservation, and second-pass gates. Marketplace and skill
paths have also been checked. These tests use fixture model judgments and paper
responses; they do not establish real model accuracy, live API availability, or
successful installation in the Codex UI. Those integration checks remain open.
