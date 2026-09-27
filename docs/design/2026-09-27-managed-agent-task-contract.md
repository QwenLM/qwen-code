# Managed Agent Task Contract (Stage H0a)

[English](2026-09-27-managed-agent-task-contract.md) | [简体中文](2026-09-27-managed-agent-task-contract.zh-CN.md)

Status: H0a implemented in this change, as a contract only (every addition is `planned`); H0b, H0c and H1 to H6 pending
Date: 2026-09-27
Issue: [#12827](https://github.com/QwenLM/qwen-code/issues/12827), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)

## 1. Problem

Stage H brings MCP, Hooks, background Shell and Monitor, child agents,
workflows, teams, Channels and automation onto the Managed path. The
[extension runtime design][design] gives every asynchronous capability one
read-only task projection, `SessionTaskView`, and names the public resources in
its section 11. Section 6 of the [API contract][api] asks for the task view,
task query and cancel, idempotent commands and errors to be frozen in the
OpenAPI before H0 is implemented.

The in-repo OpenAPI from [#12808](https://github.com/QwenLM/qwen-code/pull/12808)
has none of these resources. The only task surfaces today are daemon routes
(`GET /session/:id/tasks`, `GET /session/:id/hooks`, `/workspace/mcp`,
`/scheduled-tasks`). The design treats them as internal adapter sources, not as
tenant-level contracts. Without a frozen public shape, WebShell and SDK work
has nothing to plan against except those daemon routes.

## 2. Goals

- Add `SessionTaskView` to the OpenAPI as `PublicTask` and `WebShellTask`.
- Add task list, detail, events (the output cursor) and cancel on the public
  API and the WebShell adapter. Cancel takes an `Idempotency-Key` and returns
  `202` with a command operation.
- Record the task error codes.
- Name the MCP catalog, hook catalog, automation and channel resources, so that
  later slices fill in shapes instead of inventing paths.
- Keep the D1 exit check: no `planned` route is mapped, and the generated
  WebShell types do not change.

## 3. Non-goals

- No server, Harness, Broker or worker change. Nothing is mapped, and no
  status becomes `partial` or `implemented`.
- No response shapes for the MCP, hook, automation and channel resources. H1,
  H2, H5 and H6 define them.
- No projection of task changes into the Session event stream. H0c defines the
  event types. `PublicEvent.type` is an open string, so that needs no schema
  change here.
- No shared record schema (`OperationGrant`, the three state lines,
  `monitor_run`). That is H0b.

## 4. Decisions

### 4.1 Every addition is `planned`

Every route, schema and new property added here carries
`x-qwen-implementation-status: planned`, including the properties added to
the existing `PublicCommandOperation`, `WebShellCommandOperation`,
`SessionCapabilities` and `WebShellSession.capabilities` schemas. The generator
drops them, and the Java contract test fails if the server maps any of the
routes. The version becomes `1.14.0` because routes are added.

### 4.2 `PublicTask`

`PublicTask` is `SessionTaskView` in the public API's conventions:

| `SessionTaskView`    | `PublicTask`          | `WebShellTask`       | Notes                                  |
| -------------------- | --------------------- | -------------------- | -------------------------------------- |
| `taskId`             | `id`                  | `taskId`             | As `PublicSession` and `PublicAction`. |
| `sessionId`          | `session_id`          | `sessionId`          |                                        |
| `kind`               | `kind`                | `kind`               | `TaskKind`, same five values.          |
| `state`              | `state`               | `state`              | `TaskState`, same eight values.        |
| `definitionRevision` | `definition_revision` | `definitionRevision` | `int64`, at least 1.                   |
| `runtimeState`       | `runtime_state`       | `runtimeState`       | `TaskRuntimeState`, same five values.  |
| (none)               | `created_at`          | `createdAt`          | Added, required.                       |
| `startedAt`          | `started_at`          | `startedAt`          | Epoch milliseconds, not an ISO string. |
| `settledAt`          | `settled_at`          | `settledAt`          | Epoch milliseconds, not an ISO string. |
| `outputCursor`       | `output_cursor`       | `outputCursor`       | Opaque, at most 512 characters.        |
| `artifactRefs`       | `artifact_refs`       | `artifactRefs`       | At most 100 unique Artifact IDs.       |
| `actionCapabilities` | `action_capabilities` | `actionCapabilities` | `TaskActionCapability`, unique values. |

The enums are shared components (`TaskKind`, `TaskState`, `TaskRuntimeState`,
`TaskActionCapability`), as `CwdOperationStatus` already is, so the two
surfaces cannot drift apart.

The design's shape changes in four places:

- **`id`.** `PublicSession`, `PublicAction`, `PublicArtifact` and
  `PublicCommandOperation` name their identifier `id`; WebShell keeps
  `taskId`, as it keeps `actionId` and `operationId`.
- **Timestamps.** The public API uses `int64` epoch milliseconds everywhere
  (`created_at`, `expires_at`), and the server fills them from `clock.millis()`.
- **`created_at`.** The list is ordered by creation, and a `pending` task has
  no `started_at`, so the view needs a creation time.
- **Bounded `artifact_refs`.** A long-running Monitor can rotate many
  Artifacts. The view lists at most 100, and the Session artifact routes keep
  every Artifact readable.

`additionalProperties: false` rejects every field the design forbids:
Runtime binding ID, generation, Runtime endpoint, Pod, absolute path, raw PID,
SecretHandle and local sidecar.

Three invariants follow from the state definitions and are schema conditionals:

- `completed`, `failed` and `cancelled` are terminal. A terminal task has
  `settled_at` and advertises neither `cancel` nor `send_input`. Every other
  state, including `recovery_blocked`, has no `settled_at`.
- `running`, `waiting` and `degraded` have `started_at`.
- `pending` has no `started_at`. A task cancelled before it started settles
  without one.

### 4.3 Task events and the output cursor

`GET /v1/agents/sessions/{sessionId}/tasks/{taskId}/events?after=` returns a
page of `PublicTaskEvent`, oldest first. An event is one of:

- `state_changed`, with `state` and optionally `runtime_state`;
- `output`, a chunk of at most 16384 characters in `text`, with `truncated`
  when the chunk was cut and the full output is in an Artifact;
- `artifact`, the `artifact_id` of an Artifact that received task output.

Conditionals forbid the fields of one type on another. High-volume logs and
Monitor raw lines go into Artifacts, never one event per line, as design
section 11 requires.

The cursor is opaque, like `output_cursor`, so the server may back it with
event sequences, Artifact offsets or both. `after` accepts a page's
`next_cursor` or a task's `output_cursor`; without `after` the page starts at
the oldest retained event. Unlike list pages, `next_cursor` is required and
never `null`: a running task can produce more events, so a caller that reached
the end still needs a position to poll from. An empty page returns the
requested position. `limit` uses the shared `ListLimit` (1 to 100, default
20), so a page holds at most 100 chunks of at most 16384 characters.

`read_output` in `action_capabilities` says that the route returns `output`
events for the task. Without it the route returns only state and Artifact
events.

### 4.4 Cancel

Cancel is `POST /v1/agents/sessions/{sessionId}/tasks/{taskId}/cancel`, not the
design's `tasks/{taskId}:cancel`. Every other command in the contract is a
sub-path (`/close`, `/archive`, `/unarchive`, `/actions/{actionId}/responses`),
and task cancel follows the same style.

Cancel reuses the command operation model instead of a new one:

- `PublicCommandOperation.type` gains `task_cancel`, and the operation gains a
  `task_id` that is required for `task_cancel` and forbidden for every other
  type. `task_cancel` never carries `action_resolution`. The WebShell mirror
  gains `taskId` in the same way.
- The operation is read back through the existing
  `GET .../operations/{operationId}` and WebShell `operations/query`.
- `202` and a `completed` operation mean that the authority recorded the
  cancel, not that the task stopped. The task becomes `cancelled` only after
  its physical execution settles, and an unknown outcome becomes
  `recovery_blocked`. This follows design section 3.2: a logical settle never
  covers a process that has not drained.
- The route accepts a cancel only while `action_capabilities` contains
  `cancel`. A settled task never advertises it, so the same rule covers both
  cases.

### 4.5 WebShell adapter

The adapter mirrors the public routes in its existing `POST …/query|get|verb`
style:

| Route                                             | Request                         | Response                       |
| ------------------------------------------------- | ------------------------------- | ------------------------------ |
| `POST /api/agent/web-shell/v1/tasks/query`        | `WebShellTaskQueryRequest`      | `200 WebShellTaskPage`         |
| `POST /api/agent/web-shell/v1/tasks/get`          | `WebShellTaskGetRequest`        | `200 WebShellTask`             |
| `POST /api/agent/web-shell/v1/tasks/events/query` | `WebShellTaskEventQueryRequest` | `200 WebShellTaskEventPage`    |
| `POST /api/agent/web-shell/v1/tasks/cancel`       | `WebShellTaskCancelRequest`     | `202 WebShellCommandOperation` |

The cancel request carries `idempotencyKey` in the body, as
`WebShellActionRespondRequest` and `WebShellLifecycleRequest` do.
`SessionCapabilities.tasks` and `WebShellSession.capabilities.tasks` (both
`planned`, default `false`) let a client learn whether a Session serves the
task routes.

### 4.6 Resources named for later slices

Each resource gets one `planned` `GET` whose `200` has a description and no
body, so a later slice adds the shape without renaming a path:

| Route                                              | Slice |
| -------------------------------------------------- | ----- |
| `GET /v1/agents/sessions/{sessionId}/mcp-catalog`  | H1    |
| `GET /v1/agents/sessions/{sessionId}/hook-catalog` | H2    |
| `GET /v1/agent-channels`                           | H5    |
| `GET /v1/agent-channels/{channelId}/deliveries`    | H5    |
| `GET /v1/agent-automations`                        | H6    |
| `GET /v1/agent-automations/{automationId}/runs`    | H6    |

Mutations, workspace MCP administration and manual automation runs are left
to those slices.

### 4.7 Errors

Errors keep `ErrorEnvelope` and the shared `BadRequest`, `Forbidden`,
`NotFound`, `Conflict` and `CursorExpired` responses. The codes are those the
API contract already froze, plus two task codes:

| Status | Code                      | When                                                                     |
| ------ | ------------------------- | ------------------------------------------------------------------------ |
| `400`  | `invalid_cursor`          | The list cursor or `after` is malformed or belongs to another task.      |
| `400`  | `invalid_limit`           | `limit` is outside 1 to 100.                                             |
| `404`  | `session_not_found`       | The Session is absent or outside the caller's scope.                     |
| `404`  | `task_not_found`          | The task is absent or outside the caller's scope. New.                   |
| `409`  | `cursor_expired`          | `after` is older than the retained events.                               |
| `409`  | `task_action_unavailable` | `action_capabilities` lacks `cancel`, which includes settled tasks. New. |
| `409`  | `idempotency_conflict`    | The key was used with a different request.                               |

After `cursor_expired` the caller reads the task's Artifacts and continues
from its current `output_cursor`.

## 5. Contract test change

`ManagedAgentApiContractTest` compares mapped routes with the spec only under
its `API_PREFIXES`. `/v1/agent-channels` and `/v1/agent-automations` do not
start with `/v1/agents`, so a server that mapped them would pass unnoticed.
Both are added to `API_PREFIXES`. No gap line is added to
`contract-known-gaps.txt`.

## 6. Validation

- `npm run generate:managed-agent-api` in `packages/web-shell` leaves
  `client/components/managed/generated/managed-agent-api.ts` unchanged, and
  `managed-agent-api.test.ts` passes.
- `ManagedAgentApiContractTest` (3 tests) and
  `ManagedSessionStoreContractFixtureTest` (3 tests) pass without new gap
  lines.
- 55 Ajv 2020-12 probes against the spec's schemas pass. They cover valid
  tasks in every invariant branch, and reject: each broken invariant,
  forbidden fields (`runtime_binding_id`, `generation`, `pid`), unknown kinds
  and states, duplicate capabilities, cross-type event fields, oversize
  output, a `null` event cursor, `task_cancel` without `task_id`, `task_id` on
  other command types, and `task_cancel` with `action_resolution` (rejected by
  the intended conditional, checked with a valid resolution).
- Mutations fail the matching gate:
  - Marking `cancelWebShellTask` `partial` fails the route and scenario checks
    ("is partial but not mapped") and adds 75 lines to the generated types.
  - A probe controller mapping `GET /v1/agent-automations` fails with "is
    mapped but planned", and passes silently with the old `API_PREFIXES`.
- `openapi-typescript` parses the full spec, including public routes.

## 7. Follow-up

- **Version order.** #12822 (D2) and #12797 (W0d) also move the spec to
  `1.14.0`. Whichever of the three lands later takes the next minor version.
- **H0b.** The shared record schema, including `monitor_run`, the three state
  lines and `OperationGrant`. It depends on issue question 1 (whether
  `monitor_run` joins the closed v1 domain index).
- **H0c.** Builds the task projection, maps these routes as `partial`, and
  defines the Session events that announce task changes.
- **Later additions.** Query filters (`kind`, `state`), a `send_input` route
  and any display label are additive `planned` changes. `SessionTaskView`
  has no title; the first slice that renders tasks in WebShell should decide
  whether it needs one.

[design]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md
[api]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
