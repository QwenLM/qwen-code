# Managed Agent API Contract (Stage D1)

[English](2026-09-27-managed-agent-api-contract.md) | [简体中文](2026-09-27-managed-agent-api-contract.zh-CN.md)

Status: D1 implemented; D2 implemented in [Session query](2026-09-27-managed-agent-session-query.md); D3 implemented in [Event replay](2026-09-27-managed-agent-event-replay.md); the lifecycle work implemented as D4 of [#12867](https://github.com/QwenLM/qwen-code/issues/12867) in [Durable lifecycle](2026-09-28-managed-agent-durable-lifecycle.md); D5 implemented in [Turn queries](2026-09-28-managed-agent-turn-queries.md); D6 designed in [Actions](2026-09-30-managed-agent-actions.md), with its Hosted Harness part (D6a) implemented
Date: 2026-09-27
Issue: [#12793](https://github.com/QwenLM/qwen-code/issues/12793), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)

## 1. Problem

The Managed Agent server exposes public Session routes under
`/v1/agents/sessions` and a WebShell adapter under `/api/agent/web-shell/v1`.
Their reviewed contract, the [public API contract][contract] and
[OpenAPI v1.12][openapi], lived only in the design repository. In this
repository, `ApiModels.java` and the interfaces in
`packages/web-shell/client/components/managed/java-managed-agent-client.ts`
were written by hand, and nothing compared them, or the mapped Spring routes,
with the schema. Each new field (W0b's `workspace`, the planned Artifacts and
Actions) had to be added twice with no check.

Sections 3 to 5, 7 and 8 of the contract define request correlation, paging,
replay, versions and capabilities, the known implementation gaps, and the rule
that a route moves from `partial` to `implemented` only after contract tests
pass. Stage D closes those gaps in three slices; D1 provides the contract and
the checks that D2 and D3 build on.

## 2. Goals

- Keep the reviewed OpenAPI in this repository as the single source for the
  Java server, the WebShell TypeScript client and the contract tests.
- Generate the WebShell TypeScript types from it and fail CI when the
  committed types are stale.
- Fail CI when a Java record, a mapped Spring route, or a real response of a
  `partial` route drifts from the spec.
- Record the current differences as explicit expected failures, so that D2 and
  D3 remove them one by one and a fixed gap cannot stay listed.

## 3. Non-goals

- No route becomes `implemented`. Shipped lifecycle routes (4.3) and W0d
  discovery and binding (4.5) are recorded as `partial`.
- No server behavior changes. D1 only records what D2 and D3 must fix.
- No schema field is removed to make the current server pass.
- Durable admission, Turns, AgentDefinition, Artifacts, workspace execution and context switching, Actions and
  event retention stay out of scope, as in the issue.

## 4. Decisions

### 4.1 Spec location and format

The spec moves into
`packages/sdk-java/managed-agent-server/src/main/resources/openapi/managed-agent-public-api.openapi.json`
and becomes the single source; the design repository points here from now on.

It is stored as JSON rather than YAML. The repository's yamllint rules require
single-quoted scalars and block style, and the upstream YAML fails them in 2264
places. JSON follows the precedent of
`docs/developers/daemon-rest-api.openapi.json`, needs no YAML parser on either
side, and is formatted by Prettier like the rest of the repository. The
conversion keeps key order and is lossless apart from the changes in 4.3
and 4.5.

D1 introduced `1.13.0` for the lifecycle routes (4.3). Integrating W0d adds
the workspace lookup route and advances the version to `1.14.0` (4.5).

### 4.2 Generate TypeScript, validate Java

- **TypeScript is generated.** `openapi-typescript` generates the WebShell
  types. The client's exported names (`JavaAgentSession`, `JavaAgentEvent`, …)
  stay, now as aliases of the generated types. `JavaAgentEnvironment` stays
  handwritten, because the contract leaves `environment` an open object.
- **Java records are validated, not generated.** They carry Bean Validation and
  Jackson annotations that a generator would have to reproduce. A contract test
  compares them with the schemas instead (5.2).

### 4.3 Shipped routes that v1.12 does not match

Main already serves rename (`PATCH /v1/agents/sessions/{sessionId}`),
`unarchive`, `archive` and `DELETE`. Section 8 forbids a mapped `planned` route,
so v1.13 records all four as `partial`:

- `archive` and `DELETE` keep their reviewed v1.10 targets (`202` with
  `PublicCommandOperation`). The current `200` responses are known gaps for the
  lifecycle work.
- `updateSession` (rename) and `unarchiveSession` have no reviewed target. They
  are added with the shape main ships: `200` with `PublicSession` and
  `X-Qwen-Idempotent-Replay`. `UpdateSessionRequest` requires a `title` of 1 to
  256 characters. The lifecycle work decides whether they become durable
  operations like `archive`.

### 4.4 `agent_revision` before AgentDefinition

`PublicSession.agent_revision` is required. D2 returns a fixed revision taken
from the server's agent configuration, and D1 only records the missing field.
D8a (v1.29) implements the `/v1/agents` routes as stored, immutable revisions;
Sessions keep the configured revision until D8b pins a stored one. See
[AgentDefinition revisions](2026-10-01-managed-agent-definitions.md).

### 4.5 W0d discovery and empty-session binding

The W0d integration marks public workspace list/get, WebShell workspace query/get,
and Session workspace selection and readback as `partial`. It adds the previously
missing WebShell `workspaces/get` operation and regenerates the client types.
Workspace queries have their own request schema: limit defaults to 50 and is
bounded at 100; cursors are bounded at 2048 characters.

Discovery's required `workspace_binding` / `workspaceBinding` capability advertises
only discovery, empty-session creation and binding readback. It does not enable
workspace execution or context switching. The existing `workspace_context` /
`workspaceContext` capability remains false.

Discovery now returns the target public workspace `id` and `object` and lowercase
WebShell states. Bound Sessions still return only workspace identity and cwd, so
traffic coverage records the missing context revision and state for W2. The
local client override remains only for that Session binding.

## 5. Java contract test

`ManagedAgentApiContractTest` runs in the ordinary `mvn test` lane with the
fake Harness of `ManagedAgentServerIntegrationTest` and its own in-memory H2
database. The two classes load separate Spring contexts, and each context's
dispatcher polls its database, so a shared database would let one test's
dispatcher claim the other's Turns. It uses the test-scoped
`com.networknt:json-schema-validator` (1.5.9, Jackson 2 like Spring Boot 3.5)
with JSON Schema 2020-12 and format assertions enabled. Schemas are addressed
by JSON Pointer into the spec, so `$ref` resolves inside the one file.

### 5.1 Routes

The test reads every route under `/v1/agent` and `/api/agent/web-shell/v1`
from Spring's `RequestMappingHandlerMapping` and compares them with the spec.
The first prefix covers `/v1/agents` and the `/v1/agent-*` resources that the
[H0a task contract](2026-09-27-managed-agent-task-contract.md) names; D1 read
only `/v1/agents`. A mapped route that is absent from the spec or marked
`planned` fails; so does a `partial` or `implemented` route that is not mapped.
There are no route gaps after 4.3 and 4.5.

### 5.2 Records

Every record in `ApiModels` must map to a schema, or the test reports it. For
each pair, Jackson's own property introspection supplies the JSON names:

- a schema property that is not `planned` and is absent from the record is
  reported as `missing`;
- a record property that the schema does not define is reported as `extra`.

`oneOf` and `allOf` members are merged, so `SessionEventRequest` is compared
with both the input and the cancellation event.

### 5.3 Real traffic

One scenario drives every non-`planned` operation through MockMvc against the
fake Harness: a completed Turn, an input and a cancellation, rename, archive,
a get and a list of the archived Session, unarchive and delete on the public
API; create with and without a first message, query, get, transcript, submit,
cancel and the SSE stream on the WebShell adapter; and cross-tenant `404` and
idempotency `409` errors. Workspace traffic covers all four discovery routes,
a default outside the current page, and bound empty-session creation and readback
on both surfaces, including normalized cwd. For each exchange it checks that:

- the request body the test sends is valid against the request schema;
- the status is the one the spec expects for that call;
- the body is valid against the declared schema for the actual status;
- every header that the response declares is present;
- each SSE frame's `id` is the event's `sequence`, its `event` is the type, and
  its `data` is valid against `PublicEvent` or `WebShellEvent`.

The test also fails if the scenario skips an operation that the spec does not
mark `planned`, so a route that becomes `partial` must be exercised.

### 5.4 Known gaps

A failure is normalized to a stable line: array indices become `*`, and a line
names the operation, status, location, keyword and property. The three tests
compare their lines with
`src/test/resources/openapi/contract-known-gaps.txt`. Any line not in the file
fails as new drift, and any listed line that no longer occurs fails as a
resolved gap that must be deleted. The file groups the lines by the slice that
closes them.

## 6. TypeScript types

`packages/web-shell/scripts/generate-managed-agent-api.mjs` writes
`client/components/managed/generated/managed-agent-api.ts`. Before running
`openapi-typescript` it:

- keeps only `WebShell` operations that are not `planned`;
- removes `planned` parameters and properties, and drops them from `required`;
- keeps only the components those operations reach.

The contract says planned surface must not reach a production client, so
fields such as `WebShellSession.capabilities` stay out until they are
implemented. Properties with a `default` stay optional
(`defaultNonNullable: false`); only `required` makes a field required.

`managed-agent-api.test.ts` regenerates the file in memory and fails when the
committed copy differs, and covers the filter on a small fixture.

The generated types also correct the handwritten interfaces. Three of the
corrections needed code changes: `turnId` can be absent on an event, and
`nextCursor` and `olderCursor` can be `null`. The provider now handles all
three. The stream request no longer sends `limit`, which v1.6 removed and the
server ignores. Input blocks keep
`type: 'text'` through a local override that names the known gap, because the
server still rejects the contract's `input_text`.

`openapi-typescript` depends on `supports-color` 10. With a second, higher
`supports-color` in the graph, pnpm rewrote the optional `supports-color` peer
of every `debug` entry in the lockfile (about 1100 changed lines) without
changing the hoisted tree. A pnpm override pins
`openapi-typescript>supports-color` to the 7.2.0 the repository already uses;
the generator only reads `stdout` and `stdout.hasBasic` to decide whether to
colour its logs, and 7.2.0 exports the same `stdout` (`false` without a TTY,
which turns colours off).

## 7. Gaps recorded by D1

| Slice                  | Gaps                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2                     | `agent_revision` and `capabilities` missing from every Session response; `replay_floor_sequence`, `snapshot_through_sequence` and `PublicTurn.input_item_id` missing from the records; `agent_revision` missing from `CreateSessionRequest`; no `X-Request-Id` on WebShell commands; `WebShellStreamRequest.limit` still in the record; input blocks accept only `text`, not the contract's `input_text`. |
| D3                     | `schema_version`, `projection_version`, `item_id` and `content_part_id` missing from public and WebShell events, in JSON and SSE; event and transcript pages reject `limit` above 100 with `400 invalid_limit`.                                                                                                                                                                                           |
| Lifecycle work         | `archive` and `DELETE` return `200` instead of `202` with a command operation; `DeletedSession` has no schema; an archived Session reads back with `status: "archived"`, which the contract's status enum lacks (v1.10 models archiving with the planned `archived_at`).                                                                                                                                  |
| Workspace context (W2) | The Session `workspace` lacks `context_revision` and `state` on both surfaces, checked through records and bound-session responses.                                                                                                                                                                                                                                                                       |

The input type mismatch was not in the issue's list; the request validation in
5.3 found it. The server's `input()` rejects anything but `text`, and the
WebShell client sends `text`, so both must change together in D2.

## 8. Changing the contract

1. Edit the JSON spec.
2. Run `npm run generate:managed-agent-api` in `packages/web-shell` and fix the
   client if the types changed.
3. Run `ManagedAgentApiContractTest`. Fix new drift in the server, or, only for
   a gap a later slice owns, add its line to the known-gaps file. When a fix
   closes a gap, delete its line.
4. Move a route to `implemented` only when it has no remaining gaps and its
   contract tests pass.

## 9. Validation

- `mvn test` in `packages/sdk-java/managed-agent-server` runs the three
  contract tests with the recorded gaps.
- Mutations each fail the matching test: a new field on a record, a new mapped
  route, a removed gap line, and a spec change without regenerating the
  TypeScript types.
- `npm run typecheck` and the managed component tests in `packages/web-shell`
  pass against the generated types.

## 10. Follow-up

D2 and D3 can start in parallel. Each closes its gaps from section 7 and then
moves its routes to `implemented`, as the issue defines. The gap file cannot
hold everything those slices must fix:

- **Undeclared error responses (D2).** Several `partial` operations do not
  declare error statuses that the server returns: `404 session_not_found` and
  `400 invalid_limit` on the WebShell transcript and session query,
  `400 invalid_limit` on the public event query, and `400`/`404` on WebShell
  submit and cancel. The test does not validate a body whose status the spec
  does not declare, so D2 adds these responses together with `request_id`.
- **Schema-valid semantics (D3).** A full event page returns
  `has_more: false` and `next_cursor: null`. The response matches the schema,
  so no gap line can record it, and D3's own tests must cover it.
- **Workspace-bound Sessions (W2).** Creation and readback on both surfaces now
  exercise the missing `context_revision` and `state` directly. W2 supplies those
  fields and removes the corresponding record and response gaps.

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
[openapi]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-public-api.openapi.yaml
