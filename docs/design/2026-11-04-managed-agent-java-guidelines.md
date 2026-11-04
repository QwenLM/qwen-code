# Managed Agent Java guideline adoption

[English](2026-11-04-managed-agent-java-guidelines.md) | [简体中文](2026-11-04-managed-agent-java-guidelines.zh-CN.md)

## Status and scope

Implemented in this PR on 2026-11-04; full CI acceptance is pending. One PR contains low-risk cleanup, concurrency and exception handling, and focused maintainability work. Database rules, persistence implementation, schema changes, and broad lifecycle rewrites are out of scope. Verification results must distinguish local checks from outstanding CI acceptance.

## Problem

The Alibaba Java handbook audit found two cached platform executors without thread limits, unnamed virtual executors, repeated request-path regular expressions, missing overrides, unused private members, exception-driven null validation, and silent cleanup failures.

The current local provisioner also runs reconciliation and cleanup through its executor. A bounded shared queue could delay cleanup behind worker startup. Broker recovery currently blocks managed-context provisioning after failures; treating capacity exhaustion as an ordinary startup failure would make temporary pressure permanent. A worker's stdout must remain open and drained after READY.

## Low-risk cleanup

Fix the verified overrides, unused private members, float suffix, virtual-thread names, and hot action-cursor regular expressions. Existing Checkstyle, SpotBugs, tests, and profile gates remain required.

## Concurrency and exception handling

The private Broker HTTP dispatcher uses an explicit platform executor with at most 64 threads, a `SynchronousQueue` (no waiting queue), named daemon threads, and `AbortPolicy`. Rejection closes/refuses the connection at the JDK HTTP dispatcher boundary; it does not promise a JSON 503 because the executor receives an opaque dispatch task. Do not run rejected work on the dispatcher thread. This limit covers ordinary, native-readback, and registered authority contexts.

Local runtime operations use named virtual threads. A semaphore admits at most 32 concurrent worker startups, without a waiting queue. Acquire inside the asynchronous task immediately before `start`, and release in `finally`; cancellation must not release capacity while startup is still running or leak a permit before a task starts. Reconciliation, attestation, stop, and release escalation remain independent of startup capacity. Saturation fails the stage with retryable `503 runtime_local_capacity` before spawning or entering startup. Only this precise local-process admission failure remains retryable in Broker provisioning; retain the seed and durable handle and release the operation claim. For a first non-durable startup, clear only the synthetic v1 handle created during this attempt, using the existing compare-and-set claim fence. Otherwise the next attempt would mistake the placeholder for a lost worker requiring recovery. A failed compare-and-set reports fencing and cannot clear another owner's handle. The same error from later attestation does not authorize this exception. Other failures preserve existing recovery-blocking behavior.

These fixed bounds are conservative initial limits, not measured deployment capacity or limits on the number of live runtimes. Deployments must qualify their workload under them. No public configuration surface is introduced in this increment.

Keep a separate named daemon platform thread per live non-durable worker to drain stdout. Java 21's synchronized process-pipe reads can pin virtual-thread carriers; moving these long-lived reads to the startup pool or a virtual executor could starve control operations. Extract the reader's lifetime handling from the READY wait and retain size limits, timeout cleanup, and post-READY draining. Preserve interrupt status when waits are interrupted.

Replace the deferred-reference `NullPointerException` catch with an explicit null check while preserving the failed-stage 400 and error code. Add cleanup diagnostics that identify the operation and exception type without exposing credentials, worker output, request contents, or path-bearing exception messages. Cleanup remains best effort and must not mask the original failure.

## Maintainability

Move durable provisioning failure classification and local-capacity recognition into a package-private handler, and separate the local READY wait from the lifetime stdout reader. Failure classification uses the renewed durable claim's request as its authority; the existing recovery-blocking callback retains its CAS and suppressed-error behavior. Keep spawn-and-register, shutdown snapshots, release transfers and reaping under the same lifecycle lock, using `ReentrantLock` to avoid carrier pinning from contended monitor entry on Java 21. Preserve cleanup in `finally`. Name repeated cursor and protocol size limits. Document RuntimeWarmer lifecycle obligations and RuntimeObservation outcomes from their actual callers. Avoid generic helpers, wholesale formatting, and unrelated method decomposition.

Recognize only the exact first-start non-durable placeholder before clearing it; lack of startup-recovery support alone does not prove a handle is safe to discard. The retry regression obtains this placeholder from the real local provisioner so a producer-format change fails the test. No new provider SPI is required. Lower the Broker class pin and global class-size ceiling after extraction; do not raise either limit.

Public snake_case fields, semantic error codes, JSON canonicalization, exact binary floating-point conversion, and existing persistence/lease protocols retain their semantics. In particular, exact `BigDecimal(double)` conversions used for canonical digests are intentional.

## Affected areas

Local runtime provisioning, Broker HTTP dispatch and admission-failure handling, SSH cleanup, action cursor validation, selected configuration/adapters, and public lifecycle contracts are affected. All Java regression tests remain in `verification`.

## Validation and acceptance

Use the module's shared ten-minute local verification budget with JDK 21, a task-isolated Maven repository, and a matching sibling SDK installation. A CLI dry-run cannot exercise these private Java paths; use focused Java tests and real worker processes. Cover startup saturation, no spawn on refusal, capacity recovery after failure/cancellation, concurrent cleanup, shutdown, stdout after READY, and retry with the original durable identity. Check that unrelated startup errors still block recovery and null references still fail asynchronously.

Run the affected action, SSH, Broker, and local-process tests and both Checkstyle configurations. Existing full unit, SpotBugs, real MySQL, Hosted, and fault gates remain CI acceptance requirements. If the relevant real MySQL path cannot run locally within budget, report it as pending CI rather than substituting H2 evidence. No deployment acceptance is implied by the fixed concurrency limits or focused test passes.

## Open questions

None for implementation scope. Workload sizing remains a follow-up decision requiring load evidence.
