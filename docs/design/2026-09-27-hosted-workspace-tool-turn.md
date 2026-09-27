# Gated Hosted Workspace Tool Turns

[English](2026-09-27-hosted-workspace-tool-turn.md) | [简体中文](2026-09-27-hosted-workspace-tool-turn.zh-CN.md)

Status: implemented behind the private gates, based on main `daaac2223`. Part of proposal #12380, following the Hosted no-tool path and W0c-3. This is a private integration slice, not public capability enablement.

## Problem and current state

The Hosted Harness has a durable no-tool text turn. W0c-3 independently runs tools through a persisted Workspace binding and holds a SQL storage owner. Nothing connects the model's function calls to that path. Before this change, the generic TypeScript Broker provider depended on control, prepare and start operations absent from the production Broker. This slice supplies prepare/start but deliberately does not implement that provider's generic control contract.

The current immediate execution API starts effects while creating the Broker execution record. It also stores tool inputs inside the reference. A Hosted continuation needs the opposite order: reserve the original execution, commit its Session intent and wait checkpoint, then dispatch. Model continuation must depend on a committed result, not a successful HTTP response alone.

O1c #12821 supplies local foreground Shell capture and a same-process publisher. It does not supply production Broker selection or separate-process result publication. A Hosted Shell cannot claim complete capture or use Tool v3 ACK until that boundary exists.

## Scope and gates

Keep ordinary Hosted sessions on the existing no-tool path. Tool mode requires the existing deployment-owned Broker URL/token pair and an explicit `toolProfile: "hosted-workspace-files/1"` on private Session create/load requests. Persist the selected profile with the Session definition and reject a changed profile on load. Public Workspace Turn gates and capability advertisement remain closed.

Use the existing fixed, trusted, preapproved Workspace configuration. This slice does not implement interactive approvals, arbitrary configuration, MCP, Hooks, background Shell, file undo snapshots or cross-host recovery. Durable tool messages and results are retained; that is distinct from file backup history. Runtime tools retain the W0c deployment trust boundary and do not become a filesystem sandbox.

The first independently verifiable profile admits Read/Write/Edit. Foreground Shell remains subject to the complete-required capture contract: the design reserves its integration with O1c, but it must not fall back to v2 when the required publisher/receipt capability is absent. The separate-process bridge is a follow-up; this implementation keeps Shell closed.

## Ownership and configuration

The private Hosted routes are live-session-owner scoped. Their Managed Store tenant, Workspace and Session keys are immutable. The Broker resolves the original persisted Session and validates its frozen Workspace binding, current grants, storage identity and configuration through the existing W0c resolver. A Harness launch directory is only a local configuration/scratch directory and never selects tool placement.

Broker routes remain persisted-Session and selected-Runtime scoped. Acquisition returns the resolved tenant/Workspace and fixed capability identity; the Harness checks them before reserving an invocation. No unknown, revoked, mismatched or unavailable binding may use a global directory or Legacy engine.

Model tool declarations are a fixed snapshot of the admitted profile. They are available before Runtime readiness. No local executable tools remain registered in the Harness; its local invocation guard stays closed. File arguments use Workspace-relative paths, resolved only inside the worker's installed context. The model does not need the Harness host's physical directory.

## Two-phase Broker dispatch

Implement the already reserved private `executions:prepare` and `executions/{id}:start` routes. Prepare writes the four-field invocation reference plus the internal `dispatchMode: "deferred"` marker and returns the durable execution identity without dispatch. Start supplies one bounded `payloadJson` string containing the tool name and input. The reference's digest is SHA-256 over those exact UTF-8 bytes. Java verifies the bytes before parsing, including on a replay; it does not attempt to reproduce JavaScript canonical JSON.

The Harness retains the exact payload bytes in its durable argument resource. The Broker carries parsed inputs only on the original dispatch stack, never in `reference_json`. Repeated start with different bytes conflicts. A repeated matching start observes the original execution; it cannot rerun SETTLED or UNKNOWN work. The existing immediate endpoint must not become a bypass that starts a payload-free deferred reservation.

Prepared cancellation settles without invoking the Runtime. A dispatcher commits EXECUTING before transport effects. Expired EXECUTING ownership becomes UNKNOWN, preserving the existing no-replay rule. Only a matching explicit start can drive a still-unclaimed reservation; there is no implicit restart replay.

## Turn sequence

1. Admit the prompt durably using the existing Session authority. Start Runtime warming and model inference independently. A no-tool answer can finish while provisioning is still pending.
2. Validate the complete model response and refuse tools outside the profile before side effects. Before acquisition, check each exact serialized argument resource and the complete assistant record against the inline Store limit, including UTF-8 encoding, JSON escaping and record metadata.
3. On the first tool batch, acquire one Runtime Session and its Workspace storage owner. Commit the full model response, publish each exact argument resource, reserve its invocation and anchor every input/schema with a `tool.intent` event, then commit one `await_runtime` checkpoint before any start request.
4. Execute calls sequentially under that owner. Read status and cancel using the original execution identity. Never create a replacement call to recover a lost response.
5. Persist each execution outcome and model-facing function response, then advance the existing Harness checkpoint to `results_ready`. Send only those committed responses to the next model request. Record consumption after that request finishes and preserve ordering across multiple batches.
6. Commit the final assistant message and settle the consumed continuation. Release the original Runtime Session after durable result/history settlement; release closes its worker gate before clearing Workspace ownership. Only then commit the terminal turn record. A lost release reply therefore leaves an unsettled input on cold load.

