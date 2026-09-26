# Paired engine owner selection and typed rejections

[English](./2026-09-26-paired-engine-owner-selection.md) | [简体中文](./2026-09-26-paired-engine-owner-selection.zh-CN.md)

## Status

Slice B2a of #12737, the Stage B host integration for #12380, based on upstream
`342ba1bcdd`. It follows the Bridge routing slice in
[ACP Bridge execution engines](./acp-bridge-execution-engines.md) and is the
prerequisite for host wiring (B2d). Workspace contracts (B2b), per-engine
operations (B2c) and host wiring remain separate slices. After this change no
ordinary daemon, Channels or embedded constructor passes `executionEngines`.

## Problem and current behavior

#12693 added the `session_execution_engine` transcript record and a reader that
accumulates it over the whole physical transcript. #12698 made a paired Bridge
require `_meta['qwen.session.executionEngine']` in every new/load/resume
response. Nothing connects the two: no ACP host persists or verifies the owner
before answering, the Legacy ACP host returns no receipt at all, and no host
selector reads the persisted owner for a cold restore.

The paired Bridge rejects an invalid or already live requested session ID with
an ACP SDK `RequestError`. REST answers it with HTTP 500 and the ACP transports
with `-32603` internal errors. Ordinary routes reach the Bridge only after
shared ID admission, but `LocalManagedRuntimeProvider` and the standalone
service create sessions directly, and a direct creator can register an ID
while a route's persisted-state admission check is still running. The Managed
branch and side-task rejection is a plain `Error` and also becomes a 500.

## Scope

In scope:

- The Legacy ACP host persists or verifies the owner before initialization side
  effects and only then returns the engine receipt.
- A host selector that selects cold load/resume from the persisted owner.
- Bridge-owned typed rejections for requested IDs and Managed branching, mapped
  through REST, the ACP HTTP/WebSocket transports, the managed-runtime provider
  and the standalone service.
- The test-hardening items from #12698 that belong to this slice.

Out of scope: wiring any host and the configuration-compatibility selection of
new sessions (B2d), workspace contracts (B2b), per-engine operations and
quarantine recovery (B2c), the Managed Harness and Managed branching. Public
REST changes are limited to the error classifications below.

## Proposed design

### Owner persistence and receipts

A paired Bridge puts the selected engine in the request
`_meta['qwen.session.executionEngine']` for new, load and resume. The
single-factory path sends nothing and is unchanged. The Legacy ACP host accepts
only `legacy`; any other value is refused with `-32024` and
`session_execution_engine_unavailable` before a Config is created. The host
passes the engine to the session Config as host policy (`loadCliConfig`
`hostPolicy.executionEngine`, then `ConfigParameters.sessionExecutionEngine`);
it is never read from argv, settings or the environment.

`Config.initialize()` binds the owner after chat recording can take writes and
before `initializeInternal()` starts hooks, MCP, skills, tools and the model.
With the writer lease enabled, this is after the lease is held and the
authoritative history has been re-read.

- A new session appends `session_execution_engine` with
  `{ version: 1, engine }` as the first transcript record through the strict
  write path. A failed write fails initialization and the creation.
- A restore requires the owner in its restore projection to be verified and to
  equal the selected engine. The transcript reader computes that owner from the
  same file snapshot as the restored history. Another engine, unprovable
  history or a missing proof rejects with `SessionExecutionEngineError` before
  any side effect.
- Without chat recording there is no durable session, so nothing is written.

The ACP response carries the receipt only after this binding succeeded. A
session that is already live in the child keeps its owner and returns the
receipt without a new Config.

A paired Legacy session is therefore durable from creation, as a Managed
session is. A session that is created but never used, or whose creation fails
after the owner record was written (for example during authentication), leaves
a transcript that holds only the owner record. It is listed, it can be loaded,
and its ID stays occupied. Single-factory sessions keep today's behavior.

### Host selector

`createSessionExecutionEngineSelector({ newSessionEngine, runtimeBaseDir })`
builds the paired Bridge `select` callback in the CLI serve layer.

- Spawn returns `newSessionEngine`. B2d replaces this input with the
  configuration-compatibility policy.
- Load and resume resolve the persisted spelling that the ACP child restores
  (case-insensitive lookup), then read the whole active transcript with the
  strict owner accumulator and return the verified owner. A complete history
  without an owner record is Legacy. A missing or empty transcript is
  `SessionNotFoundError`. Invalid, conflicting or incomplete owner evidence is
  `SessionExecutionEngineError`. A restore never uses the host default.

The selector and the ACP child read the same transcript, and the child checks
the owner again from its restore snapshot, so a change between the two reads
cannot move a session to another engine.

### Typed rejections

