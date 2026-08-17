# Transactional same-session refresh

## Problem

Cross-session restore is transactional, but refreshing the current logical session still used the legacy handoff: it stopped the source event runner and could detach or clear the source before `load` or `resume` settled. A slow, failed, partial, or stale refresh could therefore interrupt an otherwise healthy transcript, prompt, and attachment. Changing an explicit client ID had the same problem.

## Scope

This change covers `loadSession`, ordinary or configured `reloadSession`, `resumeSession`, and explicit non-empty client-ID replacement when the normalized `(sessionId, workspaceCwd)` remains unchanged. It reuses the provider-local restore coordinator introduced for cross-session switching. Epoch or ring resync, memory repair, branch adoption, selective JSONL reading, and daemon-side resource scheduling remain separate work.

Modern transactional behavior requires a successful capability snapshot advertising `client_identity` and concrete source and candidate client IDs. A daemon that explicitly lacks the feature retains the legacy destructive path. Unknown capabilities, incomplete modern responses, missing cursor or epoch state, and malformed ownership fail closed and preserve the source. An explicit client ID changing to `undefined` keeps the current attachment.

## Scheduling and request identity

Restore identity includes the normalized session and workspace, the effective replay shape (`load/all`, `load/recent(N)`, or `resume/none`), and the requested client ID. Only identical signal-free requests coalesce. Different same-session intents are latest-wins, while a cross-session target supersedes a refresh and a pending cross-session target cannot be silently cancelled by reloading its source. One ordinary restore RPC runs at a time; a compatible same-shape retry may adopt a late result, while every stale result is detached once on a best-effort basis.

A same-session request waits for the source runner to be ready and free of local, restored, or observed work before it starts. This wait does not consume the restore budget. The budget starts with the raw RPC, and signal, lifecycle, navigation, resync, or environment changes can still cancel the intent. Resync remains authoritative and continues through its existing destructive recovery path for this change.

Source-bound branch, create, attach, and legacy restore operations exclude ordinary restores. The exclusion follows the raw operation rather than an outer action timeout: a timed-out create keeps restores blocked until its raw request settles, and a late successful create is detached once. A controlled target discovered during a source-bound operation remains pending and is retried once the final source-bound operation settles, so a transient interlock cannot permanently drop the host's desired target.

## Cursor capture and integrity

The source runner tracks a processed cursor separately from the SDK read cursor. It advances the processed cursor only after transcript normalization, notices, side channels, workspace signals, prompt settlement, and connection side effects for an event have completed.

When a full load starts, the runner captures the exact source object, client ID, event epoch, and processed cursor. Subsequent raw event references are retained only while their IDs are contiguous and increasing. The capture is bounded by the configured event queue and 8 MiB of serialized UTF-8 data; id-less non-sentinel frames, gaps, serialization failures, overflow, epoch changes, or in-place source client-ID changes invalidate the candidate.

A load candidate must carry both replay arrays, a matching epoch, a valid watermark at or after capture start, complete non-degraded replay, and no partial-replay diagnostic. A resume candidate must carry a matching epoch and valid watermark. If the candidate watermark is ahead, the source remains live until the processed cursor catches up. A candidate claiming active prompt work cannot commit until the source processes a later terminal or cancellation and no runner-owned turn remains.

## Staging and commit

Full-load replay is normalized into an unsubscribed shadow store in batches of at most 512 events. Replay arrays are traversed directly rather than concatenated. At commit, the bounded source tail after the candidate watermark and through the final processed cursor is applied to the shadow store. Staging does not publish notices, side channels, workspace signals, prompt state, transcript, history, or connection updates; malformed or repair-requiring replay invalidates the candidate.

One synchronous commit rechecks the desired intent, lifecycle and environment, exact source object and client ID, epoch, deadline, runner readiness, turn state, and processed cursor. It then flushes and stops the source runner, installs the candidate attachment and connection, and either replaces the visible replay page for `load` or preserves the existing transcript for `resume`. Resume creates a new history owner so stale pagination cannot write through. The candidate cursor is advanced to the source's final processed cursor before its metadata and SSE runner starts. The public promise resolves only after visible owners agree; source detach happens afterward and never blocks the result.

Same-session notices and settled-prompt bookkeeping are preserved. Candidate replay and captured tail side effects are not republished because the source already processed them through the final cursor. Connection metadata is based on the connection current at commit and refreshed by the new runner, avoiding rollback to metadata captured when the request began.

## Client-ID reconciliation and failure behavior

Raw `clientId` props are desired input rather than committed owner state. A modern explicit client-ID change performs transactional resume. A change while another target is preparing updates that target rather than rebinding the source. Legacy daemons use a full destructive load so the transcript is not replaced by an empty resume replay.

The commit CAS includes the source object's current client ID. If SDK prompt-admission self-heal updates that ID in place, the prepared candidate is discarded and the healed source remains active. Failures publish one recoverable transition failure while leaving source connection, transcript, prompt, metadata, and controls usable; they never rewrite the source as missing or disconnected.

The committed client ID is also the recovery identity. Once a modern rebind commits, later renders cannot restore the initial prop into the committed client ref; subsequent ring or epoch recovery therefore requests the attachment that actually owns the current runner. Legacy daemons still mirror the prop because they do not support transactional client ownership.

All terminal intent paths retire a prepared candidate and release its source-tail capture. A raw restore timeout may retain the capture only until that raw request settles, allowing an exact-shape retry to adopt its result without leaving event capture enabled after the intent has otherwise failed.

Bounded load responses carry the same event epoch as full load responses. The bridge snapshots the replay watermark and epoch together and returns them only if both remain unchanged through the persisted-page read, preserving the provider's same-epoch commit check.

## Verification and risks

Unit coverage checks delayed success and failure, local and observer prompt gating, response completeness, partial or degraded replay, epoch and tail gaps, cursor catch-up, client-ID rebind, in-place self-heal, late cleanup, and cross-session arbitration. SDK tests cover epoch and replay-integrity propagation. A real-daemon JSDOM test withholds an already-completed same-session load response, sends live source work during the hold, and verifies atomic replay-plus-tail commit without loss or duplication; structured timeout and client-ID rebind paths verify source preservation and transcript continuity.

Staging temporarily retains the visible transcript, the candidate replay, and up to 8 MiB of source tail. CPU-heavy restore in the same ACP child may still delay source events. Detach is deliberately single-attempt and best effort, so a failed cleanup can leave an invisible client reference until the existing reaper runs.
