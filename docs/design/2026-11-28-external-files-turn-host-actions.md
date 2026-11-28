# Turn-Scoped Host Actions for External Files Sessions

[English](2026-11-28-external-files-turn-host-actions.md) | [简体中文](2026-11-28-external-files-turn-host-actions.zh-CN.md)

Status: implementation candidate for [QwenLM/qwen-code#18578](https://github.com/QwenLM/qwen-code/issues/18578). Date: 2026-11-28.

## Problem and current state

An embedding host running `hosted-workspace-external-files/1` sessions needs the model to invoke a host-owned action on specific authorized turns — for example, posting text written during the turn as a comment on the host task that started the turn and receiving the resulting comment ID before finishing the turn. The host already holds the task identity, CLI executable, and task-scoped credential inside its trusted run context; none of those secrets or binaries belong on the external workspace worker or in model arguments.

At `dev/managed-agent@0f496b8a`, every extension path on `hosted-workspace-external-files/1` is closed:

1. External session creation (`ExternalWorkspaceSessionPolicies`) rejects extension pins and disables session-level MCP and hooks.
2. `POST /session/:id/client-files` (`configuration-routes.ts`) rejects external profiles with `409 hosted_client_files_profile_unsupported` because `client-files` is a session-scoped browser filesystem relay (`SERVER_ID = "local-files"`), not a trusted host action interface.
3. `HostedWorkspaceToolTurn` rejects optional lanes on external Files and advertises only `read_file`, `write_file`, `edit`, `glob`, and optional content-only `skill`.
4. Neither `ManagedAgentService` nor `qwen-managed-agent-spring-boot-starter` exposes a turn-scoped host tool interface or a `(turnId, callId)` receipt ledger for reconciling interrupted action responses.

## Goals and non-goals

### Goals

- Allow an embedding host to register typed, turn-scoped host action specifications (`HostTurnActionSpec`) when creating an external Files session with initial input or submitting a turn on an external Files session.
- Execute authorized host actions inside the host JVM through a Spring-managed `HostTurnActionExecutor` SPI bean without mounting new Spring MVC controllers, exposing credentials or executables to the external worker, or changing ordinary `hosted-workspace-files/1` sessions.
- Bind every invocation and its settled result durably to `(sessionId, turnId, callId)` so retried callbacks replay idempotently without duplicate side effects and the host can reconcile interrupted deliveries.
- Return structured output (such as `commentId`) plus `(turnId, callId)` attribution to the originating turn so the model can read the result before completing the turn.

### Non-goals

- Opening `client-files`, session-wide MCP, hooks, plan mode, or child agents on `hosted-workspace-external-files/1`.
- Modifying `hosted-workspace-external-shell/1` or its storage and publication contracts tracked under `#15512`.
- Executing host CLI binaries on external workspace workers or persisting raw host credentials in Managed Agent tables.

## Proposed solution

### 1. Host Java contracts and SPI (`qwen-managed-agent-contracts`)

Add `com.alibaba.qwen.code.managedagent.contracts.hostaction`:

- `HostTurnActionSpec(name, description, inputSchema, contextRef)`:
  - `name`: `[A-Za-z_][A-Za-z0-9_-]{0,63}`, excluding all built-in Hosted Workspace/Harness tool names and the `mcp_` prefix.
  - `description`: non-blank UTF-8 text up to 4096 bytes without control characters other than `\n` and `\t`.
  - `inputSchema`: strict JSON Schema object (`type: "object"`, typed `properties`, optional `required`, `additionalProperties` defaulting to `false`) up to 16 KiB.
  - `contextRef`: optional opaque host correlation identifier (up to 512 characters) persisted only in `ma_turn.host_actions_json` and never sent to the Harness, model, or external worker.
- `HostTurnActionInvocation(tenantId, sessionId, turnId, promptId, callId, actionName, contextRef, arguments)`: supplied to the host executor when an authorized turn invokes `actionName`.
- `HostTurnActionResult(isError, text, output)`: structured tool response returned to the model and stored in the durable receipt.
- `HostTurnActionExecutor`: functional interface implemented by a host Spring `@Bean` (resolved via `ObjectProvider<HostTurnActionExecutor>` across standalone, explicit `ManagedAgentConfiguration`, and `qwen-managed-agent-spring-boot-starter` parent contexts).
- `HostTurnActionReceipt(sessionId, turnId, promptId, callId, actionName, state, result, createdAt, updatedAt)`: durable execution record readable by the host for reconciliation.

`ManagedAgentService` adds overloads on `createWorkspaceSession` and `submitTurn` accepting `List<HostTurnActionSpec>`, plus `listTurnHostActionReceipts` to inspect recorded `(turnId, callId)` outcomes on a session turn.

### 2. Admission, schema, and capability negotiation

- Negotiate Harness support through capability feature token `hosted-turn-host-actions/1`.
- Admit non-empty `hostActions` only when:
  1. Effective session `toolProfile` is `hosted-workspace-external-files/1`;
  2. Runtime Broker is enabled and a `HostTurnActionExecutor` bean is available;
  3. Harness capabilities include `hosted-turn-host-actions/1`.
- Include canonicalized `hostActions` in the command `requestDigest` so idempotency-key replays reject mismatched action definitions with `409 idempotency_conflict`.
- Store frozen specifications in nullable `ma_turn.host_actions_json` (`OCTET_LENGTH(host_actions_json) <= 65536`) in the same transaction that inserts the `ma_turn` row, avoiding any race between `submitTurn` return and asynchronous turn dispatch.
- Record execution receipts in `ma_request_receipt` under `ReceiptNamespace.HOST_TURN_ACTION` (`scope_kind = 'SESSION'`, `idempotency_key = turnId + ":" + callId`), keeping the 38-table V1 baseline count unchanged.

### 3. Broker callback, idempotency, and reconciliation

- `SubmitHarnessTurn` forwards wire-sanitized `hostActions` (`name`, `description`, `inputSchema` only — `contextRef` stripped) on `POST /session/:id/prompt`.
- `RuntimeBrokerHttpServer` serves `POST /internal/runtime-broker/v1/harness-sessions/{sessionId}/host-actions/execute`, authenticated with the Broker Bearer token and fenced by the active `(sessionId, writerId, writerGeneration)` lease in `ma_session_head`. Because `EmbeddedRuntimeBroker` runs its own loopback HTTP listener inside `ManagedAgentConfiguration`, Starter hosts keep zero Spring MVC `@RestController` beans.
- `JdbcHostTurnActionStore` validates session profile, active turn state, action membership, and JSON Schema arguments, then coordinates execution under per-call serialization and `ma_request_receipt`:
  - A settled receipt (`COMPLETED` or `FAILED`) with a matching `requestDigest` replays the stored `HostTurnActionResult` without invoking `HostTurnActionExecutor` again.
  - A mismatched `requestDigest` for the same `(turnId, callId)` fails with `409 runtime_idempotency_conflict`.
  - Transport retries from `HostedWorkspaceBroker` after an interrupted HTTP reply hit the settled receipt and deliver the original `commentId` back to the turn.

### 4. TypeScript Harness turn lane (`packages/cli/src/serve/`)

- `turn.ts` and `takeover-routes.ts` validate `hostActions` only for `hosted-workspace-external-files/1`, persist them in the `managed-admission` resource of `input.accepted`, verify equality on duplicate prompt replay, and pass them to `HostedWorkspaceToolTurn`.
- `HostedWorkspaceToolTurn` keeps `mcp`, `hooks`, `shell`, `publication`, and `client-files` closed on external Files, advertises authorized `hostActions` declarations only on turns that carry them, validates model arguments against `inputSchema`, skips external worker warmup/acquisition for host-action-only batches, treats host-registered actions as turn-authorized unless denied/prompted by explicit `permissionRules`, and commits `tool_result` with `{ ...output, turnId, callId, executionStatus }`.

## Design decisions and rationale

1. **Dedicated turn-scoped lane instead of widening `client-files`**: `client-files` is a session-wide browser SSE relay tied to `local-files` and WebShell controllers. Host actions are per-turn, server-trusted, typed callbacks that must work in controller-free Starter deployments and leave unannotated turns unchanged.
2. **Opaque `contextRef` bound at turn admission**: Asynchronous turn dispatch can run before `submitTurn` returns the minted `turnId` to the caller. Binding `contextRef` atomically in `ma_turn` lets the host resolve its task, executable, and credential deterministically on first invocation while keeping secrets out of SQL and wire payloads.
3. **Reuse `EmbeddedRuntimeBroker` and `ma_request_receipt`**: Routing execution over `/internal/runtime-broker/v1/harness-sessions/{sessionId}/host-actions/execute` reuses the existing internal listener and writer-generation fencing, avoids new ports or Spring MVC controllers, and keeps the 38-table schema invariant intact.

## Validation and acceptance criteria

- **Ordinary Files regression gate**: `hosted-workspace-files/1` and external Files turns without `hostActions` advertise their exact existing tool lists; `POST /session/:id/client-files` still returns `409 hosted_client_files_profile_unsupported` on external profiles; `hosted-workspace-external-shell/1` rejects `hostActions`.
- **Authorized turn E2E / integration**: An external Files turn with a registered comment action allows the model to write workspace files, invoke the host action with only the comment text, execute the host callback with task/run attribution, and receive the matching `commentId` in the same turn without dispatching the action to the external worker.
- **Interrupted response reconciliation**: Simulating a dropped response after the host action executes replays the identical `(promptId, callId)` request against `ma_request_receipt`, invokes the host executor only once, returns the original `commentId` to the turn, and exposes the settled `HostTurnActionReceipt` via `ManagedAgentService.listTurnHostActionReceipts`.
