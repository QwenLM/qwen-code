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
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
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
            assertEquals(fixture.provisioner.issuedLease,
                    fixture.transport.lastLease);
            assertEquals("runtime-b", fixture.transport.lastSession
                    .getRuntimeSessionId());
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
            assertEquals(reference, fixture.transport.lastReference);
        }
    }

    @Test
    void dispatcherThatLosesItsClaimDoesNotExecute() {
        MutableClock clock = new MutableClock(START);
        TakeoverExecutionRepository executions =
                new TakeoverExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        transport.executionRepository = executions;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(WORKSPACE_SCOPE),
                new FakeProvisioner(), transport,
                new InMemoryRuntimeBindingRepository(clock,
                        () -> "binding"),
                new InMemoryRuntimeSessionRepository(), executions,
                "broker-a", Duration.ofMinutes(1), Duration.ofSeconds(1),
                clock, () -> "execution")) {
            join(service.acquire("harness", "runtime", "bootstrap"));

            join(service.createExecution("harness", "runtime",
                    "idempotency", reference("runtime", "digest")));

            assertEquals(0, transport.executeCalls.get());
            ToolExecutionRecord current = executions
                    .findByExecutionCallId("execution");
            assertEquals(ToolExecutionRecord.State.EXECUTING,
                    current.getState());
            assertEquals("broker-b", current.getDispatchOwner());
            assertEquals(2, current.getDispatchGeneration());
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
            fixture.transport.observedExecutionId =
                    created.getExecutionCallId();

            ToolExecutionRecord cancelling = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId()));

            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                    cancelling.getState());
            assertTrue(cancelling.isCancelRequested());
            assertEquals(1, fixture.transport.cancelCalls.get());
            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                    fixture.transport.recordAtCancel.getState());
            assertTrue(fixture.transport.recordAtCancel
                    .isCancelRequested());
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

    @Test
    void concurrentProvisioningCallsProvisionerOnce() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<RuntimeLease> lease = new CompletableFuture<>();
            fixture.provisioner.provisionResult = lease;

            CompletionStage<RuntimeBindingRecord> first =
                    fixture.service.warm("harness-a");
            CompletionStage<RuntimeBindingRecord> second =
                    fixture.service.warm("harness-b");

            assertEquals(1, fixture.provisioner.calls.get());
            lease.complete(lease(1));
            assertEquals(join(first).getBindingId(),
                    join(second).getBindingId());
        }
    }

    @Test
    void staleProvisioningReadDoesNotReprovisionAReadyBinding() {
        MutableClock clock = new MutableClock(START);
        StaleBindingRepository bindings = new StaleBindingRepository(clock);
        FakeProvisioner provisioner = new FakeProvisioner();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        WORKSPACE_SCOPE),
                provisioner, new FakeTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(clock), "broker",
                Duration.ofMinutes(1), Duration.ofMinutes(1), clock,
                () -> "execution")) {
            RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                    WORKSPACE_SCOPE, null);
            RuntimeBindingRecord stale = bindings.findOrCreate(request);
            RuntimeBindingRecord ready = join(service.warm("harness-a"));
            bindings.nextRead = stale;

            RuntimeBindingRecord second = join(service.warm("harness-b"));

            assertEquals(1, provisioner.calls.get());
            assertEquals(ready.getBindingId(), second.getBindingId());
            assertEquals(ready.getLease(), bindings.findById(
                    ready.getBindingId()).getLease());
        }
    }

    @Test
    void readyBindingStillFinishingInThisProcessIsJoined() {
        MutableClock clock = new MutableClock(START);
        StaleBindingRepository bindings = new StaleBindingRepository(clock);
        FakeProvisioner provisioner = new FakeProvisioner();
        AtomicReference<CompletionStage<RuntimeBindingRecord>> joined =
                new AtomicReference<>();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        WORKSPACE_SCOPE),
                provisioner, new FakeTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(clock), "broker",
                Duration.ofMinutes(1), Duration.ofMinutes(1), clock,
                () -> "execution")) {
            bindings.afterReady = () -> joined.set(
                    service.warm("harness-b"));

            RuntimeBindingRecord first = join(service.warm("harness-a"));

            assertEquals(first.getBindingId(),
                    join(joined.get()).getBindingId());
            assertEquals(1, provisioner.calls.get());
        }
    }

    @Test
    void overlappingSameKeyCreatesDispatchOnce() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            Map<String, Object> reference = reference("runtime", "digest");

            CompletionStage<ToolExecutionRecord> first =
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency", reference);
            CompletionStage<ToolExecutionRecord> second =
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency", reference);

            assertEquals(1, fixture.transport.executeCalls.get());
            assertEquals(join(first).getExecutionCallId(),
                    join(second).getExecutionCallId());
            result.complete(Map.of("executionStatus", "success"));
            awaitExecution(fixture.executionRepository,
                    join(first).getExecutionCallId(),
                    ToolExecutionRecord.State.SETTLED);
        }
    }

    @Test
    void interruptedDispatchIsDrivenOnRetryAndCancellation() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            Map<String, Object> firstReference =
                    reference("runtime", "digest-a");
            ToolExecutionRecord first = ToolExecutionRecord.prepared(
                    "manual-1", "key-1", session.getBindingId(),
                    session.getRuntimeGeneration(), "harness", "runtime",
                    "prompt", "call", "digest-a", firstReference);
            fixture.executionRepository.findOrCreate(first);
            fixture.executionRepository.claimDispatch("manual-1", "broker",
                    Duration.ofMinutes(1));

            ToolExecutionRecord retried = join(
                    fixture.service.createExecution("harness", "runtime",
                            "key-1", firstReference));

            assertEquals(ToolExecutionRecord.State.SETTLED,
                    retried.getState());
            assertEquals(1, fixture.transport.executeCalls.get());

            Map<String, Object> secondReference =
                    reference("runtime", "digest-b");
            ToolExecutionRecord second = ToolExecutionRecord.prepared(
                    "manual-2", "key-2", session.getBindingId(),
                    session.getRuntimeGeneration(), "harness", "runtime",
                    "prompt", "call", "digest-b", secondReference);
            fixture.executionRepository.findOrCreate(second);
            fixture.executionRepository.claimDispatch("manual-2", "broker",
                    Duration.ofMinutes(1));

            ToolExecutionRecord cancelled = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            "manual-2"));

            assertEquals(ToolExecutionRecord.State.SETTLED,
                    cancelled.getState());
            assertEquals("cancelled", cancelled.getExecutionStatus());
            assertEquals(0, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void lapsedDispatchIsFencedAsUnknown() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofMillis(30))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            clock.advance(Duration.ofMinutes(1));
            ToolExecutionRecord unknown = awaitExecution(
                    fixture.executionRepository,
                    created.getExecutionCallId(),
                    ToolExecutionRecord.State.UNKNOWN);
            result.complete(Map.of("executionStatus", "success"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    unknown.getState());
            assertEquals(1, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void cancellationAfterALapseStillReachesTheRunningInvocation() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofHours(1))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            // Renewal first ticks after a third of the lease in wall time,
            // so the lease lapses before renewal notices while this process
            // still serves the invocation.
            clock.advance(Duration.ofHours(2));
            join(fixture.service.cancelExecution("harness", "runtime",
                    created.getExecutionCallId()));

            assertEquals(1, fixture.transport.cancelCalls.get());
            result.complete(Map.of("executionStatus", "success"));
        }
    }

    @Test
    void cancellationOfAFencedRunningInvocationStillReachesTheRuntime() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofMillis(30))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));
            clock.advance(Duration.ofMinutes(1));
            awaitExecution(fixture.executionRepository,
                    created.getExecutionCallId(),
                    ToolExecutionRecord.State.UNKNOWN);

            ToolExecutionRecord cancelled = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId()));

            assertEquals(1, fixture.transport.cancelCalls.get());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    cancelled.getState());
            result.complete(Map.of("executionStatus", "success"));

            ToolExecutionRecord repeated = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId()));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    repeated.getState());
            assertEquals(1, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void lapsedCancellationThatNothingHereRunsIsFenced() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofMinutes(1))) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            Map<String, Object> reference = reference("runtime", "digest");
            fixture.executionRepository.findOrCreate(
                    ToolExecutionRecord.prepared("manual", "key",
                            session.getBindingId(),
                            session.getRuntimeGeneration(), "harness",
                            "runtime", "prompt", "call", "digest",
                            reference));
            ToolExecutionRecord claimed = fixture.executionRepository
                    .claimDispatch("manual", "broker",
                            Duration.ofMinutes(1));
            ToolExecutionRecord executing = fixture.executionRepository
                    .compareAndSet(claimed, claimed.withState(
                            ToolExecutionRecord.State.EXECUTING, false),
                            "broker", claimed.getDispatchGeneration());
            fixture.executionRepository.requestCancel("manual",
                    executing.getVersion());

            clock.advance(Duration.ofMinutes(2));
            ToolExecutionRecord cancelled = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            "manual"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    cancelled.getState());
            assertEquals(0, fixture.transport.cancelCalls.get());
            assertEquals(0, fixture.transport.executeCalls.get());

            ToolExecutionRecord repeated = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            "manual"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    repeated.getState());
            assertEquals(0, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void cancellationDuringAFenceDoesNotReachTheRuntime() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(WORKSPACE_SCOPE),
                new FakeProvisioner(), transport,
                new InMemoryRuntimeBindingRepository(clock,
                        () -> "binding"),
                new InMemoryRuntimeSessionRepository(), executions,
                "broker", Duration.ofMinutes(1), Duration.ofMinutes(1),
                clock, () -> "execution")) {
            RuntimeSessionRecord session = join(service.acquire("harness",
                    "runtime", "bootstrap"));
            executions.findOrCreate(ToolExecutionRecord.prepared("manual",
                    "key", session.getBindingId(),
                    session.getRuntimeGeneration(), "harness", "runtime",
                    "prompt", "call", "digest",
                    reference("runtime", "digest")));
            ToolExecutionRecord claimed = executions.claimDispatch("manual",
                    "broker", Duration.ofMinutes(1));
            ToolExecutionRecord executing = executions.compareAndSet(
                    claimed, claimed.withState(
                            ToolExecutionRecord.State.EXECUTING, false),
                    "broker", claimed.getDispatchGeneration());
            executions.requestCancel("manual", executing.getVersion());
            clock.advance(Duration.ofMinutes(2));
            AtomicReference<ToolExecutionRecord> nested =
                    new AtomicReference<>();
            executions.beforeClaim = () -> nested.set(join(
                    service.cancelExecution("harness", "runtime",
                            "manual")));

            ToolExecutionRecord cancelled = join(service.cancelExecution(
                    "harness", "runtime", "manual"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    nested.get().getState());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    cancelled.getState());
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void lapsedInvocationThatCompletesIsFencedAsUnknown() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofHours(1))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            clock.advance(Duration.ofHours(2));
            result.complete(Map.of("executionStatus", "success"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.executionRepository.findByExecutionCallId(
                            created.getExecutionCallId()).getState());
        }
    }

    @Test
    void lapsedInvocationThatFailsIsFencedAsUnknown() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofHours(1))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            clock.advance(Duration.ofHours(2));
            result.completeExceptionally(
                    new IllegalStateException("connection lost"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.executionRepository.findByExecutionCallId(
                            created.getExecutionCallId()).getState());
        }
    }

    @Test
    void lapsedCancelledInvocationThatCompletesIsFencedAsUnknown() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofHours(1))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));
            clock.advance(Duration.ofHours(2));
            ToolExecutionRecord cancelled = join(
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                    cancelled.getState());

            result.complete(Map.of("executionStatus", "cancelled"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.executionRepository.findByExecutionCallId(
                            created.getExecutionCallId()).getState());
            assertEquals(1, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void settledCancellationJudgesTheLapseByTheRepositoryClock() {
        MutableClock serviceClock = new MutableClock(START);
        MutableClock repositoryClock = new MutableClock(START);
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(repositoryClock);
        FakeTransport transport = new FakeTransport();
        CompletableFuture<Map<String, Object>> result =
                new CompletableFuture<>();
        CompletableFuture<Map<String, Object>> acknowledgement =
                new CompletableFuture<>();
        transport.executeResult = result;
        transport.cancelResult = acknowledgement;
        try (RuntimeBrokerService service = brokerService(serviceClock,
                executions, transport)) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            ToolExecutionRecord created = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));
            CompletionStage<ToolExecutionRecord> cancelled =
                    service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId());

            // Only the repository sees the lease lapse; this broker's clock
            // lags behind it.
            repositoryClock.advance(Duration.ofHours(2));
            acknowledgement.complete(Map.of("state", "settled", "result",
                    Map.of("executionStatus", "cancelled")));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    join(cancelled).getState());
            result.complete(Map.of("executionStatus", "cancelled"));
        }
    }

    @Test
    void settlementConflictJudgesLivenessByTheRepositoryClock() {
        MutableClock serviceClock = new MutableClock(START);
        MutableClock repositoryClock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(repositoryClock);
        FakeTransport transport = new FakeTransport();
        CompletableFuture<Map<String, Object>> result =
                new CompletableFuture<>();
        CompletableFuture<Map<String, Object>> acknowledgement =
                new CompletableFuture<>();
        transport.executeResult = result;
        transport.cancelResult = acknowledgement;
        try (RuntimeBrokerService service = brokerService(serviceClock,
                executions, transport)) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            ToolExecutionRecord created = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));
            CompletionStage<ToolExecutionRecord> cancelled =
                    service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId());

            // This broker's clock runs ahead, but the repository still
            // holds the claim live, so the conflict is real.
            serviceClock.advance(Duration.ofHours(2));
            executions.rejectWrites = true;
            acknowledgement.complete(Map.of("state", "settled", "result",
                    Map.of("executionStatus", "cancelled")));

            assertEquals("runtime_execution_state_conflict",
                    failure(cancelled).getCode());
            executions.rejectWrites = false;
            result.complete(Map.of("executionStatus", "cancelled"));
        }
    }

    @Test
    void lapsedInvocationThatCompletesUnderClockSkewIsFencedAsUnknown() {
        MutableClock serviceClock = new MutableClock(START);
        MutableClock repositoryClock = new MutableClock(START);
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(repositoryClock);
        FakeTransport transport = new FakeTransport();
        CompletableFuture<Map<String, Object>> result =
                new CompletableFuture<>();
        transport.executeResult = result;
        try (RuntimeBrokerService service = brokerService(serviceClock,
                executions, transport)) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            ToolExecutionRecord created = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));

            // Only the repository sees the lease lapse.
            repositoryClock.advance(Duration.ofHours(2));
            result.complete(Map.of("executionStatus", "success"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    executions.findByExecutionCallId(
                            created.getExecutionCallId()).getState());
        }
    }

    @Test
    void lapsedCancellationJudgesTheLapseByTheRepositoryClock() {
        MutableClock serviceClock = new MutableClock(START);
        MutableClock repositoryClock = new MutableClock(START);
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(repositoryClock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = brokerService(serviceClock,
                executions, transport)) {
            RuntimeSessionRecord session = join(service.acquire("harness",
                    "runtime", "bootstrap"));
            ToolExecutionRecord executing = seedExecuting(executions,
                    session, "other", Duration.ofMinutes(1));
            executions.requestCancel("manual", executing.getVersion());

            // This broker's clock lags; the repository sees the lapse.
            repositoryClock.advance(Duration.ofHours(2));
            ToolExecutionRecord cancelled = join(service.cancelExecution(
                    "harness", "runtime", "manual"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    cancelled.getState());
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void cancellationOfALiveClaimJudgesLivenessByTheRepositoryClock() {
        MutableClock serviceClock = new MutableClock(START);
        MutableClock repositoryClock = new MutableClock(START);
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(repositoryClock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = brokerService(serviceClock,
                executions, transport)) {
            RuntimeSessionRecord session = join(service.acquire("harness",
                    "runtime", "bootstrap"));
            seedExecuting(executions, session, "other", Duration.ofHours(1));

            // This broker's clock runs ahead, but another broker still holds
            // the claim live, so the stop has to reach the Runtime.
            serviceClock.advance(Duration.ofHours(2));
            ToolExecutionRecord cancelled = join(service.cancelExecution(
                    "harness", "runtime", "manual"));

            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                    cancelled.getState());
            assertEquals(1, transport.cancelCalls.get());
        }
    }

    @Test
    void retriedExecutionJudgesTheLapseByTheRepositoryClock() {
        MutableClock serviceClock = new MutableClock(START);
        MutableClock repositoryClock = new MutableClock(START);
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(repositoryClock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = brokerService(serviceClock,
                executions, transport)) {
            RuntimeSessionRecord session = join(service.acquire("harness",
                    "runtime", "bootstrap"));
            seedExecuting(executions, session, "other",
                    Duration.ofMinutes(1));

            // This broker's clock lags; the repository sees the lapse.
            repositoryClock.advance(Duration.ofHours(2));
            ToolExecutionRecord retried = join(service.createExecution(
                    "harness", "runtime", "key",
                    reference("runtime", "digest")));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    retried.getState());
            assertEquals(0, transport.executeCalls.get());
        }
    }

    @Test
    void cancellationDuringARetryFenceDoesNotReachTheRuntime() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = brokerService(clock,
                executions, transport)) {
            RuntimeSessionRecord session = join(service.acquire("harness",
                    "runtime", "bootstrap"));
            seedExecuting(executions, session, "other",
                    Duration.ofMinutes(1));
            clock.advance(Duration.ofMinutes(2));
            AtomicReference<ToolExecutionRecord> nested =
                    new AtomicReference<>();
            // A retry fencing through beginDispatch holds a dispatches
            // entry for a record nothing here is running.
            executions.beforeClaim = () -> nested.set(join(
                    service.cancelExecution("harness", "runtime",
                            "manual")));

            ToolExecutionRecord retried = join(service.createExecution(
                    "harness", "runtime", "key",
                    reference("runtime", "digest")));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    nested.get().getState());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    retried.getState());
            assertEquals(0, transport.cancelCalls.get());
            assertEquals(0, transport.executeCalls.get());
        }
    }

    @Test
    void cancellationOfARecordSettledDuringItsFenceSkipsTheRuntime() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = brokerService(clock,
                executions, transport)) {
            RuntimeSessionRecord session = join(service.acquire("harness",
                    "runtime", "bootstrap"));
            seedExecuting(executions, session, "other", Duration.ofHours(1));
            // The claim holder settles the record after the cancel request
            // is recorded but before the fence claims it.
            executions.beforeClaim = () -> {
                ToolExecutionRecord current = executions
                        .findByExecutionCallId("manual");
                executions.compareAndSet(current, current.withResult(
                        Map.of("executionStatus", "success"),
                        current.getLastSequence(), clock.instant()),
                        "other", current.getDispatchGeneration());
            };

            ToolExecutionRecord cancelled = join(service.cancelExecution(
                    "harness", "runtime", "manual"));

            assertEquals(ToolExecutionRecord.State.SETTLED,
                    cancelled.getState());
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void cancellationReportsAFailedFenceAsRetryable() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = brokerService(clock,
                executions, transport)) {
            RuntimeSessionRecord session = join(service.acquire("harness",
                    "runtime", "bootstrap"));
            seedExecuting(executions, session, "other", Duration.ofHours(1));
            executions.beforeClaim = () -> {
                throw new IllegalStateException("repository unavailable");
            };

            RuntimeBrokerException error = failure(service.cancelExecution(
                    "harness", "runtime", "manual"));

            assertEquals("runtime_execution_cancel_failed", error.getCode());
            assertTrue(error.isRetryable());
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void claimThatLapsesBeforeExecutionIsLeftForRetry() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        try (RuntimeBrokerService service = brokerService(clock,
                executions, transport)) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            executions.afterClaim = () -> clock.advance(Duration.ofHours(2));

            join(service.createExecution("harness", "runtime",
                    "idempotency", reference("runtime", "digest")));

            // Nothing ran, so the lapsed DISPATCHING claim stays as it was
            // for a retry instead of being claimed again with no dispatcher.
            ToolExecutionRecord stalled = executions
                    .findByExecutionCallId("execution");
            assertEquals(ToolExecutionRecord.State.DISPATCHING,
                    stalled.getState());
            assertEquals(1, stalled.getDispatchGeneration());
            assertEquals(0, transport.executeCalls.get());

            ToolExecutionRecord retried = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));

            assertEquals(ToolExecutionRecord.State.SETTLED,
                    retried.getState());
            assertEquals(1, transport.executeCalls.get());
        }
    }

    @Test
    void settlementConflictResolvedByAnotherWriterIsNotReported() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        CompletableFuture<Map<String, Object>> result =
                new CompletableFuture<>();
        CompletableFuture<Map<String, Object>> acknowledgement =
                new CompletableFuture<>();
        transport.executeResult = result;
        transport.cancelResult = acknowledgement;
        try (RuntimeBrokerService service = brokerService(clock,
                executions, transport)) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            ToolExecutionRecord created = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));
            CompletionStage<ToolExecutionRecord> cancelled =
                    service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId());
            executions.rejectWrites = true;
            // After the cancel's settle gives up, the invocation's own
            // completion settles the record before the fence claims it.
            executions.beforeClaim = () -> {
                executions.rejectWrites = false;
                ToolExecutionRecord current = executions
                        .findByExecutionCallId(created.getExecutionCallId());
                executions.compareAndSet(current, current.withResult(
                        Map.of("executionStatus", "success"),
                        current.getLastSequence(), clock.instant()),
                        "broker", current.getDispatchGeneration());
            };

            acknowledgement.complete(Map.of("state", "settled", "result",
                    Map.of("executionStatus", "cancelled")));

            ToolExecutionRecord settled = join(cancelled);
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    settled.getState());
            assertEquals("success", settled.getExecutionStatus());
            result.complete(Map.of("executionStatus", "success"));
        }
    }

    @Test
    void settlementConflictUnderALiveClaimIsReported() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        CompletableFuture<Map<String, Object>> result =
                new CompletableFuture<>();
        CompletableFuture<Map<String, Object>> acknowledgement =
                new CompletableFuture<>();
        transport.executeResult = result;
        transport.cancelResult = acknowledgement;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(WORKSPACE_SCOPE),
                new FakeProvisioner(), transport,
                new InMemoryRuntimeBindingRepository(clock,
                        () -> "binding"),
                new InMemoryRuntimeSessionRepository(), executions,
                "broker", Duration.ofMinutes(1), Duration.ofHours(1),
                clock, () -> "execution")) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            ToolExecutionRecord created = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));
            CompletionStage<ToolExecutionRecord> cancelled =
                    service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId());

            // The claim is still live, so a settle that cannot land is a
            // real conflict rather than a lapse to fence.
            executions.rejectWrites = true;
            acknowledgement.complete(Map.of("state", "settled", "result",
                    Map.of("executionStatus", "cancelled")));

            assertEquals("runtime_execution_state_conflict",
                    failure(cancelled).getCode());
            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                    executions.findByExecutionCallId(
                            created.getExecutionCallId()).getState());
            executions.rejectWrites = false;
            result.complete(Map.of("executionStatus", "cancelled"));
        }
    }

    @Test
    void cancellationOfAFinishedInvocationDoesNotReachTheRuntime() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        CompletableFuture<Map<String, Object>> result =
                new CompletableFuture<>();
        transport.executeResult = result;
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(WORKSPACE_SCOPE),
                new FakeProvisioner(), transport,
                new InMemoryRuntimeBindingRepository(clock,
                        () -> "binding"),
                new InMemoryRuntimeSessionRepository(), executions,
                "broker", Duration.ofMinutes(1), Duration.ofHours(1),
                clock, () -> "execution")) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            ToolExecutionRecord created = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));
            AtomicReference<ToolExecutionRecord> nested =
                    new AtomicReference<>();
            executions.afterUnknown = () -> nested.set(join(
                    service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId())));

            // The failed invocation is written as UNKNOWN; a cancel that
            // observes that write must not treat it as still running.
            result.completeExceptionally(
                    new IllegalStateException("connection lost"));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    nested.get().getState());
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void settledCancellationAfterALapseIsFencedInsteadOfConflicting() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofHours(1))) {
            CompletableFuture<Map<String, Object>> result =
                    new CompletableFuture<>();
            CompletableFuture<Map<String, Object>> acknowledgement =
                    new CompletableFuture<>();
            fixture.transport.executeResult = result;
            fixture.transport.cancelResult = acknowledgement;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));
            CompletionStage<ToolExecutionRecord> cancelled =
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId());

            clock.advance(Duration.ofHours(2));
            acknowledgement.complete(Map.of("state", "settled", "result",
                    Map.of("executionStatus", "cancelled")));

            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    join(cancelled).getState());
            result.complete(Map.of("executionStatus", "cancelled"));
        }
    }

    @Test
    void invalidExecutionInputsUseTheCodedErrorChannel() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            Map<String, Object> blank = Map.of("sessionId", "runtime",
                    "promptId", "", "callId", "call", "argsDigest",
                    "digest");

            RuntimeBrokerException invalidReference = failure(
                    fixture.service.createExecution("harness", "runtime",
                            "blank", blank));
            RuntimeBrokerException invalidPayload = failure(
                    fixture.service.createExecution("harness", "runtime",
                            "payload", Map.of("sessionId", "runtime",
                                    "promptId", "prompt", "callId", "call",
                                    "argsDigest", "digest", "extra", START)));

            assertEquals("runtime_reference_invalid",
                    invalidReference.getCode());
            assertEquals(400, invalidReference.getStatusCode());
            assertTrue(!invalidReference.isRetryable());
            assertEquals("runtime_payload_invalid",
                    invalidPayload.getCode());
            assertEquals(400, invalidPayload.getStatusCode());
            assertTrue(!invalidPayload.isRetryable());
        }
    }

    @Test
    void invalidSettledCancellationKeepsTheStickyIntent() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Map<String, Object>> execution =
                    new CompletableFuture<>();
            fixture.transport.executeResult = execution;
            fixture.transport.cancelResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", Map.of()));
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));

            RuntimeBrokerException error = failure(
                    fixture.service.cancelExecution("harness", "runtime",
                            created.getExecutionCallId()));

            assertEquals("runtime_execution_cancel_failed",
                    error.getCode());
            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                    fixture.executionRepository.findByExecutionCallId(
                            created.getExecutionCallId()).getState());
            execution.complete(Map.of("executionStatus", "cancelled"));
        }
    }

    @Test
    void negativeReleaseAcknowledgementCanBeRetried() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            fixture.transport.releaseResult =
                    CompletableFuture.completedFuture(false);

            assertTrue(!join(fixture.service.release(
                    "harness", "runtime")));
            assertEquals(1, fixture.transport.releaseCalls.get());
            fixture.transport.releaseResult =
                    CompletableFuture.completedFuture(true);

            assertTrue(join(fixture.service.release(
                    "harness", "runtime")));
            assertEquals(2, fixture.transport.releaseCalls.get());
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE,
                            "runtime").getState());
        }
    }

    @Test
    void failedControlReleasesItsSessionSlot() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            fixture.transport.controlResult = CompletableFuture.failedFuture(
                    new IllegalStateException("connection lost"));

            RuntimeBrokerException error = failure(fixture.service.control(
                    "harness", "runtime", Map.of("kind", "preflight")));

            assertEquals("runtime_control_failed", error.getCode());
            assertEquals(503, error.getStatusCode());
            assertTrue(error.isRetryable());
            assertTrue(join(fixture.service.release(
                    "harness", "runtime")));
        }
    }

    @Test
    void synchronousControlFailureReleasesItsSessionSlot() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            fixture.transport.controlError = new AssertionError("boom");

            RuntimeBrokerException error = failure(fixture.service.control(
                    "harness", "runtime", Map.of("kind", "preflight")));

            assertEquals("runtime_control_failed", error.getCode());
            assertTrue(join(fixture.service.release(
                    "harness", "runtime")));
        }
    }

    @Test
    void blockingControlDoesNotBlockCancellation() throws Exception {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Map<String, Object>> execution =
                    new CompletableFuture<>();
            fixture.transport.executeResult = execution;
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency",
                            reference("runtime", "digest")));
            fixture.transport.controlEntered = new CountDownLatch(1);
            fixture.transport.continueControl = new CountDownLatch(1);
            CompletableFuture<Object> control = CompletableFuture.supplyAsync(
                    () -> join(fixture.service.control("harness", "runtime",
                            Map.of("kind", "preflight"))));
            assertTrue(fixture.transport.controlEntered.await(2,
                    TimeUnit.SECONDS));

            CompletableFuture<ToolExecutionRecord> cancel =
                    CompletableFuture.supplyAsync(() -> join(
                            fixture.service.cancelExecution("harness",
                                    "runtime",
                                    created.getExecutionCallId())));
            try {
                await(() -> fixture.transport.cancelCalls.get() == 1);
            } finally {
                fixture.transport.continueControl.countDown();
            }
            join(control);
            join(cancel);
            execution.complete(Map.of("executionStatus", "cancelled"));
        }
    }

    @Test
    void executionCannotCrossWorkspaceSessionOwnership() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<Map<String, Object>> execution =
                    new CompletableFuture<>();
            fixture.transport.executeResult = execution;
            join(fixture.service.acquire("harness-a", "runtime-a",
                    "bootstrap"));
            join(fixture.service.acquire("harness-b", "runtime-b",
                    "bootstrap"));
            ToolExecutionRecord created = join(
                    fixture.service.createExecution("harness-a", "runtime-a",
                            "idempotency",
                            reference("runtime-a", "digest")));

            for (CompletionStage<?> stage : List.of(
                    fixture.service.getExecution("harness-b", "runtime-b",
                            created.getExecutionCallId()),
                    fixture.service.cancelExecution("harness-b", "runtime-b",
                            created.getExecutionCallId()))) {
                assertEquals("runtime_execution_conflict",
                        failure(stage).getCode());
            }
            assertEquals(0, fixture.transport.cancelCalls.get());
            execution.complete(Map.of("executionStatus", "success"));
        }
    }

    @Test
    void resolverReceivesHarnessIdentityAndMapsFailures() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.warm("harness"));
            assertEquals("harness", fixture.resolver.lastHarness.get());
        }
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.resolver.result = CompletableFuture.failedFuture(
                    new IllegalStateException("unavailable"));

            RuntimeBrokerException error = failure(
                    fixture.service.warm("harness"));

            assertEquals("runtime_scope_resolution_failed",
                    error.getCode());
            assertEquals(503, error.getStatusCode());
            assertTrue(error.isRetryable());
            assertEquals(0, fixture.provisioner.calls.get());
        }
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.resolver.result =
                    CompletableFuture.completedFuture(null);

            RuntimeBrokerException error = failure(
                    fixture.service.warm("harness"));

            assertEquals("runtime_scope_resolution_failed",
                    error.getCode());
            assertEquals(0, fixture.provisioner.calls.get());
        }
    }

    @Test
    void failedProvisioningUsesTheCodedChannelAndMarksTheBindingFailed() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.provisioner.provisionResult =
                    CompletableFuture.failedFuture(
                            new IllegalStateException("unavailable"));

            RuntimeBrokerException error = failure(
                    fixture.service.warm("harness"));

            assertEquals("runtime_provision_failed", error.getCode());
            assertEquals(503, error.getStatusCode());
            assertTrue(error.isRetryable());
            assertEquals(RuntimeBindingRecord.State.FAILED,
                    fixture.bindingRepository.findById("binding-1")
                            .getState());
        }
    }

    @Test
    void changedDurableLeaseRequiresReconciliation() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeBindingRecord ready = join(
                    fixture.service.warm("harness"));
            RuntimeBindingRecord changed = fixture.bindingRepository
                    .compareAndSet(ready, ready.withState(
                            RuntimeBindingRecord.State.READY, lease(2),
                            START));
            assertTrue(changed != null);

            RuntimeBrokerException error = failure(
                    fixture.service.warm("harness"));

            assertEquals("runtime_reconciliation_required",
                    error.getCode());
            assertEquals(1, fixture.provisioner.calls.get());
        }
    }

    @Test
    void closeFencesPendingProvisioningAndRejectsNewWork() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            CompletableFuture<RuntimeLease> lease = new CompletableFuture<>();
            fixture.provisioner.provisionResult = lease;
            CompletionStage<RuntimeBindingRecord> warm =
                    fixture.service.warm("harness");

            fixture.service.close();
            lease.complete(lease(1));

            assertThrows(RuntimeException.class, () -> join(warm));
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    fixture.bindingRepository.findActive(
                            new RuntimeProvisionRequest(WORKSPACE_SCOPE, null))
                            .getState());
            assertThrows(IllegalStateException.class,
                    () -> fixture.service.warm("harness"));
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

    private static ToolExecutionRecord seedExecuting(
            ToolExecutionRepository executions, RuntimeSessionRecord session,
            String owner, Duration leaseDuration) {
        executions.findOrCreate(ToolExecutionRecord.prepared("manual", "key",
                session.getBindingId(), session.getRuntimeGeneration(),
                "harness", "runtime", "prompt", "call", "digest",
                reference("runtime", "digest")));
        ToolExecutionRecord claimed = executions.claimDispatch("manual",
                owner, leaseDuration);
        return executions.compareAndSet(claimed, claimed.withState(
                ToolExecutionRecord.State.EXECUTING, false), owner,
                claimed.getDispatchGeneration());
    }

    private static RuntimeBrokerService brokerService(Clock serviceClock,
            ToolExecutionRepository executions, FakeTransport transport) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(WORKSPACE_SCOPE),
                new FakeProvisioner(), transport,
                new InMemoryRuntimeBindingRepository(serviceClock,
                        () -> "binding"),
                new InMemoryRuntimeSessionRepository(), executions,
                "broker", Duration.ofMinutes(1), Duration.ofHours(1),
                serviceClock, () -> "execution");
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

    @Test
    void failedReattestationRetiresTheBindingAndReprovisions() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeBindingRecord ready = join(fixture.service.warm(
                    "harness"));
            assertEquals(RuntimeBindingRecord.State.READY, ready.getState());

            fixture.provisioner.confirmResult = CompletableFuture
                    .failedFuture(new RuntimeBrokerException(503,
                            "runtime_provision_failed",
                            "Managed Runtime process is not alive.", true));

            RuntimeBrokerException error = failure(
                    fixture.service.warm("harness"));
            assertEquals("runtime_provision_failed", error.getCode());
            assertEquals(RuntimeBindingRecord.State.FAILED,
                    fixture.bindingRepository.findById(ready.getBindingId())
                            .getState());

            fixture.provisioner.confirmResult =
                    CompletableFuture.completedFuture(null);
            RuntimeBindingRecord again = join(fixture.service.warm(
                    "harness"));
            assertEquals(RuntimeBindingRecord.State.READY, again.getState());
            assertEquals(2, fixture.provisioner.calls.get());
            assertNotEquals(ready.getLease().getRuntimeInstanceId(),
                    again.getLease().getRuntimeInstanceId());
            assertEquals(1, fixture.provisioner.releaseCalls.get());
            assertEquals(ready.getLease().getRuntimeInstanceId(),
                    fixture.provisioner.releasedLease
                            .getRuntimeInstanceId());
        }
    }

    @Test
    void deadLeaseReleasesTheSessionWithoutCallingTransport() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            fixture.provisioner.usable = false;

            assertTrue(join(fixture.service.release("harness", "runtime")));
            assertEquals(0, fixture.transport.releaseCalls.get());
            assertEquals(1, fixture.provisioner.releaseCalls.get());
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE,
                            "runtime").getState());
            assertEquals(RuntimeBindingRecord.State.FAILED,
                    fixture.bindingRepository.findById("binding-1")
                            .getState());

            fixture.provisioner.usable = true;
            assertEquals("runtime_session_conflict",
                    failure(fixture.service.acquire("harness", "runtime",
                            "bootstrap")).getCode());
            assertEquals(RuntimeSessionRecord.State.READY,
                    join(fixture.service.acquire("harness", "runtime-2",
                            "bootstrap")).getState());
        }
    }

    @Test
    void deadLeaseReleaseStaysBusyWhileAnExecutionIsUnsettled() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.transport.executeResult = CompletableFuture.failedFuture(
                    new IllegalStateException("connection lost"));
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            join(fixture.service.createExecution("harness", "runtime",
                    "idempotency", reference("runtime", "digest")));
            awaitExecution(fixture.executionRepository, "execution-1",
                    ToolExecutionRecord.State.UNKNOWN);
            fixture.provisioner.usable = false;

            RuntimeBrokerException busy = failure(
                    fixture.service.release("harness", "runtime"));

            assertEquals("runtime_session_busy", busy.getCode());
            assertEquals(0, fixture.transport.releaseCalls.get());
            assertEquals(RuntimeSessionRecord.State.READY,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE,
                            "runtime").getState());
        }
    }

    @Test
    void deadLeaseSkipsDispatchAndRetiresTheBinding() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            fixture.provisioner.usable = false;

            join(fixture.service.createExecution("harness", "runtime",
                    "idempotency", reference("runtime", "digest")));

            assertEquals(0, fixture.transport.executeCalls.get());
            awaitExecution(fixture.executionRepository, "execution-1",
                    ToolExecutionRecord.State.UNKNOWN);
            assertEquals(RuntimeBindingRecord.State.FAILED,
                    fixture.bindingRepository.findById("binding-1")
                            .getState());
        }
    }

    @Test
    void closingTheServiceClosesTheProvisioner() {
        Fixture fixture = new Fixture(WORKSPACE_SCOPE);
        fixture.close();
        assertTrue(fixture.provisioner.closed);
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
        final FakeResolver resolver;
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
            resolver = new FakeResolver(scope);
            transport.executionRepository = executionRepository;
            service = new RuntimeBrokerService(
                    resolver,
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

    private static final class FakeResolver
            implements HarnessSessionResolver {
        final AtomicReference<String> lastHarness = new AtomicReference<>();
        volatile CompletionStage<RuntimeScope> result;

        FakeResolver(RuntimeScope scope) {
            result = CompletableFuture.completedFuture(scope);
        }

        @Override
        public CompletionStage<RuntimeScope> resolve(
                String harnessSessionId) {
            lastHarness.set(harnessSessionId);
            return result;
        }
    }

    private static final class FakeProvisioner
            implements RuntimeProvisioner {
        final AtomicInteger calls = new AtomicInteger();
        final AtomicInteger confirmCalls = new AtomicInteger();
        final AtomicInteger releaseCalls = new AtomicInteger();
        volatile CompletableFuture<RuntimeLease> provisionResult;
        volatile RuntimeLease issuedLease;
        volatile RuntimeLease releasedLease;
        volatile CompletableFuture<Void> confirmResult =
                CompletableFuture.completedFuture(null);
        volatile boolean usable = true;
        volatile boolean closed;

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            int call = calls.incrementAndGet();
            if (provisionResult != null) {
                return provisionResult;
            }
            issuedLease = lease(call);
            return CompletableFuture.completedFuture(issuedLease);
        }

        @Override
        public CompletionStage<Void> confirm(RuntimeProvisionRequest request,
                RuntimeLease lease) {
            confirmCalls.incrementAndGet();
            return confirmResult;
        }

        @Override
        public CompletionStage<Void> release(RuntimeProvisionRequest request,
                RuntimeLease lease) {
            releaseCalls.incrementAndGet();
            releasedLease = lease;
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public boolean isUsable(RuntimeLease lease) {
            return usable;
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static final class FakeTransport implements RuntimeTransport {
        final AtomicInteger acquireCalls = new AtomicInteger();
        final AtomicInteger executeCalls = new AtomicInteger();
        final AtomicInteger cancelCalls = new AtomicInteger();
        final AtomicInteger releaseCalls = new AtomicInteger();
        volatile RuntimeLease lastLease;
        volatile RuntimeSession lastSession;
        volatile Map<String, Object> lastReference;
        volatile ToolExecutionRepository executionRepository;
        volatile String observedExecutionId;
        volatile ToolExecutionRecord recordAtCancel;
        volatile CompletableFuture<Void> acquireResult =
                CompletableFuture.completedFuture(null);
        volatile CompletableFuture<Object> controlResult =
                CompletableFuture.completedFuture("ok");
        volatile Error controlError;
        volatile CountDownLatch controlEntered;
        volatile CountDownLatch continueControl;
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
            lastLease = lease;
            lastSession = session;
            return acquireResult;
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session,
                Map<String, Object> operation) {
            lastLease = lease;
            lastSession = session;
            lastControl = operation;
            if (controlError != null) {
                throw controlError;
            }
            CountDownLatch entered = controlEntered;
            CountDownLatch proceed = continueControl;
            if (entered != null && proceed != null) {
                entered.countDown();
                try {
                    proceed.await();
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(exception);
                }
            }
            return controlResult;
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            executeCalls.incrementAndGet();
            lastLease = lease;
            lastSession = session;
            lastReference = reference;
            return executeResult;
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancelCalls.incrementAndGet();
            lastLease = lease;
            lastSession = session;
            lastReference = reference;
            if (executionRepository != null
                    && observedExecutionId != null) {
                recordAtCancel = executionRepository
                        .findByExecutionCallId(observedExecutionId);
            }
            return cancelResult;
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            releaseCalls.incrementAndGet();
            lastLease = lease;
            lastSession = session;
            return releaseResult;
        }
    }

    private static final class TakeoverExecutionRepository
            implements ToolExecutionRepository {
        private final MutableClock clock;
        private final InMemoryToolExecutionRepository delegate;
        private boolean takeoverPending = true;

        TakeoverExecutionRepository(MutableClock clock) {
            this.clock = clock;
            delegate = new InMemoryToolExecutionRepository(clock);
        }

        @Override
        public ToolExecutionRecord findOrCreate(
                ToolExecutionRecord candidate) {
            return delegate.findOrCreate(candidate);
        }

        @Override
        public ToolExecutionRecord findByExecutionCallId(
                String executionCallId) {
            return delegate.findByExecutionCallId(executionCallId);
        }

        @Override
        public ToolExecutionRecord findByIdempotencyKey(
                String idempotencyKey) {
            return delegate.findByIdempotencyKey(idempotencyKey);
        }

        @Override
        public ToolExecutionRecord compareAndSet(
                ToolExecutionRecord expected,
                ToolExecutionRecord replacement, String owner,
                long dispatchGeneration) {
            if (takeoverPending && "broker-a".equals(owner)) {
                takeoverPending = false;
                clock.advance(Duration.ofSeconds(2));
                ToolExecutionRecord claimed = delegate.claimDispatch(
                        expected.getExecutionCallId(), "broker-b",
                        Duration.ofMinutes(1));
                delegate.compareAndSet(claimed, claimed.withState(
                        ToolExecutionRecord.State.EXECUTING, false),
                        "broker-b", claimed.getDispatchGeneration());
            }
            return delegate.compareAndSet(expected, replacement, owner,
                    dispatchGeneration);
        }

        @Override
        public ToolExecutionRecord claimDispatch(String executionCallId,
                String owner, Duration leaseDuration) {
            return delegate.claimDispatch(executionCallId, owner,
                    leaseDuration);
        }

        @Override
        public ToolExecutionRecord renewDispatch(String executionCallId,
                String owner, long dispatchGeneration,
                Duration leaseDuration) {
            return delegate.renewDispatch(executionCallId, owner,
                    dispatchGeneration, leaseDuration);
        }

        @Override
        public ToolExecutionRecord requestCancel(String executionCallId,
                long expectedVersion) {
            return delegate.requestCancel(executionCallId, expectedVersion);
        }

        @Override
        public ToolExecutionRecord resolveUnknown(
                ToolExecutionRecord expected,
                Map<String, Object> resolutionResult,
                Instant resolutionTime) {
            return delegate.resolveUnknown(expected, resolutionResult,
                    resolutionTime);
        }

        @Override
        public boolean hasActiveByRuntimeSession(String runtimeSessionId) {
            return delegate.hasActiveByRuntimeSession(runtimeSessionId);
        }
    }

    private static final class HookedExecutionRepository
            implements ToolExecutionRepository {
        private final InMemoryToolExecutionRepository delegate;
        volatile Runnable beforeClaim;
        volatile Runnable afterClaim;
        volatile Runnable afterUnknown;
        volatile boolean rejectWrites;

        HookedExecutionRepository(Clock clock) {
            delegate = new InMemoryToolExecutionRepository(clock);
        }

        @Override
        public ToolExecutionRecord findOrCreate(
                ToolExecutionRecord candidate) {
            return delegate.findOrCreate(candidate);
        }

        @Override
        public ToolExecutionRecord findByExecutionCallId(
                String executionCallId) {
            return delegate.findByExecutionCallId(executionCallId);
        }

        @Override
        public ToolExecutionRecord findByIdempotencyKey(
                String idempotencyKey) {
            return delegate.findByIdempotencyKey(idempotencyKey);
        }

        @Override
        public ToolExecutionRecord compareAndSet(
                ToolExecutionRecord expected,
                ToolExecutionRecord replacement, String owner,
                long dispatchGeneration) {
            if (rejectWrites) {
                return null;
            }
            ToolExecutionRecord updated = delegate.compareAndSet(expected,
                    replacement, owner, dispatchGeneration);
            Runnable hook = afterUnknown;
            if (hook != null && updated != null && updated.getState()
                    == ToolExecutionRecord.State.UNKNOWN) {
                afterUnknown = null;
                hook.run();
            }
            return updated;
        }

        @Override
        public ToolExecutionRecord claimDispatch(String executionCallId,
                String owner, Duration leaseDuration) {
            Runnable hook = beforeClaim;
            beforeClaim = null;
            if (hook != null) {
                hook.run();
            }
            ToolExecutionRecord claimed = delegate.claimDispatch(
                    executionCallId, owner, leaseDuration);
            Runnable after = afterClaim;
            afterClaim = null;
            if (after != null) {
                after.run();
            }
            return claimed;
        }

        @Override
        public ToolExecutionRecord renewDispatch(String executionCallId,
                String owner, long dispatchGeneration,
                Duration leaseDuration) {
            return delegate.renewDispatch(executionCallId, owner,
                    dispatchGeneration, leaseDuration);
        }

        @Override
        public ToolExecutionRecord requestCancel(String executionCallId,
                long expectedVersion) {
            return delegate.requestCancel(executionCallId, expectedVersion);
        }

        @Override
        public ToolExecutionRecord resolveUnknown(
                ToolExecutionRecord expected,
                Map<String, Object> resolutionResult,
                Instant resolutionTime) {
            return delegate.resolveUnknown(expected, resolutionResult,
                    resolutionTime);
        }

        @Override
        public boolean hasActiveByRuntimeSession(String runtimeSessionId) {
            return delegate.hasActiveByRuntimeSession(runtimeSessionId);
        }
    }

    private static final class StaleBindingRepository
            implements RuntimeBindingRepository {
        private final InMemoryRuntimeBindingRepository delegate;
        volatile RuntimeBindingRecord nextRead;
        volatile Runnable afterReady;

        StaleBindingRepository(Clock clock) {
            delegate = new InMemoryRuntimeBindingRepository(clock,
                    () -> "binding");
        }

        @Override
        public RuntimeBindingRecord findOrCreate(
                RuntimeProvisionRequest request) {
            RuntimeBindingRecord stale = nextRead;
            nextRead = null;
            return stale == null ? delegate.findOrCreate(request) : stale;
        }

        @Override
        public RuntimeBindingRecord findActive(
                RuntimeProvisionRequest request) {
            return delegate.findActive(request);
        }

        @Override
        public List<RuntimeBindingRecord> findActiveByIsolationKey(
                RuntimeScope scope, String isolationKey) {
            return delegate.findActiveByIsolationKey(scope, isolationKey);
        }

        @Override
        public RuntimeBindingRecord findById(String bindingId) {
            return delegate.findById(bindingId);
        }

        @Override
        public RuntimeBindingRecord compareAndSet(
                RuntimeBindingRecord expected,
                RuntimeBindingRecord replacement) {
            RuntimeBindingRecord updated = delegate.compareAndSet(expected,
                    replacement);
            Runnable hook = afterReady;
            if (updated != null && hook != null
                    && updated.getState()
                            == RuntimeBindingRecord.State.READY) {
                afterReady = null;
                hook.run();
            }
            return updated;
        }

        @Override
        public RuntimeBindingRecord claimOperation(String bindingId,
                String owner, Duration leaseDuration) {
            return delegate.claimOperation(bindingId, owner, leaseDuration);
        }

        @Override
        public RuntimeBindingRecord renewOperation(String bindingId,
                String owner, long operationGeneration,
                Duration leaseDuration) {
            return delegate.renewOperation(bindingId, owner,
                    operationGeneration, leaseDuration);
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
