# Shared helpers for the hosted gate drivers and probes (#14147)

[English](2026-10-17-hosted-gate-shared-helpers.md) | [简体中文](2026-10-17-hosted-gate-shared-helpers.zh-CN.md)

## Problem statement

The hosted fault-gate lanes (FG6e, FG7, FG8, FG9, FG10a) each brought their
own driver (`integration-tests/helpers/hosted-*-driver.ts`), probe
(`Hosted*Probe.java`), and IT class. Review round 1 of the FG8 PR (#14120)
flagged five spots where the new gate class added the Nth private copy of an
existing mechanism; the per-class private copy was the lane's deliberate
convention up to that point, so the extraction was deferred out of the FG8 PR
to keep its diff scoped. #14147 tracks the sweep. Since then FG10a landed one
more driver/probe/IT set, adding fresh copies of the same patterns — including
one that diverges from the original in a way that matters (see item 6).

Private copies drift. The concrete cost so far: FG10a's probe re-implemented
the extension-record read without the `session_scope_key` index-leading
predicate that FG8's probe comment documents as load-bearing (the unindexed
tenant+session-only form scans every byte the lane has written). Each new
letter makes the next extraction more expensive.

## Current state, measured

The full duplication map, verified at `main` = `e847c14496`:

| #   | Mechanism                                                                          | Copies                                                                                                                                                                                                                                    | Divergences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | SSE `Observer` class + event projection (TS)                                       | `hosted-sse-gap-driver.ts` (FG6e: Observer at :81, inline projection map at :339) ↔ `hosted-monitor-run-fault-driver.ts` (FG8: Observer at :44, `projection()` at :1002)                                                                 | The SSE block-parsing loop and the row→event field mapping are byte-identical. FG8's Observer takes `(surface, sessionId)` via constructor and a 300 s timeout, and adds `turnIdOf` (dual-surface snake_case/camelCase) and `terminalOfOtherTurn()`; FG6e's reads module-level config, uses a 45 s timeout, and has `through()` instead.                                                                                                                                                                                                   |
| 2   | `authentication(tenant)` servlet filter (Java)                                     | `HostedSseGapProbe` ↔ `HostedMonitorRunProbe`                                                                                                                                                                                            | Verbatim except the fixture name (`fg6e-fixture` / `fg8-fixture`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3   | Probe SSE relay loop (Java)                                                        | `HostedSseGapProbe.relay` ↔ `HostedMonitorRunProbe.relay`                                                                                                                                                                                | Identical: client builder values (fixture token, capability digest), boot-id capability check, `parseSession` reflection bridge, `streamEvents(lastEventId, eventEpoch)`, project-then-`appendPublicEventIfAbsent`, source key `bootId:epoch:eventId`. Divergent loop control: FG6e pins one `promptId`, holds the terminal event on a latch before appending it, and breaks on terminal; FG8 reads the turn per event, never breaks, and stops via a stop latch plus stream close (swallowing the close-induced `IllegalStateException`). |
| 4   | Tool-publication tuning block + OSS stub (Java)                                    | `HostedPublicWorkspaceIT.startSpring` (:1310–1325 + :1349–1381) ↔ `HostedMonitorRunFaultGatesIT.runLetter` (:175–191 + :237–255)                                                                                                         | 16 property lines verbatim except `oss-bucket` and `execution-bytes` (1 MiB vs 1 GiB). The OSS Mockito stub's supported method set differs: the publication IT's stub serves `putObject`/`getObject` because it really publishes; FG8's serves only `getBucketVersioning`/`toString` and throws on anything else.                                                                                                                                                                                                                          |
| 5   | `quote()` POSIX single-quote escape (TS)                                           | `hosted-shell-output-driver.ts:284`, `hosted-provider-control-driver.ts:182`, `hosted-workspace-tool-turn-driver.ts:297`, `hosted-monitor-run-fault-driver.ts:325`                                                                        | Byte-identical semantics under three formatting variants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | Extension-record JDBC read (Java) — **not in the issue's list, landed with FG10a** | `HostedMonitorRunProbe.extensionRecords` (:241), `HostedWorkflowProbe.extensionRecords` (:83), and the single-record variants `HostedMonitorRunFaultGatesIT.extensionRecord` (:1531), `HostedWorkflowFaultGatesIT.extensionRecord` (:351) | FG10a's copies dropped the `session_scope_key`-led predicate FG8's comment documents as the performance-critical shape.                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Goals

- Extract one shared home per mechanism; move every carrier of items 1–5 onto
  it in the same PR (a half-extraction is worse than the copies, per the
  issue).
- Item 6 rides along: it has four carriers, two of them in files this PR
  already touches, and the extraction fixes FG10a's dropped index prefix. This
  is the one addition beyond the issue's named five; everything else observed
  (the drivers' `diagnose()`, the store-proxy boilerplate) stays private — two
  carriers with real divergences have not earned a shared abstraction.
- Zero behavior change: every gate must pass for the same reason it passes
  today. The sweep is semantics-preserving by construction, and the full
  `hosted-harness-mysql` lane is the evidence.

## Non-goals

- No production code changes.
- No new gates, letters, or cases; no assertion changes.
- No deduplication of the drivers' fault arms, case choreography, or per-letter
  fixtures — those are the letters' own substance.
- FG10b/c/e/f remain sequenced after this refactor (per #14165).

## Proposed changes

### TypeScript: two new single-concern helper modules

Following the established precedent (`hosted-harness-process.ts`,
`hosted-relay-headers.ts` are single-concern shared modules):

- `integration-tests/helpers/hosted-sse-observer.ts` — the `Observer` class
  (SSE fetch, block parsing, `frames`, `through`, `terminalOfOtherTurn`,
  `turnIdOf`, `close`) with constructor-injected `surface`, `sessionId`,
  `storeUrl`, `tenantId`, and timeout; plus `projectEvents(rows, surface)`
  carrying the FG6e/FG8 field mapping verbatim. FG6e's driver stops reading
  module-level config for the observer; both drivers import the class.
- `integration-tests/helpers/hosted-shell-quote.ts` — `quotePosix(value)`.
  Four call sites swap their local const for the import.

### Java: one package-private test-support class

`com.alibaba.qwen.code.managedagent.HostedGateTestSupport` (final class,
static methods, test scope), joining the existing test-support precedent
(`CoordinatorTestSupport`):

- `authentication(String tenant, String fixtureName)` — the
  `FilterRegistrationBean` factory; both probes delegate, the fixture name is
  the only parameter.
- The relay loop's shared mechanics: client construction with the pinned
  fixture token and capability digest, the boot-id capability check, the
  `parseSession` reflection bridge, and the stream → project → append walk
  with the `bootId:epoch:eventId` source key. The per-letter loop control
  stays in the probes behind a small policy seam with exactly three hooks —
  which turn an event belongs to (FG6e's fixed `promptId` vs FG8's per-event
  prompt id), a pre-append hook that may block (FG6e's terminal latch), and a
  terminal-stop decision (FG6e breaks on terminal; FG8 never does and stops on
  stream close). FG8's close-induced `IllegalStateException` swallow stays in
  FG8's probe.
- `toolPublicationArgs(int servicePort, String bucket, long executionBytes)` —
  the 16 property lines.
- `stubPublicationOss(context, fixtureName)` — the union of both stubs'
  method sets (`getBucketVersioning`, `putObject` with the
  FileAlreadyExists semantics, `getObject` with NoSuchKey, `toString`),
  default-throwing on anything else and naming the fixture. FG8's strictness
  is preserved: it never calls `putObject`/`getObject`, and the
  default-throw still fires on any other method.
- `extensionRecords(jdbc, tenant, sessionId, domain)` /
  `extensionRecord(...)` — the record+resource JDBC read, standardized on the
  `session_scope_key`-led query shape FG8's comment documents; FG10a's probe
  and IT move onto it, restoring the index-leading predicate.

## Files affected

- New: `integration-tests/helpers/hosted-sse-observer.ts`,
  `integration-tests/helpers/hosted-shell-quote.ts`,
  `packages/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedGateTestSupport.java`.
- TS carriers updated in place: `hosted-sse-gap-driver.ts`,
  `hosted-monitor-run-fault-driver.ts`, `hosted-shell-output-driver.ts`,
  `hosted-provider-control-driver.ts`, `hosted-workspace-tool-turn-driver.ts`.
- Java carriers updated in place: `HostedSseGapProbe.java`,
  `HostedMonitorRunProbe.java`, `HostedWorkflowProbe.java`,
  `HostedPublicWorkspaceIT.java`, `HostedMonitorRunFaultGatesIT.java`,
  `HostedWorkflowFaultGatesIT.java`, `HostedWorkspaceToolTurnIT.java`.

## Risks

- The sweep touches settled gate files, which reddens every hosted lane if a
  transplant slips. Mitigation is the issue's own acceptance bar: one full
  `hosted-harness-mysql` lane run locally as evidence, not per-class spot
  checks; plus the CI meta-pins (`hosted-process-ci.test.js`,
  `hosted-relay-headers.test.ts`), checkstyle, and ESLint.
- The FG6e relay's terminal latch holds the event _before_ the append — the
  ordering is the test's point, so the policy seam must keep the pre-append
  hook blocking-capable.

## Validation plan

1. Baseline: `main` is green on the lane (CI runs it on the Java workflow);
   record the baseline.
2. Post-change evidence: full `hosted-harness-mysql` lane locally
   (`mvn -Phosted-harness-mysql failsafe:integration-test failsafe:verify`
   against a throw-away MySQL), every class green.
3. Static pins: `scripts/tests/hosted-process-ci.test.js` and
   `hosted-relay-headers.test.ts` via vitest, `checkstyle:check`, ESLint on
   the touched TS files, and `npm run build` for the TypeScript side.

## Acceptance criteria

- Every copy of items 1–5 lives in exactly one place; all carriers moved in
  the same diff; no carrier keeps a private variant.
- Item 6's read goes through the shared, index-leading query in all four
  carriers.
- The full hosted lane passes unchanged; CI meta-pins, checkstyle, and lint
  stay green; zero production files touched.

## Open questions

None currently — item 6's inclusion is argued above; if review disagrees it
drops out without affecting items 1–5.
