# Native two-pass live verification — 2026-10-21

Version 0.3.0 was exercised live in the current Codex desktop session using native `collaboration.spawn_agent` with `fork_turns="none"`. This is not a retest of nested CLI startup in the original read-only ChatGPT Work runtime. The native route never starts that CLI. A host without the required native tools remains blocked and must not silently substitute a same-chat rereading or external API.

## Test scope and execution

Five selected claim/reference pairs from the user-supplied Hu et al. 2026 ACC Food and Health PDF: references 11, 12, 13, 95, and 96, on PDF pages 5 and 12. This is a purposive integration test, not a full-document audit or accuracy benchmark. Source identity was matched by title, authors, year, and DOI/PMID. Two sources were full text; three were abstracts.

Two initial native attempts returned explicit input-truncation errors. No judgments were accepted from them. The handoff was corrected to require complete reads/chunks, then two fresh agents were started. They received separate source-only files with identical contents, prepared before either verdict. Both completed all five claims. Actual completion snapshots and tool results were captured; no model responses were simulated or rewritten.

Input SHA-256: `21f367c57f253f19dcca4f2bd0531537d909269b60dd4366b502fc48bd4d01a1`

Accepted reviewers:

- `/root/citation_first_0e3a3b2561cb46588dcda38d91a99304`
- `/root/citation_second_42c64f9530874dcdb6448a868779c1b2`

Both reviewer tool traces were inspected: only the designated input file was read (an initial large read, then complete chunks). No sibling-file, prior-verdict, or network reads were observed. The general adapter records host-observed spawn/completion data, not signed provider attestations or a guarantee that native tools were disabled. The model label is `runtime-inherited`; no exact backend model or reasoning effort is claimed.

## Results

| Reference | First / second relation | Final status | Coverage |
|---|---|---|---|
| 11 | off_topic / off_topic | not_supported | abstract_only |
| 12 | supports / contradicts | needs_review | full_text |
| 13 | supports / supports | needs_review | abstract_only |
| 95 | contradicts / contradicts | needs_review | full_text |
| 96 | contradicts / contradicts | needs_review | abstract_only |

The single `not_supported` result is a cited-source outcome mismatch, not a finding that DASH lacks cardiovascular benefits. All four other rows require human review. In particular, the reviewers differ on how to interpret the CKD wording; certainty language is interpretive. No human verdict was entered.

## Validation

- Both passes completed: 10 judgments across five claims.
- `check-export`: passed, 5 rows and 10 execution bindings checked.
- All 10 quotations match their normalized source spans. Context, source URLs/hashes, and both raw judgments are preserved.
- CSV round-trip checked for all five rows, both execution records, second-pass evidence, manuscript page/column locations, and human fields.
- Human verdicts/notes remain null/empty in the live report. Synthetic regression tests separately verify preservation of existing nonempty human decisions and rejection of model-injected human/provenance fields.
- 36 automated tests pass. These include historical CLI compatibility, native fresh-context/identity checks, failed/truncated/malformed results, changed input/source/records, same-agent reuse, disputed/silent/rejected-quote export integrity, and no native subprocess invocation.

## Evidence and limits

The complete evidence bundle is delivered with the chat as `citation-verifier-live-five-claim.zip`: original PDF, extraction/provenance, five source JSON files, prepared inputs, captured native tool returns, reviewer tool traces, failed attempts, model-run receipts, JSON/CSV exports, validation JSON, and the verifier scripts. Public repository changes contain code, tests, and this validation summary; manuscript/source full text and local-session logs are retained in the delivered bundle rather than published to GitHub.

PDF layout extraction interleaved columns. The five sentences were checked against rendered pages and transcribed with page/column locations; printed superscripts are represented as inline numbers. The full layout extraction and cropped-column text remain available. The existing numeric-token heuristic can treat these inline citation numbers as claim numbers (for example reference 13); it is not semantic numerical validation. The salt-substitution row remains needs_review because both reviewers explicitly record scope uncertainty. No claim is promoted past an uncertainty or disagreement gate.

Native support must be inspected on each host. No separate API key or hosted-service architecture was added. No runtime-directory permission workaround was retried.
