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
debt projection is the retry state.

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

An attempt that reports no actionable evidence, or that throws, is paced in
memory: 10 seconds for the first retry, doubling to a 5-minute cap, reset when
the debt disappears. The pacing map is bounded by the current scan page. A
failed attempt also drops the connector's cached attachment, so the next one
performs its own cold cleanup load instead of reusing a reference to the dead
generation. At most one debt per Session is attempted per tick.

Two control planes may scan the same debt. The cleanup load is idempotent: a
concurrent attachment is refused by the Harness while live work is present,
the loser backs off, and a confirmed cleanup removes the projection so the
other scan observes nothing. A Session's Turn ownership is still assumed to
have one active control plane, as in the rest of Step 3.

## Validation

- `HostedCleanupDebtStoreTest` runs against the real schema in H2 and pins the
  listing rules: own Session, no active Turn, inline descriptor, Workspace
  present; foreign and unreadable descriptors are not returned.
- `HostedCleanupRetryCoordinatorTest` pins the retry path, per-Session pacing,
  one-debt-per-tick, stale-attachment eviction and the unavailable-Harness
  no-op.
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
