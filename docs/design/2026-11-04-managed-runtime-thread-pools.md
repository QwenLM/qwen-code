# Managed Runtime thread pool limits

[English](2026-11-04-managed-runtime-thread-pools.md) | [简体中文](2026-11-04-managed-runtime-thread-pools.zh-CN.md)

## Problem and scope

The November 4 Java conventions audit found unbounded cached platform thread
pools in the private Broker HTTP server and the local Runtime provisioner. Each
non-durable local worker also owns a manually started stdout reader. A burst of
slow requests or worker handshakes can therefore create unlimited platform
threads. Sharing readers with provisioning would deadlock handshakes or stop
draining a live worker's output.

This change governs those two pools and the local stdout readers. It does not
change database schemas, API schemas, authentication, worker identity, durable
recovery, or lease renewal. Virtual thread naming and the remaining audit
findings belong to the separate conventions cleanup. Scheduled renewal queues
still follow their existing lifecycle; this change does not claim to bound all
server work or every pending asynchronous HTTP exchange.

## Design

Use component-owned JDK executors with named daemon threads and explicit
`AbortPolicy`. Keep the limits as internal constants rather than adding public
configuration without operational evidence.

| Work                                                               | Maximum threads | Queue                     | Saturation                                               |
| ------------------------------------------------------------------ | --------------: | ------------------------- | -------------------------------------------------------- |
| Broker HTTP dispatch                                               |              32 | 64 requests               | JDK closes the connection before handler admission       |
| Local provision, registration, reconcile, confirm and drained stop |              16 | None (`SynchronousQueue`) | Failed stage with retryable `503 runtime_local_capacity` |
| Non-durable worker stdout                                          |              64 | None (`SynchronousQueue`) | Refuse startup before spawning a process                 |
| Non-durable worker stop escalation                                 |               4 | None (`SynchronousQueue`) | Immediately force-stop the already released process      |

These are safety caps, not load-tested production sizing recommendations.
Local pools release idle threads after 60 seconds. No operation waits in an
executor queue, so shutdown cannot silently discard a queued operation's
completion stage. Rejection remains asynchronous for the provisioner SPI.

Reserve a reader by submitting its task before spawning the worker. The reader
waits for the process reference, reads the bounded ready record, and keeps
draining stdout until EOF. If startup fails before spawn, cancel that reference
to release the reader. Reader saturation therefore cannot launch an unobserved
child or turn an admission refusal into a managed-context recovery failure.
Readers never consume provisioning or stop capacity.

The Broker recognizes local admission refusals by provider kind, status, code,
retryability and the in-process `RejectedExecutionException` cause. It retains
the original PROVISIONING binding and seed instead of blocking recovery. A
newly saved non-durable placeholder handle is cleared under the current claim's
compare-and-set fence; durable handles remain intact. This lets the next attempt
retry the same identity without relaxing failure handling for work that actually
started. Worker/transport errors with a matching string code lack the local
rejection cause and do not receive this exception to recovery blocking.

Release retains its existing immediate return. Stop escalation has independent
capacity so a full provisioning pool cannot delay SIGKILL indefinitely. If the
stop executor is full or closed, force-stop immediately. Shutdown terminates
non-durable children before stopping all three executors. Durable workers retain
their existing restart/recovery ownership and survive provisioner shutdown.

The HTTP pool covers all registered contexts, including the CSI native readback
and original-session authority routes. Preserve `server.stop(0)`, executor
shutdown, then service close. JDK 21 closes the connection when executor
submission is rejected; there is no `HttpExchange` available to produce a JSON
503 at that point. Do not run rejected work on the HTTP dispatcher. Existing
clients continue to apply their route-specific transport-error handling; this
change does not add universal automatic retries. A handler may return before
its asynchronous operation completes, so this pool limits dispatch threads and
queued dispatches, not total in-flight business operations.

## Implementation and consumers

Modify `LocalProcessRuntimeProvisioner` in `runtime-local`, admission-failure
handling in `RuntimeBrokerService`, and `RuntimeBrokerHttpServer` in `server`.
Add focused tests in `verification`.
The HTTP consumers are `EmbeddedRuntimeBroker` and `WorkspaceCsiRuntimeMain`;
both retain their construction and ownership contracts. Local provisioning is
consumed by Broker binding provisioning/reconciliation and Workspace drained
stop; all existing completion and failure contracts remain in use.

## Verification and acceptance

1. Establish the current unbounded-pool baseline. The global CLI does not host
   the Java executors; use a Java test-script fallback for their behavior.
2. Saturate HTTP workers and queue, observe connection failure, then release
   blocked handlers and verify queued and later requests still complete. Check
   thread naming, shutdown and authentication regressions.
3. Saturate local operations and readers. Verify prompt failed stages, no child
   on reader rejection, no stalled shutdown completions, and successful retry
   after capacity becomes available.
4. Verify continuous stdout draining after readiness, release while startup is
   saturated, forced stop of a SIGTERM-resistant child, and cleanup on close.
5. Run focused existing HTTP, local process, durable recovery and stop tests,
   plus Checkstyle. Select an affected real MySQL integration path within the
   module's shared ten-minute local verification budget. Keep full Maven,
   SpotBugs, MySQL and Hosted/fault gates in CI; report unavailable paths as
   pending rather than replacing their evidence with H2 or fixture tests.

No production throughput, full platform, or full Hosted acceptance is implied
by focused local tests. Further tuning requires measured workload evidence.
