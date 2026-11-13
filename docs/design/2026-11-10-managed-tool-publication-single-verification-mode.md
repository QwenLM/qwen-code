# Managed tool publication single verification mode

[English](2026-11-10-managed-tool-publication-single-verification-mode.md) | [简体中文](2026-11-10-managed-tool-publication-single-verification-mode.zh-CN.md)

## Status and scope

Implemented for local verification; acceptance still requires the full CI
gates. This change narrows the
[asynchronous verification design](2026-10-07-managed-tool-publication-async-verification.md)
to its asynchronous mode under the
[first-release contract](2026-10-23-managed-first-release-contract.md): one
matching Server, Broker, Harness, WebShell and Managed SDK build on fresh
state, with no migration of development databases.

## Problem

Issue [#13242](https://github.com/QwenLM/qwen-code/issues/13242) moved
publication readback and stream scans to a durable verifier, but kept the
synchronous path for rolling upgrades. An operation is admitted
asynchronously only when
`qwen.managed-agent.tool-publication.async-verification-enabled` is `true`
(default `false`) and the request carries `X-Qwen-Tool-Publication-Async: 1`.

- The only producer, the CLI remote Shell publisher, always sends the header.
- No deployment, Spring profile, CI job or E2E test enables the flag. Every
  deployment therefore still verifies on the HTTP request thread, which #13242
  set out to remove, while the verifier runs only in unit tests.
- Both modes share the producer store methods. A thread-local verifier
  context, an `asynchronous` argument, a `preparing` argument and the
  persisted `ma_operation.execution_mode` select between them; each producer
  route has a second overload; mode stickiness, "legacy claim" retries and
  rollback drainage exist only for mixed versions.

The first-release contract removed comparable mixed-version paths, but not
this one.

## Decisions

1. **Asynchronous admission is the only producer mode.** Segment, resource,
   seal, prefix and finish requests validate their input, claim the slot and
   operation, persist the verification inputs (object PUT or inline bytes),
   mark the operation ready and return HTTP 202 with `state: PENDING`. A
   replay returns the current status: `SUCCEEDED` with `receipt`, `FAILED`
   with `error`, or `PENDING`, `RETRYABLE` or `EXPIRED`. The verifier performs
   all readback, scans and finish validation and installs results. The state
   table, deadlines, epochs, leases, quarantine fences, recovery and quota
   accounting keep their current asynchronous behavior.
2. **Remove the selection inputs.** Remove the
   `async-verification-enabled` setting with its environment variable and
   settings accessor, the `X-Qwen-Tool-Publication-Async` header, the
   per-route mode overloads, the synchronous claim/readback/install path for
   uploads, the `preparing` argument and every check that distinguishes the
   two modes. Remove `ma_operation.execution_mode`, its CHECK constraint and
   its column in `idx_ma_operation_verification` by editing the V1 baseline in
   place. `verification-concurrency` remains.
3. **Keep the verifier context, not the mode switch.** The thread-local still
   carries the accepted operation's authorization and epoch into shared read
   helpers, so quarantine writes and heartbeats remain fenced to the live
   attempt. Seal, prefix and finish dispatch explicitly: without a verifier
   context they admit the request; inside one they run its verification. The
   verifier's heartbeat always renews the next attempt time, because it only
   runs for ready operations.
4. **The client requires a state.** Every producer response must carry
   `state`; the branch that accepted a direct receipt is removed, so a
   stateless answer fails as an unexpected state. After `PENDING`, polls start
   at 25 ms and double up to the existing 250 ms interval, so operations that
   verify within milliseconds do not each wait a full interval. The serial
   queue, 30-minute observation deadline, three recoveries and other retry
   delays are unchanged.
5. **Replay follows the asynchronous contract.** An exact success replay
   returns its historical receipt without object I/O, where the synchronous
   path re-read the object. Reads, finish, receipt verification and ACK still
   check current bytes.

## Compatibility and constraints

- Deployments with tool publication enabled now verify asynchronously.
  Spring ignores the removed property, so a leftover environment variable has
  no effect.
- Only matching producer builds are supported. Released CLI builds already
  send the header and handle HTTP 202.
- The V1 baseline changes, so development catalogs must be recreated. Server
  and Broker still validate the same final columns, indexes and constraints.
- Verification failures are reported as the safe `{status, code}` pair rather
  than the synchronous exception message.

## Risks

- The verifier becomes the production path for the first time. Its H2 and
  MySQL suites remain; tests that drove the synchronous path now admit and
  drain the verifier, so their assertions cover the asynchronous path. Hosted
  CI profiles exercise it end to end.
- Shorter initial polls add at most four status reads per operation before
  reaching 250 ms; each is one read-only query.
- Completion latency now includes verifier pickup and one poll. Pickup is
  immediate after commit; the 25 ms initial poll bounds the added wait for
  fast operations.

## Validation

- Focused Java tests: the asynchronous verification suite, publication store,
  controller, configuration, acknowledgement, collector, query-budget, schema
  and CSI inventory tests, plus Checkstyle.
- Real MySQL 8.4: the asynchronous verification suite and selected publication
  MySQL tests.
- CLI: the remote Shell publication tests, root build and typecheck.
- The configuration reference is regenerated and its `--check` passes.
- CI: the full unit/H2 suite with SpotBugs, `mysql-integration` and the
  Hosted profiles.

Tests that only pinned the removed combinations (flag and header matrix,
mode stickiness, drainage with admission disabled) are removed with those
behaviors. Client tests answer every producer request with a stated status,
and query-budget and inventory pins follow the removed column and the extra
verifier authorizations.

## Acceptance criteria

- No production reference remains to the removed setting, the header,
  `execution_mode` or a synchronous producer path.
- Every producer route returns a stated result, and producer bytes are read
  back or scanned only by the verifier.
- State, recovery, quarantine and quota behavior pinned by the asynchronous
  suite is preserved on H2 and MySQL.
- Local results, skipped checks and pending CI gates are reported separately.
