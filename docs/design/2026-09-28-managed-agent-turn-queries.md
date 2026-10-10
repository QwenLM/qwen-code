# Managed Agent Turn Queries (Stage D5)

[English](2026-09-28-managed-agent-turn-queries.md) | [简体中文](2026-09-28-managed-agent-turn-queries.zh-CN.md)

Status: implemented in this change
Date: 2026-09-28
Issue: [#12867](https://github.com/QwenLM/qwen-code/issues/12867), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
Builds on: [API contract (D1)](2026-09-27-managed-agent-api-contract.md), [Session query (D2)](2026-09-27-managed-agent-session-query.md) and [durable lifecycle (D4)](2026-09-28-managed-agent-durable-lifecycle.md)

## 1. Problem

Every Turn of a Session is stored in `managed_agent_turn`, but the public API
shows only the Session's `active_turn`. The contract's Turn list and detail,
`listTurns` and `getTurn`, are `planned` in contract v1.19, so a client cannot
page through a Session's earlier Turns or read one by its ID.

#12867 defines D5 as `GET turns` and `GET turns/{turnId}`, a read model over
`managed_agent_turn` that follows the contract's cursor and limit rules. Its
exit check is that both routes are `implemented` and that cross-tenant reads
return `404`.

## 2. Goals

- Serve both routes on the public surface with the `PublicTurn` view that a
  Session's `active_turn` already uses.
- Page with the contract's list rules: an opaque cursor, a limit from 1 to 100
  with a default of 20, and `has_more` and `next_cursor`.
- Apply the checks that the other Session reads apply.

## 3. Non-goals

- The durable admission fields of `PublicTurn` (`operation_id`,
  `admission_stage` and `delivery_state`). They belong to D7 and stay
  `planned`.
- A WebShell Turn read. The contract defines none; the WebShell reads Turns
  through its Session and transcript routes.
- Role checks beyond read access, which wait for Q4 in #12867. Reading a
  Turn needs only what reading its Session needs, so within a tenant any actor
  reads the Turns of a Session that no Workspace binds, as it reads the
  Session, its events and its Items. Section 10 of the contract and section 6
  of the contract closure ask for more before production enablement; the role
  source that Q4 decides will cover these reads with the others.
- The `recovery_blocked` status. The contract's enum lists it, but the server
  never stores it; a Turn whose recovery is blocked fails with an error code.
- An index for Turn pages (4.4).

## 4. Decisions

### 4.1 Contract v1.20

- `listTurns` and `getTurn` move to `implemented`. They declare `400` for
  the validation errors below and a missing tenant, and `403` for the tenant
  filter's `actor_scope_mismatch`, as `getSession` does. Their descriptions
  state the order, the cursor and the error codes.
- The three D7 fields of `PublicTurn` stay `planned`. The known-gap file is
  unchanged, and the generated WebShell types do not change, because the
  generator emits only the types that WebShell routes use.

### 4.2 Order, cursor and limit

A page lists Turns newest first: by creation time in milliseconds, then by
Turn ID, both descending. That is the order in which the server already picks
a Session's latest Turn, and the order of the Task list. `created_at` shows the
creation time in whole seconds, so two Turns created within one second can
list in either ID order.

Neither key changes after admission, so pages are keyset pages: a page never
repeats or skips a Turn that existed when the first page was read. A Turn
admitted while a client pages normally sorts before the cursor and appears on
a new first page. It appears on a later page only when its creation time is
not after the cursor's: when the clock of the server that admitted it lags
behind, or when it was created in the same millisecond as the cursor's Turn
and has a smaller ID.

The cursor is the base64url form of `createdAt:turnId` for the last Turn of a
page, as the Task cursor is. The server accepts only cursors of that form,
with or without base64 padding: a creation time in decimal without leading
zeros that fits in a long, and a Turn ID of 1 to 64 characters from `A-Z`,
`a-z`, `0-9`, `_` and `-`. Anything else answers `400 invalid_cursor`, and an
empty or blank cursor reads the first page, as for the Session list; the Task
list rejects a blank cursor and checks the Session before the request. A
well-formed cursor positions a page even when this server never issued it for
this Session, for example one taken from another Session: like the Session and
Task cursors, a cursor is not bound to a Session. It only positions by time and
ID and reveals nothing, and every page checks the Session again, so a cursor
never outlives read access.

The limit is 1 to 100 with a default of 20. A 32-bit integer outside that range
answers `400 invalid_limit`, and a value that is not a 32-bit integer
`400 invalid_request`, as for the other lists. Like them, the limit goes
through Spring's integer conversion, which also accepts a sign, surrounding
spaces and hexadecimal notation. `next_cursor` is `null` on the last page.

### 4.3 Fields and checks

- A Turn reads as a Session's `active_turn` does: `id`, `object` `agent.turn`,
  `session_id`, `input_item_id` (`item_<turnId>_input`), `status` in lower
  case (`accepted`, `running`, `cancelling`, `completed`, `failed` or
  `cancelled`), `created_at` and `completed_at` in seconds, and `error_code`.
- Reads leave the input out. The store selects only the columns the view
  needs and never parses a Turn's input, so a long input does not weigh on a
  page, and a Turn whose stored input cannot be parsed still reads.
- A read answers `404 session_not_found` for an unknown Session, another
  tenant's Session, a deleted Session, whose tombstone keeps only its
  operations readable (D4), and a Workspace-bound Session that the actor cannot
  read. The Turns of a closed or archived Session stay readable.
- `getTurn` answers `404 turn_not_found` when the Session has no such Turn,
  also when another Session has it, and `400 invalid_request` for a Turn ID
  longer than the path schema's 64 characters, counted as characters rather
  than UTF-16 units. The binary collation ignores trailing spaces, so the store
  compares the Turn ID it found with the one requested: an ID that differs only
  by trailing spaces finds nothing.
- The tenant filter answers `403 actor_scope_mismatch` and `400` without a
  tenant, as on every route.
- A request is validated before the Session is checked: a malformed request
  gets `400` whatever the Session, and a well-formed one gets `404` for a
  Session it cannot read.

### 4.4 No index

The primary key `(tenant_id, session_id, turn_id)` narrows a page to one
Session's rows, and the database sorts that Session's Turns by creation time,
as the existing latest-Turn lookup already does. An index on
`(tenant_id, session_id, created_at, turn_id)` would need a Flyway migration,
which open pull requests already contend for; it can come with a later
migration once Sessions hold enough Turns for the sort to matter.

## 5. Tests

- **Contract test.** A new Session runs one Turn, and a failed Turn is written
  after it. The scenario pages through both, reads one back and compares it
  with its list entry, and probes `400` (cursor, limit, missing tenant,
  overlong ID), `403` and `404` (another tenant, unknown Turn) on the two
  routes. Every response validates against the schema.
- **Turn query test.** Six scenarios: newest-first paging at every limit from
  1 to 6 over Turns whose oldest has the largest ID, so that an order by ID
  alone differs and page boundaries also fall between two Turns created at the
  same time, with `has_more` and `next_cursor` at each boundary, the default
  limit of 20 over 25 Turns, and an empty and a blank cursor; every stored
  status with its outcome fields, each list entry equal to the Turn's detail; a
  Turn whose stored input is not JSON; limit and cursor validation, also on an
  unknown Session to show that a request is validated first, including limits
  that are not 32-bit integers, an overflowing creation time, a cursor beyond
  every Turn, one at the oldest Turn, one with base64 padding and one with a
  64-character Turn ID; the Session checks (another Session's
  Turn, 64- and 65-character IDs, 33 and 65 characters outside the Basic
  Multilingual Plane, an ID with a trailing space, an unknown Session, another
  tenant, an archived and a deleted Session); and a bound Session read with and
  without a read grant.
- **MySQL test.** Five Turns, the oldest with the largest ID and two created
  at the same time with IDs that differ only by case, are paged two at a time
  on MariaDB and MySQL. The order follows the binary collation, a lookup
  matches the ID's case exactly, an ID with trailing spaces finds nothing
  although the collation matches it in SQL, and another tenant's name finds
  nothing.

## 6. Compatibility

- Two new routes; no existing response changes.
- Contract v1.20.0. No migration, and the generated WebShell types are
  unchanged.

## 7. Validation

- The Managed Agent server's `mvn test` (176 tests) and Checkstyle pass.
- `ManagedAgentMySqlIT` passes 14/14 against `mariadb:10.11.18`, the image CI
  uses, and against `mysql:8.4`. With the exact Turn ID comparison removed it
  fails on both.
- Regenerating the managed API types leaves them unchanged.
- Each of 24 mutations fails a test: an oldest-first order; no Turn ID
  tie-break; a cursor that repeats its Turn or skips a Turn created at the same
  time; a keyset that ignores creation time; a full last page that reports
  more; an unchecked limit; cursors with leading zeros; an overflowing creation
  time answered with another error; the list or the detail skipping the
  Session check, or checking it before the request; a default limit of 100;
  the detail ignoring the Session or reading the input; an overlong ID looked
  up; an ID length counted in UTF-16 units; a cursor on the last page; an empty
  or a blank cursor rejected; a cursor rejected for its padding or for a Turn
  ID longer than the server issues; and a cursor with such an ID ignored.

## 8. Follow-up

- D7: the durable admission fields of a Turn.
- An index for Turn pages, with a later migration, if Sessions grow long.
- A WebShell Turn read, if a WebShell view needs one.
- Role checks once Q4 is answered; reads need only read access.
- One keyset cursor codec for the Session, Task and Turn lists, at the latest
  before another resource, such as the planned Artifact or Action lists, adds a
  fourth copy; the Workspace list already pages with a cursor of its own. The
  three encode alike but decode differently: the Session list accepts any long
  and any non-empty ID, and the Task list rejects a blank cursor and checks the
  Session first. A shared codec has to decide on purpose whether the Session
  list keeps its lenient grammar, which it ships although the contract does not
  describe it, and whether the Task list reads a blank cursor as the first page,
  as the Session and Turn lists do, and validates a request before it checks
  the Session, as the Turn list does.
- Exact path IDs on every Session route. The binary collation also ignores
  trailing spaces in a Session ID, which then reaches the same Session, and
  Spring removes `;` path parameters from every path segment before binding
  it, so `turn_x;v=1` reads `turn_x`. Nothing leaks, because the tenant and the
  read grant are checked on the Session found and a response names the real
  IDs.
