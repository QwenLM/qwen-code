# Managed Agent Task Contract (Stage H0a)

[English](2026-09-27-managed-agent-task-contract.md) | [简体中文](2026-09-27-managed-agent-task-contract.zh-CN.md)

Status: H0a implemented in this change, as a contract only (every added route and schema, and every property added to an existing schema, is `planned`); H0b, H0c and H1 to H6 pending
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
  event types. `PublicEvent.type` and `WebShellEvent.type` are open strings, so
  that needs no schema change here.
- No shared record schema (`OperationGrant`, the three state lines,
  `monitor_run`). That is H0b.

## 4. Decisions

### 4.1 Everything added is `planned`

Every route and schema added here carries
`x-qwen-implementation-status: planned`, and so does every property added to
an existing schema (`PublicCommandOperation`, `WebShellCommandOperation`,
`SessionCapabilities` and `WebShellSession.capabilities`). The properties of
the new schemas and the two new parameters need no marker of their own: only
planned operations reach them. The generator drops all of it, and the Java
contract test fails if the server maps any of the routes. The version becomes `1.15.0`: routes are added, and W0d (#12797) already took `1.14.0`.

An enum value cannot carry the marker, and cancel reuses the command
operation (section 4.4). The new `task_cancel` command type is therefore
already visible in the public spec, because the `partial` archive and delete
routes declare `202` with `PublicCommandOperation`, as the planned
`action_response` and `close` types are. Only the generated WebShell types are
insulated, until any WebShell route that returns `WebShellCommandOperation`
becomes `partial`. A separate planned operation schema would have kept the
value out, at the cost of a second operation model for one command; this
change accepts the visibility instead.

### 4.2 `PublicTask`

`PublicTask` is `SessionTaskView` in the conventions of the served public
resources:

| `SessionTaskView`    | `PublicTask`          | `WebShellTask`       | Notes                                  |
| -------------------- | --------------------- | -------------------- | -------------------------------------- |
| `taskId`             | `id`                  | `taskId`             | As `PublicSession` and `PublicAction`. |
| (none)               | `object`              | (none)               | Added, `agent.task`.                   |
| `sessionId`          | `session_id`          | `sessionId`          |                                        |
| `kind`               | `kind`                | `kind`               | `TaskKind`, same five values.          |
| `state`              | `state`               | `state`              | `TaskState`, same eight values.        |
| `definitionRevision` | `definition_revision` | `definitionRevision` | `int64`, at least 1.                   |
| `runtimeState`       | `runtime_state`       | `runtimeState`       | `TaskRuntimeState`, same five values.  |
| (none)               | `created_at`          | `createdAt`          | Added, required.                       |
| `startedAt`          | `started_at`          | `startedAt`          | Epoch milliseconds, not an ISO string. |
| `settledAt`          | `settled_at`          | `settledAt`          | Epoch milliseconds, not an ISO string. |
| `outputCursor`       | `output_cursor`       | `outputCursor`       | Opaque, at most 512 characters.        |
| `artifactRefs`       | `artifact_refs`       | `artifactRefs`       | The newest 100 at most, unique.        |
| `actionCapabilities` | `action_capabilities` | `actionCapabilities` | `TaskActionCapability`, unique values. |

The enums are shared components (`TaskKind`, `TaskState`, `TaskRuntimeState`
and `TaskActionCapability`), as `CwdOperationStatus` already is, and so is the
open event type `TaskEventType`. The conditionals and bounds are copied into
each surface, so `PlannedTaskContractTest` checks every instance against both
(section 5).

The design's shape changes in five places:

- **`id`.** `PublicSession`, `PublicAction`, `PublicArtifact` and
  `PublicCommandOperation` name their identifier `id`; WebShell keeps
  `taskId`, as it keeps `actionId` and `operationId`.
- **`object`.** The Session, Turn, Item, Artifact and Workspace resources
  carry an `object` discriminator and their lists carry `object: "list"`;
  operations, event items and the planned Action family do not. `PublicTask`, `PublicTaskList` and
  `PublicTaskEventList` carry it too, because adding a required field later
  would break clients.
- **Timestamps.** The public API uses `int64` epoch milliseconds everywhere
  (`created_at`, `expires_at`), and the server fills them from `clock.millis()`.
- **`created_at`.** The list is ordered by creation, and a `pending` task has
  no `started_at`, so the view needs a creation time.
- **Bounded `artifact_refs`.** A long-running Monitor can rotate many
  Artifacts. The view lists the newest 100, oldest first; older Artifacts stay
  readable through the Session artifact routes.

Optional fields are omitted, never `null`, as in the Action family; records
that implement the view need `@JsonInclude(NON_NULL)`, which several API
records already use. `additionalProperties: false` rejects every field the design
forbids: Runtime binding ID, generation, Runtime endpoint, Pod, absolute path,
raw PID, SecretHandle and local sidecar.

The list is ordered newest first by `created_at`, then by `id`, both
descending. That is the order of the Session list in the API contract, with
creation time instead of update time, so a task that changes state does not
move between pages.

These invariants are schema conditionals:

- `completed`, `failed` and `cancelled` are terminal. A terminal task has
  `settled_at` and advertises neither `cancel` nor `send_input`.
- `running`, `waiting`, `degraded` and `completed` have `started_at`.
  `pending` has none. A task that failed or was cancelled before it started
  settles without one.
- `recovery_blocked` ends the logical run line in design section 3.2, but it
  is not a settlement: recovery could not prove the physical outcome. It
  therefore has no `settled_at`. It may still advertise `cancel`, so a caller
  can ask the owner to stop whatever may still run, but never `send_input`,
  because input to an execution in an unknown state could run twice. This is
  a decision, not something the design states.

### 4.3 Task events and the output cursor

`GET /v1/agents/sessions/{sessionId}/tasks/{taskId}/events?after=` returns a
`PublicTaskEventList`, oldest first. The event types defined now are:

- `state_changed`, with `state` and optionally `runtime_state`;
- `output`, a chunk of 1 to 16384 characters in `text`, with `truncated` when
  the chunk was cut and the full output is in an Artifact;
- `artifact`, the `artifact_id` of an Artifact that received task output.

Conditionals forbid the fields of one type on another. The set of types is
open: a later minor version may add a type together with the optional fields
it needs, and clients ignore types they do not know, as section 5 of the API
contract requires. Every event carries `schema_version` and
`projection_version`, as section 5 of the API contract requires of public
events. High-volume logs and Monitor raw lines go into Artifacts, never one
event per line, as design section 11 requires, and events are retained for a
bounded time rather than kept forever.

Every event carries `cursor`, the position after it, which also serves as its
identity. A consumer that stores the cursor with each event it applies resumes
after a crash without applying an output chunk twice. A page's `next_cursor`
is the position after the last event the server examined, including events
the route does not return, so a page that filtered everything out still
advances; when nothing was examined, it is the requested position, or the
start of the retained events when `after` was omitted. Unlike list pages,
`next_cursor` is required and never `null`: a running task can produce more
events, so a caller that reached the end still needs a position to poll from.
`after` accepts an event's or a page's cursor, or a task's `output_cursor`;
without `after` the page starts at the oldest retained event.

This stream departs from the Session event history in section 4 of the API
contract, which uses a public integer `sequence`, reads events strictly after
it, and allows `limit` up to 1000 with a default of 100:

- The cursor is opaque, like the design's `outputCursor`, so the server may
  back it with event sequences, Artifact offsets or both.
- `limit` uses the shared `ListLimit` (1 to 100, default 20), because one
  event can carry 16384 characters where a Session event carries a small
  delta. A page holds at most 100 chunks.
- A malformed `after`, or one from another task, is `400
invalid_event_cursor`, the code the Session event history already uses.

`action_capabilities` describes the task, not the caller: it lists the
actions the task supports now, the same for every caller, and whether a
caller may use one is a separate authorization check. `read_output` says that
the route returns `output` events for the task. Without it the route returns
only state and Artifact events.

### 4.4 Cancel

Cancel is `POST /v1/agents/sessions/{sessionId}/tasks/{taskId}/cancel`, not the
design's `tasks/{taskId}:cancel`. No route in the contract uses a `:` suffix;
commands on an existing Session use sub-paths (`/close`, `/archive`,
`/unarchive`, `/cwd`, `/actions/{actionId}/responses`), `POST …/events`,
`PATCH` or `DELETE`, and task cancel takes the sub-path form.

Cancel reuses the command operation model instead of a new one:

- `PublicCommandOperation.type` gains `task_cancel`, and the operation gains a
  `task_id` that is required for `task_cancel` and forbidden for every other
  type. `task_cancel` never carries `action_resolution`. The WebShell mirror
  gains `taskId` in the same way.
- The operation is read back through the existing
  `GET .../operations/{operationId}` and WebShell `operations/query`.
- Checks run in a fixed order: access (`404` when the caller cannot read
  the task, then `403 task_forbidden` when it may not cancel it), idempotent
  replay, then task state. A retry by the same actor with the same
  `Idempotency-Key` and request therefore replays the original operation even
  after the task settled, as the cwd change and API contract sections 3 and
  10 require, and a lost `202` never turns into a `409` for the caller that
  made the request.
- `202` and a `completed` operation mean that the authority recorded the
  cancel, not that the task stopped. The task becomes `cancelled` only after
  its physical execution settles, and an unknown outcome becomes
  `recovery_blocked`. This follows design section 3.2: a logical settle never
  covers a process that has not drained.
- A new key is accepted only while `action_capabilities` contains `cancel`. A
  settled task never advertises it, so the same rule covers both cases.

### 4.5 WebShell adapter

The adapter mirrors the public routes in its existing style, as `POST` routes
that end in `query`, `get` or a verb:

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
task routes. Public lists are named `…List` and WebShell pages `…Page`, as in
the Action family.

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
to those slices, and so is the meaning of the error responses these routes
declare.

### 4.7 Errors

Errors keep `ErrorEnvelope` and the shared `BadRequest`, `Forbidden`,
`NotFound`, `Conflict` and `CursorExpired` responses. The codes are those the
API contract already froze, `invalid_idempotency_key`, which the idempotent
routes already return, and three new task codes:

| Status | Code                      | When                                                                                     |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------- |
| `400`  | `invalid_cursor`          | The task list cursor is malformed.                                                       |
| `400`  | `invalid_event_cursor`    | `after` is malformed or belongs to another task.                                         |
| `400`  | `invalid_limit`           | `limit` is outside 1 to 100.                                                             |
| `400`  | `invalid_request`         | `Idempotency-Key` is missing.                                                            |
| `400`  | `invalid_idempotency_key` | `Idempotency-Key` is malformed, as on the other idempotent routes.                       |
| `400`  | `unsupported_feature`     | The Session does not serve tasks (`capabilities.tasks` is `false`).                      |
| `403`  | `task_forbidden`          | The caller can read the task but may not cancel it. New.                                 |
| `404`  | `session_not_found`       | The Session is absent or outside the caller's scope.                                     |
| `404`  | `task_not_found`          | The task is absent or outside the caller's scope. New.                                   |
| `409`  | `cursor_expired`          | `after` is older than the retained events.                                               |
| `409`  | `task_action_unavailable` | A new key while `action_capabilities` lacks `cancel`, which includes settled tasks. New. |
| `409`  | `idempotency_conflict`    | The key was used with a different request.                                               |

A caller that cannot read a task gets `404`, not `403`, as API contract
section 10 requires, so the read routes declare no `403`; only cancel does. `cursor_expired` leaves the envelope's
`replay_floor_sequence` and `snapshot_through_sequence` absent, because task
cursors are opaque. An output event expires only after its text is in an
Artifact, so a caller that reads the task's Artifacts and then the retained
events from the start misses no output. Joining the two without overlap
depends on how output is segmented, which H3 defines.

## 5. Contract test changes

`ManagedAgentApiContractTest` compares mapped routes with the spec only under
its `API_PREFIXES`. `/v1/agent-channels` and `/v1/agent-automations` do not
start with `/v1/agents`, so a server that mapped them would pass unnoticed.
The prefix becomes `/v1/agent`, which covers `/v1/agents` and every
`/v1/agent-*` resource a later slice adds, and section 5.1 of the
[D1 design](2026-09-27-managed-agent-api-contract.md) now says so. No gap line
is added to `contract-known-gaps.txt`.

The same test validates only operations that are not `planned`, so nothing
would catch a broken conditional in the task schemas until H0c maps the
routes. A new `PlannedTaskContractTest` validates valid and invalid instances
against them with the same validator: the task invariants, forbidden fields,
one shape per event type, the event versions, list and page cursors, and the
`task_cancel` operation, including through the `PublicOperation` and
`WebShellOperation` unions. Each instance is written once in the public shape
and checked again, renamed to camelCase, against the WebShell mirror, so a
conditional copied wrongly into one surface fails the test. The WebShell
cancel and event query requests are checked as well.

## 6. Validation

- `npm run generate:managed-agent-api` in `packages/web-shell` leaves
  `client/components/managed/generated/managed-agent-api.ts` unchanged, and
  `managed-agent-api.test.ts` passes.
- `ManagedAgentApiContractTest` (3 tests), `PlannedTaskContractTest` (5
  tests, 103 validations: 50 public, 49 WebShell mirrors and 4 WebShell
  requests) and `ManagedSessionStoreContractFixtureTest` (3 tests) pass
  without new gap lines.
- Mutations fail the matching gate:
  - Removing, on one surface, the conditionals of the task, the task event,
    the task list and the `task_cancel` rule, and the minimum output length,
    fails `PlannedTaskContractTest` on 22 instances of that surface, for the
    public schemas and for the WebShell mirror alike.
  - Dropping the `state` requirement of `state_changed`, the `artifact_id`
    requirement of `artifact`, or `waiting` or `degraded` from the start-time
    rule each fails it on one instance.
  - Marking `cancelWebShellTask` `partial` fails the route and scenario checks
    ("is partial but not mapped") and adds 75 lines to the generated types,
    including `task_cancel` in the command type (section 4.1).
  - A probe controller mapping `GET /v1/agent-automations` fails with "is
    mapped but planned", and passes silently with the previous prefixes.
- `openapi-typescript` parses the full spec, including public routes.

## 7. Follow-up

- **Version order.** W0d (#12797) landed first as `1.14.0`, so this change is
  `1.15.0`. D2 (#12822) also moves the spec; whichever of the two lands later
  takes the next minor version.
- **H0b.** The shared record schema, including `monitor_run`, the three state
  lines and `OperationGrant`. It depends on issue question 1 (whether
  `monitor_run` joins the closed v1 domain index).
- **H0c.** Builds the task projection, maps these routes as `partial`, and
  defines the Session events that announce task changes. Marking the routes
  alone is not enough: `PublicCommandOperation.task_id`,
  `WebShellCommandOperation.taskId` and both `capabilities.tasks` flags are
  `planned` properties of their own, as is the `WebShellSession.capabilities`
  object that holds one of them, and they stay out of the generated types
  until they are marked too.
- **Output recovery.** H3 defines output segmentation, and with it how a
  caller joins the task's Artifacts with the retained events after
  `cursor_expired` without overlap.
- **Artifact attribution.** `PublicArtifact` has no task reference and the
  artifact list has no task filter, so an Artifact beyond the newest 100 in
  `artifact_refs` cannot be tied back to its task. The Artifact slices (O2,
  O4) should add one of the two before a task can rotate that many.
- **Legacy states.** The daemon's task status includes `paused`, and
  workflow runs add `pausing`; `TaskState` has neither. The adapter slice (H3
  or H4) maps them, most likely to `waiting`, or the design adds a state.
- **Later additions.** Query filters (`kind`, `state`), a `send_input` route
  and any display label are additive `planned` changes. `SessionTaskView`
  has no title; the first slice that renders tasks in WebShell should decide
  whether it needs one.

[design]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md
[api]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
