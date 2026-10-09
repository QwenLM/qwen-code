package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class DurableRuntimeRecoveryTest {
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant",
            "workspace", "generation", "/workspace", "capability",
            "workspace");
    private static final RuntimeResourceHandle HANDLE =
            new RuntimeResourceHandle("test-scheduler", 1,
                    Map.of("resourceId", "runtime-resource"));

    @Test
    void restoredReadyBindingWaitsForReconcileAndAttestation()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner restored = new DurableProvisioner();
        CompletableFuture<Void> attestationGate = new CompletableFuture<>();
        TestTransport transport = new TestTransport(attestationGate, false);
        try (RuntimeBrokerService service = service(restored, transport,
                bindings, sessions, executions, "broker-two")) {
            CompletableFuture<RuntimeSessionRecord> acquired =
                    service.acquire("harness", "runtime-session",
                            "bootstrap").toCompletableFuture();

            await(() -> restored.reconciliations.get() > 0,
                    Duration.ofSeconds(1));
            assertFalse(acquired.isDone());
            assertEquals(0, restored.ensures.get());
            assertEquals(0, transport.acquisitions.get());

            attestationGate.complete(null);
            acquired.get(1, TimeUnit.SECONDS);
            assertEquals(1, transport.acquisitions.get());
            RuntimeBindingRecord record = bindings.findActive(
                    request(restored));
            assertEquals(RuntimeBindingRecord.State.READY,
                    record.getState());
            assertTrue(record.getAttestationGeneration() >= 2);
            assertEquals(HANDLE, restored.lastReconcileHandle);
            assertEquals(initial.provisionedLease.getLeaseId(),
                    restored.lastReconcileLease.getLeaseId());
            assertEquals(initial.provisionedLease.getRuntimeInstanceId(),
                    restored.lastReconcileLease.getRuntimeInstanceId());
            assertEquals(initial.provisionedLease.getEpoch(),
                    restored.lastReconcileLease.getEpoch());
        }
    }

    @Test
    void unknownObservationNeverCreatesOrReplacesAReadyResource()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner unknown = new DurableProvisioner();
        unknown.outcome = RuntimeObservation.Outcome.UNKNOWN;
        // The deadline is four leases, so it must stay clear of the 50 ms
        // first backoff by more than a loaded runner can consume.
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                unknown, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofMillis(100),
                Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            assertTrue(unknown.reconciliations.get() >= 2,
                    "unknown observation must be retried");
            assertEquals(0, unknown.ensures.get());
            RuntimeBindingRecord untouched = bindings.findActive(
                    request(unknown));
            assertEquals(RuntimeBindingRecord.State.READY,
                    untouched.getState());
            assertEquals(HANDLE, untouched.getResourceHandle());
            assertNull(untouched.getOperationOwner());
        }
    }

    @Test
    void unknownObservationTimesOutAndAnewRequestCanResume()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner unavailable = new DurableProvisioner();
        unavailable.outcome = RuntimeObservation.Outcome.UNKNOWN;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                unavailable, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofMillis(20),
                Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            assertNull(bindings.findActive(request(unavailable))
                    .getOperationOwner());
        }

        DurableProvisioner recovered = new DurableProvisioner();
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-three")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(recovered)).getState());
        }
    }

    @Test
    void anInFlightReconcileIsBoundedByTheOperationDeadline()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner unavailable = new DurableProvisioner();
        unavailable.reconcileGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                unavailable, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofMillis(20),
                Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            assertNull(bindings.findActive(request(unavailable))
                    .getOperationOwner());
        }

        unavailable.reconcileGate.complete(RuntimeObservation.ready(HANDLE,
                URI.create("http://127.0.0.1:4190"), "late-runtime",
                "late-lease", 1));
        DurableProvisioner recovered = new DurableProvisioner();
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-three")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(recovered)).getState());
        }
    }

    @Test
    void lateAttestationCannotOverwriteARestoredReadyBinding()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner restored = new DurableProvisioner();
        CompletableFuture<Void> attestationGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                restored, new TestTransport(attestationGate, false),
                bindings, sessions, executions, "broker-two",
                Duration.ofMillis(20), Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            RuntimeBindingRecord timedOut = bindings.findActive(
                    request(restored));
            long attestationGeneration = timedOut
                    .getAttestationGeneration();

            attestationGate.complete(null);
            Thread.sleep(100);

            RuntimeBindingRecord unchanged = bindings.findActive(
                    request(restored));
            assertEquals(RuntimeBindingRecord.State.READY,
                    unchanged.getState());
            assertEquals(attestationGeneration,
                    unchanged.getAttestationGeneration());
            assertNull(unchanged.getOperationOwner());
        }
    }

    @Test
    void attestationMismatchMarksTheBindingRecoveryBlocked()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        try (RuntimeBrokerService service = service(provisioner,
                new TestTransport(CompletableFuture.completedFuture(null),
                        true), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(request(provisioner)).getState());
            assertEquals(1, provisioner.releaseCalls.get());
            assertEquals(provisioner.provisionedLease,
                    provisioner.releasedLease);
        }
    }

    @Test
    void concurrentRestoredWarmReconcilesOnce() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner restored = new DurableProvisioner();
        CompletableFuture<Void> attestationGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = service(restored,
                new TestTransport(attestationGate, false), bindings,
                sessions, executions, "broker-two")) {
            CompletableFuture<RuntimeBindingRecord> firstWarm =
                    CompletableFuture.supplyAsync(
                            () -> service.warm("harness")
                                    .toCompletableFuture().join());
            await(() -> restored.reconciliations.get() == 1,
                    Duration.ofSeconds(1));
            CompletableFuture<RuntimeBindingRecord> secondWarm =
                    service.warm("harness").toCompletableFuture();
            attestationGate.complete(null);

            RuntimeBindingRecord firstRecord = firstWarm.get(2,
                    TimeUnit.SECONDS);
            RuntimeBindingRecord secondRecord = secondWarm.get(2,
                    TimeUnit.SECONDS);
            assertEquals(1, restored.reconciliations.get());
            assertEquals(firstRecord.getBindingId(),
                    secondRecord.getBindingId());
            assertEquals(firstRecord.getGeneration(),
                    secondRecord.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    secondRecord.getState());
        }
    }

    @Test
    void persistedIdentityMismatchesBlockRecovery() throws Exception {
        assertIdentityMismatchBlocksRecovery(
                provisioner -> provisioner.observedRuntimeId =
                        "wrong-runtime",
                transport -> { });
        assertIdentityMismatchBlocksRecovery(
                provisioner -> provisioner.observedLeaseId = "wrong-lease",
                transport -> { });
        assertIdentityMismatchBlocksRecovery(
                provisioner -> provisioner.observedEpoch = 999L,
                transport -> { });
        assertIdentityMismatchBlocksRecovery(
                provisioner -> provisioner.observedHandle =
                        new RuntimeResourceHandle("other-scheduler", 1,
                                Map.of("resourceId", "untrusted")),
                transport -> { });
        assertIdentityMismatchBlocksRecovery(provisioner -> { },
                transport -> transport.attestedIncarnation =
                        "wrong-incarnation");
        assertIdentityMismatchBlocksRecovery(provisioner -> { },
                transport -> transport.attestedLeaseId = "wrong-lease");
        assertIdentityMismatchBlocksRecovery(provisioner -> { },
                transport -> transport.attestedEpoch = 999L);
        assertIdentityMismatchBlocksRecovery(provisioner -> { },
                transport -> transport.attestedScope = new RuntimeScope(
                        "other-tenant", "workspace", "generation",
                        "/workspace", "capability", "workspace"));
        assertIdentityMismatchBlocksRecovery(provisioner -> { },
                transport -> transport.attestedProvisionRequestId =
                        "wrong-request");
    }

    private void assertIdentityMismatchBlocksRecovery(
            Consumer<DurableProvisioner> observationMismatch,
            Consumer<TestTransport> attestationMismatch) throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner restored = new DurableProvisioner();
        observationMismatch.accept(restored);
        TestTransport transport = new TestTransport();
        attestationMismatch.accept(transport);
        try (RuntimeBrokerService service = service(restored, transport,
                bindings, sessions, executions, "broker-two")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            RuntimeBindingRecord blocked = bindings.findActive(
                    request(restored));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    blocked.getState());
            assertEquals(HANDLE, blocked.getResourceHandle());
        }
    }

    @Test
    void defaultEnsureResourceFailsClosedForADurableKind() throws Exception {
        AtomicInteger bindingIds = new AtomicInteger();
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository(Clock.systemUTC(),
                        () -> "binding-" + bindingIds.incrementAndGet());
        DefaultsOnlyProvisioner provisioner = new DefaultsOnlyProvisioner();
        try (RuntimeBrokerService service = service(provisioner,
                new BareTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_provision_failed",
                    brokerFailure(failure).getCode());
            assertTrue(brokerFailure(failure).isRetryable());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findById("binding-1").getState());
        }
    }

    @Test
    void defaultReconcileWaitsInsteadOfGuessing() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DefaultsOnlyProvisioner restored = new DefaultsOnlyProvisioner();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                restored, new BareTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofMillis(20),
                Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(restored)).getState());
        }
    }

    @Test
    void defaultAttestFailsClosedForDurableProvisioning() throws Exception {
        AtomicInteger bindingIds = new AtomicInteger();
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository(Clock.systemUTC(),
                        () -> "binding-" + bindingIds.incrementAndGet());
        DurableProvisioner provisioner = new DurableProvisioner();
        try (RuntimeBrokerService service = service(provisioner,
                new BareTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_broker_attestation_unavailable",
                    brokerFailure(failure).getCode());
            assertFalse(brokerFailure(failure).isRetryable());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findById("binding-1").getState());
        }
    }

    @Test
    void nonRetryableAttestationFailureBlocksRecovery() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner restored = new DurableProvisioner();
        TestTransport transport = new TestTransport(
                new RuntimeBrokerException(409,
                        "managed_runtime_identity_conflict", "conflict",
                        false));
        try (RuntimeBrokerService service = service(restored, transport,
                bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-two")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(request(restored)).getState());

            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            assertEquals(1, transport.attestations.get());
        }
    }

    @Test
    void aTransientAttestationFailureDoesNotBlockRecovery() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        // What HttpRuntimeTransport reports for a throttled attestation: a
        // non-retryable incompatibility that carries no identity evidence.
        DurableProvisioner throttled = new DurableProvisioner();
        try (RuntimeBrokerService service = service(throttled,
                new TestTransport(new RuntimeBrokerException(502,
                        "managed_runtime_incompatible", "throttled", false)),
                bindings, sessions, executions, "broker-two")) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("managed_runtime_incompatible",
                    brokerFailure(failure).getCode());
            RuntimeBindingRecord waiting = bindings.findActive(
                    request(throttled));
            assertEquals(RuntimeBindingRecord.State.READY,
                    waiting.getState());
            assertNull(waiting.getOperationOwner());
        }

        DurableProvisioner recovered = new DurableProvisioner();
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-three")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            RuntimeBindingRecord adopted = bindings.findActive(
                    request(recovered));
            assertEquals(RuntimeBindingRecord.State.READY,
                    adopted.getState());
            assertTrue(adopted.getAttestationGeneration() >= 2);
        }
    }

    @Test
    void sessionsLeftAcquiringOrReleasingStillNeedStopProof()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.acquire("harness", "sess-acquiring", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
            service.acquire("harness", "sess-releasing", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
        }

        // A Broker killed mid-acquire and mid-release leaves these behind.
        RuntimeSessionRecord acquired = sessions.findById(SCOPE,
                "sess-acquiring");
        sessions.compareAndSet(acquired, acquired.withState(
                RuntimeSessionRecord.State.ACQUIRING, Instant.now()));
        RuntimeSessionRecord releasing = sessions.findById(SCOPE,
                "sess-releasing");
        sessions.compareAndSet(releasing, releasing.withState(
                RuntimeSessionRecord.State.RELEASING, Instant.now()));

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.notFoundOnce = true;
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            Exception lost = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_runtime_lost",
                    brokerFailure(lost).getCode());

            for (String sessionId : List.of("sess-acquiring", "sess-releasing")) {
                assertThrows(Exception.class, () -> service.release("harness", sessionId)
                        .toCompletableFuture().join());
            }
            assertEquals(RuntimeSessionRecord.State.ACQUIRING,
                    sessions.findById(SCOPE, "sess-acquiring").getState());
            assertEquals(RuntimeSessionRecord.State.RELEASING,
                    sessions.findById(SCOPE, "sess-releasing").getState());
            assertEquals(0, recovered.ensures.get());
        }
    }

    @Test
    void releaseDoesNotSettleLocallyWhileTheRuntimeIsNotProvenGone()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.acquire("harness", "live-session", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner restored = new DurableProvisioner();
        try (RuntimeBrokerService service = service(restored,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.release("harness", "live-session")
                            .toCompletableFuture().get(2, TimeUnit.SECONDS));

            assertEquals("runtime_reconciliation_required",
                    brokerFailure(failure).getCode());
            assertEquals(RuntimeSessionRecord.State.READY,
                    sessions.findById(SCOPE, "live-session").getState());
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(restored)).getState());
        }
    }

    @Test
    void conflictObservationRetainsTheLastTrustedResourceHandle()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner conflicted = new DurableProvisioner();
        conflicted.outcome = RuntimeObservation.Outcome.CONFLICT;
        conflicted.conflictHandle = new RuntimeResourceHandle(
                "test-scheduler", 1,
                Map.of("resourceId", "untrusted-replacement"));
        try (RuntimeBrokerService service = service(conflicted,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-two")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            RuntimeBindingRecord blocked = bindings.findActive(
                    request(conflicted));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    blocked.getState());
            assertEquals(HANDLE, blocked.getResourceHandle());
        }
    }

    @Test
    void nonRetryableEnsureFailureDoesNotLoopForever() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.ensureFailure = new RuntimeBrokerException(409,
                "runtime_broker_resource_conflict", "conflict", false);
        try (RuntimeBrokerService service = service(provisioner,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            assertEquals(1, provisioner.ensures.get());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(request(provisioner)).getState());
        }
    }

    @Test
    void retryableProvisionFailureKeepsTheEnsuredResource()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.provisionFailure = new RuntimeBrokerException(503,
                "runtime_provision_failed", "transient", true);
        try (RuntimeBrokerService service = service(provisioner,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            RuntimeBindingRecord pending = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    pending.getState());
            assertEquals(HANDLE, pending.getResourceHandle());
            String bindingId = pending.getBindingId();
            long generation = pending.getGeneration();

            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            RuntimeBindingRecord ready = bindings.findActive(
                    request(provisioner));
            assertEquals(bindingId, ready.getBindingId());
            assertEquals(generation, ready.getGeneration());
            assertEquals(HANDLE, provisioner.lastKnownHandle);
        }
    }

    @Test
    void synchronousReconcileFailureDoesNotPoisonSingleFlight()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        RuntimeBindingRepository failingOnce =
                new ClaimFailureRepository(bindings);
        DurableProvisioner restored = new DurableProvisioner();
        try (RuntimeBrokerService service = service(restored,
                new TestTransport(), failingOnce,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-two")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            assertEquals(1, restored.reconciliations.get());
        }
    }

    @Test
    void startingObservationRetriesUntilTheOperationDeadline()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner starting = new DurableProvisioner();
        starting.outcome = RuntimeObservation.Outcome.STARTING;
        // The deadline is four leases, so it must stay clear of the 50 ms
        // first backoff by more than a loaded runner can consume.
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                starting, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofMillis(100),
                Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            assertTrue(starting.reconciliations.get() >= 2,
                    "starting observation must be retried");
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(starting)).getState());
        }
    }

    @Test
    void retryableReconcileFailureTimesOutWithoutBlockingRecovery()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner failing = new DurableProvisioner();
        failing.reconcileFailure = new RuntimeBrokerException(503,
                "runtime_broker_reconcile_failed", "transient", true);
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                failing, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofMillis(20),
                Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(failing)).getState());
        }
    }

    @Test
    void nonRetryableReconcileFailureBlocksRecovery() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner failing = new DurableProvisioner();
        failing.reconcileFailure = new RuntimeBrokerException(409,
                "managed_runtime_identity_conflict", "conflict", false);
        try (RuntimeBrokerService service = service(failing,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_broker_recovery_failed",
                    brokerFailure(failure).getCode());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(request(failing)).getState());
        }
    }

    @Test
    void ambiguousEnsureFailurePinsTheGeneration()
            throws Exception {
        AtomicInteger bindingIds = new AtomicInteger();
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository(Clock.systemUTC(),
                        () -> "binding-" + bindingIds.incrementAndGet());
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.ensureFailure = new RuntimeBrokerException(503,
                "runtime_provision_failed", "transient", true);
        try (RuntimeBrokerService service = service(provisioner,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findById("binding-1").getState());

            provisioner.ensureFailure = null;
            assertThrows(Exception.class, () -> service.warm("harness").toCompletableFuture().join());
            assertNull(bindings.findById("binding-2"));
            assertEquals(1, provisioner.ensures.get());
        }
    }

    @Test
    void parkedProvisionIsBoundedByTheOperationDeadline() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.ensureGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofMillis(20), Duration.ofSeconds(1))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_provision_timeout",
                    brokerFailure(failure).getCode());

            RuntimeBindingRecord timedOut = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    timedOut.getState());
            assertNull(timedOut.getOperationOwner());

            provisioner.ensureGate.complete(HANDLE);
            Thread.sleep(100);

            RuntimeBindingRecord afterLateResult = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    afterLateResult.getState());
            assertNull(afterLateResult.getOperationOwner());
        }
    }

    @Test
    void activeExecutionAloneKeepsALostGenerationPinned() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.acquire("harness", "pinned-session", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
        }

        RuntimeBindingRecord first = bindings.findActive(request(initial));
        executions.findOrCreate(ToolExecutionRecord.prepared("execution",
                "key", first.getBindingId(), first.getGeneration(),
                "harness", "pinned-session", "prompt", "call", "digest",
                Map.of("sessionId", "pinned-session", "promptId", "prompt",
                        "callId", "call", "argsDigest", "digest")));
        RuntimeSessionRecord acquired = sessions.findById(SCOPE,
                "pinned-session");
        sessions.compareAndSet(acquired, acquired.withState(
                RuntimeSessionRecord.State.RELEASED, Instant.now()));

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.notFoundOnce = true;
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_runtime_lost",
                    brokerFailure(failure).getCode());

            RuntimeBindingRecord pinned = bindings.findActive(
                    request(recovered));
            assertEquals(first.getBindingId(), pinned.getBindingId());
            assertEquals(1, pinned.getGeneration());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    pinned.getState());
            assertEquals(0, recovered.ensures.get());
        }
    }

    @Test
    void concurrentWarmOnAnIdleLostBindingReclaimsOnce() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.reconcileGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            CompletableFuture<RuntimeBindingRecord> firstWarm = service.warm("harness").toCompletableFuture();
            CompletableFuture<RuntimeBindingRecord> secondWarm = service.warm("harness").toCompletableFuture();
            RuntimeBindingRecord original = bindings.findActive(request(initial));
            recovered.reconcileGate.complete(RuntimeObservation.notFound(
                    RuntimeRecoveryContract.evidence(original, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    RuntimeRecoveryContract.evidence(original, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)));
            RuntimeBindingRecord firstRecord = firstWarm.get(2,
                    TimeUnit.SECONDS);
            RuntimeBindingRecord secondRecord = secondWarm.get(2,
                    TimeUnit.SECONDS);
            assertEquals(firstRecord.getBindingId(),
                    secondRecord.getBindingId());
            assertEquals(2, secondRecord.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    secondRecord.getState());
            assertEquals(1, recovered.ensures.get());
        }
    }

    @Test
    void lostBranchSurvivesAnInFlightRenewalTick() throws Exception {
        ReclaimWatchRepository bindings = new ReclaimWatchRepository(
                new InMemoryRuntimeBindingRepository());
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.reconcileGate = new CompletableFuture<>();
        // A 2s lease so the 1.5s evidence-write hold below still fits
        // inside the branch's just-renewed claim.
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                recovered, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofSeconds(2),
                Duration.ofSeconds(2))) {
            CompletableFuture<RuntimeBindingRecord> warm =
                    service.warm("harness").toCompletableFuture();
            RuntimeBindingRecord original = bindings.findActive(
                    request(initial));
            await(() -> recovered.reconciliations.get() > 0,
                    Duration.ofSeconds(2));
            // Hold the branch's evidence write until a background tick
            // lands in the renewal window; with the renewal stopped on
            // branch entry no tick comes and the write proceeds.
            bindings.holdEvidenceCas.set(true);
            recovered.reconcileGate.complete(RuntimeObservation.notFound(
                    RuntimeRecoveryContract.evidence(original,
                            RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    RuntimeRecoveryContract.evidence(original,
                            RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)));
            RuntimeBindingRecord reclaimed = warm.get(5, TimeUnit.SECONDS);
            assertEquals(2, reclaimed.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    reclaimed.getState());
            assertEquals(1, recovered.ensures.get());
        }
    }

    @Test
    void lostBranchRenewsBeforeItsEvidenceWrite() throws Exception {
        ReclaimWatchRepository bindings = new ReclaimWatchRepository(
                new InMemoryRuntimeBindingRepository());
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.reconcileGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            CompletableFuture<RuntimeBindingRecord> warm =
                    service.warm("harness").toCompletableFuture();
            RuntimeBindingRecord original = bindings.findActive(
                    request(initial));
            await(() -> recovered.reconciliations.get() > 0,
                    Duration.ofSeconds(2));
            // The claim and its ticks have moved the row past this read;
            // the branch must renew — re-reading and refreshing its
            // snapshot — rather than CAS from the stale findById result.
            RuntimeBindingRecord stale = bindings.findById(
                    original.getBindingId());
            await(() -> bindings.ticks.get() > 0, Duration.ofSeconds(2));
            bindings.staleRead = stale;
            recovered.reconcileGate.complete(RuntimeObservation.notFound(
                    RuntimeRecoveryContract.evidence(original,
                            RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    RuntimeRecoveryContract.evidence(original,
                            RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)));
            RuntimeBindingRecord reclaimed = warm.get(5, TimeUnit.SECONDS);
            assertEquals(2, reclaimed.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    reclaimed.getState());
            assertEquals(1, recovered.ensures.get());
        }
    }

    @Test
    void lostBranchReclaimsBeyondTheReconcileDeadline() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner recovered = new DurableProvisioner();
        // The eighth call starts no earlier than 5.15s of the 8s deadline
        // (2s lease, 4x), leaving 2.85s for loss discovery. The cleanup's
        // 3s observation then finishes after 8.15s, past that deadline
        // but within its own 4s step bound. This checks the fresh handoff
        // window without relying on a 0.85s discovery margin.
        recovered.startingBeforeNotFound = 7;
        recovered.notFoundOnce = true;
        recovered.reconcileDelayMillis = 3000;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                recovered, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofSeconds(2),
                Duration.ofSeconds(2))) {
            RuntimeBindingRecord original = bindings.findActive(
                    request(initial));
            long started = System.nanoTime();
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(20, TimeUnit.SECONDS));
            assertEquals("runtime_broker_runtime_lost",
                    brokerFailure(failure).getCode());
            assertTrue(System.nanoTime() - started >= TimeUnit.SECONDS.toNanos(8));
            RuntimeBindingRecord pinned = bindings.findActive(
                    request(initial));
            assertEquals(original.getBindingId(), pinned.getBindingId());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    pinned.getState());
        }
    }

    /**
     * The LOST handoff runs the evidence CAS, the reclaim's claimOperation
     * (a same-owner no-op that does not extend the lease) and the first
     * recoverLost on one renewal; slow handoff steps must not lapse it.
     */
    @Test
    void lostHandoffRenewsBeforeTheFirstRecoverLost() throws Exception {
        ReclaimWatchRepository bindings = new ReclaimWatchRepository(
                new InMemoryRuntimeBindingRepository());
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }
        DurableProvisioner recovered = new DurableProvisioner();
        recovered.reconcileGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                recovered, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofSeconds(2),
                Duration.ofSeconds(2))) {
            CompletableFuture<RuntimeBindingRecord> warm =
                    service.warm("harness").toCompletableFuture();
            RuntimeBindingRecord original = bindings.findActive(
                    request(initial));
            await(() -> recovered.reconciliations.get() > 0,
                    Duration.ofSeconds(2));
            bindings.handoffSleepMillis = 800;
            recovered.reconcileGate.complete(RuntimeObservation.notFound(
                    RuntimeRecoveryContract.evidence(original,
                            RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    RuntimeRecoveryContract.evidence(original,
                            RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)));
            RuntimeBindingRecord reclaimed = warm.get(10, TimeUnit.SECONDS);
            assertTrue(bindings.casSlept.get() && bindings.claimSlept.get()
                    && bindings.recoverSlept.get(),
                    "all three handoff steps slept");
            assertEquals(2, reclaimed.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    reclaimed.getState());
        }
    }

    /**
     * A restored Broker adopting a live worker through reconcileLoop's
     * default branch: one background renewal tick lands between
     * adoptObservation's findById and its attestation CAS.
     */
    @Test
    void adoptCasSurvivesARenewalTickInItsWindow() throws Exception {
        ReclaimWatchRepository bindings = new ReclaimWatchRepository(
                new InMemoryRuntimeBindingRepository());
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
        }
        DurableProvisioner restored = new DurableProvisioner();
        bindings.tickInAdoptWindow = true;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                restored, new TestTransport(), bindings, sessions,
                executions, "broker-two", Duration.ofSeconds(3),
                Duration.ofSeconds(3))) {
            RuntimeBindingRecord adopted = service.warm("harness")
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            assertTrue(bindings.adoptTickFired.get(), "the window was held");
            assertEquals(RuntimeBindingRecord.State.READY, adopted.getState());
            assertEquals(1, adopted.getGeneration());
            assertEquals(0, restored.ensures.get());
        }
    }

    @Test
    void stoppedFlagRetractsATickQueuedBehindClose() throws Exception {
        ReclaimWatchRepository bindings = new ReclaimWatchRepository(
                new InMemoryRuntimeBindingRepository());
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        // persistResourceHandle's write holds the renewal monitor for 2.5s
        // of the 3s lease, so the tick dispatched at 1s queues on the
        // monitor; the write then fails, and persistResourceHandle calls
        // close() reentrantly. The queued tick must see the stopped flag
        // and never call renewOperation — without the flag it renews here.
        bindings.holdResourceHandleCasMillis = 2500;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new TestTransport(), bindings, sessions,
                executions, "broker", Duration.ofSeconds(3),
                Duration.ofSeconds(3))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(15, TimeUnit.SECONDS));
            assertEquals("runtime_provision_fenced",
                    brokerFailure(failure).getCode());
            assertEquals(0, bindings.ticks.get(),
                    "a tick queued behind close() renewed the claim");
        }
    }

    @Test
    void lateEnsureResultCannotOverwriteANewOperationOwner()
            throws Exception {
        MutableClock clock = new MutableClock();
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository(clock,
                        () -> "binding");
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner first = new DurableProvisioner();
        first.ensureGate = new CompletableFuture<>();
        RuntimeBrokerService firstService = service(first,
                new TestTransport(), bindings, sessions, executions,
                "broker-one");
        try {
            firstService.warm("harness");
            await(() -> first.ensures.get() == 1, Duration.ofSeconds(1));
            clock.advance(Duration.ofSeconds(2));

            DurableProvisioner second = new DurableProvisioner();
            try (RuntimeBrokerService secondService = service(second,
                    new TestTransport(), bindings, sessions, executions,
                    "broker-two")) {
                secondService.warm("harness").toCompletableFuture()
                        .get(2, TimeUnit.SECONDS);
                RuntimeBindingRecord current = bindings.findActive(
                        request(second));
                assertEquals(HANDLE, current.getResourceHandle());
                assertEquals(2, current.getOperationGeneration());

                first.ensureGate.complete(new RuntimeResourceHandle(
                        "test-scheduler", 1,
                        Map.of("resourceId", "stale-resource")));
                Thread.sleep(50);

                RuntimeBindingRecord afterLateResult = bindings.findActive(
                        request(second));
                assertEquals(HANDLE, afterLateResult.getResourceHandle());
                assertEquals(RuntimeBindingRecord.State.READY,
                        afterLateResult.getState());
                assertEquals(2, afterLateResult.getOperationGeneration());
            }
        } finally {
            firstService.close();
        }
    }

    @Test
    void lossAndStopEvidencePermitANewGeneration()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        String initialBinding;
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            initialBinding = bindings.findActive(request(initial))
                    .getBindingId();
        }

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.notFoundOnce = true;
        recovered.stopProved = true;
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            RuntimeBindingRecord replacement = bindings.findActive(
                    request(recovered));
            assertFalse(initialBinding.equals(replacement.getBindingId()));
            assertEquals(2, replacement.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    replacement.getState());
            assertEquals(1, recovered.ensures.get());
        }
    }

    @Test
    void authoritativeLossStaysBlockedWithAnActiveRuntimeSession()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        DurableProvisioner initial = new DurableProvisioner();
        try (RuntimeBrokerService service = service(initial,
                new TestTransport(), bindings, sessions, executions,
                "broker-one")) {
            service.acquire("harness", "active-session", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
        }

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.notFoundOnce = true;
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            Exception lost = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_runtime_lost",
                    brokerFailure(lost).getCode());

            RuntimeBindingRecord blocked = bindings.findActive(
                    request(recovered));
            assertEquals(1, blocked.getGeneration());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    blocked.getState());
            assertEquals(0, recovered.ensures.get());

            ToolExecutionRecord active = executions.findOrCreate(
                    ToolExecutionRecord.prepared("execution", "key",
                            blocked.getBindingId(), blocked.getGeneration(),
                            "harness", "active-session", "prompt", "call",
                            "digest", Map.of("sessionId", "active-session",
                                    "promptId", "prompt", "callId", "call",
                                    "argsDigest", "digest")));
            Exception pinned = assertThrows(Exception.class,
                    () -> service.release("harness", "active-session")
                            .toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_reconciliation_required",
                    brokerFailure(pinned).getCode());
            executions.requestCancel(active.getExecutionCallId(),
                    active.getVersion());

            assertThrows(Exception.class, () -> service.release("harness", "active-session")
                    .toCompletableFuture().join());
            recovered.notFoundOnce = true;
            recovered.stopProved = true;
            service.warm("harness").toCompletableFuture().get(2, TimeUnit.SECONDS);
            assertTrue(service.release("harness", "active-session").toCompletableFuture().join());
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    sessions.findById(SCOPE, "active-session").getState());
            RuntimeBindingRecord replacement = bindings.findActive(
                    request(recovered));
            assertEquals(2, replacement.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    replacement.getState());
            assertEquals(1, recovered.ensures.get());
        }
    }

    @Test
    void cachedReleaseHonorsLossAndAcknowledgesCompletedRecovery() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var provisioner = new DurableProvisioner();
        var transport = new TestTransport();
        try (RuntimeBrokerService service = service(provisioner, transport, bindings, sessions, executions, "broker")) {
            RuntimeSessionRecord session = service.acquire("harness", "cached", "bootstrap").toCompletableFuture().join();
            ToolExecutionRecord execution = executions.findOrCreate(ToolExecutionRecord.prepared(
                    "call", "key", session.getBindingId(), session.getRuntimeGeneration(), "harness", "cached",
                    "turn", "call", "digest", Map.of("sessionId", "cached", "promptId", "turn",
                            "callId", "call", "argsDigest", "digest")));
            RuntimeBindingRecord claimed = bindings.claimOperation(session.getBindingId(), "recovery", Duration.ofMinutes(1));
            RuntimeBindingRecord lost = bindings.compareAndSet(claimed, claimed.withRecoveryEvidence(
                    RuntimeRecoveryContract.evidence(claimed, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST), null, Instant.now()));
            bindings.recoverLost(sessions, executions, lost);
            assertEquals(ToolExecutionRecord.State.ABANDONED,
                    executions.findByExecutionCallId(execution.getExecutionCallId()).getState());
            assertEquals("runtime_reconciliation_required", brokerFailure(assertThrows(Exception.class,
                    () -> service.release("harness", "cached").toCompletableFuture().join())).getCode());
            assertEquals(RuntimeSessionRecord.State.READY, sessions.findById(SCOPE, "cached").getState());
            assertEquals(0, transport.releases.get());
            RuntimeBindingRecord stopped = bindings.compareAndSet(lost, lost.withRecoveryEvidence(null,
                    RuntimeRecoveryContract.evidence(lost, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED), Instant.now()));
            assertEquals(RuntimeBindingRecord.State.RELEASED, bindings.recoverLost(sessions, executions, stopped).getState());
            provisioner.usable = false;
            assertTrue(service.release("harness", "cached").toCompletableFuture().join());
            assertTrue(service.release("harness", "cached").toCompletableFuture().join());
            assertEquals(0, transport.releases.get());
        }
    }

    @Test
    void aReplacedBrokerConfirmsAPreparedCancellationAfterAdoptingTheSession() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        String runtime = "550e8400-e29b-41d4-a716-446655440302";
        Map<String, Object> reference = Map.of("sessionId", runtime, "promptId", "turn",
                "callId", "call", "argsDigest", "a".repeat(64), "capabilityDigest", "b".repeat(64),
                "policyRevision", "policy", "invocationId", "invocation");
        ToolExecutionRecord settled;
        try (RuntimeBrokerService service = service(new DurableProvisioner(), new TestTransport(),
                bindings, sessions, executions, "broker-one")) {
            service.acquire("harness", runtime, "bootstrap").toCompletableFuture().join();
            ToolExecutionRecord prepared = service.prepareExecution("harness", runtime, "key", reference)
                    .toCompletableFuture().join();
            // The process dies after persisting the cancellation and before
            // the worker, which still holds the preparation, hears of it.
            settled = executions.requestCancel(prepared.getExecutionCallId(), prepared.getVersion());
        }
        var transport = new TestTransport();
        transport.cancelAnswer = Map.of("state", "settled", "result", Map.of("executionStatus", "cancelled"));
        try (RuntimeBrokerService replaced = service(new DurableProvisioner(), transport,
                bindings, sessions, executions, "broker-two")) {
            RuntimeBrokerException adopt = brokerFailure(assertThrows(Exception.class,
                    () -> replaced.cancelExecution("harness", runtime, settled.getExecutionCallId())
                            .toCompletableFuture().join()));
            assertEquals("runtime_reconciliation_required", adopt.getCode());
            assertTrue(adopt.isRetryable());
            assertEquals(0, transport.cancels.get());
            replaced.acquire("harness", runtime, "bootstrap").toCompletableFuture().join();
            ToolExecutionRecord confirmed = replaced.cancelExecution("harness", runtime,
                    settled.getExecutionCallId()).toCompletableFuture().join();
            assertEquals("cancelled", confirmed.getExecutionStatus());
            assertEquals(1, transport.cancels.get());
        }
    }

    @Test
    void lateReleaseReplyKeepsALostSessionPinned() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var provisioner = new DurableProvisioner();
        var transport = new TestTransport();
        transport.releaseResult = new CompletableFuture<>();
        try (RuntimeBrokerService service = service(provisioner, transport, bindings, sessions, executions, "broker")) {
            RuntimeSessionRecord session = service.acquire("harness", "cached", "bootstrap").toCompletableFuture().join();
            var releasing = service.release("harness", "cached").toCompletableFuture();
            RuntimeBindingRecord claimed = bindings.claimOperation(session.getBindingId(), "recovery", Duration.ofMinutes(1));
            bindings.compareAndSet(claimed, claimed.withRecoveryEvidence(
                    RuntimeRecoveryContract.evidence(claimed, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST), null, Instant.now()));
            transport.releaseResult.complete(true);
            assertEquals("runtime_reconciliation_required", brokerFailure(assertThrows(Exception.class,
                    releasing::join)).getCode());
            assertEquals(RuntimeSessionRecord.State.RELEASING, sessions.findById(SCOPE, "cached").getState());
        }
    }

    private static RuntimeBrokerService service(
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String owner) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                owner, Duration.ofSeconds(1), Duration.ofSeconds(1));
    }

    private static RuntimeProvisionRequest request(
            RuntimeProvisioner provisioner) {
        return new RuntimeProvisionRequest(SCOPE, null, provisioner.kind());
    }

    private static void await(CheckedCondition condition, Duration timeout)
            throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (condition.evaluate()) {
                return;
            }
            Thread.sleep(10);
        }
        assertTrue(condition.evaluate(), "condition did not become true");
    }

    private static RuntimeBrokerException brokerFailure(Throwable failure) {
        Throwable current = failure;
        while (current.getCause() != null
                && !(current instanceof RuntimeBrokerException)) {
            current = current.getCause();
        }
        return (RuntimeBrokerException) current;
    }

    @FunctionalInterface
    private interface CheckedCondition {
        boolean evaluate() throws Exception;
    }

    private static final class DefaultsOnlyProvisioner
            implements RuntimeProvisioner {
        @Override
        public String kind() {
            return "test-scheduler";
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            throw new UnsupportedOperationException(
                    "durable provisioning is not used by this test");
        }
    }

    private static final class BareTransport implements RuntimeTransport {
        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            throw new UnsupportedOperationException("unused");
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            throw new UnsupportedOperationException("unused");
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            throw new UnsupportedOperationException("unused");
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            throw new UnsupportedOperationException("unused");
        }
    }

    private static final class GatedSessionRepository
            implements RuntimeSessionRepository {
        @Override
        public RuntimeSessionRecord findHistorical(String tenant, String harness, String runtime) {
            return delegate.findHistorical(tenant, harness, runtime);
        }

        @Override
        public java.util.List<RuntimeSessionRecord> findByBinding(String id, long generation, String after, int limit) {
            return delegate.findByBinding(id, generation, after, limit);
        }

        private final RuntimeSessionRepository delegate;
        private final CountDownLatch gate;
        private final AtomicInteger counts = new AtomicInteger();

        GatedSessionRepository(RuntimeSessionRepository delegate,
                CountDownLatch gate) {
            this.delegate = delegate;
            this.gate = gate;
        }

        @Override
        public RuntimeSessionRecord findOrCreate(
                RuntimeSessionRecord candidate) {
            return delegate.findOrCreate(candidate);
        }

        @Override
        public RuntimeSessionRecord findById(RuntimeScope scope,
                String runtimeSessionId) {
            return delegate.findById(scope, runtimeSessionId);
        }

        @Override
        public RuntimeSessionRecord compareAndSet(
                RuntimeSessionRecord expected,
                RuntimeSessionRecord replacement) {
            return delegate.compareAndSet(expected, replacement);
        }

        @Override
        public long countActiveByBinding(String bindingId,
                long runtimeGeneration) {
            if (counts.incrementAndGet() == 1) {
                try {
                    gate.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
            }
            return delegate.countActiveByBinding(bindingId,
                    runtimeGeneration);
        }
    }

    private static final class ClaimFailureRepository
            extends DelegatingBindingRepository {
        private final AtomicBoolean fail = new AtomicBoolean(true);

        ClaimFailureRepository(RuntimeBindingRepository delegate) {
            super(delegate);
        }

        @Override
        public RuntimeBindingRecord claimOperation(String bindingId,
                String owner, Duration leaseDuration) {
            if (fail.compareAndSet(true, false)) {
                throw new IllegalStateException("transient database failure");
            }
            return delegate.claimOperation(bindingId, owner, leaseDuration);
        }
    }

    private static final class DurableProvisioner
            implements RuntimeProvisioner {
        private final AtomicInteger ensures = new AtomicInteger();
        private final AtomicInteger reconciliations = new AtomicInteger();
        private final AtomicInteger releaseCalls = new AtomicInteger();
        private RuntimeObservation.Outcome outcome =
                RuntimeObservation.Outcome.READY;
        private RuntimeResourceHandle conflictHandle = HANDLE;
        private RuntimeException ensureFailure;
        private RuntimeException provisionFailure;
        private RuntimeException reconcileFailure;
        private CompletableFuture<RuntimeResourceHandle> ensureGate;
        private CompletableFuture<RuntimeObservation> reconcileGate;
        private RuntimeResourceHandle lastKnownHandle;
        private RuntimeResourceHandle lastReconcileHandle;
        private RuntimeLease lastReconcileLease;
        private RuntimeResourceHandle observedHandle;
        private String observedRuntimeId;
        private String observedLeaseId;
        private Long observedEpoch;
        private RuntimeLease provisionedLease;
        private RuntimeLease releasedLease;
        private boolean notFoundOnce;
        private boolean stopProved;
        private int startingBeforeNotFound;
        private long reconcileDelayMillis;
        private boolean usable = true;

        @Override
        public boolean isUsable(RuntimeLease lease) {
            return usable;
        }

        private RuntimeRecoveryEvidence proof(RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                RuntimeRecoveryEvidence.Fact fact) {
            return new RuntimeRecoveryEvidence(java.util.UUID.randomUUID().toString(), fact,
                    "test-supervisor", Instant.now(), "test-host/domain", seed.getProvisionRequestId(),
                    seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(), seed.getLeaseId(),
                    seed.getEpoch(), handle);
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            throw new AssertionError("legacy provision must not be used");
        }

        @Override
        public String kind() {
            return "test-scheduler";
        }

        @Override
        public CompletionStage<RuntimeResourceHandle> ensureResource(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle knownHandle) {
            ensures.incrementAndGet();
            lastKnownHandle = knownHandle;
            if (ensureFailure != null) {
                return CompletableFuture.failedFuture(ensureFailure);
            }
            if (ensureGate != null) {
                return ensureGate;
            }
            return CompletableFuture.completedFuture(HANDLE);
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            if (provisionFailure != null) {
                RuntimeException failure = provisionFailure;
                provisionFailure = null;
                return CompletableFuture.failedFuture(failure);
            }
            provisionedLease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:4190"), seed.getToken(),
                    seed.getLeaseId(), seed.getEpoch());
            return CompletableFuture.completedFuture(provisionedLease);
        }

        @Override
        public CompletionStage<Void> release(RuntimeProvisionRequest request,
                RuntimeLease lease) {
            releaseCalls.incrementAndGet();
            releasedLease = lease;
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<RuntimeObservation> reconcile(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle handle, RuntimeLease lastLease) {
            reconciliations.incrementAndGet();
            lastReconcileHandle = handle;
            lastReconcileLease = lastLease;
            if (startingBeforeNotFound > 0) {
                startingBeforeNotFound--;
                return CompletableFuture.completedFuture(
                        RuntimeObservation.starting(HANDLE));
            }
            if (reconcileFailure != null) {
                return CompletableFuture.failedFuture(reconcileFailure);
            }
            if (reconcileGate != null) {
                return reconcileGate;
            }
            if (notFoundOnce) {
                notFoundOnce = false;
                if (stopProved) {
                    return CompletableFuture.completedFuture(RuntimeObservation.notFound(
                            proof(seed, handle, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                            proof(seed, handle, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)));
                }
                return CompletableFuture.completedFuture(RuntimeObservation.notFound());
            }
            if (reconcileDelayMillis > 0) {
                return CompletableFuture.supplyAsync(
                        () -> RuntimeObservation.unknown(HANDLE),
                        CompletableFuture.delayedExecutor(
                                reconcileDelayMillis, TimeUnit.MILLISECONDS));
            }
            if (outcome == RuntimeObservation.Outcome.READY) {
                return CompletableFuture.completedFuture(
                        RuntimeObservation.ready(
                                observedHandle == null ? HANDLE
                                        : observedHandle,
                                URI.create("http://127.0.0.1:4190"),
                                observedRuntimeId == null
                                        ? seed.getProvisionalRuntimeId()
                                        : observedRuntimeId,
                                observedLeaseId == null ? seed.getLeaseId()
                                        : observedLeaseId,
                                observedEpoch == null ? seed.getEpoch()
                                        : observedEpoch));
            }
            if (outcome == RuntimeObservation.Outcome.STARTING) {
                return CompletableFuture.completedFuture(
                        RuntimeObservation.starting(HANDLE));
            }
            if (outcome == RuntimeObservation.Outcome.UNKNOWN) {
                return CompletableFuture.completedFuture(
                        RuntimeObservation.unknown(HANDLE));
            }
            if (outcome == RuntimeObservation.Outcome.CONFLICT) {
                return CompletableFuture.completedFuture(
                        RuntimeObservation.conflict(conflictHandle));
            }
            throw new AssertionError("unsupported test outcome");
        }
    }

    /**
     * A binding repository double that watches background renewal ticks and
     * can hold the reconcile loop's loss-evidence write until one lands.
     */
    private static final class ReclaimWatchRepository
            extends DelegatingBindingRepository {
        final AtomicInteger ticks = new AtomicInteger();
        final AtomicBoolean holdEvidenceCas = new AtomicBoolean();
        volatile RuntimeBindingRecord staleRead;
        volatile long holdResourceHandleCasMillis;
        /** Real-time sleep injected once into each LOST-handoff step. */
        volatile long handoffSleepMillis;
        final AtomicBoolean casSlept = new AtomicBoolean();
        final AtomicBoolean claimSlept = new AtomicBoolean();
        final AtomicBoolean recoverSlept = new AtomicBoolean();
        /** Hold the attestation CAS until a renewal tick lands in its window. */
        volatile boolean tickInAdoptWindow;
        final AtomicBoolean adoptTickFired = new AtomicBoolean();

        private void handoffSleep(AtomicBoolean once) {
            if (handoffSleepMillis > 0 && once.compareAndSet(false, true)) {
                try {
                    Thread.sleep(handoffSleepMillis);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        @Override
        public RuntimeBindingRecord claimOperation(String bindingId,
                String owner, Duration leaseDuration) {
            handoffSleep(claimSlept);
            return delegate.claimOperation(bindingId, owner, leaseDuration);
        }

        @Override
        public RuntimeBindingRecord recoverLost(
                RuntimeSessionRepository sessions,
                ToolExecutionRepository executions,
                RuntimeBindingRecord expected) {
            handoffSleep(recoverSlept);
            return delegate.recoverLost(sessions, executions, expected);
        }

        ReclaimWatchRepository(InMemoryRuntimeBindingRepository delegate) {
            super(delegate);
        }

        @Override
        public RuntimeBindingRecord findById(String bindingId) {
            RuntimeBindingRecord stale = staleRead;
            if (stale != null && stale.getBindingId().equals(bindingId)) {
                staleRead = null;
                return stale;
            }
            return delegate.findById(bindingId);
        }

        @Override
        public RuntimeBindingRecord compareAndSet(
                RuntimeBindingRecord expected,
                RuntimeBindingRecord replacement) {
            if (tickInAdoptWindow
                    && replacement.getAttestationGeneration()
                            > expected.getAttestationGeneration()
                    && adoptTickFired.compareAndSet(false, true)) {
                // A slow attestation CAS: give a live background renewal
                // one tick to land between findById and this write; a
                // stopped renewal never arrives (bounded wait, 3s lease).
                int baseline = ticks.get();
                long deadline = System.nanoTime()
                        + Duration.ofMillis(1500).toNanos();
                try {
                    while (ticks.get() == baseline
                            && System.nanoTime() < deadline) {
                        Thread.sleep(10);
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            if (expected.getLossEvidence() == null
                    && replacement.getLossEvidence() != null) {
                handoffSleep(casSlept);
            }
            if (holdResourceHandleCasMillis > 0
                    && expected.getResourceHandle() == null
                    && replacement.getResourceHandle() != null) {
                // persistResourceHandle runs this write on the renewal
                // monitor; holding it queues a dispatched tick behind the
                // monitor, and failing it makes persistResourceHandle call
                // close() reentrantly — the only deterministic staging of
                // the stopped flag's window.
                long millis = holdResourceHandleCasMillis;
                holdResourceHandleCasMillis = 0;
                try {
                    Thread.sleep(millis);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                return null;
            }
            if (holdEvidenceCas.get() && expected.getLossEvidence() == null
                    && replacement.getLossEvidence() != null) {
                // Give a live background renewal one tick to land in the
                // renewal window; a stopped one never arrives. Only ticks
                // newer than the hold count — a tick that fired while the
                // reconcile was still gated must not pre-satisfy the wait.
                int baseline = ticks.get();
                long deadline = System.nanoTime()
                        + Duration.ofMillis(1500).toNanos();
                try {
                    while (ticks.get() == baseline
                            && System.nanoTime() < deadline) {
                        Thread.sleep(10);
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            return delegate.compareAndSet(expected, replacement);
        }

        @Override
        public RuntimeBindingRecord renewOperation(String bindingId,
                String owner, long operationGeneration,
                Duration leaseDuration) {
            if (Thread.currentThread().getName()
                    .equals("qwen-runtime-broker-lease-renewal")) {
                ticks.incrementAndGet();
            }
            return delegate.renewOperation(bindingId, owner,
                    operationGeneration, leaseDuration);
        }
    }

    private static final class TestTransport implements RuntimeTransport {
        private final CompletableFuture<Void> attestationGate;
        private final RuntimeException attestationFailure;
        private volatile boolean mismatch;
        private String attestedIncarnation;
        private String attestedLeaseId;
        private Long attestedEpoch;
        private RuntimeScope attestedScope;
        private String attestedProvisionRequestId;
        private final AtomicInteger attestations = new AtomicInteger();
        private final AtomicInteger acquisitions = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();
        private final AtomicInteger cancels = new AtomicInteger();
        private CompletableFuture<Boolean> releaseResult = CompletableFuture.completedFuture(true);
        private Map<String, Object> cancelAnswer = Map.of();

        TestTransport() {
            this(CompletableFuture.completedFuture(null), false, null);
        }

        TestTransport(CompletableFuture<Void> attestationGate,
                boolean mismatch) {
            this(attestationGate, mismatch, null);
        }

        TestTransport(RuntimeException attestationFailure) {
            this(CompletableFuture.completedFuture(null), false,
                    attestationFailure);
        }

        private TestTransport(CompletableFuture<Void> attestationGate,
                boolean mismatch, RuntimeException attestationFailure) {
            this.attestationGate = attestationGate;
            this.mismatch = mismatch;
            this.attestationFailure = attestationFailure;
        }

        @Override
        public CompletionStage<RuntimeAttestation> attest(
                RuntimeLease lease, RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed) {
            attestations.incrementAndGet();
            if (attestationFailure != null) {
                return CompletableFuture.failedFuture(attestationFailure);
            }
            return attestationGate.thenApply(ignored ->
                    new RuntimeAttestation(
                            mismatch ? "wrong-runtime"
                                    : lease.getRuntimeInstanceId(),
                            attestedIncarnation == null
                                    ? seed.getGatewayIncarnation()
                                    : attestedIncarnation,
                            attestedLeaseId == null ? lease.getLeaseId()
                                    : attestedLeaseId,
                            attestedEpoch == null ? lease.getEpoch()
                                    : attestedEpoch,
                            attestedScope == null ? request.getScope()
                                    : attestedScope,
                            attestedProvisionRequestId == null
                                    ? seed.getProvisionRequestId()
                                    : attestedProvisionRequestId));
        }

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            acquisitions.incrementAndGet();
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            cancels.incrementAndGet();
            return CompletableFuture.completedFuture(cancelAnswer);
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            releases.incrementAndGet();
            return releaseResult;
        }
    }

    private static final class MutableClock extends Clock {
        private Instant current = Instant.parse("2026-09-21T00:00:00Z");

        void advance(Duration duration) {
            current = current.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneId.of("UTC");
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return current;
        }
    }
}