Tool-enabled history preserves complete function-call/function-response groups. The no-tool history filter, which removes unanswered text prompts, cannot be reused for this history. Event replay exposes only committed records. Every assistant message containing a tool call is replayed as the complete record, including mixed text/tool messages; it must not become an empty or text-only assistant chunk.

## Failure and cancellation

A definite HTTP 409 `workspace_busy` or `workspace_unavailable` acquisition refusal before claiming storage ends the turn with an ordinary error; the Session may retry or reload. After storage is claimed, acquisition failures use `runtime_session_acquire_failed`, including a failed authority recheck, and remain recovery-blocked. A lost acquisition reply also remains blocked.

Admission or argument-resource failure before dispatch causes no tool effect. After a lost start reply, query only the original execution. An unobservable outcome, lease loss, failed result commit or unverified cancellation blocks the Session at its durable wait. The caller can observe recovery-required status. The Harness neither emits a normal completed/cancelled safety boundary nor permits a fresh prompt to forget that work.

Cancellation aborts inference and requests cancellation of every reserved or started original invocation. A cancellation request is not stop evidence. Only a terminal Runtime result permits result settlement and release. If observation cannot determine the outcome, retain ownership and block. A failed release also blocks further tools rather than clearing ownership locally. An unknown outcome retains the Workspace storage holder, so other Sessions in the same Workspace receive a recoverable busy error until W0e recovery clears that holder.

The private loop is bounded to 16 model rounds. Broker payloads are limited to 256 KiB, but each argument, result and history resource must also fit the existing 64 KiB inline Session Store limit; larger resources fail closed rather than truncate. Each Broker HTTP request has a 30-second timeout and execution observation is bounded to two minutes plus the current request. These limits are internal to this private profile, not new user settings.

Cold load keeps the existing refusal of unsettled input. Automatic continuation after process loss, adoption of orphan workers and retired-generation reconciliation remain W0e/#12766/#12670. This slice records enough original identities to support that later work but does not claim it.

## Components and consumers

Affected layers are the Hosted profile validator and Session/model runner, a narrow Workspace Broker client and turn coordinator, Runtime Broker prepare/start service/HTTP routes and transport input separation, and the worker's profile-relative file argument handling. The ordinary daemon/ACP model loop and generic Managed provider remain independent consumers.

The Java product coordinator and public Workspace admission stay gated. Private integration tests construct actual persisted Workspace Sessions and exercise the same production Broker/worker, not a transport with invented manifest or start behavior. O1c remains a separate branch; no local publisher code is duplicated here.

## Validation and acceptance

- Baseline the global CLI, recording whether its private profile is reachable. Distinguish an unavailable global entry from source-level evidence of the no-tool gate.
- Prove first model traffic precedes deliberately delayed Runtime readiness, and a no-tool answer completes without waiting for readiness.
- Drive Read/Write/Edit through a real worker in two Workspace directories. Place a decoy file under the Harness launch directory and prove it is not read or modified.
- Drive at least two model/tool rounds and a later prompt. Assert exact function-call/result pairing in both model requests and durable replay.
- Verify busy/unavailable refusals permit another prompt and reload, while lost acquire replies and failures after storage claim remain blocked. Reject oversized inputs and complete assistant records before acquisition, including UTF-8 and nested JSON escaping.
- Fail argument/intent persistence before start and observe zero filesystem effects. Drop start responses and prove the original execution is queried without a second effect.
- Cancel before start, during an operation and with status unavailable. Only physically settled work may produce a terminal turn; unknown outcomes block subsequent prompts and reload.
- Verify prepare/start payload conflicts before and after settlement, payload-free stored references, prepare/cancel races and original API compatibility.
- Keep default no-tool process tests green. Refuse Shell before side effects until its complete capture/receipt capability is available.
- Run build, typecheck, bundle, focused TypeScript/Java tests, independent process verification and two consecutive clean self-audit passes. Report fixture, real-process and real-database evidence separately.

## Open boundaries

The separate-process O1c publisher/receipt bridge, complete Shell output, file backup/undo settlement, public actor admission, product UI enablement, W0e recovery and broader G/H work are not certified by a private tool-turn test. Worker results currently retain native absolute paths; converting them to Workspace-relative model-facing output and returning correctable function errors for invalid paths is a follow-up. Any expansion must update both language versions and its acceptance tests before enabling the associated capability.
