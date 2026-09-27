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
- Durable archive and delete operations (lifecycle work) and the Session
  workspace's `context_revision` and `state` (workspace-context work).
- AgentDefinition. Only one agent revision exists until it lands.

## 4. Decisions

### 4.1 Contract v1.14

- `PublicSession.status` gains `archived`, the value the server has always
  returned for an archived Session. The planned `archived_at` field is
  unchanged. If the lifecycle work later represents archiving as `closed` plus
  `archived_at`, that is a contract change of its own.
- `ErrorEnvelope.error.request_id` becomes required, as section 3 of the
  contract already states.
- The error responses the server returns are declared: `400` on the event
  query, the Items list, and the WebShell session query and get; `400` and
  `404` on the WebShell transcript, event stream, submit and cancel.
- The six Session routes above move to `implemented`.

### 4.2 `agent_revision`

The revision comes from the new setting `qwen.managed-agent.agent-revision`
(environment variable `QWEN_MANAGED_AGENT_REVISION`, default `1`). It is
written to the Session row at admission, so a later change of the setting does
not rewrite existing Sessions. Flyway V13 adds the column and gives existing
rows `1`.

A create request may name `agent_revision`. A value other than the current
revision is rejected with `400 unsupported_feature`. Because the only
acceptable explicit value equals the one an omitted field resolves to, the
field is not part of the idempotency digest; that changes when AgentDefinition
allows several revisions.

### 4.3 Capabilities and watermarks

- `capabilities` reports `items: true` and `snapshots`, `resync` and
  `artifacts` as `false`. Snapshot reset and resync arrive with D3, and the
  contract forbids declaring them before the server can honour them. The
  planned optional flags are omitted; the schema defaults them to `false`.
- `replay_floor_sequence` is `0`. Events are never pruned yet; D3 persists the
  floor.
- `snapshot_through_sequence` is the covered sequence of the Session's
  Snapshot, the same value the Items list returns, or `0` before the first
  materialization. It is read without loading the Snapshot's Items.
- `input_item_id` is `item_<turnId>_input`, the id the input Item is
  materialized with.

### 4.4 Request id

A filter that runs before tenant resolution assigns every request an id. It
uses the incoming `X-Request-Id` when that is visible ASCII of at most 128
characters, and a random UUID otherwise. On WebShell create, submit and cancel,
a `requestId` in the body replaces it. The contract allows any string of up to
128 characters there, so a value that is unsafe to echo in a header is ignored
rather than rejected. The id is returned in `X-Request-Id` on every response,
written to `error.request_id`, and placed in the log MDC, which the
`logging.pattern.correlation` setting prints.

### 4.5 Input type

The server accepts `input_text` and keeps accepting `text` from older clients.
Both normalize to the same Harness input, so request digests and idempotent
replays do not change. The WebShell client now sends `input_text`, which means
a new client needs a server that includes this change.

### 4.6 JSON errors on SSE routes

The new error probes showed that a client sending only
`Accept: text/event-stream`, which is what the WebShell client does, received a
500 instead of the `404` or `400` envelope, because the JSON envelope was not an
acceptable representation. Error responses now preset
`Content-Type: application/json`, so content negotiation no longer drops them.

## 5. Contract test

- The scenario sends `input_text`, names the current and a foreign agent
  revision, and probes every newly declared error status. Request bodies are
  validated against the schema only for calls that expect success, because
  error probes send invalid bodies on purpose.
- Every response must carry `X-Request-Id`, an error's `request_id` must equal
  it, and a WebShell `requestId` must be echoed.
- A gap line may not name an `implemented` operation.
- A parity test creates one Session through the WebShell adapter and compares
  the public get and list with the WebShell get and query: identity, agent,
  status and last sequence must match. Cross-tenant reads on both surfaces
  return `404 session_not_found`.
- The gap file shrinks from 51 to 21 lines; what remains is D3, lifecycle and
  workspace-context work.

## 6. Compatibility

- Public Session and Turn responses and error envelopes gain fields; nothing
  is removed.
- Archived Sessions keep `status: "archived"`, now part of the contract.
- The server accepts both input spellings. The WebShell client sends
  `input_text` and requires a server with this change.
- The generated `@qwen-code/web-shell` types now require `request_id` in the
  error envelope, and the client's create and submit requests take
  `input_text` blocks.
- Flyway V13 adds a column with a default; no data is rewritten.

## 7. Validation

- The Managed Agent server's full test suite and Checkstyle pass, including the
  contract and parity tests.
- Mutations each fail the matching check: dropping the WebShell `requestId`
  echo, dropping `request_id` from the envelope, returning a different status
  on one surface, listing a gap for an `implemented` operation, and rejecting
  `input_text`.
- Before the JSON content-type fix, the SSE error probe failed with the
  exception the WebShell client would have seen as a 500.
- The WebShell typecheck, the managed component tests and the managed-progress
  e2e spec pass against the regenerated types.

## 8. Follow-up

- D3: the event-replay gaps that remain in the gap file.
- Lifecycle work: durable archive and delete, and whether archiving becomes
  `closed` plus `archived_at`.
- Workspace-context work: `context_revision` and `state` on the Session
  workspace, and a read of a bound Session in the scenario.
