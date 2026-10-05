# P1: Frozen External Contract

[English](2026-09-09-a2a-frozen-contract.md) | [简体中文](2026-09-09-a2a-frozen-contract.zh-CN.md)

Status: the frozen contract and polling JSON-RPC transport are implemented; cross-implementation interoperability has not been demonstrated. Updated 2026-09-28.

This began as P1 of the [continuation architecture](https://github.com/QwenLM/qwen-code/blob/8ff056f1c7e5842393bc8d0f5b8a6ab1502462b6/docs/design/2026-09-09-agent-service-collaboration.md) and [implementation plan](https://github.com/QwenLM/qwen-code/blob/8ff056f1c7e5842393bc8d0f5b8a6ab1502462b6/docs/plans/2026-09-09-agent-service-collaboration-plan.md). It now records the contract implemented by the core workspace-agent A2A modules and the daemon transport. Code takes precedence when it differs from this document.

## 1. Frozen Version and Binding

| Item              | Value                                            | Source                                                |
| ----------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Protocol version  | `1.0` (`Major.Minor`, wire header `A2A-Version`) | Specification; `@a2a-js/sdk`'s `A2A_PROTOCOL_VERSION` |
| Transport binding | `JSONRPC` (the only binding)                     | `AgentInterface.protocolBinding`                      |
| SDK               | `@a2a-js/sdk@1.1.0`, Apache-2.0, node ≥ 20       | npm registry                                          |
| Agent Card path   | `.well-known/agent-card.json`                    | Specification §8 (RFC 8615)                           |
| Content-Type      | `application/a2a+json`                           | SDK constant                                          |

Choose JSON-RPC over gRPC: the daemon already uses Express, and the SDK provides `./server/express` directly. gRPC would introduce two runtime peers, `@grpc/grpc-js` and `@bufbuild/protobuf`, for capabilities we do not use.

The specification defines three bindings but **requires none of them**. An A2A support claim therefore needs to name the binding.

## 2. Required and Optional Operations

Required (using `A2ARequestHandler` names): `sendMessage`, `getTask`, `listTasks`, `cancelTask`, and `getAuthenticatedExtendedAgentCard`. Do not claim A2A support until all five respond.

Optional, with **none included in the first version**: `sendMessageStream` / `resubscribe` (require `streaming`) and the four push notification operations (require `pushNotifications`). Both merely provide earlier task-state updates. Polling `getTask` answers the same question without introducing a second delivery path that needs its own reliability guarantees.

## 3. Entity Mapping (the Central Decision)

**An A2A `Task` maps to one local `Thread`, not a `ThreadRun`.**

A Task can enter `INPUT_REQUIRED`, but the first transport accepts new tasks only. Messages carrying `taskId` or `contextId` are refused until thread continuation is implemented explicitly. A run is a single turn and has no corresponding protocol entity. For returned tasks, **A2A `contextId` = `rootThreadId`**: the specification describes a contextual collection of interactions, matching a parent thread together with its child threads. `Message` ↔ `ThreadMessage`.

| Local `ThreadStatus` | A2A `TaskState`             | Explanation |
| -------------------- | --------------------------- | ----------- |
| `open`               | `TASK_STATE_SUBMITTED`      |             |
| `in_progress`        | `TASK_STATE_WORKING`        |             |
| `blocked`            | `TASK_STATE_INPUT_REQUIRED` |             |
| `in_review`          | `TASK_STATE_INPUT_REQUIRED` | See below   |
| `done`               | `TASK_STATE_COMPLETED`      |             |
| `cancelled`          | `TASK_STATE_CANCELED`       |             |

`toA2ATaskState` is the exhaustive raw status mapping. The external view also considers runs: while any run is live the task is `WORKING`; once no run is live it becomes `COMPLETED`, `FAILED`, or `CANCELED` so a polling caller does not wait forever on a local review state it cannot continue. Adding a `ThreadStatus` without deciding its external representation makes the mapper throw rather than use a default. Tests cover both behaviors.

## 4. Unsupported Items

- **Remote usage is not reported with Task/Message.** The A2A 1.0 data model has no usage or token field. Third-party agents therefore **cannot be required** to report usage. Our own numbers use an extension under `Task.metadata`. **Admission must treat missing usage as unknown, not zero**; otherwise a remote agent that declines to report usage would effectively be free to call.
- **Idempotency is only a `MAY`.** The specification says an agent _may_ deduplicate on `Message.messageId`, but the client generates this unscoped ID. Two callers can supply the same ID. The server therefore adds a scoped key: `externalRequestKey(callerId, targetAgentId, messageId)`, restricted to the authenticated caller and target agent. Its three components are length-prefixed rather than delimiter-separated: IDs are opaque external strings, and a caller able to put delimiters in an ID could otherwise forge another caller's key (covered by an assertion and mutation verification).
  **The key must be persisted in the same write that accepts the request.** Adding it afterward cannot establish whether a retry is the request currently being accepted, nor reliably reject the same key with different content.
- **Two gaps in local state:** `TASK_STATE_REJECTED` (the agent declines work) and `TASK_STATE_AUTH_REQUIRED` have no local equivalents. Thread cancellation is implemented. Task continuation is deliberately refused, so a caller can submit, poll, list, and cancel work but cannot add another message to an existing task.

## 5. A Non-`_meta` Channel for Run Frames

Local ACP prompts carry run frames in `_meta`. That is the daemon's trust boundary and **is neither externally reachable nor intended to be**. External tasks use a separate channel: declare the extension URI `https://qwenlm.github.io/qwen-code/a2a/workspace-agents/v1` in `AgentCapabilities.extensions`, and put frames and usage under that URI in `Task.metadata`.

Set `required: false`: clients that ignore the extension still receive correct Task / Message semantics, but cannot see usage.

## 6. Interoperability Acceptance Client

Choose **`a2a-sdk` (Python, PyPI 1.1.2, requires-python ≥ 3.10)**, repository `a2aproject/a2a-python`.

It uses a different language and codebase from our server's `@a2a-js/sdk`, avoiding the architecture's §6 exclusion of self-testing with our own client at both ends. The client bundled with `@a2a-js/sdk` can provide a smoke test at most, not compatibility evidence.

## 7. Decisions Still Requiring a Person

1. The production connectivity model: who can reach the daemon and whether the outbound channel must move earlier.
2. The approval recipient for externally submitted work.

A grant names exactly one caller and one agent. It does not carry a speculative permission scope; the agent's existing tool policy remains the capability boundary.

A grant follows the agent's current configuration (decided 2026-09-30): it is checked against the agent's live definition on every request, so changing the agent's instructions, role, tools or execution placement after a share is issued applies to that share too. Moving an agent between local and managed-host execution does not revoke its grants; later requests run in the currently assigned runtime's workspace. The share dialog says so. To preserve an earlier boundary, revoke the share before changing the agent, or share a separate agent.

One additional decision from architecture §5 is needed before P3: what signal at the end of a Codex turn counts as an explicit task result.

## 8. Implementation Status

The daemon publishes the Agent Card and authenticated polling JSON-RPC routes for submit, get, list, and cancel. Grants store only secret digests, intake is idempotent and caller-scoped, and transport tests cover admission plus the successful task lifecycle. Streaming, push notifications, task continuation, and cross-implementation acceptance with the Python client remain out of scope.

The external task stays working while any descendant run or parent report is pending. Unclosed turns fail. The first terminal response (state, timestamp and granted-agent answer) is persisted under the intake record and reused by submit retries, get, list and cancel. Local follow-ups remain visible in extension metadata but cannot reopen that external result; canceling an already published terminal task does not cancel later local work.
