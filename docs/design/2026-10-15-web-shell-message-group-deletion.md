# Web Shell message group deletion

[English](2026-10-15-web-shell-message-group-deletion.md) | [简体中文](2026-10-15-web-shell-message-group-deletion.zh-CN.md)

## Status

Implemented. Scope: ordinary local daemon sessions; authoritative Managed storage and SSH workspaces are explicitly unsupported. The hosted harness profile does not advertise message deletion.

## Problem and current behavior

Web Shell cannot delete selected conversation turns. Rewind discards a suffix and leaves abandoned JSONL records; neither behavior satisfies arbitrary grouped physical deletion. Local commands also create ephemeral display messages.

## Behavior

A group contains a user prompt and all its answer, thought, tool, result, error and cancellation messages, or one slash-command invocation and its display output. The message action row shows Copy and a vertical-ellipsis trigger. Hovering the trigger opens a shared portal-scoped menu containing the available tool-call, edit and delete actions; moving into the menu keeps it open, and leaving both closes it after a short grace period. Click/touch and keyboard opening remain supported. Starting deletion selects the current group; checkboxes at the left of message rows toggle the whole group. Each user message keeps its checkbox; a reply group has a single checkbox beside its Processed header, or beside its first reply row when no status header is shown. Expanding thought/tool steps never adds checkboxes. Groups before and after the entry can be selected non-contiguously; the entry determines only the initial selection. During selection the Delete messages menu item remains visible but disabled. Unselected groups survive. Empty selection disables deletion. A confirmation explains irreversible history deletion, preserved summaries and unchanged command effects/files.

Deleting the only/all groups preserves the session and necessary metadata. An empty visible transcript can still have effective summary context. Only idle sessions may mutate history; running, queued and background turns are rejected server-side. Selection is session-scoped and cleared on switching sessions.

## Design decisions and rationale

Use two hashes: the selection snapshot ignores late metrics and automatic titles so harmless background writes do not reject a selection; the complete-file hash protects atomic replacement from any concurrent modification. A single hash cannot provide both behaviors, and a version counter would require all existing writers to maintain another authority.

Refuse ambiguous ownership instead of deleting only identifiable fragments, because partial deletion could leave original text in retained compression context or break tool-call/result pairs. Preserve summaries exactly; deleting an original does not retract information already summarized. Fast compression inherits the existing summary boundary when that prefix is unchanged.

Reject busy sessions instead of queueing deletion. The bridge queue serializes operations, but executing a stale destructive selection after a running turn would change the history the user reviewed. The session gate also blocks automatic and background turns during replacement.

Listing a legacy transcript serializes with its writer without acquiring a lease or changing its write mode. Only deletion upgrades it to lease ownership. Telemetry belongs to its explicit prompt/tool identity, including late arrivals; events owned by deleted groups are discarded during and after replacement.

After a snapshot conflict, clear selection and require the user to select again with a fresh snapshot; never automatically retry deletion. A committed deletion with failed context installation returns its deleted identities and a reopen requirement, refreshes the originating client, and blocks stale-context admission while releasing the operation lock so close can drain. Later requests receive a fresh context-unavailable error without a persisted claim or earlier deletion identities; reopening rebuilds context from JSONL before admission resumes. Failed transcript reloads retain surviving saved messages and local commands and explain that deletion succeeded but refresh failed. Preserve local command positions and IDs through reload, including failed reloads.

Keep each surviving file turn’s original diff endpoint when its next turn is deleted, separately from rewindable snapshots. Retaining the deleted snapshot as a turn would shift rewind ordinals; using the next surviving snapshot would attribute deleted edits to its predecessor. Persist the endpoint backups and include them in validation, backup version allocation and retention so restart, fork, later edits and cleanup preserve the same diff. This does not restore files or retain the deleted turn’s identity.

## Persistence and model context

A server listing returns stable owning-record UUIDs, associated daemon prompt IDs and record IDs plus a SHA-256 snapshot excluding only system/ui_telemetry and custom_title records with titleSource=auto. Late background metrics and automatic title updates do not invalidate selection. Atomic replacement separately verifies the current complete JSONL SHA under the writer lease. Deletion validates the snapshot and the complete group set under history and writer locks. A lease-owned temporary-file replacement atomically removes original records, reconnects parentUuid edges through removed ancestors without resurrecting abandoned branches, and retains a non-message transaction anchor even for empty histories. Recorder state and future write proof are refreshed.

Every existing summary stays unchanged; deletion never invokes a model or regenerates summaries. Selected original model-facing spans are removed from live history and from compressedHistory raw-tail copies, including paired tool results. New checkpoints record the generated summary/restore prefix length; its contents remain unchanged. Missing or partial identities that cannot distinguish summarized content from retained raw input cause deletion to fail before writing. Copied selected tool calls/results inside an unowned compression span also cause refusal. Thus deletion of a fully summarized turn changes display/persisted originals only; deletion of raw context changes future model input. Files and command effects, model bindings, title, approvals and compression checkpoints are preserved.

## Runtime and client integration

GET /session/:id/message-groups and POST /session/:id/messages/delete are live-session-owner routes. They never fall back to the primary runtime. The ACP operation owns the history mutation gate; the bridge serializes with prompts and publishes session_messages_deleted after authoritative persistence/context update. Existing replay caches must be invalidated so reload cannot resurrect removed messages. All connected clients refresh transcript, navigation and search state. Frontend-only messages are removed locally without adding persistence.

## Affected areas

Core grouping, compression-tail pruning, ChatRecordingService and SessionWriterLease; CLI ACP session/control and owner-scoped daemon routes; ACP bridge/capabilities; TypeScript daemon SDK; Web Shell message projection, selection controls and session refresh; focused tests and browser E2E.

## Constraints and risks

No undo, command rollback, file restoration, re-answering later messages, summary editing, or deletion from unrelated retained replies. Ambiguous/corrupt history and stale snapshots fail closed. Managed append-only stores require a separate authoritative mutation contract and are not supported by this change. Atomic file replacement must re-pin writer identity/hash and preserve secure permissions. A failure after persistence must not permit continued prompts with stale memory.

## Validation and acceptance criteria

Focused tests cover single/all/non-contiguous deletion, tools/thoughts, compression before/after/raw-tail behavior with summary equality, slash output/effects, abandoned branches, stale snapshots, writer conflicts and continued append/resume. Owner route tests cover busy and workspace isolation. Browser tests cover reply-header placement, stable checkbox counts across step expansion, linked checkboxes, empty selection, cancel/confirm/error, local commands, peer invalidation and reload. Build, bundle, typecheck, changed-file lint and two clean self-audit passes are required. UI screenshots use a clearly identified mock daemon; persistent backend evidence uses a real daemon, ACP process and JSONL with a deterministic local mock model. The latter verifies stale snapshots, physical tool-group deletion, subsequent model requests, compression summary equality, command display deletion, delete-all and reopen/append.

## Open questions

None for the agreed behavior. Unsupported runtime capabilities are explicitly reported rather than silently degrading to frontend-only deletion.
