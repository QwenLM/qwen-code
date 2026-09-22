package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;

class RuntimeBrokerServiceTest {
    private static final Instant START = Instant.parse(
            "2026-09-22T00:00:00Z");
    private static final RuntimeScope WORKSPACE_SCOPE = new RuntimeScope(
            "tenant", "workspace", "generation", "/workspace",
            "capability", "workspace");
    private static final RuntimeScope SESSION_SCOPE = new RuntimeScope(
            "tenant", "workspace", "generation", "/workspace",
            "capability", "session");

    @Test
    void workspaceSessionsShareOneProvisionedBinding() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeSessionRecord first = join(fixture.service.acquire(
                    "harness-a", "runtime-a", "bootstrap"));
            RuntimeSessionRecord second = join(fixture.service.acquire(
                    "harness-b", "runtime-b", "bootstrap"));

            assertEquals(first.getBindingId(), second.getBindingId());
            assertEquals(1, fixture.provisioner.calls.get());
            assertEquals(2, fixture.transport.acquireCalls.get());
        }
    }

    @Test
    void sessionIsolationProvisionsOneBindingPerHarnessSession() {
        try (Fixture fixture = new Fixture(SESSION_SCOPE)) {
            RuntimeSessionRecord first = join(fixture.service.acquire(
                    "harness-a", "runtime-a", "bootstrap"));
            RuntimeSessionRecord second = join(fixture.service.acquire(
                    "harness-b", "runtime-b", "bootstrap"));

            assertNotEquals(first.getBindingId(), second.getBindingId());
            assertEquals(2, fixture.provisioner.calls.get());
        }
    }

    @Test
    void concurrentAcquireOfOneSessionCallsRuntimeOnce() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Void> acquire = new CompletableFuture<>();
            fixture.transport.acquireResult = acquire;

            CompletionStage<RuntimeSessionRecord> first =
                    fixture.service.acquire("harness", "runtime",
                            "bootstrap");
            CompletionStage<RuntimeSessionRecord> second =
                    fixture.service.acquire("harness", "runtime",
                            "bootstrap");

            assertEquals(1, fixture.transport.acquireCalls.get());
            acquire.complete(null);
            assertSame(join(first), join(second));
        }
    }

    @Test
    void failedAcquireCanRetryTheSameSessionIdentity() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.transport.acquireResult = CompletableFuture.failedFuture(
                    new IllegalStateException("connection lost"));

            RuntimeBrokerException failure = failure(
                    fixture.service.acquire("harness", "runtime",
                            "bootstrap"));
            assertEquals("runtime_session_acquire_failed",
                    failure.getCode());

            fixture.transport.acquireResult =
                    CompletableFuture.completedFuture(null);
            RuntimeSessionRecord ready = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            assertEquals(RuntimeSessionRecord.State.READY,
                    ready.getState());
            assertEquals(1, fixture.provisioner.calls.get());
            assertEquals(2, fixture.transport.acquireCalls.get());
        }
    }

    @Test
    void persistedReadyBindingRequiresProcessLocalReconciliation() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                    WORKSPACE_SCOPE, null);
            RuntimeBindingRecord created =
                    fixture.bindingRepository.findOrCreate(request);
            RuntimeBindingRecord claimed = fixture.bindingRepository
                    .claimOperation(created.getBindingId(), "other-owner",
                            Duration.ofMinutes(1));
            fixture.bindingRepository.compareAndSet(claimed,
                    claimed.withState(RuntimeBindingRecord.State.READY,
                            lease(1), START));

            RuntimeBrokerException error = failure(
                    fixture.service.warm("harness"));

            assertEquals("runtime_reconciliation_required",
                    error.getCode());
            assertEquals(0, fixture.provisioner.calls.get());
        }
    }

    @Test
    void duplicateExecutionDispatchesOnceAndReturnsOriginalRecord() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            Map<String, Object> reference = reference("runtime", "digest");

            ToolExecutionRecord first = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency", reference));
            ToolExecutionRecord second = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency", reference));

            assertEquals(first.getExecutionCallId(),
                    second.getExecutionCallId());
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    second.getState());
            assertEquals("success", second.getExecutionStatus());
            assertEquals(1, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void changedRequestCannotReuseAnIdempotencyKey() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            join(fixture.service.createExecution("harness", "runtime",
                    "idempotency", reference("runtime", "digest-a")));

            RuntimeBrokerException error = failure(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest-b")));

            assertEquals("runtime_idempotency_conflict", error.getCode());
            assertEquals(1, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void cancellationIntentSurvivesUntilPhysicalExecutionSettles() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            ToolExecutionRecord cancelling = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId()));

            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                    cancelling.getState());
            assertTrue(cancelling.isCancelRequested());
            assertEquals(1, fixture.transport.cancelCalls.get());
            result.complete(Map.of("executionStatus", "cancelled"));
            ToolExecutionRecord settled = awaitExecution(
                    fixture.executionRepository,
                    created.getExecutionCallId(),
                    ToolExecutionRecord.State.SETTLED);
            assertEquals("cancelled", settled.getExecutionStatus());
        }
    }

    @Test
    void ambiguousTransportFailureMarksExecutionUnknown() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.transport.executeResult = CompletableFuture.failedFuture(
                    new IllegalStateException("connection lost"));
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));

            ToolExecutionRecord record = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    record.getState());
        }
    }

    @Test
    void releaseWaitsForActiveExecutionAndThenRemovesSession() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            RuntimeBrokerException busy = failure(
                    fixture.service.release("harness", "runtime"));
            assertEquals("runtime_session_busy", busy.getCode());
            result.complete(Map.of("executionStatus", "success"));
            awaitExecution(fixture.executionRepository,
                    created.getExecutionCallId(),
                    ToolExecutionRecord.State.SETTLED);

            assertTrue(join(fixture.service.release(
                    "harness", "runtime")));
            assertEquals(1, fixture.transport.releaseCalls.get());
            assertTrue(join(fixture.service.release(
                    "harness", "runtime")));
            assertEquals(1, fixture.transport.releaseCalls.get());
            assertEquals("runtime_session_not_found",
                    failure(fixture.service.getExecution("harness",
                            "runtime", created.getExecutionCallId()))
                                    .getCode());
        }
    }

    @Test
    void dispatchLeaseIsRenewedUntilExecutionCompletes() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofMillis(60))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));
            long initialVersion = created.getVersion();

            await(() -> fixture.executionRepository
                    .findByExecutionCallId(created.getExecutionCallId())
                    .getVersion() > initialVersion);
            long firstRenewalVersion = fixture.executionRepository
                    .findByExecutionCallId(created.getExecutionCallId())
                    .getVersion();
            clock.advance(Duration.ofMillis(40));
            await(() -> fixture.executionRepository
                    .findByExecutionCallId(created.getExecutionCallId())
                    .getVersion() > firstRenewalVersion);
            clock.advance(Duration.ofMillis(40));
            result.complete(Map.of("executionStatus", "success"));

            assertEquals(ToolExecutionRecord.State.SETTLED,
                    awaitExecution(fixture.executionRepository,
                            created.getExecutionCallId(),
                            ToolExecutionRecord.State.SETTLED).getState());
        }
    }

    @Test
    void provisioningLeaseIsRenewedUntilProvisionerCompletes() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofMillis(60), Duration.ofMinutes(1))) {
            CompletableFuture<RuntimeLease> lease = new CompletableFuture<>();
            fixture.provisioner.provisionResult = lease;

            CompletionStage<RuntimeBindingRecord> warm =
                    fixture.service.warm("harness");
            RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                    WORKSPACE_SCOPE, null);
            await(() -> fixture.bindingRepository.findActive(request)
                    .getVersion() > 1);
            long firstRenewalVersion = fixture.bindingRepository
                    .findActive(request).getVersion();
            clock.advance(Duration.ofMillis(40));
            await(() -> fixture.bindingRepository.findActive(request)
                    .getVersion() > firstRenewalVersion);
            clock.advance(Duration.ofMillis(40));
            lease.complete(lease(1));

            assertEquals(RuntimeBindingRecord.State.READY,
                    join(warm).getState());
        }
    }

    @Test
    void inFlightControlBlocksRelease() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            CompletableFuture<Object> control = new CompletableFuture<>();
            fixture.transport.controlResult = control;

            CompletionStage<Object> status = fixture.service.control(
                    "harness", "runtime",
                    Map.of("kind", "preflight"));
            RuntimeBrokerException busy = failure(
                    fixture.service.release("harness", "runtime"));

            assertEquals("runtime_session_busy", busy.getCode());
            control.complete("ready");
            assertEquals("ready", join(status));
            assertTrue(join(fixture.service.release(
                    "harness", "runtime")));
        }
    }

    @Test
    void controlUsesTheExistingPrivateOperationAllowlist() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));

            assertEquals("ok", join(fixture.service.control(
                    "harness", "runtime",
                    Map.of("kind", "manifest"))));
            assertEquals("manifest",
                    fixture.transport.lastControl.get("kind"));
            RuntimeBrokerException error = assertThrows(
                    RuntimeBrokerException.class,
                    () -> fixture.service.control("harness", "runtime",
                            Map.of("kind", "status")));
            assertEquals("runtime_control_operation_invalid",
                    error.getCode());
        }
    }

    @Test
    void settledCancellationWinsOverLateExecutionCompletion() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Map<String, Object>> execution =
                    new CompletableFuture<>();
            fixture.transport.executeResult = execution;
            fixture.transport.cancelResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "cancelRequested", true,
                            "result", Map.of(
                                    "executionStatus", "cancelled")));
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            ToolExecutionRecord cancelled = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId()));
            execution.complete(Map.of("executionStatus", "success"));

            assertEquals(ToolExecutionRecord.State.SETTLED,
                    cancelled.getState());
            assertEquals("cancelled", join(fixture.service.getExecution(
                    "harness", "runtime", created.getExecutionCallId()))
                            .getExecutionStatus());
        }
    }

    @Test
    void concurrentReleaseCallsRuntimeOnce() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            CompletableFuture<Boolean> release = new CompletableFuture<>();
            fixture.transport.releaseResult = release;

            CompletionStage<Boolean> first = fixture.service.release(
                    "harness", "runtime");
            CompletionStage<Boolean> second = fixture.service.release(
                    "harness", "runtime");

            assertEquals(1, fixture.transport.releaseCalls.get());
            release.complete(true);
            assertTrue(join(first));
            assertTrue(join(second));
        }
    }

    @Test
    void runtimeSessionIdentityCannotMoveBetweenHarnessSessions() {
        try (Fixture fixture = new Fixture(SESSION_SCOPE)) {
            join(fixture.service.acquire("harness-a", "runtime",
                    "bootstrap"));

            RuntimeBrokerException error = failure(
                    fixture.service.acquire("harness-b", "runtime",
                            "bootstrap"));

            assertEquals("runtime_session_conflict", error.getCode());
            assertEquals(1, fixture.provisioner.calls.get());
        }
    }

    private static RuntimeLease lease(int index) {
        return new RuntimeLease("runtime-" + index,
                URI.create("http://127.0.0.1:" + (4000 + index)),
                "token-" + index, "lease-" + index, index);
    }

    private static Map<String, Object> reference(String runtimeSessionId,
            String digest) {
        return Map.of("sessionId", runtimeSessionId,
                "promptId", "prompt", "callId", "call",
                "argsDigest", digest);
    }

    private static ToolExecutionRecord awaitExecution(
            ToolExecutionRepository repository, String executionCallId,
            ToolExecutionRecord.State state) {
        await(() -> {
            ToolExecutionRecord record = repository
                    .findByExecutionCallId(executionCallId);
            return record != null && record.getState() == state;
        });
        return repository.findByExecutionCallId(executionCallId);
    }

    private static void await(BooleanSupplier condition) {
        long deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() >= deadline) {
                throw new AssertionError("condition was not met in time");
            }
            try {
                Thread.sleep(5);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new AssertionError("interrupted while waiting",
                        exception);
            }
        }
    }

    private static <T> T join(CompletionStage<T> stage) {
        return stage.toCompletableFuture().join();
    }

    private static RuntimeBrokerException failure(
            CompletionStage<?> stage) {
        CompletionException exception = assertThrows(
                CompletionException.class,
                () -> stage.toCompletableFuture().join());
        Throwable cause = exception;
        while (cause.getCause() != null
                && !(cause instanceof RuntimeBrokerException)) {
            cause = cause.getCause();
        }
        assertTrue(cause instanceof RuntimeBrokerException);
        return (RuntimeBrokerException) cause;
    }

    private static final class Fixture implements AutoCloseable {
        final AtomicInteger bindingIds = new AtomicInteger();
        final AtomicInteger executionIds = new AtomicInteger();
        final InMemoryRuntimeBindingRepository bindingRepository;
        final InMemoryRuntimeSessionRepository sessionRepository =
                new InMemoryRuntimeSessionRepository();
        final InMemoryToolExecutionRepository executionRepository;
        final FakeProvisioner provisioner = new FakeProvisioner();
        final FakeTransport transport = new FakeTransport();
        final RuntimeBrokerService service;

        Fixture(RuntimeScope scope) {
            this(scope, new MutableClock(START), Duration.ofMinutes(1));
        }

        Fixture(RuntimeScope scope, Clock clock,
                Duration dispatchLeaseDuration) {
            this(scope, clock, Duration.ofMinutes(1),
                    dispatchLeaseDuration);
        }

        Fixture(RuntimeScope scope, Clock clock,
                Duration operationLeaseDuration,
                Duration dispatchLeaseDuration) {
            bindingRepository = new InMemoryRuntimeBindingRepository(clock,
                    () -> "binding-" + bindingIds.incrementAndGet());
            executionRepository =
                    new InMemoryToolExecutionRepository(clock);
            service = new RuntimeBrokerService(
                    ignored -> CompletableFuture.completedFuture(scope),
                    provisioner, transport, bindingRepository,
                    sessionRepository, executionRepository, "broker",
                    operationLeaseDuration, dispatchLeaseDuration, clock,
                    () -> "execution-" + executionIds.incrementAndGet());
        }

        @Override
        public void close() {
            service.close();
        }
    }

    private static final class FakeProvisioner
            implements RuntimeProvisioner {
        final AtomicInteger calls = new AtomicInteger();
        volatile CompletableFuture<RuntimeLease> provisionResult;

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            int call = calls.incrementAndGet();
            return provisionResult == null
                    ? CompletableFuture.completedFuture(lease(call))
                    : provisionResult;
        }
    }

    private static final class FakeTransport implements RuntimeTransport {
        final AtomicInteger acquireCalls = new AtomicInteger();
        final AtomicInteger executeCalls = new AtomicInteger();
        final AtomicInteger cancelCalls = new AtomicInteger();
        final AtomicInteger releaseCalls = new AtomicInteger();
        volatile CompletableFuture<Void> acquireResult =
                CompletableFuture.completedFuture(null);
        volatile CompletableFuture<Object> controlResult =
                CompletableFuture.completedFuture("ok");
        volatile Map<String, Object> lastControl;
        volatile CompletableFuture<Map<String, Object>> executeResult =
                CompletableFuture.completedFuture(
                        Map.of("executionStatus", "success"));
        volatile CompletableFuture<Map<String, Object>> cancelResult =
                CompletableFuture.completedFuture(
                        Map.of("state", "cancel_requested"));
        volatile CompletableFuture<Boolean> releaseResult =
                CompletableFuture.completedFuture(true);

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            acquireCalls.incrementAndGet();
            return acquireResult;
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session,
                Map<String, Object> operation) {
            lastControl = operation;
            return controlResult;
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            executeCalls.incrementAndGet();
            return executeResult;
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancelCalls.incrementAndGet();
            return cancelResult;
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            releaseCalls.incrementAndGet();
            return releaseResult;
        }
    }

    private static final class MutableClock extends Clock {
        private final AtomicReference<Instant> instant;

        MutableClock(Instant instant) {
            this.instant = new AtomicReference<>(instant);
        }

        void advance(Duration duration) {
            instant.updateAndGet(value -> value.plus(duration));
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return instant.get();
        }
    }
}
