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
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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
        try (RuntimeBrokerService service = service(unknown,
                new TestTransport(), bindings, sessions, executions,
                "broker-two")) {
            CompletableFuture<RuntimeBindingRecord> warm =
                    service.warm("harness").toCompletableFuture();
            await(() -> unknown.reconciliations.get() > 0,
                    Duration.ofSeconds(1));

            assertFalse(warm.isDone());
            assertEquals(0, unknown.ensures.get());
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findActive(request(unknown)).getState());
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
            assertThrows(Exception.class, () -> service.warm("harness")
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));

            RuntimeBindingRecord blocked = bindings.findActive(
                    request(recovered));
            assertEquals(1, blocked.getGeneration());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    blocked.getState());
            assertEquals(0, recovered.ensures.get());
        }
    }

    private static RuntimeBrokerService service(
            DurableProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String owner) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                owner, Duration.ofSeconds(1), Duration.ofSeconds(1));
    }

    private static RuntimeProvisionRequest request(
            DurableProvisioner provisioner) {
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

    private static final class DurableProvisioner
            implements RuntimeProvisioner {
        private final AtomicInteger ensures = new AtomicInteger();
        private final AtomicInteger reconciliations = new AtomicInteger();
        private final AtomicInteger releaseCalls = new AtomicInteger();
        private RuntimeObservation.Outcome outcome =
                RuntimeObservation.Outcome.READY;
        private RuntimeResourceHandle conflictHandle = HANDLE;
        private RuntimeException ensureFailure;
        private CompletableFuture<RuntimeResourceHandle> ensureGate;
        private CompletableFuture<RuntimeObservation> reconcileGate;
        private RuntimeLease provisionedLease;
        private RuntimeLease releasedLease;
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
        public CompletionStage<RuntimeResourceHandle> ensureResource(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle knownHandle) {
            ensures.incrementAndGet();
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
                        RuntimeObservation.ready(HANDLE,
                                URI.create("http://127.0.0.1:4190"),
                                seed.getProvisionalRuntimeId(),
                                seed.getLeaseId(), seed.getEpoch()));
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

    private static final class TestTransport implements RuntimeTransport {
        private final CompletableFuture<Void> attestationGate;
        private final RuntimeException attestationFailure;
        private volatile boolean mismatch;
        private final AtomicInteger attestations = new AtomicInteger();
        private final AtomicInteger acquisitions = new AtomicInteger();

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
                            seed.getGatewayIncarnation(), lease.getLeaseId(),
                            lease.getEpoch(), request.getScope(),
                            seed.getProvisionRequestId()));
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
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
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
