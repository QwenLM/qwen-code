# Runtime Broker hardening: atomic session release, isolated renewals, listener posture

[English](2026-10-02-runtime-broker-hardening.md) | [简体中文](2026-10-02-runtime-broker-hardening.zh-CN.md)

Status: implemented in `packages/sdk-java/runtime-broker` (PR #13214, issue #13183).

## Problem

A code audit of the Runtime Broker found three high-risk defects. First, the session release decision and the no-active-execution check ran in separate transactions guarded only by a process-local lock: with two Broker processes sharing one database, an execution could be admitted while its session was marked `RELEASED`. Second, every lease renewal ran on one scheduled thread shared with retries, deadline fences, and polling, all with synchronous JDBC: a 1–2 s storage stall queued renewals past their lease and fenced healthy bindings. Third, the broker's HTTP face served one global Bearer token over plaintext HTTP and accepted non-loopback listen addresses.

## Decisions

**One release transaction.** `RuntimeBindingRepository.beginSessionRelease` moves the no-active-execution check into the RELEASING transition's own transaction. The transition locks the Session row `FOR UPDATE` — the same lock `admitExecution` takes — so the two paths serialize per session row across processes. A release with an active execution fails `runtime_session_busy`; an admission that loses the row to a RELEASING session fails `runtime_admission_closed`. The in-process pre-check keeps only the free `hasActiveControl` test; the database round trip it used to pay is gone because the transition's own check answers the same 409 with the same code and message.

**Renewal pool.** Renewals (binding claims and dispatch claims) run on a dedicated two-thread `ScheduledThreadPoolExecutor`; coordination work (retries, fences, polls) keeps the single-thread scheduler. One stalled renewal blocks at most one pool thread, and the renewal instance monitors already serialize ticks per claim. v3 result polling backs off from 100 ms, doubling to a 5 s cap, and its window is configurable (`v3ResultWindow`, minimum 1 s — a suffix-less config value binds as milliseconds, which the constructor now refuses). Automatic observation of an UNKNOWN execution reuses the freshest lookup for a 1 s cooldown instead of fanning every poll through to the worker; a cached lookup whose own record already settled is replayed whole, never paired with a caller's stale snapshot. Explicit `reconcile=true` and mutation responses (`:start`, `:cancel`) never serve the cache.

**Loopback by default.** `RuntimeBrokerHttpServer` refuses a non-loopback or unresolved bind address unless the deployment opts in (`allow-non-loopback` / `QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK`), because the face has no per-tenant authorization over plaintext HTTP.

**Bounded-force shutdown.** A released non-durable worker gets `destroy()`, a bounded 5 s grace, then `destroyForcibly()`; the same applies at `close()` and at JVM exit for non-durable provisioners. Workers are tracked in a `starting` set from spawn (registered under a `lifecycle` lock), so an exit during the ready handshake cannot strand one.

**Draining reclaim.** A LOST reclaim loops the bounded 100-row recovery passes until the generation drains, capped at 16 passes per call; a larger generation answers `runtime_broker_runtime_lost` and the next reclaim resumes, since passes commit incrementally.

## Deferred

Credential key rotation (#13202), terminal-row retention (#13203), and InMemory/JDBC semantic alignment (#13204) are follow-up issues.

## Validation

`Issue13183RegressionTest` and `Issue13183AdversarialTest` encode the issue's scenarios with the fixed expectations: the race interleaving, the stalled renewal, the observation cooldown, the loopback refusal, the wedged-worker escalation, and the whole-generation drain, plus a 200-round cross-process stress and a forked-JVM exit-hook proof. `RuntimeRecoveryContract.verifyBeginSessionRelease` covers the new repository primitive's four outcomes on both repository backends. `mvn clean test` in `packages/sdk-java/runtime-broker` and the managed-agent-server fix-adjacent suites pass; `mvn checkstyle:check` is clean.