`RequestedSessionIdRejectedError` in the Bridge package extends the ACP SDK
`RequestError`, so direct ACP callers still receive invalid params (`-32602`).
Its `errorKind` is `invalid_session_id` or `session_id_conflict`; a conflict
carries the `sessionId`, and an invalid ID is not echoed back. The Bridge
package does not import CLI admission classes.
`ManagedSessionBranchUnsupportedError` replaces the plain error for Managed
branch and side-task requests, which still reject before mutating history.

| Rejection                          | REST                                                               | ACP HTTP/WebSocket `data`                                                                      |
| ---------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Invalid requested ID               | 400 `{ code: 'invalid_session_id' }`                               | `-32602`, `{ httpStatus: 400, errorKind: 'invalid_session_id' }`                               |
| Live requested ID                  | 409 `{ code: 'session_id_conflict', sessionId, conflict: 'live' }` | `-32602`, `{ httpStatus: 409, errorKind: 'session_id_conflict', sessionId, conflict: 'live' }` |
| Managed branch or side task        | 409 `{ code: 'managed_session_branch_unsupported', sessionId }`    | `-32602`, `{ httpStatus: 409, errorKind: 'managed_session_branch_unsupported', sessionId }`    |
| Owner unavailable (selector/child) | 409 `{ code: 'session_execution_engine_unavailable' }`             | `-32602`, `{ httpStatus: 409, errorKind: 'session_execution_engine_unavailable' }`             |
| Unusable transcript snapshot       | 409 `{ code: 'transcript_snapshot_unavailable' }` (existing)       | `-32603`, `{ httpStatus: 409, errorKind: 'transcript_snapshot_unavailable' }`                  |

The conflict and invalid-ID shapes match the existing shared-admission
responses. The SDK HTTP and WebSocket transports restore the HTTP status from
`data.httpStatus`. The selector's snapshot read and the ACP child can both
report an unusable snapshot, which REST already answered with 409; the ACP
transports now carry the same 409 classification instead of a generic internal
error. Only these kinds are mapped; other SDK errors still map to internal
errors.

The direct creators keep their own vocabulary. `LocalManagedRuntimeProvider`
maps a live-ID rejection to its non-retryable
`managed_runtime_identity_conflict`. The standalone service maps an undispatched
live-ID rejection to `standalone_session_conflict` instead of
`standalone_creation_rolled_back`. It does not check that nothing was persisted
for that ID, because the live owner's own transcript is expected there; finding
it must not quarantine the runtime.

## Files and consumers

| Area          | Files                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge        | `bridgeErrors.ts`, `session-control-plane.ts`                                                                                                            |
| Owner binding | core `config.ts`, `chatRecordingService.ts`; CLI `config.ts`, `acpAgent.ts`                                                                              |
| Host selector | `serve/session-execution-engine-selector.ts`                                                                                                             |
| Error mapping | `serve/server/error-response.ts`, `serve/acp-http/dispatch.ts`, `serve/managed-runtime-provider.ts`, `serve/conversations/standalone-session-service.ts` |

No daemon route is added. Session creation, restore, branch and side-task
routes keep their live-session-owner or selected-runtime scope; only their error
classification changes.

## Validation and acceptance criteria

1. A route test injects a paired Bridge, pauses the persisted-state admission
   check, lets a direct creator register the requested ID and resumes. The
   route answers 409 `session_id_conflict` with `conflict: 'live'`, dispatches
   no second ACP `newSession`, and the original session still prompts. Invalid
   input (400) and ordinary shared admission (409) still answer before the
   Bridge.
2. Paired new/load/resume requests carry the selected engine; single-factory
   requests do not.
3. The Legacy host writes the owner as the first record before initialization
   side effects, with and without the writer lease. A restore owned by another
   engine, with unprovable history or without an owner proof rejects before side
   effects, and a Managed selection is refused before a Config exists.
4. The selector restores recorded Legacy and Managed owners whatever the
   new-session engine is, treats owner-less complete history as Legacy, and
   rejects unavailable history.
5. Bridge coverage deferred from #12698: selector-failure admission and ID
   release, requested/returned ID mismatch, a late unaddressable ID while the
   other engine stays live, ID reservation until cleanup acknowledgement, Legacy
   cold restore, a successful paired Legacy branch, and the reentrant-selector
   assertion moved out of the callback.

## Risks and open questions

- Owner-only transcripts from unused or failed paired creations are listed and
  keep their IDs occupied, as described above.
- The selector reads the whole transcript before a cold restore, as the restore
  itself does, so its cost grows with the transcript.
- The selector is not wired. B2d must construct it with the runtime's session
  base directory and decide new-session selection. The questions in #12737
  about selector inputs, propagation failure, quarantine recovery and the
  Hosted boundary are not decided by this slice.
