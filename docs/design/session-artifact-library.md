# Persisted session artifact library

[English](session-artifact-library.md) | [简体中文](session-artifact-library.zh-CN.md)

## Problem and scope

DAC needs an instance-wide artifact library covering live, cold and archived sessions. Existing session artifact routes require a loaded session, and mutations require a session-bound client. Loading every historical conversation would allocate agents and change runtime state merely to browse outputs.

## Design

Add persisted-workspace-scoped `GET /workspaces/:workspace/session/:id/artifact-library` and `DELETE /workspaces/:workspace/session/:id/artifact-library/:artifactId`. Publish `session_artifact_library` only when artifact persistence is available. Old live-session/client-owned routes retain their existing contract. The management delete route requires the existing strict mutation guard and a trusted, explicitly resolved workspace; it represents the workspace owner and can remove client-created registrations without impersonating a client. It never sends prompts, attaches a client, unarchives a conversation, or deletes workspace files.

Read live artifacts through the owning runtime bridge. Read cold or archived records through SessionService, validating storage identity, project ownership, complete transcript records and the active conversation branch. Sessions that register artifacts before their first prompt may contain only artifact events and title/source metadata; these are valid without a conversation chain. Project persisted records using the existing artifact validation and public serialization rules without snapshot retention writes or allocating an agent. Bound individual transcript reads to 64 MiB and report unavailable/corrupt data explicitly.

For deletion, hold the session archive coordinator exclusively so load/archive/delete cannot race. Live deletion uses a separate owner-management bridge method, the existing store queue and durable persistence/events. Cold deletion obtains a daemon writer lease (or the existing maintenance lease for archived storage), rechecks physical identity and appends a native artifact event with an explicit tombstone and the original marker. Its parent is the reconstructed active conversation tail; the physical last record may be source metadata that artifact replay does not follow. Failure must leave the registration visible. Managed execution transcripts remain under their own authority and reject legacy mutation. A missing artifact is an idempotent success; unknown sessions and conflicting storage are errors. No transcript rewrite or second metadata authority is introduced.

## Affected components

- `packages/core/src/services/sessionService.ts`: bounded artifact snapshot reads and guarded cold tombstones.
- `packages/acp-bridge/src/sessionArtifacts.ts`, `session-control-plane.ts`, `bridgeTypes.ts`: read-only projection and explicit workspace-owner removal.
- `packages/cli/src/serve/server/session-artifact-library.ts`, routes and capabilities: selected-runtime authority, locks, lifecycle and feature negotiation.
- DAC consumes the routes through its existing authenticated daemon facade; its UI owns view/pin preferences and optional physical-file deletion.

## Validation and acceptance

Test live/cold/archived reads, removal surviving reload, unchanged archive/history, no attach/spawn, owner/client separation, workspace mismatch, corruption, concurrent writer refusal and idempotence. Run focused package tests, build, typecheck and bundle. A temporary daemon HTTP test compares the global baseline with the local bundle without model calls or real user sessions. The plan/results live in `.qwen/e2e-tests/session-artifact-library.md`.

## Risks and open questions

Older daemons do not advertise the feature; clients must show an upgrade state rather than silently returning only live artifacts. Very large or corrupt transcripts are explicit partial failures. Managed execution registration mutation is outside the legacy persistence authority.

The existing session loader can lose the live artifact view for an API-only session that has never recorded a conversation turn; this was reproduced with the unmodified global CLI. The library's cold reads and deletion persistence support these journals, but this change does not replace the existing empty-conversation loader. Restore acceptance for conversation-generated artifacts uses a completed turn recorded through the normal ChatRecordingService API. There are no remaining product decisions for this protocol.

## Ownership and failure semantics

Both routes resolve global live ownership before dispatch and reject ambiguous, unavailable or different-runtime owners. Internal runtime activity fencing surrounds the shared/read or exclusive/remove archive barrier. Cold projection preserves timestamps, downgrades legacy pinned retention with a warning, and reports metadata-only restoration without claiming persistence is unavailable. The live limit remains 200; cold reads do not evict registrations.

Per-artifact compatibility warnings accompany partial reads and permit deleting a known registration; unrecognized versions, truncated journals and stale sequence warnings refuse mutation. Incomplete records or conversation chains use `session_transcript_corrupt`, while concurrent physical changes keep the writer-conflict code. Empty or foreign-workspace journals are not found; other storage identity failures are conflicts. Managed mutation refusal names the artifact operation.

Cold no-op removal returns no changes. Successful tombstones release unreferenced managed web-preview snapshot references on a best-effort basis and preserve workspace files. Rename parents skip side records, including when a large artifact snapshot pushes the conversation tail out of the first read window. Live persistence failures retain the existing HTTP 200 warning result, which callers must inspect before removing an item from their view.
