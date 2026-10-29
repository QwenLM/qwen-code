# Hosted cleanup debt survives its Harness generation

[English](2026-10-28-hosted-cleanup-debt-retry.md) | [简体中文](2026-10-28-hosted-cleanup-debt-retry.zh-CN.md)

## Problem

A Hosted Turn's terminal commit and its physical cleanup are separate facts.
When a Broker release, file-history marker or producer cleanup is refused, the
Harness commits `hosted.cleanup` as `owed` and keeps retrying while it is
alive. The debt is also projected durably as a `HOSTED_CLEANUP` owner in
`ma_resource_ref`, which keeps the original Runtime binding family from being
collected.

The packaged C3 arm reproduced what happens when that generation dies first:
the control plane had already projected the terminal, then the Harness was
killed after a refused release. No Turn was left to dispatch, so nothing ever
loaded the Session into the replacement generation. `SessionRecoveryService`
only rechecks cleanup for an operator-initiated route, and the replacement's
`/load` never arrived. The original Runtime stayed retained and the public
Turn stayed completed with cleanup owed. The same arm passed when the crash
landed before the terminal projection — then the ordinary Turn re-dispatch
took over and paid the debt — which made it timing-sensitive rather than
deterministic.

## Decision

The control plane owns an automatic retry for this debt, because it is the
only actor that survives the generation and already holds the durable
projection.

A periodic scan lists outstanding `HOSTED_CLEANUP` owners whose Session has no
active Turn, resolves the owed Turn from the cleanup descriptor, and issues
the existing prompt-scoped cleanup-only load through
`HarnessConnector.recheckRecoveryCleanup`. That load pays the original
Runtime identity and commits `confirmed` under the same cleanup ID. No new
route, protocol field, schema column or stored retry row is introduced: the
debt projection is the retry state. The store reads the dedicated
`managedJdbcTemplate` by qualifier, so an embedded deployment never scans the
host's business database. The scan is keyset-paginated: its cursor advances
over every raw row it reads, including unreadable descriptors, and wraps to the
start when a page comes up short, so a stuck prefix cannot starve the
recoverable debts behind it.

## Scope and boundaries

- Only Sessions with a Workspace are considered. The descriptor must be the
  Session's own inline `hosted-turn-cleanup/1` resource; a foreign or
  unreadable descriptor is logged and left owed, never deleted.
- A Session with an `ACCEPTED`, `RUNNING` or `CANCELLING` Turn is skipped. Its
  own driver still owns the debt, and a cleanup-only load there would compete
  with the live Turn for the Session.
- The scan never rewrites a Turn, the public stream or a terminal. A completed
  Turn stays completed.
- Cleanup-only loads cannot start a Turn, run a tool or reissue inference.
- The release still uses the descriptor's binding and generation. Unknown
  evidence keeps the debt and the retention fence; there is no fallback to a
  newer owner or to the primary Runtime.

## Retry and concurrency

The tick runs on `managedAgentScheduler`, the same named scheduler as every
other dispatch scan in the module; an unqualified `@Scheduled` would fall to a
shared one-thread pool that a blocking Git scan already owns.

An attempt that reports no actionable evidence, or that throws, is paced in
memory on an explicit ladder — 10s, 20s, 40s, 80s, 160s, then the 5-minute cap.
A pacing entry is dropped once it has been idle for twice the cap, which only
happens after its debt has been confirmed and left the projection; rotation
therefore never resets a still-owed debt's backoff. Whether a failed attempt
also drops the connector's cached attachment is decided by an explicit
whitelist that mirrors `HarnessPoolConnector`'s own reachability classification:
transport loss, a moved generation and an unknown mutation outcome, plus a
vanished reference (404) and a 5xx that may front a dead daemon. Those mean the
cached generation is unreachable, so the next attempt performs its own cold
cleanup load. A named refusal — a declined load
(`HostedHarnessRecoveryDeclinedException`), `harness_pool_unavailable`, or a 4xx
— is not staleness and only backs off: evicting that attachment would churn a
Session whose Turn is still running. At most one debt per Session is attempted
per tick.

Two control planes may scan the same debt. The cleanup load is idempotent: a
concurrent attachment is refused by the Harness while live work is present,
the loser backs off, and a confirmed cleanup removes the projection so the
other scan observes nothing. A Session's Turn ownership is still assumed to
have one active control plane, as in the rest of Step 3.

## Validation

- `HostedCleanupDebtStoreTest` runs against the real schema in H2 and pins the
  listing rules: own Session, no active Turn, inline descriptor, Workspace
  present; foreign and unreadable descriptors are not returned. It also pins
  the cursor: a page of twenty unreadable descriptors returns no debt yet is
  not exhausted, and advancing the cursor reaches the valid debt behind them.
- `HostedCleanupRetryCoordinatorTest` pins the retry path, per-Session pacing,
  one-debt-per-tick, the cursor advancing on a full page and wrapping on a
  short one, stale-attachment eviction (and keeping the attachment on a named
  refusal) and the unavailable-Harness no-op.
- `ManagedAgentEmbeddingTest` pins that the store binds the dedicated
  `managedJdbcTemplate`: with the host business database present, the scan
  reads the managed schema instead of failing with `ma_resource_ref` not
  found. Removing the qualifier reproduces that failure.
- The packaged C3 arm (`--g3-fault cleanup-failed`) refuses the first release,
  waits until the control plane projected the terminal, kills that generation,
  starts a replacement, and requires the replacement to release the original
  identity through the scan: `releaseFailures=1`, `releaseSuccesses=1`, one
  `confirmed` event, no `HOSTED_CLEANUP` debt left, the original Runtime
  `RELEASED`, one execution, one file effect, the original terminal and the
  recovered answer. Disabling the scan makes the arm time out at
  `Post-fault cleanup retry reached the replacement`; the replacement is
  healthy and still receives no load.

## Compatibility

There is no schema, protocol, route or configuration change. The existing
operator recheck route keeps working and is the fallback for profiles the
cleanup load refuses (Hook, MCP, or a Harness without `recovery-cleanup/1`).
Those Sessions keep their debt and their retention fence until an operator or
a later compatible generation pays it.
