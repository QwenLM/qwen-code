# Retain the latest complete operation during compaction

[English](retain-latest-compaction-operation.md) | [简体中文](retain-latest-compaction-operation.zh-CN.md)

## Problem

Full-history summaries can lose the exact test failure, edit arguments or result that the agent just observed. Earlier percentage-based tail preservation was replaced by full summarization and restoration in #4599; this proposal keeps only one complete response, not an arbitrary percentage of history.

## Design

Use the latest model Content as the response boundary: main aggregates one accepted response into this entry. Keep it and subsequent stored user entries unchanged, provided there is an earlier non-synthetic model response to summarize. Validate every tool result against exactly one call, including pending results, and reject incomplete or ambiguous groups. Pending input is used for validation but remains owned by the send path and is not copied into replacement history.

Summarize only the older prefix on both cold and cache-sharing paths. Restore recent files, images and plan/subagent state from that prefix, keep the canonical summary/ack prefix, then append a user bridge containing restoration context and the temporal reminder, followed by the original tail. Explicitly mark the three-entry synthetic prefix for startup/rewind detection and checkpoint round trips. A temporal reminder explains that the tail occurred after the summarized history. Original content objects preserve signatures, tool receipts and prompt ownership.

Resolve the retained operation's owning prompt from raw history before curation can merge adjacent user entries. The first retained model entry carries that prompt identity through the existing checkpoint identity array; matching tool-result continuations may repeat it. Deletion treats this leading model entry as the ownership boundary and removes its raw operation until the next prompt. If the owner cannot be identified reliably, use full-history compaction. No transport field or new setting is introduced.

The complete operation including pending results must fit min(20,000 tokens, 20% of the configured window), using the existing estimator. Otherwise use full-history compaction. Payload-overflow and screenshot-overflow recovery also keep the existing full-summary behavior. Existing inflation and hard-send guards remain in force; this does not solve the separate general restoration-budget issue (#16895).

With cold provider usage, subtract only the summarized prefix and add the new summary/restoration cost; the retained operation already belongs to the original count, except the latest model output omitted by a prompt-only provider anchor, which the caller explicitly supplies. This assumes the retained inputs were included in that provider request; later tool results or unanswered input remain subject to the existing stale-anchor undercount until fresh usage arrives. Without usable usage, or with cache sharing, use visible-history delta accounting and preserve the non-visible system/tool remainder. Deduct retained tool images from the image-restoration allowance. Record the synthetic prefix length explicitly for normal, deferred hard-rescue, fast and hosted checkpoints so deletion/resume do not treat retained operations as generated summary. Fast compression detects the structural prefix after rewriting media instead of relying on equality with the previous snapshot; unrecognized prefixes retain the existing checkpoint inference.

When omitted output is added, use the prompt-plus-output total consistently for the inflation guard, reported before count, and telemetry. A candidate must still be rejected when it exceeds that total. Estimated and explicit override anchors already include their relevant output and do not add it again.

## Scope and risks

No new setting, threshold change, transport rewrite or broader history retention. Unidentified/incomplete tool operations fall back to current full compaction. The bounded tail trades some compression ratio for exact recent information. No live-model quality or latency improvement is claimed. Cache sharing still requires existing provider and capacity guards; prefix-only summarization may reuse a shorter prefix.

## Files and verification

Changes touch the compression service, one pure boundary helper, compression metadata and the four checkpoint writers, plus focused tests. Verify multi-tool pairing, missing IDs, duplicate/unmatched results, pending results, signatures/ownership, composition failure and plan reminders, large tails, overflow paths and repeated compaction. Verify both summary request paths exclude the tail and checkpoint prefix length is correct, including full compaction followed by fast compression, JSON restore and deletion. Run affected suites, build, typecheck and lint. Report script-level evidence separately from live CLI/model testing.

## Acceptance and open questions

All selected-tail bytes and identities survive, pending input appears once, older history alone enters the summarizer, and unsafe selections retain existing behavior. No unresolved design choice is required to implement this bounded migration. Real-model task quality, token cost and latency remain follow-up measurements, not acceptance claims of this PR.
