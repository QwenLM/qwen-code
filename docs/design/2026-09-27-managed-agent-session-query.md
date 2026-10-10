# Managed Agent Session Query (Stage D2)

[English](2026-09-27-managed-agent-session-query.md) | [简体中文](2026-09-27-managed-agent-session-query.zh-CN.md)

Status: implemented in this change
Date: 2026-09-27
Issue: [#12793](https://github.com/QwenLM/qwen-code/issues/12793), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
Builds on: [Managed Agent API Contract (Stage D1)](2026-09-27-managed-agent-api-contract.md)

## 1. Problem

D1 put the reviewed OpenAPI in this repository and recorded every difference
between it and the server as an expected failure. The Session create, list and
get routes on both surfaces still had the following gaps:

- `PublicSession` lacked `agent_revision` and `capabilities`, which the schema
  requires, and the `replay_floor_sequence` and `snapshot_through_sequence`
  watermarks. `PublicTurn` lacked `input_item_id`.
- Error envelopes had no `request_id`, and no response carried `X-Request-Id`.
  The WebShell `requestId` was accepted and never read.
- `WebShellStreamRequest` still carried the `limit` that the contract removed.
- The contract names input blocks `input_text`; the server accepted only `text`,
  which the WebShell client sent.
- An archived Session read back with `status: "archived"`, which the
  contract's status enum lacked.
- Several operations did not declare error statuses that the server returns,
  so the contract test never validated those envelopes.
- W0d ([#12797](https://github.com/QwenLM/qwen-code/pull/12797)) binds empty
  Sessions to a Workspace. A bound Session's `workspace` lacked the required
  `context_revision` and `state`, which W0d recorded as gaps on the create and
  get routes.

The issue's exit check for D2 is that these six routes move to `implemented`,
that one Session reports the same identity, status and sequence on both
surfaces, and that cross-tenant reads return `404 session_not_found`.

## 2. Goals

- Close every D2 gap recorded in D1 without adding new gap lines.
- Move `createSession`, `listSessions`, `getSession`, `webShellListSessions`,
  `webShellGetSession` and `webShellCreateSession` to `implemented`.
- Give every response a trace-only request id, and put it in every error
  envelope and in the logs.
- Prove parity between the two surfaces for one Session.

## 3. Non-goals

- Event versions, top-level Item and Part identity, real `has_more`, event
  limits up to 1000, a persisted replay floor, `cursor_expired` and resync.
  These are D3.
- Durable archive and delete operations (lifecycle work) and context changes
  (W2), which raise `context_revision` and report the other `state` values.
- AgentDefinition. D8a stores definition revisions; Sessions keep pinning the
  configured revision until D8b pins a stored one.

## 4. Decisions

### 4.1 Contract v1.15

- The Session and Turn status enums gain the values the server already
  returns. A Session reads `archived` after an archive, and `archiving` or
  `deleting` while that mutation waits for a retry after the Harness was
  unavailable. A Turn reads `cancelling` between a cancellation's admission and
  its settlement. The planned `archived_at` field is unchanged. If the lifecycle
  work later represents archiving as `closed` plus `archived_at`, that is a
  contract change of its own.
- `ErrorEnvelope.error.request_id` becomes required, as section 3 of the
  [public API contract][contract] that the D1 note links already states.
- Two shared responses are added: `Unauthorized` (401) and `Unavailable` (503).
  The implemented operations declare every status the server's own handlers
  return for them. Session create on both surfaces adds `401 actor_required`
  for a Workspace selection without a trusted actor, and `503` when the Hosted
  Harness is unavailable. Session get adds `400 invalid_tenant`, and the
  WebShell session query and get add `400`. Session get and list on both
  surfaces add `403 actor_scope_mismatch` from the tenant filter. Framework
  responses such as `405` and `415` stay undeclared, and a client that accepts
  no JSON gets a `406` without a body. The partial operations gain the `400`
  and `404` responses the new probes exercise: `400` on the event query and the
  Items list, and `400` and `404` on the WebShell transcript, event stream,
  submit and cancel.
- The six Session routes above move to `implemented`. `implemented` covers an
  operation's surface that is not `planned`, so it includes the `partial`
  `workspace` field, which section 4.4 completes.

### 4.2 `agent_revision`

The revision comes from the new setting `qwen.managed-agent.agent-revision`
(environment variable `QWEN_MANAGED_AGENT_REVISION`, default `1`). It is
written to the Session row at admission, so a later change of the setting does
not rewrite existing Sessions. Flyway V13 adds the column and gives existing
rows `1`.

A create request may name `agent_revision`. A new admission that names a value
other than the current revision is rejected with `400 unsupported_feature`.
The store checks this after the idempotency replay lookup and before it
reserves the creation or resolves a Workspace, so a retry of an admitted
creation still returns the original Session after the setting changes. An
explicit revision is part of the idempotency digest and an omitted one is not,
so digests of requests that omit it do not change. A retry that adds, drops or
changes the field is a different request and gets `409 idempotency_conflict`.
The same holds for a request that named the field before this change, whose
digest ignored it; no client in this repository sends the field.

### 4.3 Capabilities and watermarks

- `capabilities` reports `items: true` and `snapshots`, `resync` and
  `artifacts` as `false`. Snapshot reset and resync arrive with D3, and the
  contract forbids declaring them before the server can honour them. The
  planned optional flags are omitted; the schema defaults them to `false`.
- `replay_floor_sequence` is `0`. Events are never pruned yet; D3 persists the
  floor.
- `snapshot_through_sequence` is the covered sequence of the Session's
  Snapshot, the same value the Items list returns, or `0` before the first
  materialization. It is read by primary key without loading the Snapshot's
  Items, one lookup per Session, as the active Turn already needs. The Session
  row and the Snapshot are read separately, so while events are being
  materialized the watermark can briefly be ahead of `last_event_id`. A stream
  reconciliation discards the Snapshot, so the watermark can also drop back
  to `0` until the Items are rebuilt.
- `input_item_id` is `item_<turnId>_input`, the id the input Item is
  materialized with.

### 4.4 Session workspace

A bound Session's `workspace` now carries `context_revision` and `state` on
both surfaces. `context_revision` is the revision stored with the binding
since V7, which is `1` at creation. `state` is always `ready`: nothing can
change a context before W2, which adds `changing` and `recovery_blocked`. The
`WorkspaceContext` schemas stay `partial` until then. The WebShell client's
local type, which left the two fields out, now uses the generated one.

### 4.5 Request id

A filter that runs before tenant resolution assigns every request an id. It
uses the incoming `X-Request-Id` when that is visible ASCII of at most 128
characters, and a random UUID otherwise. On WebShell create, submit and cancel,
a `requestId` in the body replaces it once the handler runs. The contract
allows any string of up to 128 characters there, so a value that is unsafe to
echo in a header is ignored rather than rejected; a longer value fails
validation with `400`. A request that fails before the handler runs, such as
one without a tenant or with an invalid body, keeps the id the filter
assigned. The id is
returned in `X-Request-Id` on every response, written to `error.request_id`,
and placed in the log MDC, which the `logging.pattern.correlation` setting
prints. The WebShell client now sends a fresh `requestId` with each create,
including the empty bound create, and with each submit and cancel, instead of
reusing the idempotency key, which the contract's `RequestId` header forbids.
A retry therefore keeps its idempotency key and gets a new `requestId`.

### 4.6 Input type

The server accepts `input_text` and keeps accepting `text` from older clients.
Both normalize to the same Harness input, so request digests and idempotent
replays do not change. The WebShell client now sends `input_text`, which means
a new client needs a server that includes this change.

### 4.7 JSON errors on SSE routes

The new error probes showed that a client sending only
`Accept: text/event-stream`, which is what the WebShell client does, hit an
unhandled exception instead of the `404` or `400` envelope, because the JSON
envelope was not an acceptable representation; a servlet container turns that
into a 500. Error responses now preset `Content-Type: application/json`, so
content negotiation no longer drops them. Once a stream has started, the
response is committed and an error can no longer become an envelope, so the
handler leaves such a response alone rather than appending JSON to the stream.
A request whose `Accept` header excludes JSON gets `406` without a body, as it
did before the preset.

## 5. Contract test

- The scenario sends `input_text` and names the current and a foreign agent
  revision. It probes every status that this change declares, including a
  request without a tenant, an authenticated actor from another tenant, a
  Workspace selection without an actor and a disabled Harness. Request bodies
  are validated against the schema only for calls that expect success, because
  error probes send invalid bodies on purpose.
- The scenario reads a Session while its Turn is cancelling and while an
  archive waits for a retry, and checks `cancelling`, `input_item_id` and
  `archiving`. It reads a bound Session on both surfaces and checks
  `context_revision` `1` and `state` `ready`.
- Every response must carry `X-Request-Id`, an error's `request_id` must equal
  it, and a WebShell `requestId` must be echoed. A separate test sends a safe
  and an unsafe `X-Request-Id` and an unsafe body `requestId`.
- A request or response gap line may not name an `implemented` operation.
- A parity test creates one Session through the WebShell adapter and compares
  the public get and list with the WebShell get and query: identity, agent,
  status and last sequence must match. It also pins the revision, the
  capabilities, the replay floor and the snapshot watermark against the Items
  list, and checks that cross-tenant reads on both surfaces return
  `404 session_not_found`.
- The gap file shrinks from 57 lines (the 51 of D1 plus the 6 that W0d added)
  to 17; what remains is D3 and lifecycle work.

## 6. Compatibility

- Public Session and Turn responses, the Session workspace and error
  envelopes gain fields; nothing is removed.
- Status values the server already returned (`archived`, `archiving`,
  `deleting`, `cancelling`) are now part of the contract.
- The server accepts both input spellings. The WebShell client sends
  `input_text` and requires a server with this change.
- A WebShell `requestId` longer than 128 characters is now rejected with `400`,
  as the contract's schema requires.
- The generated `@qwen-code/web-shell` types now require `request_id` in the
  error envelope, and the client's create and submit requests take
  `input_text` blocks. The client's Session type requires `contextRevision`
  and `state` in a Session workspace.
- Flyway V13 adds a column with a default; no data is rewritten.

## 7. Validation

- The Managed Agent server's full test suite and Checkstyle pass, including the
  contract and parity tests.
- Mutations each fail the matching check: dropping the WebShell `requestId`
  echo, dropping `request_id` from the envelope, returning a different status
  on one surface, listing a gap for an `implemented` operation, and rejecting
  `input_text`.
- A retry that names the admitted revision replays the original Session after
  the setting changes; skipping the replay lookup makes that test fail.
- Before the JSON content-type fix, the SSE error probe failed with the
  exception the WebShell client would have seen as a 500.
- A unit test checks that an error on an already committed stream writes
  nothing.
- The MySQL upgrade test, which CI runs against MariaDB, reads revision `1`
  from a Session created before V13; the same upgrade was reproduced locally on
  H2 in MySQL mode.
- The revision tests cover both creation paths and read the stored revision
  back through a service configured with another one. A `406` test covers
  unacceptable media types.
- The WebShell typecheck, the managed component tests and the managed-progress
  e2e spec pass against the regenerated types. The W0d browser spec passes
  against `WorkspaceBrowserFixtureMain`, including a retry after a dropped
  create response.

## 8. Follow-up

- D3: the event-replay gaps that remain in the gap file.
- Lifecycle work: durable archive and delete, and whether archiving becomes
  `closed` plus `archived_at`.
- W2: context changes raise `context_revision`, report `changing` and
  `recovery_blocked`, and move the `WorkspaceContext` schemas out of
  `partial`.

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
