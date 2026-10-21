# Live continuation validation — 0.3.1

On 2026-10-21, a resumed turn of the existing repair chat dispatched two new
native reviewers with fork_turns=none. Both completed all five previously selected
claims (references 11, 12, 13, 95, 96) from the user-supplied Hu et al. PDF.
The earlier reviews remain unchanged. This is a fresh live rerun, not new claims.

- Source-only input SHA-256: 21f367c57f253f19dcca4f2bd0531537d909269b60dd4366b502fc48bd4d01a1
- First reviewer: /root/citation_first_b352cac12fa64ae189619f61415472ab
- Second reviewer: /root/citation_second_d42af998443a46dcb5fe212f4362d429
- Export validation passed: 5 rows, 10 actual recorded judgments, 10 quote spans.
- CSV round trip preserved both judgments, execution records, manuscript locations,
  and untouched blank human fields.
- Both reviewer tool traces show reads only of their assigned source-only file.
  Initial oversized reads were followed by complete chunked reads.
- Source coverage: two full texts and three abstracts, reused from the prior test.
- Results: one not_supported and four needs_review. These are model judgments,
  not human verdicts or independent scientific validation.
- A separate native capability probe successfully called collaboration.list_agents
  on its first and follow-up turns. This tests continuation of that native agent,
  not the desktop UI's tool exposure policy in every user chat.

The screenshot's separate validation chat reported missing tools without a failed
native invocation. Its cause has not been established. Local app code defaults
multiAgentMode to explicitRequestOnly; this does not prove it caused that failure.
0.3.1 makes the native-subagent requirement explicit in the launch prompt and on
continuation, distinguishes direct native tools from deferred registries, and
requires useful preparation/checkpointing when tools truly are unavailable.
The plugin cannot force the host to expose tools. No host configuration, nested
execution, runtime-permission workaround, or external model service was used.

The evidence bundle retains the original PDF, extraction/provenance, sources,
actual host captures, reviewer tool traces, receipts, JSON/CSV, validator scripts,
and validation results. Source text and local logs are not published to GitHub.
