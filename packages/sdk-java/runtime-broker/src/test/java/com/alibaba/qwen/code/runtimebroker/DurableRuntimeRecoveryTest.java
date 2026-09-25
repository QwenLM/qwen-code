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
        RuntimeLease initialLease = bindings.findActive(request(initial))
                .getLease();

        DurableProvisioner restored = new DurableProvisioner();
        CompletableFuture<Void> attestationGate = new CompletableFuture<>();
        TestTransport transport = new TestTransport(attestationGate, false);
        try (RuntimeBrokerService service = service(restored, transport,
                bindings, sessions, executions, "broker-two")) {
            CompletableFuture<Void> acquired = service.acquire("harness",
                    "runtime-session", "bootstrap").toCompletableFuture();

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
            assertEquals(initialLease.getLeaseId(),
                    restored.lastReconcileLease.getLeaseId());
            assertEquals(initialLease.getRuntimeInstanceId(),
                    restored.lastReconcileLease.getRuntimeInstanceId());
            assertEquals(initialLease.getEpoch(),
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
        try (RuntimeBrokerService service = service(unknown,
                new TestTransport(), bindings, sessions, executions,
                "broker-two", Duration.ofMillis(100))) {
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
        DurableProvisioner unavailable = new DurableProvisioner();
        unavailable.outcome = RuntimeObservation.Outcome.UNKNOWN;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                unavailable, new TestTransport(), bindings, sessions,
                executions, "broker-one", Duration.ofMillis(20),
                Duration.ofSeconds(1), Duration.ofMinutes(5),
                Duration.ofMillis(1))) {
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
                "broker-two")) {
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
        DurableProvisioner unavailable = new DurableProvisioner();
        unavailable.reconcileGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                unavailable, new TestTransport(), bindings, sessions,
                executions, "broker-one", Duration.ofMillis(20),
                Duration.ofSeconds(1), Duration.ofMinutes(5),
                Duration.ofMillis(1))) {
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
                "broker-two")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(recovered)).getState());
        }
    }

    @Test
    void lateAttestationCannotDrainARestoredReadyBinding()
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
                Duration.ofMillis(20), Duration.ofSeconds(1),
                Duration.ofMillis(20), Duration.ofMillis(1))) {
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
            assertEquals(0, restored.drains.get());
            assertEquals(0, restored.releases.get());
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
            CompletableFuture<Void> firstWarm = CompletableFuture.supplyAsync(
                    () -> service.warm("harness").toCompletableFuture()
                            .join());
            await(() -> restored.reconciliations.get() == 1,
                    Duration.ofSeconds(1));
            CompletableFuture<Void> secondWarm = service.warm("harness")
                    .toCompletableFuture();
            attestationGate.complete(null);

            firstWarm.get(2, TimeUnit.SECONDS);
            secondWarm.get(2, TimeUnit.SECONDS);
            assertEquals(1, restored.reconciliations.get());
            RuntimeBindingRecord adopted = bindings.findActive(
                    request(restored));
            assertEquals(1, adopted.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    adopted.getState());
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
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DefaultsOnlyProvisioner provisioner = new DefaultsOnlyProvisioner();
        try (RuntimeBrokerService service = service(provisioner,
                new BareTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofMillis(20))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));

            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            RuntimeBindingRecord pending = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    pending.getState());
            assertNull(pending.getLease());
            assertNull(pending.getResourceHandle());
            assertNull(pending.getOperationOwner());
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
        try (RuntimeBrokerService service = service(restored,
                new BareTransport(), bindings, sessions, executions,
                "broker-two", Duration.ofMillis(20))) {
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
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
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
                    bindings.findActive(request(provisioner)).getState());
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
        TestTransport throttledTransport = new TestTransport(
                new RuntimeBrokerException(502,
                        "managed_runtime_incompatible", "throttled", false));
        try (RuntimeBrokerService service = service(throttled,
                throttledTransport, bindings, sessions, executions,
                "broker-two")) {
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

            // The same process retries on the next call instead of
            // replaying the failure it saw once.
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            assertEquals(2, throttledTransport.attestations.get());
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
    void aTransientHealthAttestationFailureDoesNotBlockTheBinding()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        TestTransport transport = new TestTransport();
        try (RuntimeBrokerService service = service(provisioner, transport,
                bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            transport.failure = new RuntimeBrokerException(502,
                    "managed_runtime_incompatible", "throttled", false);
            Thread.sleep(5);

            Exception failure = assertThrows(Exception.class,
                    () -> service.acquire("harness", "throttled-session",
                            "bootstrap").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_health_failed",
                    brokerFailure(failure).getCode());
            RuntimeBindingRecord waiting = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.READY,
                    waiting.getState());
            assertNull(waiting.getOperationOwner());

            transport.failure = null;
            service.acquire("harness", "recovered-session", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
            assertEquals(1, transport.acquisitions.get());
        }
    }

    @Test
    void sessionsLeftAcquiringOrReleasingSettleAgainstALostBinding()
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
            service.acquire("harness", "sess-ready", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
            service.acquire("harness", "sess-releasing", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
        }

        // A Broker killed mid-acquire and mid-release leaves these behind.
        RuntimeSessionRecord acquired = sessions.findById("sess-acquiring");
        sessions.compareAndSet(acquired, acquired.withState(
                RuntimeSessionRecord.State.ACQUIRING, Instant.now()));
        RuntimeSessionRecord releasing = sessions.findById("sess-releasing");
        sessions.compareAndSet(releasing, releasing.withState(
                RuntimeSessionRecord.State.RELEASING, Instant.now()));

        DurableProvisioner recovered = new DurableProvisioner();
        recovered.notFoundOnce = true;
        TestTransport transport = new TestTransport();
        try (RuntimeBrokerService service = service(recovered, transport,
                bindings, sessions, executions, "broker-two")) {
            Exception lost = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_runtime_lost",
                    brokerFailure(lost).getCode());

            for (String session : List.of("sess-acquiring", "sess-ready",
                    "sess-releasing")) {
                assertTrue(service.release("harness", session)
                        .toCompletableFuture().get(2, TimeUnit.SECONDS));
                assertEquals(RuntimeSessionRecord.State.RELEASED,
                        sessions.findById(session).getState());
            }
            assertEquals(0, transport.releases.get());

            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            RuntimeBindingRecord replacement = bindings.findActive(
                    request(recovered));
            assertEquals(2, replacement.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    replacement.getState());
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
        TestTransport transport = new TestTransport();
        try (RuntimeBrokerService service = service(restored, transport,
                bindings, sessions, executions, "broker-two")) {
            assertTrue(service.release("harness", "live-session")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            // The restored Runtime is re-attested and confirms the release;
            // nothing settles on the Broker's word alone.
            assertTrue(transport.attestations.get() >= 1);
            assertEquals(1, transport.releases.get());
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    sessions.findById("live-session").getState());
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
    void unknownHealthRefreshReleasesItsClaimAndCanRetry()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        TestTransport transport = new TestTransport();
        try (RuntimeBrokerService service = service(provisioner, transport,
                bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            provisioner.outcome = RuntimeObservation.Outcome.UNKNOWN;
            Thread.sleep(5);

            assertThrows(Exception.class, () -> service.acquire("harness",
                    "failed-session", "bootstrap").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS));
            RuntimeBindingRecord retryable = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.READY,
                    retryable.getState());
            assertNull(retryable.getOperationOwner());

            provisioner.outcome = RuntimeObservation.Outcome.READY;
            service.acquire("harness", "recovered-session", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
            assertEquals(1, transport.acquisitions.get());
        }
    }

    @Test
    void anInFlightHealthRefreshIsBoundedByTheOperationDeadline()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        TestTransport transport = new TestTransport();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofMillis(20), Duration.ofSeconds(1),
                Duration.ofMinutes(5), Duration.ofMillis(1))) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            provisioner.reconcileGate = new CompletableFuture<>();
            Thread.sleep(5);

            Exception failure = assertThrows(Exception.class,
                    () -> service.acquire("harness", "failed-session",
                            "bootstrap").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_health_failed",
                    brokerFailure(failure).getCode());
            RuntimeBindingRecord current = bindings.findActive(
                    request(provisioner));
            assertNull(current.getOperationOwner());
            assertEquals(1, transport.attestations.get());

            RuntimeProvisionSeed seed = current.getProvisionSeed();
            provisioner.reconcileGate.complete(RuntimeObservation.ready(
                    HANDLE, URI.create("http://127.0.0.1:4190"),
                    seed.getProvisionalRuntimeId(), seed.getLeaseId(),
                    seed.getEpoch()));
            assertEquals(1, transport.attestations.get());
        }
    }

    @Test
    void healthRefreshAttestationMismatchBlocksTheBinding()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        TestTransport transport = new TestTransport();
        try (RuntimeBrokerService service = service(provisioner, transport,
                bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one")) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            service.acquire("harness", "existing-session", "bootstrap")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
            transport.mismatch = true;
            Thread.sleep(5);

            assertThrows(Exception.class, () -> service.acquire("harness",
                    "runtime-session", "bootstrap").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS));
            RuntimeBindingRecord blocked = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    blocked.getState());
            assertNull(blocked.getOperationOwner());
            RuntimeBrokerException blockedOperation = assertThrows(
                    RuntimeBrokerException.class, () -> service.control(
                            "harness", "existing-session",
                            Map.of("kind", "history")));
            assertEquals("runtime_broker_binding_unavailable",
                    blockedOperation.getCode());
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
    void timedOutProvisioningKeepsTheEnsuredResource() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.outcome = RuntimeObservation.Outcome.UNKNOWN;
        try (RuntimeBrokerService service = service(provisioner,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofMillis(20))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());

            RuntimeBindingRecord pending = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    pending.getState());
            assertEquals(HANDLE, pending.getResourceHandle());
            String bindingId = pending.getBindingId();
            long generation = pending.getGeneration();

            provisioner.outcome = RuntimeObservation.Outcome.READY;
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            RuntimeBindingRecord ready = bindings.findActive(
                    request(provisioner));
            assertEquals(bindingId, ready.getBindingId());
            assertEquals(generation, ready.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY, ready.getState());
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
        try (RuntimeBrokerService service = service(starting,
                new TestTransport(), bindings, sessions, executions,
                "broker-two", Duration.ofMillis(100))) {
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
        try (RuntimeBrokerService service = service(failing,
                new TestTransport(), bindings, sessions, executions,
                "broker-two", Duration.ofMillis(20))) {
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

            assertEquals("managed_runtime_identity_conflict",
                    brokerFailure(failure).getCode());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(request(failing)).getState());
        }
    }

    @Test
    void retryableEnsureFailureKeepsAFreshBindingRetryable()
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
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofMillis(20))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_reconcile_timeout",
                    brokerFailure(failure).getCode());
            RuntimeBindingRecord pending = bindings.findById("binding-1");
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    pending.getState());
            assertNull(pending.getOperationOwner());

            provisioner.ensureFailure = null;
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            RuntimeBindingRecord ready = bindings.findById("binding-1");
            assertEquals(1, ready.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY, ready.getState());
            assertNull(bindings.findById("binding-2"));
        }
    }

    @Test
    void parkedProvisionIsBoundedByTheOperationDeadline() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.ensureGate = new CompletableFuture<>();
        try (RuntimeBrokerService service = service(provisioner,
                new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofMillis(20))) {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm("harness").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS));
            assertEquals("runtime_broker_reconcile_timeout",
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
            assertNull(afterLateResult.getResourceHandle());
            assertNull(afterLateResult.getOperationOwner());
        }
    }

    @Test
    void releaseConflictKeepsTheBindingRecoveryBlocked() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.releaseFailure = new RuntimeBrokerException(409,
                "runtime_broker_resource_conflict", "conflict", false);
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofSeconds(1), Duration.ofSeconds(1),
                Duration.ofMillis(1), Duration.ofMillis(1))) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            await(() -> bindings.findActive(request(provisioner)).getState()
                            == RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    Duration.ofSeconds(1));

            RuntimeBindingRecord blocked = bindings.findActive(
                    request(provisioner));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    blocked.getState());
            assertEquals(1, blocked.getGeneration());
        }
    }

    @Test
    void synchronousDrainConflictKeepsTheBindingRecoveryBlocked()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        DurableProvisioner provisioner = new DurableProvisioner();
        provisioner.drainFailure = new RuntimeBrokerException(409,
                "runtime_broker_resource_conflict", "conflict", false);
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new TestTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one",
                Duration.ofSeconds(1), Duration.ofSeconds(1),
                Duration.ofMillis(1), Duration.ofMillis(1))) {
            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            await(() -> bindings.findActive(request(provisioner)).getState()
                            == RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    Duration.ofSeconds(1));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(request(provisioner)).getState());
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
        RuntimeSessionRecord acquired = sessions.findById("pinned-session");
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

        CountDownLatch reclaimGate = new CountDownLatch(1);
        GatedSessionRepository gated = new GatedSessionRepository(sessions,
                reclaimGate);
        DurableProvisioner recovered = new DurableProvisioner();
        recovered.notFoundOnce = true;
        try (RuntimeBrokerService service = service(recovered,
                new TestTransport(), bindings, gated, executions,
                "broker-two")) {
            CompletableFuture<Void> firstWarm = CompletableFuture.supplyAsync(
                    () -> service.warm("harness").toCompletableFuture()
                            .join());
            await(() -> gated.counts.get() == 1, Duration.ofSeconds(1));
            CompletableFuture<Void> secondWarm = service.warm("harness")
                    .toCompletableFuture();
            reclaimGate.countDown();

            firstWarm.get(2, TimeUnit.SECONDS);
            secondWarm.get(2, TimeUnit.SECONDS);
            RuntimeBindingRecord replacement = bindings.findActive(
                    request(recovered));
            assertEquals(2, replacement.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    replacement.getState());
            assertEquals(1, recovered.ensures.get());
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
        firstService.warm("harness");
        await(() -> first.ensures.get() == 1, Duration.ofSeconds(1));
        firstService.close();
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
    }

    @Test
    void authoritativeLossCreatesANewGenerationOnlyWhenIdle()
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
            assertEquals("runtime_broker_execution_active",
                    brokerFailure(pinned).getCode());
            executions.requestCancel(active.getExecutionCallId(),
                    active.getVersion());

            assertTrue(service.release("harness", "active-session")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    sessions.findById("active-session").getState());

            service.warm("harness").toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            RuntimeBindingRecord replacement = bindings.findActive(
                    request(recovered));
            assertEquals(2, replacement.getGeneration());
            assertEquals(RuntimeBindingRecord.State.READY,
                    replacement.getState());
            assertEquals(1, recovered.ensures.get());
        }
    }

    private static RuntimeBrokerService service(
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String owner) {
        return service(provisioner, transport, bindings, sessions,
                executions, owner, Duration.ofSeconds(1));
    }

    private static RuntimeBrokerService service(
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String owner,
            Duration operationLease) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                owner, operationLease, Duration.ofSeconds(1),
                Duration.ofMinutes(5), Duration.ofMillis(1));
    }

    private static RuntimeProvisionRequest request(
            RuntimeProvisioner provisioner) {
        return new RuntimeProvisionRequest(SCOPE, null, provisioner.kind(),
                provisioner.placementDomain(),
                provisioner.runtimeTemplateDigest());
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

    /** Opts into durable recovery without implementing any of it. */
    private static final class DefaultsOnlyProvisioner
            implements RuntimeProvisioner {
        @Override
        public String kind() {
            return "test-scheduler";
        }

        @Override
        public String placementDomain() {
            return "test-cluster";
        }

        @Override
        public String runtimeTemplateDigest() {
            return "sha256:test-template";
        }

        @Override
        public boolean supportsDurableRecovery() {
            return true;
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
        public RuntimeSessionRecord findById(String runtimeSessionId) {
            return delegate.findById(runtimeSessionId);
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
            implements RuntimeBindingRepository {
        private final RuntimeBindingRepository delegate;
        private final AtomicBoolean fail = new AtomicBoolean(true);

        ClaimFailureRepository(RuntimeBindingRepository delegate) {
            this.delegate = delegate;
        }

        @Override
        public RuntimeBindingRecord findOrCreate(
                RuntimeProvisionRequest request) {
            return delegate.findOrCreate(request);
        }

        @Override
        public RuntimeBindingRecord findActive(
                RuntimeProvisionRequest request) {
            return delegate.findActive(request);
        }

        @Override
        public List<RuntimeBindingRecord> findActiveByIsolationKey(
                String isolationKey) {
            return delegate.findActiveByIsolationKey(isolationKey);
        }

        @Override
        public RuntimeBindingRecord findById(String bindingId) {
            return delegate.findById(bindingId);
        }

        @Override
        public RuntimeBindingRecord compareAndSet(
                RuntimeBindingRecord expected,
                RuntimeBindingRecord replacement) {
            return delegate.compareAndSet(expected, replacement);
        }

        @Override
        public RuntimeBindingRecord claimOperation(String bindingId,
                String owner, Duration leaseDuration) {
            if (fail.compareAndSet(true, false)) {
                throw new IllegalStateException("transient database failure");
            }
            return delegate.claimOperation(bindingId, owner, leaseDuration);
        }

        @Override
        public RuntimeBindingRecord renewOperation(String bindingId,
                String owner, long operationGeneration,
                Duration leaseDuration) {
            return delegate.renewOperation(bindingId, owner,
                    operationGeneration, leaseDuration);
        }

        @Override
        public RuntimeBindingRecord releaseOperation(String bindingId,
                String owner, long operationGeneration) {
            return delegate.releaseOperation(bindingId, owner,
                    operationGeneration);
        }
    }

    private static final class DurableProvisioner
            implements RuntimeProvisioner {
        private final AtomicInteger ensures = new AtomicInteger();
        private final AtomicInteger reconciliations = new AtomicInteger();
        private final AtomicInteger drains = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();
        private RuntimeObservation.Outcome outcome =
                RuntimeObservation.Outcome.READY;
        private RuntimeResourceHandle conflictHandle = HANDLE;
        private RuntimeException ensureFailure;
        private RuntimeException reconcileFailure;
        private RuntimeException drainFailure;
        private RuntimeException releaseFailure;
        private CompletableFuture<RuntimeResourceHandle> ensureGate;
        private CompletableFuture<RuntimeObservation> reconcileGate;
        private volatile RuntimeResourceHandle lastKnownHandle;
        private volatile RuntimeResourceHandle lastReconcileHandle;
        private volatile RuntimeLease lastReconcileLease;
        private RuntimeResourceHandle observedHandle;
        private String observedRuntimeId;
        private String observedLeaseId;
        private Long observedEpoch;
        private boolean notFoundOnce;

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
        public String placementDomain() {
            return "test-cluster";
        }

        @Override
        public String runtimeTemplateDigest() {
            return "sha256:test-template";
        }

        @Override
        public boolean supportsDurableRecovery() {
            return true;
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
        public CompletionStage<RuntimeObservation> reconcile(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
            reconciliations.incrementAndGet();
            lastReconcileHandle = handle;
            lastReconcileLease = lastLease;
            if (reconcileFailure != null) {
                return CompletableFuture.failedFuture(reconcileFailure);
            }
            if (reconcileGate != null) {
                return reconcileGate;
            }
            if (notFoundOnce) {
                notFoundOnce = false;
                return CompletableFuture.completedFuture(
                        RuntimeObservation.notFound());
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

        @Override
        public CompletionStage<Void> drain(RuntimeResourceContext resource) {
            drains.incrementAndGet();
            if (drainFailure != null) {
                throw drainFailure;
            }
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Void> release(
                RuntimeResourceContext resource) {
            releases.incrementAndGet();
            return releaseFailure == null
                    ? CompletableFuture.completedFuture(null)
                    : CompletableFuture.failedFuture(releaseFailure);
        }
    }

    private static final class TestTransport implements RuntimeTransport {
        private final CompletableFuture<Void> attestationGate;
        private volatile boolean mismatch;
        private volatile RuntimeException failure;
        private String attestedIncarnation;
        private String attestedLeaseId;
        private Long attestedEpoch;
        private RuntimeScope attestedScope;
        private String attestedProvisionRequestId;
        private final AtomicInteger attestations = new AtomicInteger();
        private final AtomicInteger acquisitions = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();

        TestTransport() {
            this(CompletableFuture.completedFuture(null), false);
        }

        TestTransport(RuntimeException failure) {
            this(CompletableFuture.completedFuture(null), false);
            this.failure = failure;
        }

        TestTransport(CompletableFuture<Void> attestationGate,
                boolean mismatch) {
            this.attestationGate = attestationGate;
            this.mismatch = mismatch;
        }

        @Override
        public CompletionStage<RuntimeAttestation> attest(
                RuntimeLease lease, RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed) {
            attestations.incrementAndGet();
            RuntimeException attestationFailure = failure;
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
        public CompletionStage<Map<String, Object>> status(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, long afterSequence) {
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            releases.incrementAndGet();
            return CompletableFuture.completedFuture(true);
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
