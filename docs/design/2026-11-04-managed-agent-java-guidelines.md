# Managed Agent Java guideline adoption

[English](2026-11-04-managed-agent-java-guidelines.md) | [简体中文](2026-11-04-managed-agent-java-guidelines.zh-CN.md)

## Status and scope

Implemented in this PR on 2026-11-04 and reconciled with the thread-pool policy landed in #16330; full CI acceptance is pending. One PR contains low-risk cleanup, concurrency and exception handling, and focused maintainability work. Database rules, persistence implementation, schema changes, PMD integration, and broad lifecycle rewrites are out of scope. Verification results must distinguish local checks from outstanding CI acceptance.

## Problem

The Alibaba Java handbook audit found two cached platform executors without thread limits, unnamed virtual executors, repeated request-path regular expressions, missing overrides, unused private members, exception-driven null validation, and silent cleanup failures.

The executor bounds and independent reader/stop capacity are now provided by main. Broker recovery must distinguish admission refusal during resource preparation or worker provisioning from errors after a worker starts. Treating admission refusal as an ordinary startup failure would make temporary pressure permanent; treating attestation errors as admission refusal could permit unsafe recovery. A worker's stdout must remain open and drained after READY.

## Low-risk cleanup

Fix the verified overrides, unused private members, float suffix, virtual-thread names, and hot action-cursor regular expressions. Existing Checkstyle, SpotBugs, tests, and profile gates remain required.

## Concurrency and exception handling

Retain main's [thread-pool policy](2026-11-04-managed-runtime-thread-pools.md): the private Broker HTTP dispatcher has 32 named daemon platform threads and a queue of 64 dispatches. Local operations, lifetime stdout readers and stop escalation use independent named platform pools capped at 16, 64 and 4 threads, without queued backlogs. Reserve reader capacity before spawning, continue draining after READY, and force-stop immediately when stop escalation is rejected. This PR does not change those pool sizes, queues or rejection policies.

Capacity refusal must retain the local-process kind, retryable `503 runtime_local_capacity` and `RejectedExecutionException` cause required by main. Record that refusal only from resource preparation or provisioning, before attestation. Preserve the original binding and seed and release the operation claim. Resource preparation can be rejected before any handle is saved; retain that empty first-start state for retry. Preserve durable handles that support startup recovery. For a first non-durable startup, clear only the exact synthetic v1 handle created during this attempt, using the existing compare-and-set claim fence. Otherwise the next attempt would mistake the placeholder for a lost worker requiring recovery. A failed compare-and-set reports fencing and cannot clear another owner's handle. The same error and rejection cause from later attestation do not authorize this exception. Other failures preserve existing recovery-blocking behavior.

These fixed bounds are resource safety caps, not measured deployment capacity. The reader pool also bounds live non-durable workers that retain stdout readers. The HTTP pool bounds dispatch tasks, not every outstanding asynchronous business operation. Deployments must qualify their workload under these limits. No public configuration surface is introduced in this increment.

Keep main's separation of the lifetime stdout reader from the READY wait, including size limits, timeout cleanup and interrupt preservation. Cancelling a startup future must not free an operation-pool slot while its handshake is still running. Reuse the main executor tests and retain a focused real-process cancellation regression at the 16-operation limit.

Replace the deferred-reference `NullPointerException` catch with an explicit null check while preserving the failed-stage 400 and error code. Add cleanup diagnostics that identify the operation and exception type without exposing credentials, worker output, request contents, or path-bearing exception messages. Cleanup remains best effort and must not mask the original failure.

## Maintainability

Move durable provisioning failure classification and local-capacity recognition into a package-private handler. Failure classification uses the renewed durable claim's request as its authority; the existing recovery-blocking callback retains its CAS and suppressed-error behavior. Keep spawn-and-register, shutdown snapshots, release transfers and reaping under the same `ReentrantLock`, consistent with the local store's locking style, and preserve `finally` cleanup. The retained platform operation pool no longer runs startup on virtual threads; no carrier-load improvement is claimed. Name repeated cursor and protocol size limits. Document RuntimeWarmer lifecycle obligations and RuntimeObservation outcomes from their actual callers. Avoid generic helpers, wholesale formatting, and unrelated method decomposition.

Recognize only the exact first-start non-durable placeholder before clearing it; lack of startup-recovery support alone does not prove a handle is safe to discard. The retry regression obtains this placeholder from the real local provisioner so a producer-format change fails the test. No new provider SPI is required. Lower the Broker class pin and global class-size ceiling after extraction; do not raise either limit.

Public snake_case fields, semantic error codes, JSON canonicalization, exact binary floating-point conversion, and existing persistence/lease protocols retain their semantics. In particular, exact `BigDecimal(double)` conversions used for canonical digests are intentional.

## Affected areas

Local runtime lifecycle locking, Broker admission-failure handling, SSH cleanup, action cursor validation, selected configuration/adapters, and public lifecycle contracts are affected. HTTP dispatch and the three local pools retain main's implementation and tests. All Java regression tests remain in `verification`.

## Validation and acceptance

Use the module's shared ten-minute local verification budget with JDK 21, a task-isolated Maven repository, and a matching sibling SDK installation. A CLI dry-run cannot exercise these private Java paths; use focused Java tests and real worker processes. Cover operation and reader saturation, no spawn on refusal, capacity recovery after failure/cancellation, concurrent cleanup, shutdown, stdout after READY, and retry with the original durable identity, including resource-preparation refusal before a handle exists. Check that unrelated startup errors and capacity-shaped attestation errors still block recovery and null references still fail asynchronously. Results from before the main integration are historical evidence; the changed integration paths require current CI evidence.

Run the affected action, SSH, Broker, and local-process tests and both Checkstyle configurations. Existing full unit, SpotBugs, real MySQL, Hosted, and fault gates remain CI acceptance requirements. If the relevant real MySQL path cannot run locally within budget, report it as pending CI rather than substituting H2 evidence. No deployment acceptance is implied by the fixed concurrency limits or focused test passes.

## Open questions

None for implementation scope. Workload sizing remains a follow-up decision requiring load evidence.
