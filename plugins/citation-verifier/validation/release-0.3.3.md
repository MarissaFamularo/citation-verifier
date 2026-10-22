# Version 0.3.3 — publication candidate

This update uses the existing GitHub marketplace route:
`MarissaFamularo/citation-verifier`, Git ref `codex-citation-plugin`, plugin
`citation-verifier`. The marketplace still resolves `./plugins/citation-verifier`.
Only the plugin manifest version and default launch prompt change; marketplace
identity, installation policy, permissions and repository layout stay unchanged.
Publication, marketplace refresh and installed-plugin verification are separate steps.

## Changes from 0.3.2

- Preserve spaced ASCII/Unicode unary minus signs in numeric checks. The saved
  claim `− 0.42` matches source `−0.42`, while positive `0.42` fails. Exact values,
  percentages, explicit bounds and approximate positive-person-count rules remain
  conservative; no broad tolerance was added.
- Store each complete identical source text once per reviewer batch, keyed by
  SHA-256 and referenced by each pair. Source identity and coverage metadata stay
  per pair. Distinct first/second source-only contexts, input binding and legacy
  export/receipt validation are retained. No source truncation or judgment sharing.
- Add actionable review categories and clause-attribution guidance while preserving
  original verdicts, human fields, evidence and both-review gates.
- Add offline preflight work summaries, explicit pending-pair batches and saved
  judgment protection. Counts and bytes describe work, not quota estimates.
- Support explicit requested models from an observed current host capability
  profile. Unknown inheritance requires explicit opt-in. Prefer an appropriate
  supported lower-cost choice; do not assume runtime inheritance is cheap.
  Model provenance records requested selection, not attested backend identity.

## Validation and limits

The publication candidate passes **46 offline Python tests** covering numeric
controls, source/identity binding, old exports/receipts, source-only separation,
model selection, resumable subsets, saved judgments and human fields. No browser-app
code or dependency changes require application build or installation.

Before this packaging pass, a bounded handoff smoke test completed exactly two
synthetic pairs with two fresh reviewers and four judgments. Both dispatches
explicitly requested `gpt-6-luna`; their inputs were identical source-only payloads.
Import, quote/numeric validation, distinct execution identities, human-field
preservation, JSON/CSV export and four execution bindings passed. There were zero
retries, inherited/stronger-model fallbacks or additional reviewer calls. Runtime
results exposed task identities and responses, not backend model attestation or
complete tool-use traces. No additional reviewers were run during packaging.
This is a plumbing test, not scientific-accuracy evidence or a model benchmark.

Synthetic repeated-source prompt bytes are recorded in `payload-reduction.json`:

| Pairs sharing a complete source | Before bytes | After bytes | Payload reduction |
| --- | ---: | ---: | ---: |
| 1 | 38,164 | 38,708 | -1.43% (format overhead) |
| 5 | 186,924 | 39,656 | 78.78% |
| 12 | 447,256 | 41,317 | 90.76% |

These figures measure payload reduction, not quota/cost savings. Each fresh reviewer
still receives the full batch evidence independently. No new paper audit or pilot
was run. Two-review requirements remain universal; selective review/provisional
verdict changes remain deferred.

## Publication boundaries

The candidate contains plugin code, synthetic tests, documentation and version
metadata. No private manuscript, paper PDF, downloaded source, raw audit/export,
reviewer receipt/capture, local host profile, local filesystem path or session
identifier is added. Raw smoke-test artifacts and private implementation records
remain outside the publication candidate. Previously public historical validation
documents in the baseline are unchanged; no original audit evidence is rewritten.

The existing repository's unrelated browser application and deployment files are
unchanged. No credentials, hosted infrastructure, runtime/security configuration,
installation, marketplace refresh, push, tag or public release is part of preparation.
After explicit approval, publish the reviewed candidate to the existing branch,
refresh the existing marketplace installation, and verify that version 0.3.3 loads
before separately authorizing an installed-plugin paper test.
