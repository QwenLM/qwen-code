# Auto-memory extraction history identity

[English](auto-memory-history-identity.md) | [简体中文](auto-memory-history-identity.zh-CN.md)

Status: implemented history-identity and ineligible-tail fixes for the default-off window experiment in #13158; controlled input verification remains separate from model acceptance.

## Problem and scope

The project cursor's `processedOffset` becomes a content selector when `preserveUnprocessedHistory` is enabled. A foreign session, compression, or history replacement can make that index select unrelated content. Comparing only the current length cannot detect compression followed by regrowth or a same-length replacement. Starting at the latest 40 entries also loses the user preference at the beginning of a long tool turn.

Keep the default extraction path and the 40-entry window cap unchanged. This fix does not resolve backlog scheduling, partial-write retries, or establish model quality and token savings.

## Decision

Add an optional `processedHistoryHash` to the cursor. Only the window experiment writes or reads it. Hash the processed raw-history prefix with Node's SHA-256, including the structural-prefix length but excluding its synthetic content. Feed one entry at a time to avoid allocating a full-history JSON string. An offset is reusable only when its session, bounds, and prefix hash match.

Without an identity, or in a different session, start at the latest genuine user prompt and retain the whole pending tool turn across bounded windows. Reuse the existing user-prompt classifier, excluding delivered task notifications. A same-session identity mismatch restarts at the first real entry because the changed position cannot be recovered from a hash. A compressed prefix also starts after the synthetic entries, including for legacy cursors, so all subsequent real facts remain reachable.

Use `getStartupContextLength` with `includeCompressed: true` before history curation. Preserve a trailing function call belonging to the compressed prefix together with its response. Exclude summaries and full-file attachments from the selected raw history. Do not trim a curated prefix: curation can merge an attachment with the next genuine prompt.

Compute the start and end hashes before invoking the asynchronous extractor. Persist the hash at the offset actually written, including the live-end zero-tool holdback and the no-user early return. Default-path writes omit the field, so enabling the experiment after a default run bootstraps rather than trusts an unattested index.

Keep the fork's selected window capped, but consume its remaining tail in the same execution when that entire tail has no eligible user text and the selected window made genuine progress. Reuse the no-user gate's per-part classifier: tool responses, model text, runtime reminders, and hidden reasoning alone do not require another fork. The no-user early return may likewise consume such a tail. If any eligible user text remains, keep the existing window boundary and leave the entire remainder pending. A zero-tool completion retains its existing capped-window advancement or live-end holdback; the free tail must not convert it into a cooldown-arming no-op. Attest the consumable tail before the asynchronous fork, so changes to that content invalidate the cursor on the next execution.

## Constraints and risks

Prefix validation costs CPU proportional to the processed raw content in the opt-in experiment. Structural startup refreshes do not invalidate the index, but changes to processed conversation content intentionally restart extraction and may repeat facts. The project cursor remains shared between sessions; session changes bootstrap the current user turn. Facts already discarded by compression cannot be recovered. Media-only prompt classification and synthetic-prefix recognition retain the existing helpers' limits.

Early tail consumption changes future extraction input: a later user prompt can no longer bring that old tool or model context into the next pending window, whereas it could before a subsequent no-user execution consumed the tail. User-text eligibility alone does not prove unchanged memory quality. Representative quality and cost acceptance remains required before enabling the experiment.

## Validation and acceptance

Regression tests must cover a legal new session inheriting long history, a fresh long tool turn, compressed summaries and attachments, shrink followed by regrowth, same-length replacement with an unchanged boundary entry, startup-reminder refresh, asynchronous mutation, and preserved call/response pairs. Verify ineligible-tail consumption with and without a fork, pre-fork tail attestation, retained later user facts, and no extra fork or larger agent budget. Existing empty-window and zero-tool holdback tests must still pass with an attested cursor.

Build, bundle, typecheck, and run the affected extraction, planner, manager, and client tests. Repeat the controlled native-composer input-selection reproduction against the fixed source. Acceptance requires real post-compression facts to remain reachable, synthetic user context to stay out of the selected window, and default extraction behavior to remain unchanged. Controlled forks prove input selection only, not provider execution, memory quality, or cost reduction.
