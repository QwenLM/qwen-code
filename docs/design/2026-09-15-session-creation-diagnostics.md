# Session creation diagnostics

[English](2026-09-15-session-creation-diagnostics.md) | [简体中文](2026-09-15-session-creation-diagnostics.zh-CN.md)

Implementation design for PR 1 of [#11944](https://github.com/QwenLM/qwen-code/issues/11944), based on `main@bda4b0743b80a8d07413f03839b34cd5b470e39a`. Independent of PRs 2–4.

## Problem and evidence

A real HTTP route + standalone service + error serializer fault-injection probe confirms that a pre-dispatch failure and an unconfirmed source write both return HTTP 500 `standalone_creation_rolled_back` with `Retry-After: 5`. The original cause is lost and the collection POST warning lacks its target session ID. This proves an observability defect, not the cause or frequency of a deployed incident.

The private source acknowledgement also collapses unavailable recording and unconfirmed writes into `persisted:false`. The bridge previously logged raw RPC error messages and emitted no diagnostic for negative acknowledgements. The globally installed `qwen 0.18.5-preview.0` lacks the standalone route (404); acceptance therefore uses the supported main/candidate implementation with deterministic fault injection, without model calls.

## Scope and ownership

Keep public HTTP codes, messages, retry headers, `sourcePersisted`, model selection, admission, rollback, quarantine and runtime ownership unchanged. No endpoint, SDK upgrade, task retry, result API, schema or model change is introduced.

Standalone creation belongs to the resolved Conversations runtime. Direct child/side-task creation uses that same service boundary. Source writes use the actual session entry's child connection, including fresh ordinary/standalone creation, side tasks, cold restore and source backfill on live restore. Diagnostics never resolve another runtime or fall back to the primary runtime.

## Creation diagnostic

Each validated creation attempt carries local state and emits one `Standalone session creation failed.` record on failure, through the existing daemon logger and telemetry. Successful creation emits none. The server supplies its bounded daemon logger to the service, including for direct callers. Logging failures do not change creation results.

| Field              | Meaning                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`        | Validated, normalized target UUID; never replaced by a parent's error ID                                                                                                                  |
| `relatedSessionId` | Optional validated parent UUID                                                                                                                                                            |
| `workspaceId`      | Existing resolved runtime identity, when available                                                                                                                                        |
| `phase`            | `runtime`, `parent_validation`, `directory_prepare`, `spawn_pre_dispatch`, `spawn_dispatched`, `source_persistence`, `durable_validation`, `model_selection`, `binding`, `initial_prompt` |
| `reason`           | `unknown`, typed `rpc_timeout` / `transport_closed`, typed ownership `runtime_changed`, or `source_not_confirmed`                                                                         |
| `dispatchState`    | `not_dispatched`, `dispatched`, or `unknown`, using the existing spawn dispatch marker                                                                                                    |
| `cleanupOutcome`   | `not_needed`, verified `rolled_back`, `closed`, completed `quarantined`, or `unknown`                                                                                                     |

The source boolean alone cannot distinguish a storage rejection from an RPC failure: the service records `source_not_confirmed`, and the correlated bridge record carries the finer classification. A completed close after a binding/prompt failure is `closed`, not a claim that durable state was rolled back. Quarantine is marked complete only after its existing completion promise resolves; rejection remains `unknown`.

Keep the initiating exception chain in memory through rollback/quarantine, including the original dispatch wrapper. Binding retries preserve the first failed attempt if containment is needed. Cleanup errors cannot replace an already observed creation failure. No new prompt ID is invented; the diagnostic contains no prompt, result, tool argument, source ID, full path, raw RPC payload or credential. Existing logger trace/run context is reused.

HTTP serialization remains an explicit field projection. Its generic expected-error warning falls back to the creation diagnostic's target ID, then the service error's ID. For errors carrying a creation diagnostic, it passes a cause-free Error projection to telemetry, preserving the original safe `name`, `code` and `stack`. Other standalone errors, including deletion and directory recovery, retain their original error object. The installed OpenTelemetry recorder reads type/message/stack and does not traverse causes; the narrow projection is defence in depth for the newly retained creation causes, without sacrificing throw-site attribution. The dedicated service diagnostic also records only a fixed message and allowlisted primitive fields. Direct callers receive the same safe service message and in-memory cause chain.

## Private source acknowledgement

Only a failed `qwen/control/session/source` response adds `reason: recording_unavailable | write_not_confirmed`. The recording API stays boolean, and false is never interpreted as a particular filesystem cause. Successful responses remain unchanged.

The bridge still returns a boolean and adds no field to session results or SDK types. Unsuccessful operations routed through `persistSessionSource` (fresh creation, cold restore and live source backfill) emit a bounded `source_persistence_failed` line with the live session ID and one of:

- `recording_unavailable` or `write_not_confirmed` from the recognized private reason.
- `negative_ack` for an old child returning `{ persisted:false }`.
- `invalid_ack` for missing or non-boolean `persisted`.
- `unknown` for an unrecognized reason on a negative acknowledgement.
- `rpc_timeout` or `transport_closed` from local typed transport errors; other RPC rejection is `rpc_rejected`.

No message matching or raw exception serialization is used. A remote exception serialized across JSON-RPC is a rejection, not evidence of a locally observed timeout. The existing diagnostic callback and stderr surfaces are best-effort. Successful source confirmation emits no failure record. Branched-session source writes and `ensureDefaultSessionPersisted` bypass this helper and are outside this PR; their existing diagnostic behavior is unchanged.

## Implementation and consumers

| Area                                 | Consumers                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Standalone service and server wiring | HTTP create, scheduled standalone create, direct child/side-task tool creation; existing restore helpers retain their control flow |
| HTTP error serializer                | Existing HTTP clients, generic warnings and error telemetry                                                                        |
| ACP private source handler           | Managed daemon and direct ACP callers; optional failure reason remains compatible                                                  |
| Bridge source persistence            | Fresh ordinary/standalone sessions, side tasks, restored sessions and live source backfill                                         |
| Existing daemon logger and telemetry | Bounded operator diagnostics; no new persistence subsystem                                                                         |

## Validation and acceptance

Run build, typecheck, bundle and focused service, route, serializer, child-tool, logger, ACP and bridge tests. Compare the same real route/service/serializer faults against baseline and candidate: public body/status/headers match, while dedicated diagnostics differ by phase and correlate to the requested ID.

Cover negative/invalid/legacy acknowledgement, unavailable recording, unconfirmed write, actual transport closure and timeout, RPC rejection, direct child parent validation, binding/prompt failure, cleanup failure, throwing loggers, healthy siblings and secret-bearing nested causes. Source confirmation and healthy creation must not add failure records. Verify ordinary/standalone and restore callers retain their boolean contracts. Model inference and remote incident diagnosis are outside this deterministic acceptance.

## Risks and delivery

The main risks are sensitive-data serialization, incorrect attribution and logging changing failure behavior. Keep causes out of serializers, use fixed classifications and preserve existing lifecycle decisions. Maintainer review remains required for these cross-package boundaries; no broad refactor is included.

Reverting this PR removes diagnostic detail without changing execution or invalidating PRs 2–4. Submission, CI, review, merge and deployed acceptance are separate milestones. Use `Refs #11944`; this PR alone must not close the four-part tracker. No unresolved public protocol decisions remain for this diagnostic-only scope.
