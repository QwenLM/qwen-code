# P1: Frozen External Contract

[English](2026-09-09-a2a-frozen-contract.md) | [简体中文](2026-09-09-a2a-frozen-contract.zh-CN.md)

Status: the contract is frozen and has an executable implementation; no transport or interoperability run has been implemented yet. 2026-09-09.

This is P1 of the [continuation architecture](./2026-09-09-agent-service-collaboration.md) and [implementation plan](../plans/2026-09-09-agent-service-collaboration-plan.md). It records what was agreed, not what has been demonstrated to work.

The executable portion is in `packages/core/src/agents/workspace-agents/a2a-contract.ts` (originally asserted by section 29 of `scripts/audit/run-workspace-agents.mjs`, with 227 passed / 0 failed; that script and constants used only by its assertions were subsequently removed). Code takes precedence when it differs from this document.

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

A Task can enter `INPUT_REQUIRED` and then receive further input, just as a thread continues after an answer. A run is a single turn and has no corresponding protocol entity. Likewise, **A2A `contextId` = `rootThreadId`**: the specification describes a contextual collection of interactions, matching a parent thread together with its child threads. `Message` ↔ `ThreadMessage`.

| Local `ThreadStatus` | A2A `TaskState`             | Explanation                                      |
| -------------------- | --------------------------- | ------------------------------------------------ |
| `open`               | `TASK_STATE_SUBMITTED`      |                                                  |
| `in_progress`        | `TASK_STATE_WORKING`        |                                                  |
| `blocked`            | `TASK_STATE_INPUT_REQUIRED` |                                                  |
| `in_review`          | `TASK_STATE_INPUT_REQUIRED` | See below                                        |
| `done`               | `TASK_STATE_COMPLETED`      | The only local status mapped to a terminal state |

Map `in_review` to `INPUT_REQUIRED`, not `WORKING`: work is no longer progressing and a person must unblock it. That is the relevant meaning for a caller deciding whether to keep waiting. The cost is that **the distinction between asking a question and submitting work for review is lost at the boundary**, surviving only in extension metadata.

Adding a `ThreadStatus` without deciding its external representation makes `toA2ATaskState` throw rather than use a default. An assertion covers this behavior.

## 4. Unsupported Items

- **Remote usage is not reported with Task/Message.** The A2A 1.0 data model has no usage or token field. Third-party agents therefore **cannot be required** to report usage. Our own numbers use an extension under `Task.metadata`. **Admission must treat missing usage as unknown, not zero**; otherwise a remote agent that declines to report usage would effectively be free to call.
- **Idempotency is only a `MAY`.** The specification says an agent _may_ deduplicate on `Message.messageId`, but the client generates this unscoped ID. Two callers can supply the same ID. The server therefore adds a scoped key: `externalRequestKey(callerId, targetAgentId, messageId)`, restricted to the authenticated caller and target agent. Its three components are length-prefixed rather than delimiter-separated: IDs are opaque external strings, and a caller able to put delimiters in an ID could otherwise forge another caller's key (covered by an assertion and mutation verification).
  **The key must be persisted in the same write that accepts the request.** Adding it afterward cannot establish whether a retry is the request currently being accepted, nor reliably reject the same key with different content.
- **Three gaps in local state:** `TASK_STATE_REJECTED` (the agent declines work) and `TASK_STATE_AUTH_REQUIRED` have no local equivalents. **Thread-level cancellation is also absent**: `ThreadStatus` has no such member; only runs do. Thus **inbound `cancelTask` cannot currently be represented locally**. P2 must add this before claiming cancellation support.

## 5. A Non-`_meta` Channel for Run Frames

Local ACP prompts carry run frames in `_meta`. That is the daemon's trust boundary and **is neither externally reachable nor intended to be**. External tasks use a separate channel: declare the extension URI `https://qwenlm.github.io/qwen-code/a2a/workspace-agents/v1` in `AgentCapabilities.extensions`, and put frames and usage under that URI in `Task.metadata`.

Set `required: false`: clients that ignore the extension still receive correct Task / Message semantics, but cannot see usage.

## 6. Interoperability Acceptance Client

Choose **`a2a-sdk` (Python, PyPI 1.1.2, requires-python ≥ 3.10)**, repository `a2aproject/a2a-python`.

It uses a different language and codebase from our server's `@a2a-js/sdk`, avoiding the architecture's §6 exclusion of self-testing with our own client at both ends. The client bundled with `@a2a-js/sdk` can provide a smoke test at most, not compatibility evidence.

## 7. Decisions Still Requiring a Person (Block P2, Not P1)

1. The actual A/B environment and connectivity (who can reach whom; whether P4's outbound channel must move earlier).
2. The first externally exposed Agent and its execution permission scope.
3. The approval recipient.

One additional decision from architecture §5 is needed before P3: what signal at the end of a Codex turn counts as an explicit task result.

## 8. What This Round Did Not Do

No A2A routes, Agent Card publication, authentication, or intake storage were implemented, and `@a2a-js/sdk` was not installed (the dependency has not yet been added to `package.json`). P1's gate is to record the mappings and unsupported items individually and choose an acceptance client. This document and `a2a-contract.ts` are that record; demonstrating interoperability belongs to P2.
