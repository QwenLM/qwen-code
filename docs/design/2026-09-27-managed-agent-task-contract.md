# Managed Agent Task Contract (Stage H0a)

[English](2026-09-27-managed-agent-task-contract.md) | [简体中文](2026-09-27-managed-agent-task-contract.zh-CN.md)

Status: H0a implemented as a contract only (every route and schema it added, and every property it added to an existing schema, was `planned`); H0b has landed; H0c marks the four task read routes and their schemas `partial` and drops the marker from `capabilities.tasks`, serves the task list and detail and announces task changes ([design](2026-09-27-managed-extension-authority.md)); task events, cancel and H1 to H6 are pending
Date: 2026-09-27; contract follow-up: 2026-09-29
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
  WebShell types do not change. H0c (#12855) has since mapped the four read
  routes and changed the types accordingly; events and cancel stay `planned`.

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

The 2026-09-29 follow-up settles A1–A8 of [#12847](https://github.com/QwenLM/qwen-code/issues/12847) in contract v1.23.0. Events and cancel remain `planned`; no runtime behavior is added. A9 and the task-route part of A10 landed in #12966. The original H0a scope and validation below remain historical.

### 4.1 Everything added is `planned`

Every route and schema added here carries
`x-qwen-implementation-status: planned`, and so does every property added to
an existing schema (`PublicCommandOperation`, `WebShellCommandOperation`,
`SessionCapabilities` and `WebShellSession.capabilities`). The properties of
the new schemas and the two new parameters need no marker of their own: only
planned operations reach them. The generator drops all of it, and the Java
contract test fails if the server maps any of the routes. The version becomes `1.16.0`: routes are added, and W0d (#12797) and D2 (#12822) already took `1.14.0` and `1.15.0`. H0c (#12855) has since flipped the four read operations and the ten task schemas they return to `partial`, added the served `WebShellSessionCapabilities` schema, and made `capabilities.tasks` served and required; events, cancel and the command `task_id`/`taskId` fields stay `planned`. So read the pieces below as the state before H0c, not as the current one.

An enum value cannot carry the marker, and cancel reuses the command
operation (section 4.4). The new `task_cancel` command type is therefore
already visible in the public spec, because the `partial` archive and delete
routes declare `202` with `PublicCommandOperation`, as the planned
`action_response` and `close` types are. Only the generated WebShell types are
insulated, until any WebShell route that returns `WebShellCommandOperation`
becomes `partial`. A separate planned operation schema would have kept the
value out, at the cost of a second operation model for one command; this
change accepts the visibility instead. D4 has since exposed the shared
command operation in generated types, including `task_cancel`. The follow-up
keeps its new task-cancel-only condition `planned` as a whole, so the generator
does not retain requirements on filtered fields. The cancel slice must remove
that marker together with `task_id`/`taskId` and `failure_code`/`failureCode`
when it serves the route; no shared status enum is narrowed. It must also
persist the new fields: `managed_agent_operation` has no `task_id` or
`failure_code` column, so a migration adds both, and the worker writes
`failure_code` in the same transaction as the `FAILED` transition, so the
reason survives re-lease and restart (section 7).

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
each surface, so `PlannedTaskContractTest` checks its instances against both,
all but the public-only `object` check (section 5).

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
- **Bounded `artifact_refs`.** The view lists the newest 100, oldest first.
  A task must not rotate past the bound until older Artifacts can be
  enumerated and attributed to it (sections 4.7 and 7): an evicted Artifact
  stays readable by id through the Session artifact routes but is no longer
  discoverable from the task.

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

Conditionals forbid the fields of one known type on another. The type set is
open. Within a major version, clients ignore unknown optional fields and
unknown task event types, while still checkpointing their cursors. Task events
have no terminal flag. The closed schemas validate what a server emits for its
own contract version; strict response validation against an older minor
version is not supported. Adding a new optional field is allowed; reusing an
existing field forbidden for a known type is not. This follows API contract
section 5 and keeps the current flat event shape (A8).

Every event carries `schema_version` and `projection_version`. Its identity,
position, payload and accepted versions survive projection rebuilds, restarts
and archival unchanged. A cursor is never reassigned, even if backed by
Artifact offsets; archival must preserve its logical position (A5). Stability
does not prevent normal retention expiry.

Events are published as a committed prefix for each task: after any event,
page or `output_cursor` position is returned, no event may later become
visible at or before it. Allocating an increasing sequence before commit is
not sufficient; concurrent writers must serialize publication or readers must
wait behind unfinished writes. This requires neither global ordering across
tasks nor gapless internal sequence numbers (A2).

Every event carries `cursor`, the opaque position after it, which also serves
as its identity. A consumer atomically applies an event and saves its cursor
to avoid applying the same chunk twice after a crash. A page's `next_cursor`
is its last event's cursor, so `limit` never skips an event. On an empty page it
is the requested position, or the retention floor when `after` was omitted.
It is required and never `null`, including when no events remain.

The durable retention floor is the position after the newest expired event,
or the stream's initial position if nothing has expired. Only an oldest
prefix may expire. A cursor strictly below the floor returns
`409 cursor_expired`; equality is valid. The floor survives an empty retained
set, restarts and projection rebuilds. For example, after events 1 through 10
expire, the cursor after event 10 is valid, but the cursor after event 9 is
expired even if the retained set is empty. These are logical positions, not
client-comparable cursor strings (A1).

`after` accepts an event cursor, a page cursor or the task's `output_cursor`;
without it, reading starts at the floor. `output_cursor` is the committed tail
at the view read and intentionally skips earlier output. Recovery must keep
the event page's checkpoint, not replace it with a later task view's tail.

High-volume logs and Monitor raw lines go into Artifacts or this bounded-chunk
paged stream, never one Session event per raw line. Time-based retention is a
target under healthy archival, not an unconditional deletion deadline. Any
task that produces output requires `capabilities.artifacts`, including a task
whose output goes only to Artifacts. An output event holds back expiry of
itself and every later event until its full text is durably archived and
available through task Artifact discovery as defined in section 4.7 (A3–A4).
An archival failure must not advance the floor past that output. H3 must bound
the durable backlog and specify producer backpressure and admission blocking
before capacity is exhausted; an adapter unable to preserve accepted output
under that policy must not enable output-producing tasks. Output is not
silently discarded to meet a retention target. Those runtime mechanisms are
an H3 acceptance gate, not implemented by this contract change.

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
actions the task supports now, the same for every caller. Whether a caller may
cancel is a separate authorization check (`403` on the cancel route); reading
output needs only read access. `read_output` says that the route returns
`output` events for the task. It does not change during the task's life, and
a task without it produces no output events: its output goes only to
Artifacts. The route therefore never filters out an event that exists, and the
guarantees in this section and in section 4.7 hold for every task.

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

After the trusted tenant/actor filter and request decoding, cancel checks run
in this order (A6):

1. Validate the key: missing is `400 invalid_request`, malformed is
   `400 invalid_idempotency_key`.
2. Check current access: `404` for an unreadable Session or task, then
   `403 task_forbidden` for a readable task the actor may not cancel.
3. Look up the retained idempotency record in the
   tenant/Session/operation-kind/actor/key domain. The request digest includes
   the task ID and excludes trace-only request IDs. A different digest is
   `409 idempotency_conflict`; the same digest returns the same operation ID
   with its latest durable state and `replayed: true`.
4. Only for a new request, check task support (`400 unsupported_feature`),
   then that the Session is `active` (`409 session_not_active` otherwise,
   including `closing`, `closed`, `archived` and `deleting`), then that
   `action_capabilities` includes `cancel`
   (`409 task_action_unavailable` otherwise).
5. Atomically recheck new-request admission conditions and create the
   operation, serializing competing requests with Session/task transitions.
   A concurrent same-key winner is handled by step 3, not as a new request.
   Admission requires no other open (`pending` or `running`) operation on
   the Session: cancel operations share the durable operation table with the
   lifecycle commands, which admit one open operation per Session, so an open
   operation of any kind answers `409 session_operation_active`, and an open
   cancel blocks close, archive and delete the same way.

A retained key therefore survives capability and state changes, but never
bypasses current access checks. Missing/deleted resources or revoked access
can still produce `404` or `403`; the replay promise is conditional on access
and record retention. A legal same-key retry cannot become a new-request
`400` or `409` merely because support was disabled or the task settled.

Cancel operations have these outcomes (A7):

| Result                | Meaning                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP `202`            | Java durably accepted the command and owns its delivery; it does not prove owner acceptance or physical stop.                                                    |
| `pending` / `running` | Delivery or confirmation is outstanding; retryable transport failures stay here.                                                                                 |
| `completed`           | The task authority durably recorded the cancellation and returned the operation's receipt. It does not prove physical stop.                                      |
| `failed`              | The command definitively was not accepted and will not be delivered again; `failure_code` explains why.                                                          |
| `recovery_blocked`    | Recovery cannot determine whether the authority accepted the command. Do not report success or automatically re-execute it without reconciliation.               |
| `cancelled`           | Not produced for `task_cancel`: this contract has no mechanism to withdraw a cancellation command. The shared status remains available to other operation kinds. |

A `task_cancel` operation's other state fields follow its outcome.
`pending` and `running` carry `admission_stage: java_durable`, with
`delivery_state` `pending` between attempts and `leased` during one, and
no `receipt_id`. `completed` carries `admission_stage: harness_confirmed`,
`delivery_state: confirmed` and the task authority's `receipt_id`.
`failed` and `recovery_blocked` carry `admission_stage: java_durable` and
`delivery_state: blocked` — delivery has stopped, so a definitively rejected
or unreconciled command is never claimed and driven again — and no
`receipt_id`; `failed` adds `failure_code`. `blocked` means delivery is
not attempted again without reconciliation; no other operation kind produces
it today.

The task becomes `cancelled` only when cancellation physically settles it. A
natural completion that wins the race keeps its own terminal outcome; command
acceptance never overwrites it. An unknown physical outcome makes the task
`recovery_blocked` independently of the operation's acceptance outcome.

Different keys that each pass admission —
including step 5, no other open operation on the Session — create different
operations. Their physical stop requests may be coalesced or repeated safely,
and each operation must receive its own recorded outcome. A later request that finds no `cancel`
capability gets `409 task_action_unavailable`; two different keys do not
promise two accepted operations. No route for cancelling an operation is added.

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
`SessionCapabilities.tasks` and `WebShellSession.capabilities.tasks` were
added `planned`, default `false`; H0c made both served and required, so a
client always reads whether the Session serves the task routes. Public lists
are named `…List` and WebShell pages `…Page`, as in the Action family.

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
routes already return, the tenant filter's `invalid_tenant` and
`actor_scope_mismatch`, and three new task codes:

| Status | Code                       | When                                                                                                                                                                                                            |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_tenant`           | `X-Qwen-Tenant-Id` is missing or malformed (tenant filter).                                                                                                                                                     |
| `400`  | `invalid_cursor`           | The task list cursor is malformed.                                                                                                                                                                              |
| `400`  | `invalid_event_cursor`     | `after` is malformed or belongs to another task.                                                                                                                                                                |
| `400`  | `invalid_limit`            | `limit` is outside 1 to 100.                                                                                                                                                                                    |
| `400`  | `invalid_request`          | `Idempotency-Key` is missing.                                                                                                                                                                                   |
| `400`  | `invalid_idempotency_key`  | `Idempotency-Key` is malformed, as on the other idempotent routes.                                                                                                                                              |
| `400`  | `unsupported_feature`      | The Session does not serve tasks (`capabilities.tasks` is `false`). Only the still-`planned` events and cancel routes can answer it; the served read routes return it never, because the flag is always `true`. |
| `403`  | `task_forbidden`           | The caller can read the task but may not cancel it. New.                                                                                                                                                        |
| `403`  | `actor_scope_mismatch`     | The authenticated actor belongs to another tenant or has an invalid ID (tenant filter).                                                                                                                         |
| `404`  | `session_not_found`        | The Session is absent or outside the caller's scope.                                                                                                                                                            |
| `404`  | `task_not_found`           | The task is absent or outside the caller's scope. New.                                                                                                                                                          |
| `409`  | `cursor_expired`           | `after` is strictly below the durable retention floor, even with no retained events.                                                                                                                            |
| `409`  | `task_action_unavailable`  | A new key while `action_capabilities` lacks `cancel`, which includes settled tasks. New.                                                                                                                        |
| `409`  | `session_not_active`       | A new cancel request targets a Session that is not active.                                                                                                                                                      |
| `409`  | `session_operation_active` | A new cancel request while another operation is open on the Session, as on the lifecycle routes.                                                                                                                |
| `409`  | `idempotency_conflict`     | The key was used with a different request.                                                                                                                                                                      |

A caller that cannot read a task gets `404`, not `403`, as API contract
section 10 requires. The only `403` a read route answers is the tenant
filter's `actor_scope_mismatch`, for an authenticated actor from another
tenant or with an invalid ID. The filter covers every `/v1/agents/` and
WebShell route; the task read routes declare it from `1.21.0`, as the
Session and Turn reads do, and cancel adds `task_forbidden`. `cursor_expired`
leaves the envelope's
`replay_floor_sequence` and `snapshot_through_sequence` absent, because task
cursors are opaque. Recovery after `cursor_expired` proceeds as follows (A3):

1. Read one retained event page from the floor by omitting `after` and save
   its `next_cursor`. Do not wait for `has_more` to become false: an active
   producer may keep adding events indefinitely.
2. Read a fresh task view **after** those event reads, then discover and read
   its Artifacts. Do not reuse `artifact_refs` cached before the event read.
3. Resume events from the saved page cursor, including events held back by
   the first page limit. If the floor overtakes the reader, restart recovery;
   do not treat another `409` as an empty page. H3 defines stable output
   segment identities/ranges for joining Artifacts and events without overlap.

Before an output event expires, its full text must be durably readable in an
Artifact and that Artifact must be discoverable by the recovery reads. Merely
writing a blob, or updating a projection that a subsequent read can still lag
behind, is insufficient. The server must enforce this visibility barrier before
advancing the floor. Truncated events likewise require their full output to
be durably readable and discoverable when published.

Until older Artifacts can be enumerated and attributed to a task, a task must
not rotate beyond the 100 entries in `artifact_refs`. H3 must enforce that
bound or land the attribution mechanism with O2/O4 before enabling rotation
past it. Once that mechanism exists, recovery must enumerate older Artifacts
as well as the newest references; the bounded view alone is not complete.
These guarantees hold while the task and its Artifacts remain readable under
their resource retention and authorization rules. They do not promise recovery
after those resources are deleted. Concurrent retention may require another
recovery pass; it must never silently skip unarchived output.

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
and, except the public-only `object` check, checked again, renamed to
camelCase, against the WebShell mirror, so a
conditional copied wrongly into one surface fails the test. The WebShell
cancel and event query requests are checked as well. From `1.21.0` it also
requires the tenant filter's `403` on the four `planned` task routes, which
`ManagedAgentApiContractTest` cannot probe.

## 6. Validation

### 6.1 Contract follow-up acceptance

The follow-up adds schema instances for empty event pages, closed event
objects with an open type set, and task-cancel outcomes on both surfaces and
through the operation unions. Regeneration must not expose planned routes or
fields; the shared operation description may change. Schema tests do not prove
the runtime guarantees above. Before H3 or the cancel slice marks its routes
`partial`, it must demonstrate:

- expiry below/equal to the floor, including an empty retained set;
- delayed concurrent commits cannot appear behind a returned cursor;
- cursor and accepted-event identity survive restart, rebuild and archival;
- delayed Artifact projection, archival failure and the 100-reference bound
  cannot silently lose output; recovery joins segments without duplication;
- a Session that advertises `capabilities.tasks` without
  `capabilities.artifacts` admits no output-producing task, including one
  whose output goes only to Artifacts;
- replay after capability/session/task changes, revoked access, conflicting
  digests and concurrent same/different keys follows section 4.4;
- lost cancellation receipts are reconciled, not reported as definite failure
  or physical task settlement.

### 6.2 Historical H0a validation

- `npm run generate:managed-agent-api` in `packages/web-shell` leaves
  `client/components/managed/generated/managed-agent-api.ts` unchanged, and
  `managed-agent-api.test.ts` passes.
- `ManagedAgentApiContractTest` (5 tests), `PlannedTaskContractTest` (5
  tests, 103 validations: 50 public, 49 WebShell mirrors and 4 WebShell
  requests; `1.21.0` adds a sixth test, see section 5) and
  `ManagedSessionStoreContractFixtureTest` (3 tests) pass
  without new gap lines. Since H0c the split is different:
  `ManagedAgentApiContractTest` exercises the four served read routes, and
  only the events and cancel stay with `PlannedTaskContractTest`.
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

- **Version order.** W0d (#12797) landed as `1.14.0` and D2 (#12822) as
  `1.15.0` before this change, so it is `1.16.0`. Any spec change that lands
  before it moves it to the next minor version again.
- **H0b.** The shared record schema, including `monitor_run`, the three state
  lines and `OperationGrant`, is #12837. It adds `monitor_run` to the closed v1
  domain index, which answers issue question 1, and keeps the domain disabled
  for submission.
- **H0c.** Builds the task projection, maps these routes as `partial`, and
  defines the Session events that announce task changes. Marking the routes
  alone was not enough: `capabilities.tasks` became served and required
  with them (#12855), inside a `WebShellSession.capabilities` object that
  #12855 served without requiring; this change adds the object to
  `WebShellSession.required`, mirroring the public `Session` that already
  required it, so the generated WebShell type loses its `?`.
  `PublicCommandOperation.task_id` and `WebShellCommandOperation.taskId`
  stay `planned` with cancel, as the H0c design's Decision 9 says.
- **Output recovery.** H3 defines output segmentation, and with it how a
  caller joins the task's Artifacts with the retained events after
  `cursor_expired` without overlap.
- **Artifact attribution.** `PublicArtifact` has no task reference and the
  artifact list has no task filter, so an Artifact beyond the newest 100 in
  `artifact_refs` cannot be tied back to its task. The Artifact slices (O2,
  O4) must land one of the two before a task can rotate that many.
- **Cancel operation storage.** `managed_agent_operation` (V17) has no
  `task_id` or `failure_code` column. The cancel slice migrates both in and
  writes `failure_code` in the same transaction as the `FAILED` transition,
  so the reason a leased worker learns survives re-lease and restart (section
  4.1).
- **Legacy states.** The daemon's task status includes `paused`, and
  workflow runs add `pausing`; `TaskState` has neither. Decided in #12847
  (A9): the adapter slice (H3 or H4) maps both to `waiting`, and `TaskState`
  gains no state. H0c made `TaskState` `partial` with its eight values, and
  under section 5 of the API contract a new value would now be a breaking
  change.
- **Later additions.** Query filters (`kind`, `state`), a `send_input` route
  and any display label are additive `planned` changes. `SessionTaskView`
  has no title; the first slice that renders tasks in WebShell should decide
  whether it needs one.

[design]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md
[api]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
