package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

class RuntimeBrokerServiceTest {
    private static final String PROVIDER_SESSION = "550e8400-e29b-41d4-a716-446655440302";
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
    void failedAdoptedReleaseLeavesReclamationReachable() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("holder", "holder", "bootstrap"));
            fixture.transport.acquireResult = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(409, "workspace_busy", "busy", false));
            assertEquals("workspace_busy", failure(fixture.service.acquire("blocked", "blocked", "bootstrap")).getCode());
            assertEquals(RuntimeSessionRecord.State.ACQUIRING,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE, "blocked").getState());
            fixture.provisioner.usable = false;
            RuntimeBrokerException releaseFailure = failure(fixture.service.release("blocked", "blocked"));
            assertEquals("runtime_reconciliation_required", releaseFailure.getCode());
            assertEquals(RuntimeBindingRecord.State.LOST, fixture.bindingRepository.findById("binding-1").getState());
            fixture.provisioner.usable = true;
            fixture.transport.acquireResult = CompletableFuture.completedFuture(null);
            RuntimeBrokerException acquireFailure = failure(fixture.service.acquire("blocked", "blocked", "bootstrap"));
            assertEquals("runtime_broker_runtime_lost", acquireFailure.getCode(),
                    "missing durable stop proof must fail at reclamation, not a stale session admission guard");
            assertEquals(1, fixture.provisioner.calls.get(), "without writer-stop proof no new Runtime may be provisioned");
        }
    }

    @Test
    void releasesAnIncompleteAcquisitionOnlyAfterOriginalTransportConfirmation() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("holder", "holder", "bootstrap"));
            fixture.transport.acquireResult = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(409, "workspace_busy", "busy", false));
            assertEquals("workspace_busy", failure(fixture.service.acquire("blocked", "blocked", "bootstrap")).getCode());
            fixture.transport.releaseResult = CompletableFuture.failedFuture(new IllegalStateException("lost release"));
            assertEquals("runtime_session_release_failed", failure(fixture.service.release("blocked", "blocked")).getCode());
            assertEquals(RuntimeSessionRecord.State.RELEASING,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE, "blocked").getState());
            fixture.transport.releaseResult = CompletableFuture.completedFuture(true);
            assertTrue(join(fixture.service.release("blocked", "blocked")));
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE, "blocked").getState());
            assertEquals(RuntimeSessionRecord.State.READY,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE, "holder").getState());
            assertEquals("blocked", fixture.transport.lastSession.getRuntimeSessionId());
            assertEquals(2, fixture.transport.acquireCalls.get());
            assertEquals(2, fixture.transport.releaseCalls.get());
            assertEquals(1, fixture.provisioner.calls.get());
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
    void reservesProviderReferencesWithoutEffectsAndStartsTheOriginalOnce() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            Map<String, Object> reference = providerReference();
            ToolExecutionRecord first = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", reference));
            ToolExecutionRecord duplicate = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", reference));
            assertEquals(first.getExecutionCallId(), duplicate.getExecutionCallId());
            assertEquals(ToolExecutionRecord.State.PREPARED, duplicate.getState());
            assertEquals(reference, duplicate.getReference());
            assertEquals(0, fixture.transport.executeCalls.get());
            assertEquals("runtime_reference_invalid", failure(fixture.service.createExecution(
                    "harness", PROVIDER_SESSION, "key", reference)).getCode());
            ToolExecutionRecord started = join(fixture.service.startExecution(
                    "harness", PROVIDER_SESSION, first.getExecutionCallId()));
            join(fixture.service.startExecution("harness", PROVIDER_SESSION, first.getExecutionCallId()));
            join(fixture.service.prepareExecution("harness", PROVIDER_SESSION, "key", reference));
            assertEquals(ToolExecutionRecord.State.SETTLED, started.getState());
            assertEquals(1, fixture.transport.executeCalls.get());
            assertEquals(reference, fixture.transport.lastReference);
        }
    }

    @Test
    void providerStartNeverReplaysAnUnknownExecution() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            fixture.transport.executeResult = CompletableFuture.failedFuture(
                    new IllegalStateException("lost response"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            ToolExecutionRecord unknown = join(fixture.service.startExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
            join(fixture.service.startExecution("harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals(1, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void preparedProviderCancellationClosesWorkerAdmissionBeforeRelease() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            fixture.transport.cancelResult = new CompletableFuture<>();
            CompletionStage<ToolExecutionRecord> cancellation = fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId());
            CompletionStage<ToolExecutionRecord> repeated = fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId());
            assertFalse(repeated.toCompletableFuture().isDone());
            assertEquals("runtime_session_busy", failure(fixture.service.release(
                    "harness", PROVIDER_SESSION)).getCode());
            join(fixture.service.startExecution("harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals(0, fixture.transport.executeCalls.get());
            fixture.transport.cancelResult.completeExceptionally(new IllegalStateException("lost cancel"));
            assertEquals("runtime_execution_cancel_failed", failure(cancellation).getCode());
            assertEquals("runtime_execution_cancel_failed", failure(repeated).getCode());
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of(
                    "state", "settled", "result", Map.of("executionStatus", "cancelled")));
            ToolExecutionRecord cancelled = join(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals("cancelled", cancelled.getExecutionStatus());
            assertEquals(3, fixture.transport.cancelCalls.get());
            assertTrue(join(fixture.service.release("harness", PROVIDER_SESSION)));
            assertSame(cancelled, join(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId())));
            assertSame(cancelled, join(fixture.service.getExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId())));
            assertSame(cancelled, join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference())));
            assertEquals(3, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void abandonedProviderReceiptsKeepTheirSavedOwnershipAfterRestartAndRelease() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var recovery = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions,
                "provider-terminal", PROVIDER_SESSION);
        String harness = recovery.session.getSession().getHarnessSessionId();
        Map<String, Object> reference = providerReference();
        var prepared = bindings.admitExecution(sessions, executions,
                ToolExecutionRecord.prepared("provider-call", "provider-key", recovery.binding.getBindingId(),
                        recovery.binding.getGeneration(), harness, PROVIDER_SESSION,
                        (String) reference.get("promptId"), (String) reference.get("callId"),
                        (String) reference.get("argsDigest"), reference));
        RuntimeBindingRecord lost = recovery.lose(false);
        bindings.recoverLost(sessions, executions, lost);
        var transport = new FakeTransport();
        try (var service = new RuntimeBrokerService(
                ignored -> { throw new AssertionError("Saved ownership must not resolve current scope"); },
                new StaticRuntimeProvisioner(recovery.binding.getLease()), transport, bindings, sessions, executions,
                "restarted", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            for (boolean released : new boolean[] {false, true}) {
                if (released) {
                    var proof = bindings.compareAndSet(lost, lost.withRecoveryEvidence(null,
                            RuntimeRecoveryContract.evidence(lost, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED),
                            Instant.now()));
                    bindings.recoverLost(sessions, executions, proof);
                }
                ToolExecutionRecord receipt = join(service.prepareExecution(
                        harness, PROVIDER_SESSION, prepared.getIdempotencyKey(), reference));
                assertEquals(ToolExecutionRecord.State.ABANDONED, receipt.getState());
                assertEquals(reference, receipt.getReference());
                assertSame(receipt, join(service.getExecution(harness, PROVIDER_SESSION, receipt.getExecutionCallId())));
                assertSame(receipt, join(service.cancelExecution(harness, PROVIDER_SESSION, receipt.getExecutionCallId())));
                assertEquals("runtime_execution_conflict", failure(service.prepareExecution(
                        "other-harness", PROVIDER_SESSION, prepared.getIdempotencyKey(), reference)).getCode());
                var changed = new HashMap<>(reference);
                changed.put("invocationId", "another-invocation");
                assertEquals("runtime_idempotency_conflict", failure(service.prepareExecution(
                        harness, PROVIDER_SESSION, prepared.getIdempotencyKey(), changed)).getCode());
            }
            assertEquals(0, transport.acquireCalls.get());
            assertEquals(0, transport.executeCalls.get());
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void terminalProviderCancellationAnswersFromTheReceiptWhenTheSessionCannotAnswer() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var recovery = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions,
                "provider-terminal-cancel", PROVIDER_SESSION);
        String harness = recovery.session.getSession().getHarnessSessionId();
        Map<String, Object> reference = providerReference();
        var prepared = bindings.admitExecution(sessions, executions,
                ToolExecutionRecord.prepared("provider-call", "provider-key", recovery.binding.getBindingId(),
                        recovery.binding.getGeneration(), harness, PROVIDER_SESSION,
                        (String) reference.get("promptId"), (String) reference.get("callId"),
                        (String) reference.get("argsDigest"), reference));
        ToolExecutionRecord settled = executions.requestCancel(
                prepared.getExecutionCallId(), prepared.getVersion());
        assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
        assertTrue(settled.isCancelRequested());
        // A Session the Broker is releasing cannot be re-driven for fresh
        // worker evidence; the terminal receipt must stand alone.
        sessions.compareAndSet(recovery.session, recovery.session.withState(
                RuntimeSessionRecord.State.RELEASING, Instant.now()));
        var transport = new FakeTransport();
        try (var service = new RuntimeBrokerService(
                ignored -> { throw new AssertionError("Saved ownership must not resolve current scope"); },
                new StaticRuntimeProvisioner(recovery.binding.getLease()), transport, bindings, sessions, executions,
                "restarted", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            assertSame(settled, join(service.cancelExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId())));
            assertSame(settled, join(service.cancelExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId())));
            assertSame(settled, join(service.getExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId())));
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void terminalProviderCancellationAsksForAdoptionUntilItsGenerationCannotAnswer() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var recovery = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions,
                "provider-terminal-cancel-restart", PROVIDER_SESSION);
        String harness = recovery.session.getSession().getHarnessSessionId();
        Map<String, Object> reference = providerReference();
        var prepared = bindings.admitExecution(sessions, executions,
                ToolExecutionRecord.prepared("provider-call", "provider-key", recovery.binding.getBindingId(),
                        recovery.binding.getGeneration(), harness, PROVIDER_SESSION,
                        (String) reference.get("promptId"), (String) reference.get("callId"),
                        (String) reference.get("argsDigest"), reference));
        // Persisted before the worker heard of it, as when the process
        // dies between the two.
        ToolExecutionRecord settled = executions.requestCancel(
                prepared.getExecutionCallId(), prepared.getVersion());
        assertEquals("cancelled", settled.getExecutionStatus());
        // A replaced Broker process finds the stored Session still READY and
        // holds no live Session to ask the worker with.
        assertEquals(RuntimeSessionRecord.State.READY,
                sessions.findById(recovery.binding.getRequest().getScope(), PROVIDER_SESSION).getState());
        var transport = new FakeTransport();
        try (var service = new RuntimeBrokerService(
                ignored -> { throw new AssertionError("Saved ownership must not resolve current scope"); },
                new StaticRuntimeProvisioner(recovery.binding.getLease()), transport, bindings, sessions, executions,
                "restarted", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            // The worker may still hold the preparation: adopt, then retry.
            RuntimeBrokerException adopt = failure(service.cancelExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId()));
            assertEquals(503, adopt.getStatusCode());
            assertEquals("runtime_reconciliation_required", adopt.getCode());
            assertTrue(adopt.isRetryable());
            assertSame(settled, join(service.getExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId())));
            // Once that generation can no longer answer, the receipt stands.
            recovery.lose(false);
            assertSame(settled, join(service.cancelExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId())));
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void terminalProviderCancellationRefusesAReceiptWhoseSavedOwnershipDiffers() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var recovery = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions,
                "provider-terminal-cancel-foreign", PROVIDER_SESSION);
        String harness = recovery.session.getSession().getHarnessSessionId();
        Map<String, Object> reference = providerReference();
        // Saved against another generation of the binding than its Session's.
        ToolExecutionRecord prepared = executions.findOrCreate(ToolExecutionRecord.prepared(
                "provider-call", "provider-key", recovery.binding.getBindingId(),
                recovery.binding.getGeneration() + 1, harness, PROVIDER_SESSION,
                (String) reference.get("promptId"), (String) reference.get("callId"),
                (String) reference.get("argsDigest"), reference));
        ToolExecutionRecord settled = executions.requestCancel(
                prepared.getExecutionCallId(), prepared.getVersion());
        assertTrue(settled.isTerminal());
        // The Session is releasing, where a receipt it owns would stand alone.
        sessions.compareAndSet(recovery.session, recovery.session.withState(
                RuntimeSessionRecord.State.RELEASING, Instant.now()));
        var transport = new FakeTransport();
        try (var service = new RuntimeBrokerService(
                ignored -> { throw new AssertionError("Saved ownership must not resolve current scope"); },
                new StaticRuntimeProvisioner(recovery.binding.getLease()), transport, bindings, sessions, executions,
                "restarted", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            RuntimeBrokerException conflict = failure(service.cancelExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId()));
            assertEquals(409, conflict.getStatusCode());
            assertEquals("runtime_execution_conflict", conflict.getCode());
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void terminalProviderCancellationStandsOnceTheWorkerIsLost() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of(
                    "state", "settled", "result", Map.of("executionStatus", "cancelled")));
            ToolExecutionRecord cancelled = join(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals("cancelled", cancelled.getExecutionStatus());
            // The worker dies: this process still holds the Session, whose
            // record stays READY until recovery, but its binding is lost.
            fixture.provisioner.usable = false;
            RuntimeBrokerException lost = failure(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertTrue(lost.isRetryable(), lost.getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindingRepository.findById(prepared.getBindingId()).getState());
            assertEquals(RuntimeSessionRecord.State.READY,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE, PROVIDER_SESSION).getState());
            for (int attempt = 0; attempt < 2; attempt++) {
                assertSame(cancelled, join(fixture.service.cancelExecution(
                        "harness", PROVIDER_SESSION, prepared.getExecutionCallId())));
            }
            assertEquals(1, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void terminalProviderCancellationDoesNotWaitOnAnAcquireStillAdopting() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var recovery = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions,
                "provider-terminal-cancel-adopting", PROVIDER_SESSION);
        String harness = recovery.session.getSession().getHarnessSessionId();
        Map<String, Object> reference = providerReference();
        var prepared = bindings.admitExecution(sessions, executions,
                ToolExecutionRecord.prepared("provider-call", "provider-key", recovery.binding.getBindingId(),
                        recovery.binding.getGeneration(), harness, PROVIDER_SESSION,
                        (String) reference.get("promptId"), (String) reference.get("callId"),
                        (String) reference.get("argsDigest"), reference));
        ToolExecutionRecord settled = executions.requestCancel(
                prepared.getExecutionCallId(), prepared.getVersion());
        // A replaced Broker adopts the binding again; the adoption hangs.
        bindings.releaseOperation(recovery.binding.getBindingId(), "recovery",
                recovery.binding.getOperationGeneration());
        CompletableFuture<RuntimeObservation> adoption = new CompletableFuture<>();
        RuntimeProvisioner provisioner = new RuntimeProvisioner() {
            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                return CompletableFuture.failedFuture(new AssertionError("no provision"));
            }

            @Override
            public String kind() {
                return "test-supervisor";
            }

            @Override
            public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lastLease) {
                return adoption;
            }
        };
        var transport = new FakeTransport();
        RuntimeScope scope = recovery.binding.getRequest().getScope();
        try (var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope),
                provisioner, transport, bindings, sessions, executions, "restarted",
                Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            CompletableFuture<RuntimeSessionRecord> acquire = service.acquire(
                    harness, PROVIDER_SESSION, "bootstrap").toCompletableFuture();
            assertFalse(acquire.isDone());
            // Answered at once instead of borrowing the acquire's outcome.
            CompletableFuture<ToolExecutionRecord> cancel = service.cancelExecution(
                    harness, PROVIDER_SESSION, settled.getExecutionCallId()).toCompletableFuture();
            assertTrue(cancel.isDone());
            assertEquals("runtime_reconciliation_required", failure(cancel).getCode());
            adoption.completeExceptionally(new RuntimeBrokerException(409, "adoption_refused",
                    "adoption refused", false));
            assertThrows(CompletionException.class, acquire::join);
            assertEquals(0, transport.cancelCalls.get());
        }
    }

    @Test
    void terminalProviderCancellationReportsAnotherHarnessSessionAsAConflict() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            ToolExecutionRecord settled = fixture.executionRepository.requestCancel(
                    prepared.getExecutionCallId(), prepared.getVersion());
            try (RuntimeBrokerService restarted = restartedService(fixture)) {
                // Another scope reuses the Runtime Session id in this process.
                fixture.resolver.result = CompletableFuture.completedFuture(SESSION_SCOPE);
                join(restarted.acquire("harness-b", PROVIDER_SESSION, "bootstrap"));
                fixture.resolver.result = CompletableFuture.completedFuture(WORKSPACE_SCOPE);
                // Acquiring again cannot help here, so this is no request for
                // adoption.
                RuntimeBrokerException conflict = failure(restarted.cancelExecution(
                        "harness", PROVIDER_SESSION, settled.getExecutionCallId()));
                assertEquals("runtime_session_conflict", conflict.getCode());
                assertFalse(conflict.isRetryable());
            }
            assertEquals(0, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void rejectsForeignOrPayloadBearingProviderReservationsAndControls() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            Map<String, Object> reference = new HashMap<>(providerReference());
            reference.put("input", Map.of());
            RuntimeBrokerException reserveFailure = assertThrows(RuntimeBrokerException.class,
                    () -> fixture.service.prepareExecution(
                            "harness", PROVIDER_SESSION, "key", reference));
            assertEquals("runtime_reference_invalid", reserveFailure.getCode());
            assertNull(fixture.executionRepository.findByIdempotencyKey("key"));
            assertFalse(fixture.executionRepository.hasActiveByRuntimeSession(PROVIDER_SESSION));
            reference.remove("input");
            reference.put("sessionId", "other");
            RuntimeBrokerException controlFailure = assertThrows(RuntimeBrokerException.class,
                    () -> fixture.service.control(
                            "harness", PROVIDER_SESSION, Map.of("kind", "preflight", "reference", reference)));
            assertEquals("runtime_control_operation_invalid", controlFailure.getCode());
            assertNull(fixture.transport.lastControl);
            assertEquals(0, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void rejectsANullValuedDeferredReferenceOnTheStageChannel() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            Map<String, Object> reference = new HashMap<>();
            reference.put("sessionId", null);
            reference.put("promptId", "turn-1");
            reference.put("callId", "call-1");
            reference.put("argsDigest", "sha256:" + "a".repeat(64));
            // The rejection must arrive on the returned stage, not as a
            // synchronous throw escaping the method.
            CompletionStage<ToolExecutionRecord> stage = fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", reference);
            assertEquals("runtime_reference_invalid", failure(stage).getCode());
            assertNull(fixture.executionRepository.findByIdempotencyKey("key"));
        }
    }

    @Test
    void reconcileSettlesAnUnknownProviderExecutionOnTerminalEvidence() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            fixture.transport.executeResult = CompletableFuture.failedFuture(
                    new IllegalStateException("lost response"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            ToolExecutionRecord unknown = join(fixture.service.startExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
            fixture.transport.statusResult = CompletableFuture.completedFuture(Map.of("state", "settled",
                    "result", Map.of("executionStatus", "success", "result", Map.of("llmContent", "done"))));
            ExecutionReconciliation reconciled = join(fixture.service.reconcileExecution(
                    "harness", PROVIDER_SESSION, unknown.getExecutionCallId()));
            assertEquals(ExecutionReconciliation.Outcome.RESOLVED, reconciled.getOutcome());
            assertEquals(ToolExecutionRecord.State.SETTLED, fixture.executionRepository
                    .findByExecutionCallId(unknown.getExecutionCallId()).getState());
            assertEquals(providerReference(), fixture.transport.lastReference);
            assertEquals(1, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void preparedProviderCancellationRejectsUnknownOrSuccessfulEvidence() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of("state", "unknown"));
            RuntimeBrokerException unknown = failure(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals("runtime_execution_cancel_unconfirmed", unknown.getCode());
            assertFalse(unknown.isRetryable());
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of("state", "settled",
                    "result", Map.of("executionStatus", "success")));
            RuntimeBrokerException executed = failure(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals("runtime_execution_cancel_unconfirmed", executed.getCode());
            assertFalse(executed.isRetryable());
            // Neither failed observation rewrote the cancelled receipt.
            assertEquals("cancelled", fixture.executionRepository
                    .findByExecutionCallId(prepared.getExecutionCallId()).getResult().get("executionStatus"));
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of("state", "settled",
                    "result", Map.of("executionStatus", "not_started")));
            assertEquals("cancelled", join(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId())).getExecutionStatus());
        }
    }

    @Test
    void repeatedPreparedProviderCancellationStaysUnconfirmedOnceTheWorkerForgotTheCall() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of(
                    "state", "settled", "result", Map.of("executionStatus", "not_started")));
            ToolExecutionRecord cancelled = join(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            // The worker forgets settled calls when the next turn begins; its
            // unknown is no confirmation, on a repeat as on a first cancel.
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of("state", "unknown"));
            RuntimeBrokerException unconfirmed = failure(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals("runtime_execution_cancel_unconfirmed", unconfirmed.getCode());
            assertFalse(unconfirmed.isRetryable());
            assertEquals(2, fixture.transport.cancelCalls.get());
            assertSame(cancelled, join(fixture.service.getExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId())));
        }
    }

    @Test
    void repeatedCancellationOfADispatchedProviderExecutionReturnsItsReceipt() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
            fixture.transport.executeResult = result;
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            join(fixture.service.startExecution("harness", PROVIDER_SESSION, prepared.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED, join(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId())).getState());
            result.complete(Map.of("executionStatus", "cancelled"));
            ToolExecutionRecord cancelled = awaitExecution(fixture.executionRepository,
                    prepared.getExecutionCallId(), ToolExecutionRecord.State.SETTLED);
            assertEquals("cancelled", cancelled.getExecutionStatus());
            assertTrue(cancelled.isCancelRequested());
            assertTrue(cancelled.getDispatchGeneration() >= 1);
            int cancels = fixture.transport.cancelCalls.get();
            // The execute answer settled it, so the receipt stands on its
            // own; the worker, which forgets settled calls, is not asked.
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of("state", "unknown"));
            assertSame(cancelled, join(fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId())));
            assertEquals(cancels, fixture.transport.cancelCalls.get());
        }
    }

    @Test
    void preparedProviderCancellationWaitsForOriginalNotStartedEvidence() throws Exception {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of("state", "cancel_requested"));
            fixture.transport.statusResult = new CompletableFuture<>();
            CompletionStage<ToolExecutionRecord> cancellation = fixture.service.cancelExecution(
                    "harness", PROVIDER_SESSION, prepared.getExecutionCallId());
            assertEquals("runtime_session_busy", failure(fixture.service.release(
                    "harness", PROVIDER_SESSION)).getCode());
            fixture.transport.statusResult.complete(Map.of("state", "settled",
                    "result", Map.of("executionStatus", "not_started")));
            assertEquals("cancelled", cancellation.toCompletableFuture().get(2, TimeUnit.SECONDS).getExecutionStatus());
            assertEquals(1, fixture.transport.cancelCalls.get());
            assertEquals(1, fixture.transport.statusCalls.get());
            assertEquals(providerReference(), fixture.transport.lastReference);
            assertEquals(0, fixture.transport.executeCalls.get());
            assertTrue(join(fixture.service.release("harness", PROVIDER_SESSION)));
        }
    }

    @Test
    void preparedProviderCancellationHasABoundedObservationDeadline() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, new MutableClock(START),
                Duration.ofMillis(100), Duration.ofMinutes(1))) {
            join(fixture.service.acquire("harness", PROVIDER_SESSION, "bootstrap"));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", PROVIDER_SESSION, "key", providerReference()));
            fixture.transport.cancelResult = CompletableFuture.completedFuture(Map.of("state", "cancel_requested"));
            fixture.transport.statusResult = new CompletableFuture<>();
            assertTimeoutPreemptively(Duration.ofSeconds(2), () -> assertEquals("runtime_execution_cancel_failed",
                    failure(fixture.service.cancelExecution("harness", PROVIDER_SESSION,
                            prepared.getExecutionCallId())).getCode()));
            assertEquals(0, fixture.transport.executeCalls.get());
            assertEquals(0, fixture.transport.releaseCalls.get());
        }
    }

    private static Map<String, Object> providerReference() {
        return Map.of("sessionId", PROVIDER_SESSION, "promptId", "turn", "callId", "call",
                "argsDigest", "a".repeat(64), "capabilityDigest", "b".repeat(64),
                "policyRevision", "policy", "invocationId", "invocation");
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
    void cancellationAcceptsUnknownRuntimeStatus() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.transport.executeResult = new CompletableFuture<>();
            fixture.transport.cancelResult = CompletableFuture.completedFuture(
                    Map.of("state", "unknown"));
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
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    join(fixture.service.getExecution("harness", "runtime",
                            created.getExecutionCallId())).getState());
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
            Supplier<ToolExecutionRecord> current =
                    () -> fixture.executionRepository.findByExecutionCallId(
                            created.getExecutionCallId());
            Duration step = Duration.ofMillis(40);

            await(() -> current.get().getVersion() > initialVersion,
                    () -> "dispatch lease was never renewed");
            advanceAndAwaitRenewal(clock, step,
                    () -> current.get().getDispatchLeaseUntil(),
                    "dispatch lease");
            clock.advance(step);
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
            Supplier<RuntimeBindingRecord> current =
                    () -> fixture.bindingRepository.findActive(request);
            Duration step = Duration.ofMillis(40);
            await(() -> current.get().getVersion() > 1,
                    () -> "operation lease was never renewed");
            advanceAndAwaitRenewal(clock, step,
                    () -> current.get().getOperationLeaseUntil(),
                    "operation lease");
            clock.advance(step);
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
                    Map.of("kind", "manifest"));
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
    void inFlightDeferredV3AcknowledgementBlocksRelease() {
        Map<String, Object> manifest = Map.of("resourceId", "manifest", "kind",
                "managed-tool-result-manifest", "schemaVersion", 1,
                "byteLength", 1, "digest", "a".repeat(64));
        Map<String, Object> receipt = Map.of("executionCallId", "durable-v3",
                "manifest", manifest, "deliveryStatus", "committed",
                "historyRevision", 1);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                throw new AssertionError("No dispatch expected");
            }

            @Override
            public Map<String, Object> receipt(ToolExecutionRecord execution) {
                return receipt;
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            ToolExecutionRecord prepared = fixture.executionRepository.findOrCreate(
                    ToolExecutionRecord.prepared("durable-v3", "v3-key",
                            session.getBindingId(), session.getRuntimeGeneration(),
                            "harness", "runtime", "prompt", "call", "digest",
                            Map.of("sessionId", "runtime", "promptId", "prompt",
                                    "callId", "call", "argsDigest", "canonical",
                                    "payloadDigest", "digest", "dispatchMode", "deferred_v3",
                                    "publicationId", "pub-1")));
            ToolExecutionRecord claimed = fixture.executionRepository.claimDispatch(
                    "durable-v3", "other-broker", Duration.ofMinutes(1));
            fixture.executionRepository.compareAndSet(claimed,
                    claimed.withResult(Map.of("executionStatus", "success"), 1, START),
                    "other-broker", claimed.getDispatchGeneration());
            Map<String, Object> conflicting = new HashMap<>(receipt);
            conflicting.put("deliveryStatus", "blocked");
            assertEquals("runtime_execution_conflict", failure(
                    fixture.service.acknowledgeExecution("harness", "runtime",
                            prepared.getExecutionCallId(), conflicting)).getCode());
            CompletableFuture<Map<String, Object>> acknowledgement = new CompletableFuture<>();
            fixture.transport.acknowledgeV3Result = acknowledgement;

            CompletionStage<Map<String, Object>> pending = fixture.service.acknowledgeExecution(
                    "harness", "runtime", prepared.getExecutionCallId(), receipt);
            assertEquals("runtime_session_busy", failure(
                    fixture.service.release("harness", "runtime")).getCode());
            acknowledgement.complete(Map.of("state", "settled"));
            assertEquals("settled", join(pending).get("state"));
            assertTrue(join(fixture.service.release("harness", "runtime")));
        }
    }

    @Test
    void deferredV3SettlesOnlyAnExplicitNotStartedAnswer() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\"}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            Map<String, Object> notStarted = new java.util.LinkedHashMap<>();
            notStarted.put("executionStatus", "not_started");
            notStarted.put("capture", null);
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(Map.of(
                    "state", "settled", "result", notStarted));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));

            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));

            ToolExecutionRecord settled = awaitExecution(fixture.executionRepository,
                    prepared.getExecutionCallId(), ToolExecutionRecord.State.SETTLED);
            assertEquals("not_started", settled.getExecutionStatus());
            assertTrue(settled.getResult().containsKey("capture"));
            assertNull(settled.getResult().get("capture"));
            assertEquals(1, fixture.transport.executeV3Calls.get());
            assertEquals(0, fixture.transport.statusV3Calls.get());

            fixture.transport.executeV3Result = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(409, "workspace_unavailable", "remote refusal", false));
            ToolExecutionRecord next = join(fixture.service.prepareExecution(
                    "harness", "runtime", "next-key", reference, digest, "pub-2"));
            join(fixture.service.startExecution("harness", "runtime",
                    next.getExecutionCallId(), payload, "pub-2", "token"));
            assertEquals(ToolExecutionRecord.State.UNKNOWN, awaitExecution(fixture.executionRepository,
                    next.getExecutionCallId(), ToolExecutionRecord.State.UNKNOWN).getState());
            assertEquals(2, fixture.transport.executeV3Calls.get());
            assertEquals(0, fixture.transport.statusV3Calls.get());
        }
    }

    @Test
    void backgroundV3DetachedHandleSettlesThroughTheStatusAnswer() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }

            @Override
            public Map<String, Object> receipt(ToolExecutionRecord execution) {
                throw new AssertionError("Detached family has no publication receipt to compare");
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));

            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));

            ToolExecutionRecord settled = awaitExecution(fixture.executionRepository,
                    prepared.getExecutionCallId(), ToolExecutionRecord.State.SETTLED);
            assertEquals("success", settled.getExecutionStatus());
            assertEquals("detached",
                    ((Map<?, ?>) settled.getResult().get("capture")).get("captureStatus"));
            assertNull(((Map<?, ?>) settled.getResult().get("capture")).get("manifest"));
            assertTrue(fixture.transport.statusV3Calls.get() >= 1);

            Map<String, Object> receipt = new LinkedHashMap<>();
            receipt.put("executionCallId", prepared.getExecutionCallId());
            receipt.put("manifest", null);
            receipt.put("deliveryStatus", "blocked");
            receipt.put("historyRevision", null);
            CompletableFuture<Map<String, Object>> acknowledgement = new CompletableFuture<>();
            fixture.transport.acknowledgeV3Result = acknowledgement;
            CompletionStage<Map<String, Object>> pending = fixture.service.acknowledgeExecution(
                    "harness", "runtime", prepared.getExecutionCallId(), receipt);
            acknowledgement.complete(Map.of("state", "settled"));
            assertEquals("settled", join(pending).get("state"));
            Map<String, Object> wrong = new LinkedHashMap<>(receipt);
            wrong.put("manifest", Map.of("resourceId", "m"));
            assertEquals("runtime_execution_conflict", failure(fixture.service.acknowledgeExecution(
                    "harness", "runtime", prepared.getExecutionCallId(), wrong)).getCode());
        }
    }

    @Test
    void v3GateAdmitsTheNativeMonitorPayloadAndStillRefusesOthers() throws Exception {
        String payload = "{\"toolName\":\"monitor\",\"input\":{\"command\":\"du -sh .\"}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "watch started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }

            @Override
            public Map<String, Object> receipt(ToolExecutionRecord execution) {
                throw new AssertionError("Detached family has no publication receipt to compare");
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            // The Monitor payload passed the payload validator and the v3 gate,
            // so the dispatch drove exactly one execute call to the worker.
            ToolExecutionRecord settled = awaitExecution(fixture.executionRepository,
                    prepared.getExecutionCallId(), ToolExecutionRecord.State.SETTLED);
            assertEquals("success", settled.getExecutionStatus());
            assertEquals(1, fixture.transport.executeV3Calls.get());

            String editing = "{\"toolName\":\"edit\",\"input\":{\"file_path\":\"a\"}}";
            String editingDigest = "sha256:" + HexFormat.of().formatHex(MessageDigest
                    .getInstance("SHA-256").digest(editing.getBytes(StandardCharsets.UTF_8)));
            ToolExecutionRecord other = join(fixture.service.prepareExecution(
                    "harness", "runtime", "other-key", reference, editingDigest, "pub-2"));
            RuntimeBrokerException refusal = failure(fixture.service.startExecution(
                    "harness", "runtime", other.getExecutionCallId(), editing, "pub-2", "token"));
            assertEquals("runtime_payload_invalid", refusal.getCode());
        }
    }

    @Test
    void settlesTheProcessRowWhenTheRuntimeProvesNoStartAndReleasesCleanly()
            throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            // The Runtime proves it never started: the envelope is the
            // admitted refusal's not_started shape with its own error.
            Map<String, Object> notStarted = new LinkedHashMap<>();
            notStarted.put("executionStatus", "not_started");
            notStarted.put("responseParts", java.util.List.of());
            notStarted.put("capture", null);
            notStarted.put("error", Map.of("message",
                    "Background Shell requires a delegated Linux cgroup v2 root on this Runtime."));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", notStarted));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", notStarted));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));

            ToolExecutionRecord process = fixture.executionRepository
                    .findByExecutionCallId(prepared.getExecutionCallId() + ":process");
            assertEquals(ToolExecutionRecord.State.SETTLED, process.getState(),
                    "the proven never-started must settle its process row");
            assertEquals("not_started", process.getResult().get("state"));
            assertEquals("not_started", process.getExecutionStatus());
            assertTrue(join(fixture.service.release("harness", "runtime")),
                    "and the hold goes with it, never a permanent busy");
        }
    }

    @Test
    void reconcileOfAnUnansweredBackgroundSettlesTheProcessRowWithTheSameProof() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            // The dispatch went dark before its execute ever flew: the
            // :process row is admitted, the invocation is UNKNOWN.
            fixture.transport.executeV3Result = CompletableFuture.failedFuture(
                    new IllegalStateException("connection lost"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository,
                    prepared.getExecutionCallId(), ToolExecutionRecord.State.UNKNOWN);

            // The Runtime's own terminal answer later proves the start never
            // happened. The resume that settles the invocation must carry
            // that proof onto the sibling row too, or every release from
            // here on is a permanent runtime_session_busy.
            Map<String, Object> notStarted = new LinkedHashMap<>();
            notStarted.put("executionStatus", "not_started");
            notStarted.put("responseParts", java.util.List.of());
            notStarted.put("capture", null);
            notStarted.put("error", Map.of("message",
                    "Background Shell requires a delegated Linux cgroup v2 root on this Runtime."));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", notStarted));
            join(fixture.service.reconcileExecution("harness", "runtime",
                    prepared.getExecutionCallId()));
            ToolExecutionRecord process = fixture.executionRepository
                    .findByExecutionCallId(prepared.getExecutionCallId() + ":process");
            assertEquals(ToolExecutionRecord.State.SETTLED, process.getState(),
                    "the reconcile resume must propagate the never-started proof");
            assertEquals("not_started", process.getResult().get("state"));
            assertEquals("not_started", process.getExecutionStatus());
            assertTrue(join(fixture.service.release("harness", "runtime")));
        }
    }

    @Test
    void backgroundStartAdmitsTheProcessRowBesideTheSettledHandle() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));

            ToolExecutionRecord process = awaitExecution(fixture.executionRepository,
                    prepared.getExecutionCallId() + ":process",
                    ToolExecutionRecord.State.PREPARED);
            assertEquals("background_v3_process",
                    process.getReference().get("dispatchMode"));
            assertEquals(prepared.getExecutionCallId(), process.getReference().get("processOf"));
            awaitExecution(fixture.executionRepository, prepared.getExecutionCallId(),
                    ToolExecutionRecord.State.SETTLED);
            assertEquals("runtime_session_busy",
                    failure(fixture.service.release("harness", "runtime")).getCode());

            Map<String, Object> exited = new LinkedHashMap<>();
            exited.put("operationId", "call");
            exited.put("state", "exited");
            exited.put("unitName", "qwen-bg-call");
            exited.put("evidence", Map.of("exitCode", 0));
            fixture.transport.controlResult = CompletableFuture.completedFuture(exited);
            ToolExecutionRecord settled = join(fixture.service.observeBackgroundProcess(
                    "harness", "runtime", prepared.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
            assertEquals("exited", settled.getResult().get("state"));
            assertTrue(join(fixture.service.release("harness", "runtime")));
        }
    }

    @Test
    void unprovenProcessStatusKeepsItsHold() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository, prepared.getExecutionCallId() + ":process",
                    ToolExecutionRecord.State.PREPARED);

            fixture.transport.controlResult = CompletableFuture.completedFuture(
                    Map.of("operationId", "call", "state", "unknown"));
            ToolExecutionRecord answered = join(fixture.service.observeBackgroundProcess(
                    "harness", "runtime", prepared.getExecutionCallId()));
            assertEquals(ToolExecutionRecord.State.PREPARED, answered.getState());
            assertEquals("runtime_session_busy",
                    failure(fixture.service.release("harness", "runtime")).getCode());
        }
    }

    @Test
    void releaseSettlesAnExitedBackgroundProcessBeforeBusy() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository, prepared.getExecutionCallId() + ":process",
                    ToolExecutionRecord.State.PREPARED);

            Map<String, Object> exitedAnswer = new LinkedHashMap<>();
            exitedAnswer.put("operationId", "call");
            exitedAnswer.put("state", "exited");
            Map<String, Object> evidence = new LinkedHashMap<>();
            evidence.put("exitCode", 3);
            evidence.put("exitSignal", null);
            exitedAnswer.put("evidence", evidence);
            fixture.transport.controlResult = CompletableFuture.completedFuture(
                    exitedAnswer);
            // The Shell ended on its own: release must learn it from the
            // owner and settle the row, not wedge on busy.
            assertTrue(join(fixture.service.release("harness", "runtime")));

            ToolExecutionRecord settled = fixture.executionRepository
                    .findByExecutionCallId(prepared.getExecutionCallId() + ":process");
            assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
            assertEquals("exited", settled.getResult().get("state"));
            assertEquals("error", settled.getExecutionStatus());
            assertEquals(evidence, settled.getResult().get("evidence"));
        }
    }

    @Test
    void releaseStopsARunningBackgroundShellBeforeRefusingBusy() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"tail -f\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository, prepared.getExecutionCallId() + ":process",
                    ToolExecutionRecord.State.PREPARED);

            // The shell is still running: the sweep issues the stop through
            // the maintenance route — never a speculative release, whose
            // busy answer the transport layer could never even classify —
            // and an unproven stop still answers busy.
            fixture.transport.controlHandler = operation -> CompletableFuture
                    .completedFuture(Map.of("operationId", "call", "state", "running"));
            assertEquals("runtime_session_busy",
                    failure(fixture.service.release("harness", "runtime")).getCode());
            assertEquals(java.util.List.of("shell-status", "shell-terminate",
                            "shell-status"),
                    fixture.transport.controls.stream()
                            .map(each -> (String) each.get("kind")).toList());
            assertEquals(prepared.getExecutionCallId() + ":process",
                    fixture.transport.controls.get(0).get("operationId"));
            assertEquals("call",
                    fixture.transport.controls.get(0).get("targetOperationId"));
            assertEquals(0, fixture.transport.releaseCalls.get());
            assertEquals(ToolExecutionRecord.State.PREPARED,
                    fixture.executionRepository.findByExecutionCallId(
                            prepared.getExecutionCallId() + ":process").getState());

            // The stop worked: the owner now answers exited with evidence;
            // the next release settles that evidence and releases for good.
            Map<String, Object> exited = new LinkedHashMap<>();
            exited.put("operationId", "call");
            exited.put("state", "exited");
            exited.put("evidence", Map.of("exitCode", 143));
            fixture.transport.controlHandler = null;
            fixture.transport.controlResult = CompletableFuture.completedFuture(exited);
            assertTrue(join(fixture.service.release("harness", "runtime")));
            assertEquals(1, fixture.transport.releaseCalls.get());
            ToolExecutionRecord settled = fixture.executionRepository
                    .findByExecutionCallId(prepared.getExecutionCallId() + ":process");
            assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
            assertEquals("exited", settled.getResult().get("state"));
            assertEquals("error", settled.getExecutionStatus());
        }
    }

    @Test
    void releaseSweepsADurableOnlyBackgroundRow() throws Exception {
        // A Broker restart before the release leaves a `:process` row the
        // fresh SessionContext never had in memory: the sweep must rebuild
        // its work list from the repository, not from the in-memory index,
        // or the row answers busy forever (R3-56).
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            String harness = "harness";
            String digest = "sha256:" + "a".repeat(64);
            Map<String, Object> invocationReference = Map.of("sessionId",
                    "runtime", "promptId", "prompt", "callId", "call-b",
                    "argsDigest", digest);
            ToolExecutionRecord invocation = ToolExecutionRecord.prepared(
                    "call-b", "key-b", session.getBindingId(),
                    session.getRuntimeGeneration(), harness, "runtime",
                    "prompt", "call-b", digest, invocationReference);
            ToolExecutionRecord admitted = fixture.bindingRepository
                    .admitExecution(fixture.sessionRepository,
                            fixture.executionRepository, invocation);
            Map<String, Object> detached = new LinkedHashMap<>();
            detached.put("state", "exited");
            detached.put("executionStatus", "success");
            fixture.executionRepository.settlePrepared(admitted, detached,
                    java.time.Instant.now());
            Map<String, Object> processReference = Map.of("dispatchMode",
                    "background_v3_process", "processOf", "call-b",
                    "sessionId", "runtime", "promptId", "prompt", "callId",
                    "call-b", "argsDigest", digest);
            ToolExecutionRecord process = ToolExecutionRecord.prepared(
                    "call-b:process", "call-b:process", session.getBindingId(),
                    session.getRuntimeGeneration(), harness, "runtime",
                    "prompt", "call-b", digest, processReference);
            fixture.bindingRepository.admitExecution(fixture.sessionRepository,
                    fixture.executionRepository, process);

            Map<String, Object> exited = new LinkedHashMap<>();
            exited.put("operationId", "call-b");
            exited.put("state", "exited");
            exited.put("evidence", Map.of("exitCode", 0));
            fixture.transport.controlResult = CompletableFuture.completedFuture(exited);
            assertTrue(join(fixture.service.release("harness", "runtime")));
            ToolExecutionRecord settled = fixture.executionRepository
                    .findByExecutionCallId("call-b:process");
            assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
            assertEquals("exited", settled.getResult().get("state"));
        }
    }

    @Test
    void releaseSettlesARunningBackgroundShellOnceTheStopProvesIt() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"tail -f\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository, prepared.getExecutionCallId() + ":process",
                    ToolExecutionRecord.State.PREPARED);

            // One release begins while the stop evidence already came back:
            // the swept row settles in the same attempt.
            fixture.transport.controlHandler = operation -> CompletableFuture
                    .completedFuture("shell-terminate".equals(operation.get("kind"))
                            ? Map.of("operationId", "call", "state", "exited",
                                    "evidence", Map.of("exitCode", 143))
                            : Map.of("operationId", "call", "state", "running"));
            assertTrue(join(fixture.service.release("harness", "runtime")));
            assertEquals(java.util.List.of("shell-status", "shell-terminate"),
                    fixture.transport.controls.stream()
                            .map(each -> (String) each.get("kind")).toList());
            ToolExecutionRecord settled = fixture.executionRepository
                    .findByExecutionCallId(prepared.getExecutionCallId() + ":process");
            assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
            assertEquals("exited", settled.getResult().get("state"));
            assertEquals(Map.of("exitCode", 143), settled.getResult().get("evidence"));
            assertEquals("error", settled.getExecutionStatus());
            assertEquals(1, fixture.transport.releaseCalls.get());
        }
    }

    @Test
    void cancelRefusesASettleWithoutEvidenceForABackgroundProcess() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"tail -f\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository, prepared.getExecutionCallId() + ":process",
                    ToolExecutionRecord.State.PREPARED);

            // Cancelling the derived row must never settle a live process as
            // cancelled: it settles only on the owner's stop evidence.
            assertEquals("runtime_execution_conflict",
                    failure(fixture.service.cancelExecution("harness", "runtime",
                            prepared.getExecutionCallId() + ":process")).getCode());
            ToolExecutionRecord row = fixture.executionRepository
                    .findByExecutionCallId(prepared.getExecutionCallId() + ":process");
            assertEquals(ToolExecutionRecord.State.PREPARED, row.getState());
            assertFalse(row.isTerminal());
            assertTrue(fixture.executionRepository.hasActiveByRuntimeSession(
                    row.getBindingId(), row.getRuntimeGeneration(), "runtime"));
        }
    }

    @Test
    void acknowledgeOfADetachedHandleNeverPinsItsControl() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }

            @Override
            public Map<String, Object> receipt(ToolExecutionRecord execution) {
                throw new AssertionError("Detached family has no publication receipt to compare");
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository,
                    prepared.getExecutionCallId(), ToolExecutionRecord.State.SETTLED);

            Map<String, Object> wrong = new LinkedHashMap<>();
            wrong.put("executionCallId", prepared.getExecutionCallId());
            wrong.put("manifest", null);
            wrong.put("deliveryStatus", "pending");
            wrong.put("historyRevision", null);
            assertEquals("runtime_execution_conflict",
                    failure(fixture.service.acknowledgeExecution("harness",
                            "runtime", prepared.getExecutionCallId(), wrong))
                            .getCode());
            // The refused acknowledge left no control behind: the release
            // afterwards sweeps the row and completes, never answers busy.
            fixture.transport.controlResult = CompletableFuture.completedFuture(
                    Map.of("operationId", "call", "state", "exited",
                            "evidence", Map.of("exitCode", 0)));
            assertTrue(join(fixture.service.release("harness", "runtime")));
        }
    }

    @Test
    void concurrentReleasesJoinOneSweepAndOneRelease() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"tail -f\",\"is_background\":true}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> detachedCapture = new LinkedHashMap<>();
        detachedCapture.put("captureStatus", "detached");
        detachedCapture.put("captureReason", null);
        detachedCapture.put("manifest", null);
        detachedCapture.put("previewTruncated", false);
        detachedCapture.put("deliveryStatus", "pending");
        Map<String, Object> detachedResult = new LinkedHashMap<>();
        detachedResult.put("executionStatus", "success");
        detachedResult.put("responseParts", java.util.List.of(Map.of("text", "started")));
        detachedResult.put("capture", detachedCapture);
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                return new RuntimePublicationGrant(publicationId, token, "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId", execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "sha256:" + "a".repeat(64));
            fixture.transport.executeV3Result = CompletableFuture.completedFuture(
                    Map.of("state", "prepared"));
            fixture.transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", detachedResult));
            ToolExecutionRecord prepared = join(fixture.service.prepareExecution(
                    "harness", "runtime", "key", reference, digest, "pub-1"));
            join(fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token"));
            awaitExecution(fixture.executionRepository, prepared.getExecutionCallId() + ":process",
                    ToolExecutionRecord.State.PREPARED);

            // Two releases of one Session share one sweep and one Runtime
            // release: while the first attempt's status control is in
            // flight, the second must join it, never sweep against it.
            java.util.concurrent.CountDownLatch entered =
                    new java.util.concurrent.CountDownLatch(1);
            CompletableFuture<Object> firstControl =
                    new CompletableFuture<>();
            java.util.concurrent.atomic.AtomicInteger controlCalls =
                    new java.util.concurrent.atomic.AtomicInteger();
            fixture.transport.controlHandler = operation -> {
                if (controlCalls.getAndIncrement() == 0) {
                    entered.countDown();
                    return firstControl;
                }
                return CompletableFuture.completedFuture(Map.of(
                        "operationId", "call", "state", "exited",
                        "evidence", Map.of("exitCode", 0)));
            };
            CompletableFuture<Boolean> first = fixture.service
                    .release("harness", "runtime").toCompletableFuture();
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS));
            CompletableFuture<Boolean> second = fixture.service
                    .release("harness", "runtime").toCompletableFuture();
            firstControl.complete(Map.of("operationId", "call", "state",
                    "exited", "evidence", Map.of("exitCode", 0)));
            assertTrue(join(first));
            assertTrue(join(second));
            assertEquals(1, fixture.transport.releaseCalls.get());
            assertEquals(1, controlCalls.get());
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    fixture.executionRepository.findByExecutionCallId(
                            prepared.getExecutionCallId() + ":process").getState());
        }
    }

    @Test
    void busyStandsWithoutAWorkerHopForNonBackgroundExecutions() throws Exception {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            fixture.executionRepository.findOrCreate(
                    ToolExecutionRecord.prepared("durable-v3", "v3-key",
                            session.getBindingId(), session.getRuntimeGeneration(),
                            "harness", "runtime", "prompt", "call", "digest",
                            Map.of("sessionId", "runtime", "promptId", "prompt",
                                    "callId", "call", "argsDigest", "canonical",
                                    "payloadDigest", "digest", "dispatchMode", "deferred_v3",
                                    "publicationId", "pub-1")));
            // Something besides the Session's background processes still
            // runs: no drain may fire, the refusal stands as-is.
            assertEquals("runtime_session_busy",
                    failure(fixture.service.release("harness", "runtime")).getCode());
            assertEquals(0, fixture.transport.releaseCalls.get());
        }
    }

    @Test
    void cancelUnknownDeferredV3CallsTheOriginalRuntime() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            ToolExecutionRecord prepared = fixture.executionRepository.findOrCreate(
                    ToolExecutionRecord.prepared("durable-v3", "v3-key",
                            session.getBindingId(), session.getRuntimeGeneration(),
                            "harness", "runtime", "prompt", "call", "digest",
                            Map.of("sessionId", "runtime", "promptId", "prompt",
                                    "callId", "call", "argsDigest", "canonical",
                                    "payloadDigest", "digest", "dispatchMode", "deferred_v3",
                                    "publicationId", "pub-1")));
            ToolExecutionRecord claimed = fixture.executionRepository.claimDispatch(
                    "durable-v3", "other-broker", Duration.ofMinutes(1));
            ToolExecutionRecord executing = fixture.executionRepository.compareAndSet(claimed,
                    claimed.withState(ToolExecutionRecord.State.EXECUTING, false),
                    "other-broker", claimed.getDispatchGeneration());
            fixture.executionRepository.compareAndSet(executing, executing.withUnknown(),
                    "other-broker", executing.getDispatchGeneration());

            join(fixture.service.cancelExecution("harness", "runtime",
                    prepared.getExecutionCallId()));
            assertEquals(1, fixture.transport.cancelV3Calls.get());
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
    void mcpControlsStayWithTheAcquiredSessionAndNeverProvisionForLookup() {
        try (Fixture fixture = new Fixture(SESSION_SCOPE)) {
            RuntimeSessionRecord session = join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            for (String kind : List.of("mcp-configure", "mcp-discover", "mcp-status", "mcp-cancel", "mcp-release")) {
                Map<String, Object> operation = Map.of("kind", kind, "operationId", "operation",
                        "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"));
                assertEquals("ok", join(fixture.service.control("harness", "runtime", operation)));
                assertEquals(operation, fixture.transport.lastControl);
            }
            Map<String, Object> foreign = Map.of("kind", "mcp-status", "operationId", "lookup",
                    "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "foreign", "sessionId", "harness"));
            assertEquals("runtime_control_operation_invalid", failure(fixture.service.control("harness", "runtime", foreign)).getCode());
            assertEquals("runtime_session_not_found", failure(fixture.service.control("harness", "new-runtime", foreign)).getCode());
            assertEquals(1, fixture.provisioner.calls.get());
            assertEquals(session.getSession(), fixture.transport.lastSession);
        }
    }

    @Test
    void hookControlsStayWithTheAcquiredSessionAndNeverProvisionForLookup() {
        try (Fixture fixture = new Fixture(SESSION_SCOPE)) {
            RuntimeSessionRecord session = join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            for (String kind : List.of("hook-catalog", "hook-execute", "hook-status", "hook-cancel")) {
                Map<String, Object> operation = Map.of("kind", kind, "operationId", "operation",
                        "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"));
                assertEquals("ok", join(fixture.service.control("harness", "runtime", operation)));
                assertEquals(operation, fixture.transport.lastControl);
            }
            Map<String, Object> foreign = Map.of("kind", "hook-status", "operationId", "lookup",
                    "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "foreign", "sessionId", "harness"));
            assertEquals("runtime_control_operation_invalid", failure(fixture.service.control("harness", "runtime", foreign)).getCode());
            assertEquals("runtime_session_not_found", failure(fixture.service.control("harness", "new-runtime", foreign)).getCode());
            assertEquals(1, fixture.provisioner.calls.get());
            assertEquals(session.getSession(), fixture.transport.lastSession);
        }
    }

    @Test
    void refusesIllFormedMcpStringsBeforeForwarding() {
        try (Fixture fixture = new Fixture(SESSION_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            for (String surrogate : List.of("\uD800", "\uDC00")) {
                for (Map<String, Object> request : List.of(
                        Map.<String, Object>of("kind", "resource_read", "uri", "a" + surrogate + "b"),
                        Map.<String, Object>of("kind", "prompt_get", "name", "prompt",
                                "arguments", Map.of("a" + surrogate + "b", "value")))) {
                    Map<String, Object> operation = Map.of("kind", "mcp-invoke", "operationId", "operation",
                            "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"),
                            "request", request);
                    RuntimeBrokerException error = failure(fixture.service.control("harness", "runtime", operation));
                    assertEquals(400, error.getStatusCode());
                    assertEquals("runtime_control_operation_invalid", error.getCode());
                    assertFalse(error.isRetryable());
                    assertNull(fixture.transport.lastControl);
                }
            }
            Map<String, Object> valid = Map.of("kind", "mcp-invoke", "operationId", "operation",
                    "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"),
                    "request", Map.of("kind", "resource_read", "uri", "a\uD83D\uDE00b"));
            assertEquals("ok", join(fixture.service.control("harness", "runtime", valid)));
            assertEquals(valid, fixture.transport.lastControl);
        }
    }

    @Test
    void observesTheOriginalOwnerAfterNewAdmissionIsRevoked() {
        try (Fixture fixture = new Fixture(SESSION_SCOPE)) {
            RuntimeSessionRecord original = join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            fixture.resolver.result = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(403, "workspace_access_denied", "Access revoked", false));
            assertEquals(original, join(fixture.service.acquire("harness", "runtime", "bootstrap")));
            Map<String, Object> lookup = Map.of("kind", "mcp-status", "operationId", "lookup",
                    "targetOperationId", "original-operation",
                    "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"));
            assertEquals("ok", join(fixture.service.control("harness", "runtime", lookup)));
            assertEquals("workspace_access_denied", failure(fixture.service.acquire("harness", "new-runtime", "bootstrap")).getCode());
            assertEquals("runtime_session_conflict", failure(fixture.service.acquire("other", "runtime", "bootstrap")).getCode());
            assertEquals("runtime_session_conflict", failure(fixture.service.acquire("harness", "runtime", "continuation")).getCode());
            RuntimeBindingRecord binding = fixture.bindingRepository.findById(original.getBindingId());
            fixture.bindingRepository.compareAndSet(binding, binding.withState(RuntimeBindingRecord.State.LOST, binding.getLease(), START));
            assertEquals("runtime_admission_closed", failure(fixture.service.acquire("harness", "runtime", "bootstrap")).getCode());
            assertEquals(1, fixture.provisioner.calls.get());
            assertEquals(1, fixture.transport.acquireCalls.get());
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
    void reclaimRenewsItsClaimThroughSlowLostCleanup() {
        MutableClock clock = new MutableClock(START);
        SlowRecoveryBindingRepository bindings =
                new SlowRecoveryBindingRepository(clock,
                        Duration.ofMillis(1200));
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository(clock);
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "slow-cleanup");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {};
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(2),
                Duration.ofSeconds(2), clock, () -> "execution")) {
            // Each recoverLost burns 1.2s of the 2s claim, like the slow
            // JDBC transactions of a loaded CI runner; only the inline
            // renewal between cleanup steps keeps the claim live, so this
            // answered runtime_provision_fenced before (#13017).
            assertEquals("runtime_broker_runtime_lost",
                    failure(service.warm("slow-cleanup-harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    bindings.findById(lost.getBindingId()).getState());
        }
    }

    @Test
    void reclaimStillFencesWhenTheClaimGenuinelyLapses() {
        MutableClock clock = new MutableClock(START);
        StaleBindingRepository bindings = new StaleBindingRepository(clock);
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository(clock);
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "lapsed-cleanup");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                // A single step that outlasts the whole operation lease
                // must still fence rather than march on with a dead claim.
                clock.advance(Duration.ofSeconds(3));
                return super.reconcile(request, seed,
                        handle, lease);
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(2),
                Duration.ofSeconds(2), clock, () -> "execution")) {
            assertEquals("runtime_provision_fenced",
                    failure(service.warm("lapsed-cleanup-harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    bindings.findById(lost.getBindingId()).getState());
        }
    }

    @Test
    void reclaimRenewsItsClaimBeforeASlowReconcile() {
        MutableClock clock = new MutableClock(START);
        SlowRecoveryBindingRepository bindings =
                new SlowRecoveryBindingRepository(clock,
                        Duration.ofMillis(1200));
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository(clock);
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "slow-reconcile");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                clock.advance(Duration.ofMillis(1200));
                return super.reconcile(request, seed,
                        handle, lease);
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(2),
                Duration.ofSeconds(2), clock, () -> "execution")) {
            // recoverLost burns 1.2s and the reconcile another 1.2s of the
            // 2s claim; without the stretch renew before the provisioner
            // call the post-step renewal at 2.4s meets a claim that lapsed
            // at 2s and this answers runtime_provision_fenced.
            assertEquals("runtime_broker_runtime_lost",
                    failure(service.warm("slow-reconcile-harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    bindings.findById(lost.getBindingId()).getState());
        }
    }

    @Test
    void reclaimReleasesAnObservationAtThreeQuartersOfTheLease()
            throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "three-quarters");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                // 3000ms of a 4s lease (0.75L) — the latency band the
                // shipped callees' declared waits live in. The step's own
                // renewal keeps the claim alive through it, so the chain
                // must finish RELEASED rather than cut the observation and
                // pin the binding LOST on every attempt. The future must
                // complete asynchronously: a synchronous sleep inside the
                // supplier only delays arming orTimeout instead of tripping
                // it, and MutableClock cannot move the delayer.
                return CompletableFuture.supplyAsync(
                        () -> RuntimeObservation.notFound(
                                lost.getLossEvidence(),
                                RuntimeRecoveryContract.evidence(lost,
                                        RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)),
                        CompletableFuture.delayedExecutor(3000,
                                TimeUnit.MILLISECONDS));
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(4),
                Duration.ofSeconds(4), Clock.systemUTC(), () -> "execution")) {
            RuntimeBindingRecord recovered = service.recoverBinding(
                    lost.getBindingId(), lost.getGeneration())
                    .toCompletableFuture().get(15, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    recovered.getState());
            assertEquals(0, sessions.countActiveByBinding(
                    recovered.getBindingId(), recovered.getGeneration()));
        }
    }

    @Test
    void reclaimKeepsItsClaimAliveAcrossAPastLeaseObservation()
            throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "past-lease");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                // 3.5s of a 3s lease: without the step's own renewal ticks
                // the claim lapses mid-wait and the post-step renewal
                // fences; with them the chain finishes RELEASED.
                return CompletableFuture.supplyAsync(
                        () -> RuntimeObservation.notFound(
                                lost.getLossEvidence(),
                                RuntimeRecoveryContract.evidence(lost,
                                        RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)),
                        CompletableFuture.delayedExecutor(3500,
                                TimeUnit.MILLISECONDS));
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(3),
                Duration.ofSeconds(3), Clock.systemUTC(), () -> "execution")) {
            RuntimeBindingRecord recovered = service.recoverBinding(
                    lost.getBindingId(), lost.getGeneration())
                    .toCompletableFuture().get(15, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    recovered.getState());
            assertEquals(0, sessions.countActiveByBinding(
                    recovered.getBindingId(), recovered.getGeneration()));
        }
    }

    @Test
    void reclaimNamesAStepItCutShort() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "cut-step");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                return new CompletableFuture<>();
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(2),
                Duration.ofSeconds(2), Clock.systemUTC(), () -> "execution")) {
            // The reconcile never answers; when the step bound cuts it the
            // caller must hear a named, retryable timeout rather than a raw
            // TimeoutException or a silent "no observation".
            assertEquals("runtime_broker_reconcile_timeout",
                    failure(service.recoverBinding(lost.getBindingId(),
                            lost.getGeneration())).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    bindings.findById(lost.getBindingId()).getState());
        }
    }

    @Test
    void recoverBindingSettlesAStalledObservation() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "stalled-observation");
        bindings.releaseOperation(fixture.binding.getBindingId(), "recovery",
                fixture.binding.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                return new CompletableFuture<>();
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        fixture.binding.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(2),
                Duration.ofSeconds(2), Clock.systemUTC(), () -> "execution")) {
            // The observation hangs; the step backstop (2x the 2s lease)
            // must settle the maintenance call with a named timeout well
            // before the 4x-lease outer backstop would.
            RuntimeBrokerException timeout = assertTimeoutPreemptively(
                    Duration.ofMillis(5200),
                    () -> failure(service.recoverBinding(
                            fixture.binding.getBindingId(),
                            fixture.binding.getGeneration())));
            assertEquals("runtime_broker_reconcile_timeout",
                    timeout.getCode());
        }
    }

    @Test
    void reclaimRenewsItsClaimBeforeRecoveringResources() {
        MutableClock clock = new MutableClock(START);
        SlowRecoveryBindingRepository bindings =
                new SlowRecoveryBindingRepository(clock,
                        Duration.ofMillis(1200));
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository(clock);
        RuntimeBindingRecord lost = managedStoppedLostBinding(bindings,
                sessions, clock);
        AtomicInteger recoverResourcesCalls = new AtomicInteger();
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<Void> recoverResources(
                    RuntimeBindingRecord binding) {
                recoverResourcesCalls.incrementAndGet();
                // The stores match the cleanup against record_version, so
                // the provisioner must see the version-current record, not
                // a pre-renewal snapshot.
                assertEquals(
                        bindings.findById(binding.getBindingId())
                                .getVersion(),
                        binding.getVersion(),
                        "recoverResources must receive the version-current record");
                clock.advance(Duration.ofMillis(900));
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(2),
                Duration.ofSeconds(2), clock, () -> "execution")) {
            // The managed-context cleanup is the only path that reaches
            // recoverResources: recoverLost twice burns 2.4s and the
            // resource recovery another 0.9s of the 2s claim, so without
            // the renew handed to the provisioner the final renewal meets
            // a lapsed claim and fences AFTER the destructive step ran.
            RuntimeBindingRecord recovered = join(service.recoverBinding(
                    lost.getBindingId(), lost.getGeneration()));
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    recovered.getState());
            assertEquals(1, recoverResourcesCalls.get());
            assertEquals(0, sessions.countActiveByBinding(
                    lost.getBindingId(), lost.getGeneration()));
        }
    }

    @Test
    void recoverBindingOutlivesOneLeaseAcrossSlowRepositorySteps()
            throws Exception {
        var bindings = new SlowWallRecoveryBindings(
                new InMemoryRuntimeBindingRepository(), 1800);
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "slow-wall");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                // Asynchronous so the chain suspends: only then is the
                // outer backstop armed early enough to fire mid-chain.
                return CompletableFuture.supplyAsync(
                        () -> RuntimeObservation.notFound(
                                lost.getLossEvidence(),
                                RuntimeRecoveryContract.evidence(lost,
                                        RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)),
                        CompletableFuture.delayedExecutor(1700,
                                TimeUnit.MILLISECONDS));
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(3),
                Duration.ofSeconds(3), Clock.systemUTC(), () -> "execution")) {
            // The chain's wall time (~5.3s: 1.8s recoverLost + 1.7s
            // observation + 1.8s recoverLost) spans more than one 3s
            // lease. Every step is renewed and individually bounded, so
            // the 4x-lease outer backstop lets it finish RELEASED; the old
            // whole-lease outer bound would cut it mid-chain with a raw
            // TimeoutException.
            RuntimeBindingRecord recovered = service.recoverBinding(
                    lost.getBindingId(), lost.getGeneration())
                    .toCompletableFuture().get(12, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    recovered.getState());
            assertEquals(0, sessions.countActiveByBinding(
                    lost.getBindingId(), lost.getGeneration()));
        }
    }

    @Test
    void recoverBindingNamesAHungAttestation() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "hung-attest");
        bindings.releaseOperation(fixture.binding.getBindingId(), "recovery",
                fixture.binding.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                return CompletableFuture.completedFuture(
                        RuntimeObservation.ready(handle,
                                URI.create("http://127.0.0.1:4190"),
                                seed.getProvisionalRuntimeId(),
                                seed.getLeaseId(), seed.getEpoch()));
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        RuntimeTransport hangingAttest = (RuntimeTransport) Proxy.newProxyInstance(
                RuntimeTransport.class.getClassLoader(),
                new Class<?>[] {RuntimeTransport.class}, (proxy, method, args) -> {
                    if ("attest".equals(method.getName())) {
                        return new CompletableFuture<>();
                    }
                    throw new AssertionError("Unexpected transport: " + method);
                });
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        fixture.binding.getRequest().getScope()),
                provisioner, hangingAttest, bindings, sessions, executions,
                "restarted", Duration.ofSeconds(6), Duration.ofSeconds(6),
                Clock.systemUTC(), () -> "execution")) {
            // The runtime accepts the attest connection and never answers;
            // the step bound (2/3 of the 6s lease) must cut it with a named
            // timeout well before the 4x-lease backstop.
            RuntimeBrokerException timeout = assertTimeoutPreemptively(
                    Duration.ofMillis(5200),
                    () -> failure(service.recoverBinding(
                            fixture.binding.getBindingId(),
                            fixture.binding.getGeneration())));
            assertEquals("runtime_broker_reconcile_timeout",
                    timeout.getCode());
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findById(fixture.binding.getBindingId())
                            .getState());
        }
    }

    @Test
    void resourceRecoveryPastOneLeaseKeepsItsClaimAlive() throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        RuntimeBindingRecord lost = managedStoppedLostBinding(bindings,
                sessions, Clock.systemUTC());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<Void> recoverResources(
                    RuntimeBindingRecord binding) {
                // 2.4s of a 1.5s lease: the destructive step outlasts the
                // claim it started with; only the step's own renewal keeps
                // it live for the finishLostRecovery that follows.
                return CompletableFuture.runAsync(() -> { },
                        CompletableFuture.delayedExecutor(2400,
                                TimeUnit.MILLISECONDS));
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        lost.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofMillis(1500),
                Duration.ofMillis(1500), Clock.systemUTC(),
                () -> "execution")) {
            RuntimeBindingRecord recovered = service.recoverBinding(
                    lost.getBindingId(), lost.getGeneration())
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    recovered.getState());
        }
    }

    /** Holds the evidence CAS until a renewal-thread tick lands (bounded). */
    private static final class TickWindowRepository
            extends DelegatingBindingRepository {
        final AtomicInteger ticks = new AtomicInteger();
        final AtomicBoolean held = new AtomicBoolean();

        TickWindowRepository() {
            super(new InMemoryRuntimeBindingRepository());
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

        @Override
        public RuntimeBindingRecord compareAndSet(
                RuntimeBindingRecord expected,
                RuntimeBindingRecord replacement) {
            if (expected.getLossEvidence() == null
                    && replacement.getLossEvidence() != null
                    && held.compareAndSet(false, true)) {
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
    }

    @Test
    void settledStepStopsItsRenewal() throws Exception {
        var bindings = new TickWindowRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions,
                executions, "settled-step");
        RuntimeBindingRecord ready = fixture.binding;
        bindings.releaseOperation(ready.getBindingId(), "recovery",
                ready.getOperationGeneration());
        RuntimeProvisioner provisioner = new LostDomainProvisioner() {
            @Override
            public CompletionStage<RuntimeObservation> reconcile(
                    RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
                    RuntimeLease lease) {
                return CompletableFuture.supplyAsync(
                        () -> RuntimeObservation.notFound(
                                RuntimeRecoveryContract.evidence(ready,
                                        RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                                RuntimeRecoveryContract.evidence(ready,
                                        RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)),
                        CompletableFuture.delayedExecutor(100,
                                TimeUnit.MILLISECONDS));
            }

            @Override
            public boolean supportsStartupRecovery(
                    RuntimeResourceHandle handle) {
                return true;
            }
        };
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(
                        ready.getRequest().getScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "restarted", Duration.ofSeconds(3),
                Duration.ofSeconds(3), Clock.systemUTC(), () -> "execution")) {
            // The reconcile leg settles fast; if its step renewal kept
            // ticking, a tick would land in the held evidence-CAS window
            // and the version bump would fence the write.
            RuntimeBindingRecord recovered = service.recoverBinding(
                    ready.getBindingId(), ready.getGeneration())
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            assertTrue(bindings.held.get());
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    recovered.getState());
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
            fixture.transport.cancelResult = CompletableFuture.completedFuture(
                    Map.of("state", "unknown"));
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
    void refusesAnIllFormedRuntimeSessionIdBeforeResolvingTheScope() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            for (String surrogate : List.of("\uD800", "\uDC00")) {
                assertThrows(IllegalArgumentException.class,
                        () -> fixture.service.acquire("harness",
                                "s" + surrogate, "bootstrap"));
            }
            assertNull(fixture.resolver.lastHarness.get());
        }
    }

    @Test
    void acquireRefusesSessionIdsTheWorkerWouldRefuseToRelease() {
        String rule = " must be 1-512 ASCII letters, digits, '.', '_' or '-', without '..'";
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            for (String id : List.of("a/b", "a\\b", "a..b", ".", "..", "a\u0001b",
                    "a\uD83D\uDE00b", "a b", "a:b")) {
                assertEquals("runtimeSessionId" + rule, assertThrows(IllegalArgumentException.class,
                        () -> fixture.service.acquire("harness", id, "bootstrap"), id).getMessage());
                assertEquals("harnessSessionId" + rule, assertThrows(IllegalArgumentException.class,
                        () -> fixture.service.acquire(id, "runtime", "bootstrap"), id).getMessage());
            }
            assertNull(fixture.resolver.lastHarness.get());
            assertEquals(0, fixture.transport.acquireCalls.get());
            // Opaque ids inside the worker's alphabet stay admitted in both positions.
            for (String id : List.of("harness-1", "runtime-session-1", PROVIDER_SESSION,
                    "turn_0123abcd", "v1.2")) {
                join(fixture.service.acquire(id, id, "bootstrap"));
                assertTrue(join(fixture.service.release(id, id)), id);
            }
            assertEquals(5, fixture.transport.acquireCalls.get());
        }
    }

    @Test
    void warmRefusesHarnessIdsBeforeResolvingOrProvisioning() {
        String rule = " must be 1-512 ASCII letters, digits, '.', '_' or '-', without '..'";
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            for (String id : List.of("a/b", "a\\b", "a..b", ".", "..", "a\u0001b",
                    "a😀b", "a b", "a:b")) {
                assertEquals("harnessSessionId" + rule, assertThrows(IllegalArgumentException.class,
                        () -> fixture.service.warm(id), id).getMessage());
            }
            assertNull(fixture.resolver.lastHarness.get());
            assertEquals(0, fixture.provisioner.calls.get());
            join(fixture.service.warm("harness-1"));
            assertEquals("harness-1", fixture.resolver.lastHarness.get());
            assertEquals(1, fixture.provisioner.calls.get());
        }
    }

    @Test
    void pathSafeIdsAdmitExactlyTheWorkersAsciiAllowList() {
        // The worker's envelope rule, character by character (TypeScript
        // pins the same set in managed-runtime-provider-protocol.test.ts).
        StringBuilder admitted = new StringBuilder();
        for (char character = 0; character < 0x80; character++) {
            try {
                BrokerValues.requirePathSafe("a" + character + "b", "id");
                admitted.append(character);
            } catch (IllegalArgumentException refused) {
                // Outside the allow-list.
            }
        }
        assertEquals("-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
                admitted.toString());
        // Letters and digits outside ASCII stay outside it too.
        for (String id : List.of("a\u00e9b", "a\u4e2db", "a\u0430b", "a\u0663b", "a\uff11b")) {
            assertThrows(IllegalArgumentException.class,
                    () -> BrokerValues.requirePathSafe(id, "id"), id);
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
            // The JSON writer would send each of these as "p?", whether the
            // lone surrogate is a high or a low one.
            for (String surrogate : List.of("\uD800", "\uDC00")) {
                for (String field : List.of("promptId", "callId",
                        "argsDigest")) {
                    Map<String, Object> reference = new HashMap<>(Map.of(
                            "sessionId", "runtime", "promptId", "prompt",
                            "callId", "call", "argsDigest", "digest"));
                    reference.put(field, "p" + surrogate);
                    RuntimeBrokerException refusal = failure(
                            fixture.service.createExecution("harness",
                                    "runtime", "surrogate-" + field
                                            + surrogate, reference));
                    assertEquals("runtime_reference_invalid",
                            refusal.getCode(), field);
                    // The identity check refuses it, before the whole
                    // reference is checked.
                    assertEquals("reference " + field + " is invalid",
                            refusal.getMessage());
                }
                // The Worker would run the rewritten tool name or input.
                for (Map<String, Object> call : List.<Map<String, Object>>of(
                        Map.of("toolName", "read" + surrogate,
                                "input", Map.of()),
                        Map.of("toolName", "run_shell_command", "input",
                                Map.of("command", "rm file" + surrogate)),
                        Map.of("toolName", "read_file", "input",
                                Map.of("path" + surrogate, "a")),
                        Map.of("toolName", "read_file", "input",
                                Map.of("args", List.of("y" + surrogate))))) {
                    Map<String, Object> reference = new HashMap<>(Map.of(
                            "sessionId", "runtime", "promptId", "prompt",
                            "callId", "call", "argsDigest", "digest"));
                    reference.putAll(call);
                    assertEquals("runtime_reference_invalid", failure(
                            fixture.service.createExecution("harness",
                                    "runtime", "tool-" + call.hashCode(),
                                    reference)).getCode(), call.toString());
                }
            }
            assertEquals(0, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void refusesADeferredPayloadWithALoneSurrogate()
            throws Exception {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            // A raw one, which the UTF-8 encoder would turn into '?', then
            // plain ASCII text where only the parsed payload shows the
            // surrogates the Worker would receive as '?'.
            for (String payload : List.of(
                    "{\"toolName\":\"read_file\",\"input\":{\"path\":\"a\ud800\"}}",
                    "{\"toolName\":\"read\\ud800\",\"input\":{}}",
                    "{\"toolName\":\"read_file\",\"input\":"
                            + "{\"path\":\"a\\udc00\"}}",
                    "{\"toolName\":\"read_file\",\"input\":"
                            + "{\"p\\udfff\":[\"a\"]}}")) {
                String digest = "sha256:" + HexFormat.of().formatHex(
                        MessageDigest.getInstance("SHA-256").digest(
                                payload.getBytes(StandardCharsets.UTF_8)));
                ToolExecutionRecord reserved = join(
                        fixture.service.prepareExecution("harness",
                                "runtime", "deferred-" + payload.hashCode(),
                                Map.of("sessionId", "runtime", "promptId",
                                        "prompt", "callId",
                                        "call-" + payload.hashCode(),
                                        "argsDigest", digest)));
                RuntimeBrokerException refusal = failure(
                        fixture.service.startExecution("harness", "runtime",
                                reserved.getExecutionCallId(), payload));
                assertEquals("runtime_payload_invalid", refusal.getCode(),
                        payload);
                assertEquals(400, refusal.getStatusCode());
            }
            assertEquals(0, fixture.transport.executeCalls.get());
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
                    "harness", "runtime", Map.of("kind", "manifest")));

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
                    "harness", "runtime", Map.of("kind", "manifest")));

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
                            Map.of("kind", "manifest"))));
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

    private static ToolExecutionRecord unknownExecution(Fixture fixture) {
        fixture.transport.executeResult = CompletableFuture.failedFuture(
                new IllegalStateException("connection lost"));
        join(fixture.service.acquire("harness", "runtime", "bootstrap"));
        ToolExecutionRecord unknown = join(fixture.service.createExecution(
                "harness", "runtime", "idempotency",
                reference("runtime", "digest")));
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        return unknown;
    }

    private static void seedUnknown(ToolExecutionRepository executions,
            String executionCallId, String bindingId, long generation) {
        seedUnknown(executions, executionCallId, bindingId, generation, 0);
    }

    private static void seedUnknown(ToolExecutionRepository executions,
            String executionCallId, String bindingId, long generation,
            long lastSequence) {
        executions.findOrCreate(ToolExecutionRecord.prepared(executionCallId,
                executionCallId + "-key", bindingId, generation, "harness",
                "runtime", "prompt", executionCallId, "digest",
                Map.of("sessionId", "runtime", "promptId", "prompt",
                        "callId", executionCallId, "argsDigest", "digest")));
        ToolExecutionRecord claimed = executions.claimDispatch(
                executionCallId, "other-broker", Duration.ofMinutes(1));
        ToolExecutionRecord executing = executions.compareAndSet(claimed,
                claimed.withState(ToolExecutionRecord.State.EXECUTING, false),
                "other-broker", claimed.getDispatchGeneration());
        ToolExecutionRecord unknown = new ToolExecutionRecord(
                executing.getExecutionCallId(),
                executing.getIdempotencyKey(), executing.getBindingId(),
                executing.getRuntimeGeneration(),
                executing.getHarnessSessionId(),
                executing.getRuntimeSessionId(), executing.getTurnId(),
                executing.getToolCallId(), executing.getRequestDigest(),
                executing.getReference(), ToolExecutionRecord.State.UNKNOWN,
                null, null, lastSequence, false,
                executing.getDispatchOwner(),
                executing.getDispatchLeaseUntil(),
                executing.getDispatchGeneration(), executing.getVersion(),
                null);
        assertEquals(lastSequence, executions.compareAndSet(executing,
                unknown, "other-broker", executing.getDispatchGeneration())
                .getLastSequence());
    }

    private static void seedExecuting(ToolExecutionRepository executions,
            String executionCallId, String bindingId, long generation) {
        executions.findOrCreate(ToolExecutionRecord.prepared(executionCallId,
                executionCallId + "-key", bindingId, generation, "harness",
                "runtime-settled", "prompt", executionCallId, "digest",
                Map.of("sessionId", "runtime-settled", "promptId", "prompt",
                        "callId", executionCallId, "argsDigest", "digest")));
        ToolExecutionRecord claimed = executions.claimDispatch(
                executionCallId, "other-broker", Duration.ofMinutes(1));
        executions.compareAndSet(claimed, claimed.withState(
                ToolExecutionRecord.State.EXECUTING, false), "other-broker",
                claimed.getDispatchGeneration());
    }

    private static RuntimeBrokerService restartedService(Fixture fixture) {
        return new RuntimeBrokerService(fixture.resolver,
                fixture.provisioner, fixture.transport,
                fixture.bindingRepository, fixture.sessionRepository,
                fixture.executionRepository, "broker-restarted",
                Duration.ofMinutes(1), Duration.ofMinutes(1));
    }

    private static void assertUnknownAndNotReplayed(Fixture fixture,
            ToolExecutionRecord unknown) {
        ToolExecutionRecord current = fixture.executionRepository
                .findByExecutionCallId(unknown.getExecutionCallId());
        assertEquals(ToolExecutionRecord.State.UNKNOWN, current.getState());
        assertEquals(unknown.getDispatchGeneration(),
                current.getDispatchGeneration());
        assertEquals(1, fixture.transport.executeCalls.get());
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

    /**
     * Advances the clock by one step and waits for a renewal made at the
     * advanced time. A renewal stamps the lease from the current clock, so
     * while the lease was last stamped at the current reading, every renewal
     * before the advance repeats the current end and only a renewal made
     * after the advance moves the end exactly one step later. Call it only
     * while the lease was last stamped at the current reading, such as before
     * the clock first moves. Keep the step shorter than the lease, or the
     * claim lapses at the advance and cannot be renewed. Waiting for a newer
     * record version instead could be satisfied by a renewal that landed just
     * before the advance.
     */
    private static void advanceAndAwaitRenewal(MutableClock clock,
            Duration step, Supplier<Instant> leaseEnd, String leaseName) {
        Instant renewedEnd = leaseEnd.get().plus(step);
        clock.advance(step);
        await(() -> leaseEnd.get().equals(renewedEnd),
                () -> leaseName + " ends at " + leaseEnd.get() + ", not "
                        + renewedEnd);
    }

    private static void await(BooleanSupplier condition) {
        await(condition, null);
    }

    private static void await(BooleanSupplier condition,
            Supplier<String> detail) {
        long deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() >= deadline) {
                throw new AssertionError(detail == null
                        ? "condition was not met in time"
                        : "condition was not met in time: " + detail.get());
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
    void transientReattestationFailureCanRetryTheLiveBinding() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.provisioner.retryFailedConfirm = true;
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
            assertEquals(RuntimeBindingRecord.State.READY,
                    fixture.bindingRepository.findById(ready.getBindingId())
                            .getState());

            fixture.provisioner.confirmResult =
                    CompletableFuture.completedFuture(null);
            assertEquals(ready.getBindingId(), join(fixture.service.warm("harness")).getBindingId());
            fixture.resolver.result = CompletableFuture.completedFuture(new RuntimeScope(
                    "tenant", "another-workspace", "generation", "/another-workspace",
                    "capability", "workspace"));
            assertEquals(RuntimeBindingRecord.State.READY,
                    join(fixture.service.warm("another-harness")).getState());
            assertEquals(2, fixture.provisioner.calls.get());
            assertEquals(0, fixture.provisioner.releaseCalls.get());
        }
    }

    @Test
    void deadProcessReattestationPinsTheBindingWithoutStopEvidence() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.provisioner.retryFailedConfirm = true;
            RuntimeBindingRecord ready = join(fixture.service.warm("harness"));
            fixture.provisioner.usable = false;
            fixture.provisioner.confirmResult = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(503, "runtime_provision_failed",
                            "Managed Runtime process is not alive.", true));

            assertEquals("runtime_provision_failed", failure(fixture.service.warm("harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindingRepository.findById(ready.getBindingId()).getState());
            fixture.provisioner.confirmResult = CompletableFuture.completedFuture(null);
            assertEquals("runtime_broker_runtime_lost", failure(fixture.service.warm("harness")).getCode());
            assertEquals(1, fixture.provisioner.calls.get());
            assertEquals(0, fixture.provisioner.releaseCalls.get());
        }
    }

    @Test
    void identityConflictStillPinsTheLiveBinding() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.provisioner.retryFailedConfirm = true;
            RuntimeBindingRecord ready = join(fixture.service.warm("harness"));
            fixture.provisioner.confirmResult = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(409, "managed_runtime_identity_conflict",
                            "Unexpected Runtime identity", false));

            assertEquals("managed_runtime_identity_conflict",
                    failure(fixture.service.warm("harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindingRepository.findById(ready.getBindingId()).getState());
            assertEquals(0, fixture.provisioner.releaseCalls.get());
        }
    }

    @Test
    void provisionerWithoutLiveRetryProofPinsAfterFailedConfirm() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeBindingRecord ready = join(fixture.service.warm("harness"));
            fixture.provisioner.confirmResult = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(503, "runtime_provision_failed",
                            "Attestation unavailable", true));

            assertEquals("runtime_provision_failed", failure(fixture.service.warm("harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindingRepository.findById(ready.getBindingId()).getState());
        }
    }

    @Test
    void deadLeaseDoesNotReleaseWithoutStopProof() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime", "bootstrap"));
            fixture.provisioner.usable = false;
            assertEquals("runtime_reconciliation_required",
                    failure(fixture.service.release("harness", "runtime")).getCode());
            assertEquals(0, fixture.transport.releaseCalls.get());
            assertEquals(0, fixture.provisioner.releaseCalls.get());
            assertEquals(RuntimeSessionRecord.State.READY,
                    fixture.sessionRepository.findById(WORKSPACE_SCOPE, "runtime").getState());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindingRepository.findById("binding-1").getState());
            fixture.provisioner.usable = true;
            assertEquals("runtime_broker_runtime_lost",
                    failure(fixture.service.acquire("harness", "runtime-2", "bootstrap")).getCode());
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

            assertEquals("runtime_reconciliation_required", busy.getCode());
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
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindingRepository.findById("binding-1")
                            .getState());
        }
    }

    @Test
    void settledLookupResolvesUnknownWithTheRuntimeResult() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.statusResult = CompletableFuture
                    .completedFuture(Map.of("state", "settled", "result",
                            Map.of("executionStatus", "error",
                                    "detail", "exit 1")));

            ExecutionReconciliation reconciled = join(
                    fixture.service.reconcileExecution("harness",
                            "runtime", unknown.getExecutionCallId()));

            assertEquals(ExecutionReconciliation.Outcome.RESOLVED,
                    reconciled.getOutcome());
            assertEquals("settled", reconciled.getRuntimeState());
            ToolExecutionRecord settled = reconciled.getRecord();
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    settled.getState());
            assertEquals("error", settled.getExecutionStatus());
            assertEquals("exit 1", settled.getResult().get("detail"));
            assertEquals(settled.getVersion(), fixture.executionRepository
                    .findByExecutionCallId(unknown.getExecutionCallId())
                    .getVersion());
            assertEquals(unknown.getReference(),
                    fixture.transport.lastReference);
            assertEquals(unknown.getLastSequence(),
                    fixture.transport.lastAfterSequence);
            assertEquals(fixture.provisioner.issuedLease,
                    fixture.transport.lastLease);
            assertEquals("harness", fixture.transport.lastSession
                    .getHarnessSessionId());
            assertEquals("runtime", fixture.transport.lastSession
                    .getRuntimeSessionId());
            assertEquals(1, fixture.transport.statusCalls.get());
            assertEquals(1, fixture.transport.executeCalls.get());
            assertTrue(join(fixture.service.release("harness",
                    "runtime")));
        }
    }

    @Test
    void finishedV3PublicationAnswersStatusWithoutAWorkerStatusQuery() {
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String publicationId, String token) {
                throw new AssertionError("Reconciliation cannot install another grant");
            }

            @Override
            public Map<String, Object> finished(ToolExecutionRecord execution) {
                assertEquals("durable-v3", execution.getExecutionCallId());
                return Map.of("executionStatus", "success", "responseParts", java.util.List.of());
            }
        };
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, verifier)) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            var prepared = fixture.executionRepository.findOrCreate(ToolExecutionRecord.prepared(
                    "durable-v3", "v3-key", session.getBindingId(), session.getRuntimeGeneration(),
                    "harness", "runtime", "prompt",
                    "call", "digest", Map.of("sessionId", "runtime", "promptId", "prompt",
                            "callId", "call", "argsDigest", "canonical", "payloadDigest", "digest",
                            "dispatchMode", "deferred_v3",
                            "publicationId", "pub-1")));
            var claimed = fixture.executionRepository.claimDispatch("durable-v3", "other-broker",
                    Duration.ofMinutes(1));
            var executing = fixture.executionRepository.compareAndSet(claimed,
                    claimed.withState(ToolExecutionRecord.State.EXECUTING, false),
                    "other-broker", claimed.getDispatchGeneration());
            assertEquals(prepared.getExecutionCallId(), executing.getExecutionCallId());
            fixture.executionRepository.compareAndSet(executing, executing.withUnknown(),
                    "other-broker", executing.getDispatchGeneration());

            var settled = join(fixture.service.getExecution("harness", "runtime", "durable-v3"));
            assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
            assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                    join(fixture.service.reconcileExecution("harness", "runtime", "durable-v3"))
                            .getOutcome());
            assertEquals(0, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void nonTerminalLookupKeepsTheExecutionUnknown() {
        for (String state : List.of("prepared", "executing",
                "cancel_requested", "unknown")) {
            try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
                ToolExecutionRecord unknown = unknownExecution(fixture);
                fixture.transport.statusResult = CompletableFuture
                        .completedFuture(Map.of("state", state));

                ExecutionReconciliation reconciled = join(
                        fixture.service.reconcileExecution("harness",
                                "runtime", unknown.getExecutionCallId()));

                assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                        reconciled.getOutcome(), state);
                assertEquals(state, reconciled.getRuntimeState());
                assertEquals(unknown.getVersion(),
                        reconciled.getRecord().getVersion(), state);
                assertUnknownAndNotReplayed(fixture, unknown);
                assertEquals("runtime_session_busy", failure(
                        fixture.service.release("harness", "runtime"))
                        .getCode(), state);
            }
        }
    }

    @Test
    void invalidLookupResponseKeepsTheExecutionUnknown() {
        Map<String, Object> resultOnPending = new HashMap<>();
        resultOnPending.put("state", "executing");
        resultOnPending.put("result", Map.of("executionStatus", "success"));
        Map<String, Object> nullField = new HashMap<>();
        nullField.put("state", "unknown");
        nullField.put(null, "value");
        List<Map<String, Object>> responses = List.of(
                nullField,
                Map.of(),
                Map.of("state", 1),
                Map.of("state", "done"),
                Map.of("state", "unknown", "reason", "missing"),
                Map.of("state", "settled"),
                Map.of("state", "settled", "result", "success"),
                Map.of("state", "settled", "result", Map.of()),
                Map.of("state", "settled", "result",
                        Map.of("executionStatus", "not_executed")),
                resultOnPending);
        for (Map<String, Object> response : responses) {
            try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
                ToolExecutionRecord unknown = unknownExecution(fixture);
                fixture.transport.statusResult =
                        CompletableFuture.completedFuture(response);

                RuntimeBrokerException error = failure(
                        fixture.service.reconcileExecution("harness",
                                "runtime", unknown.getExecutionCallId()));

                assertEquals("runtime_execution_status_invalid",
                        error.getCode(), response.toString());
                assertEquals(502, error.getStatusCode());
                assertFalse(error.isRetryable());
                assertUnknownAndNotReplayed(fixture, unknown);
            }
        }
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.statusResult =
                    CompletableFuture.completedFuture(null);

            assertEquals("runtime_execution_status_invalid", failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())).getCode());
            assertUnknownAndNotReplayed(fixture, unknown);
        }
    }

    @Test
    void lookupFailureKeepsTransportClassificationElseRetries() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.statusResult = CompletableFuture.failedFuture(
                    new IllegalStateException("connection reset"));

            RuntimeBrokerException lost = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));
            assertEquals("runtime_execution_reconcile_failed",
                    lost.getCode());
            assertTrue(lost.isRetryable());
            assertUnknownAndNotReplayed(fixture, unknown);

            fixture.transport.statusResult = CompletableFuture.failedFuture(
                    new RuntimeBrokerException(503,
                            "managed_runtime_unavailable", "unavailable",
                            true));
            RuntimeBrokerException unavailable = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));
            assertEquals("managed_runtime_unavailable",
                    unavailable.getCode());
            assertTrue(unavailable.isRetryable());

            for (int status : new int[] {404, 405, 409}) {
                fixture.transport.statusResult =
                        CompletableFuture.failedFuture(
                                new RuntimeBrokerException(status,
                                        "managed_runtime_incompatible",
                                        "incompatible", false));
                RuntimeBrokerException fatal = failure(
                        fixture.service.reconcileExecution("harness",
                                "runtime", unknown.getExecutionCallId()));
                assertEquals(status, fatal.getStatusCode());
                assertFalse(fatal.isRetryable());
            }

            fixture.transport.statusError = new IllegalStateException(
                    "thrown before a stage");
            assertEquals("runtime_execution_reconcile_failed", failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())).getCode());
            assertUnknownAndNotReplayed(fixture, unknown);
            assertEquals(6, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void transportWithoutLookupFailsClosed() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.defaultStatus = true;

            RuntimeBrokerException error = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));

            assertEquals("runtime_execution_status_unsupported",
                    error.getCode());
            assertFalse(error.isRetryable());
            assertUnknownAndNotReplayed(fixture, unknown);
        }
    }

    @Test
    void executionThatIsNotUnknownIsNeverLookedUp() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord settled = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency", reference("runtime", "digest")));
            assertTrue(settled.isSettled());

            ExecutionReconciliation reconciled = join(
                    fixture.service.reconcileExecution("harness", "runtime",
                            settled.getExecutionCallId()));

            assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                    reconciled.getOutcome());
            assertNull(reconciled.getRuntimeState());
            assertEquals(settled.getVersion(),
                    reconciled.getRecord().getVersion());
            assertEquals(0, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void onlyTheOriginalRuntimeGenerationIsAsked() {
        try (Fixture fixture = new Fixture(SESSION_SCOPE)) {
            RuntimeSessionRecord own = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            RuntimeSessionRecord other = join(fixture.service.acquire(
                    "harness-b", "runtime-b", "bootstrap"));
            seedUnknown(fixture.executionRepository, "other-binding",
                    other.getBindingId(), other.getRuntimeGeneration());
            seedUnknown(fixture.executionRepository, "missing-generation",
                    own.getBindingId(), own.getRuntimeGeneration() + 1);

            RuntimeBrokerException elsewhere = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            "other-binding"));
            assertEquals("runtime_execution_conflict", elsewhere.getCode());
            assertFalse(elsewhere.isRetryable());
            RuntimeBrokerException gone = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            "missing-generation"));
            assertEquals("runtime_execution_evidence_unavailable",
                    gone.getCode());
            assertFalse(gone.isRetryable());
            assertEquals(0, fixture.transport.statusCalls.get());
            assertEquals(0, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void deadRuntimeStopsPollingWithoutALookup() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.provisioner.usable = false;

            RuntimeBrokerException first = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));
            assertEquals("runtime_execution_evidence_unavailable",
                    first.getCode());
            assertFalse(first.isRetryable());
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindingRepository.findById("binding-1")
                            .getState());
            fixture.provisioner.usable = true;
            int releases = fixture.provisioner.releaseCalls.get();
            assertEquals("runtime_execution_evidence_unavailable", failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())).getCode());

            fixture.provisioner.usable = false;
            assertEquals("runtime_execution_evidence_unavailable", failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())).getCode());
            // A retired binding is not released again on every poll.
            assertEquals(releases, fixture.provisioner.releaseCalls.get());
            assertEquals(0, fixture.transport.statusCalls.get());
            assertUnknownAndNotReplayed(fixture, unknown);
        }
    }

    @Test
    void sessionNotAcquiredInThisProcessRequiresReconciliation() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            join(fixture.service.acquire("harness", "runtime-settled",
                    "bootstrap"));
            fixture.transport.executeResult = CompletableFuture
                    .completedFuture(Map.of("executionStatus", "success"));
            ToolExecutionRecord settled = join(
                    fixture.service.createExecution("harness",
                            "runtime-settled", "settled-key",
                            reference("runtime-settled", "digest")));
            assertTrue(settled.isSettled());
            RuntimeSessionRecord settledSession = fixture.sessionRepository
                    .findById(WORKSPACE_SCOPE, "runtime-settled");
            seedExecuting(fixture.executionRepository, "executing",
                    settledSession.getBindingId(),
                    settledSession.getRuntimeGeneration());
            try (RuntimeBrokerService restarted = restartedService(fixture)) {
                assertEquals(ExecutionReconciliation.Outcome.IN_FLIGHT,
                        join(restarted.reconcileExecution("harness",
                                "runtime-settled", "executing"))
                                .getOutcome());
                assertEquals("runtime_reconciliation_required", failure(
                        restarted.release("harness", "runtime")).getCode());
                fixture.resolver.result = CompletableFuture.failedFuture(
                        new IllegalStateException("resolver down"));
                assertEquals("runtime_scope_resolution_failed", failure(
                        restarted.reconcileExecution("harness", "runtime",
                                unknown.getExecutionCallId())).getCode());
                fixture.resolver.result =
                        CompletableFuture.completedFuture(SESSION_SCOPE);
                assertEquals("runtime_session_not_found", failure(
                        restarted.reconcileExecution("harness", "runtime",
                                unknown.getExecutionCallId())).getCode());
                fixture.resolver.result =
                        CompletableFuture.completedFuture(WORKSPACE_SCOPE);
                assertEquals("runtime_reconciliation_required", failure(
                        restarted.reconcileExecution("harness", "runtime",
                                unknown.getExecutionCallId())).getCode());
                assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                        join(restarted.reconcileExecution("harness",
                                "runtime-settled",
                                settled.getExecutionCallId())).getOutcome());
                assertEquals("runtime_execution_conflict", failure(
                        restarted.reconcileExecution("other-harness",
                                "runtime", unknown.getExecutionCallId()))
                        .getCode());
                assertEquals("runtime_execution_conflict", failure(
                        restarted.reconcileExecution("harness", "missing",
                                unknown.getExecutionCallId())).getCode());
                assertEquals("runtime_execution_conflict", failure(
                        restarted.reconcileExecution("harness",
                                "runtime-settled",
                                unknown.getExecutionCallId())).getCode());
            }
            RuntimeBindingRecord ready = fixture.bindingRepository
                    .findById("binding-1");
            fixture.bindingRepository.compareAndSet(ready, ready.withState(
                    RuntimeBindingRecord.State.LOST, ready.getLease(), START));
            try (RuntimeBrokerService restarted = restartedService(fixture)) {
                assertEquals("runtime_execution_evidence_unavailable",
                        failure(restarted.reconcileExecution("harness",
                                "runtime", unknown.getExecutionCallId()))
                                .getCode());
            }
            assertEquals(0, fixture.transport.statusCalls.get());
            // One failed call for the UNKNOWN record, one for the settled one.
            assertEquals(2, fixture.transport.executeCalls.get());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.executionRepository.findByExecutionCallId(
                            unknown.getExecutionCallId()).getState());
        }
    }

    @Test
    void pollAfterSettlementAndReleaseEndsWithNotUnknown() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.statusResult = CompletableFuture
                    .completedFuture(Map.of("state", "settled", "result",
                            Map.of("executionStatus", "success")));
            join(fixture.service.reconcileExecution("harness", "runtime",
                    unknown.getExecutionCallId()));
            assertTrue(join(fixture.service.release("harness", "runtime")));

            ExecutionReconciliation late = join(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));

            assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                    late.getOutcome());
            assertEquals("success", late.getRecord().getExecutionStatus());
            assertEquals(1, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void sessionThatIsNoLongerReadyIsNotAsked() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.executeResult = CompletableFuture
                    .completedFuture(Map.of("executionStatus", "success"));
            ToolExecutionRecord settled = join(
                    fixture.service.createExecution("harness", "runtime",
                            "settled-key", Map.of("sessionId", "runtime",
                                    "promptId", "prompt", "callId",
                                    "settled-call", "argsDigest",
                                    "digest")));
            assertTrue(settled.isSettled());
            RuntimeSessionRecord ready = fixture.sessionRepository.findById(
                    WORKSPACE_SCOPE, "runtime");
            fixture.sessionRepository.compareAndSet(ready, ready.withState(
                    RuntimeSessionRecord.State.RELEASING, START));

            assertEquals("runtime_session_not_ready", failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())).getCode());
            assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                    join(fixture.service.reconcileExecution("harness",
                            "runtime", settled.getExecutionCallId()))
                            .getOutcome());
            assertEquals(0, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void drainingBindingCanStillAnswer() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            RuntimeBindingRecord ready = fixture.bindingRepository
                    .findById("binding-1");
            RuntimeBindingRecord claimed = fixture.bindingRepository
                    .claimOperation("binding-1", "broker",
                            Duration.ofMinutes(1));
            assertEquals(RuntimeBindingRecord.State.DRAINING,
                    fixture.bindingRepository.compareAndSet(claimed,
                            claimed.withState(
                                    RuntimeBindingRecord.State.DRAINING,
                                    ready.getLease(), START)).getState());

            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    join(fixture.service.reconcileExecution("harness",
                            "runtime", unknown.getExecutionCallId()))
                            .getOutcome());
            assertEquals(1, fixture.transport.statusCalls.get());
            assertUnknownAndNotReplayed(fixture, unknown);
        }
    }

    @Test
    void hungLookupTimesOutAndFreesTheSlot() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE,
                new MutableClock(START), Duration.ofMillis(200),
                Duration.ofMinutes(1))) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            CompletableFuture<Map<String, Object>> hung =
                    new CompletableFuture<>();
            fixture.transport.statusResult = hung;

            // Bounded here too, so a missing service timeout fails the test
            // instead of hanging it.
            RuntimeBrokerException timedOut = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())
                            .toCompletableFuture()
                            .orTimeout(5, TimeUnit.SECONDS));
            assertEquals("runtime_execution_reconcile_failed",
                    timedOut.getCode());
            assertTrue(timedOut.isRetryable());
            // An answer after the timeout is dropped; the next poll asks.
            hung.complete(Map.of("state", "settled", "result",
                    Map.of("executionStatus", "error")));
            assertUnknownAndNotReplayed(fixture, unknown);

            fixture.transport.statusResult = CompletableFuture
                    .completedFuture(Map.of("state", "settled", "result",
                            Map.of("executionStatus", "success")));
            assertEquals(ExecutionReconciliation.Outcome.RESOLVED,
                    join(fixture.service.reconcileExecution("harness",
                            "runtime", unknown.getExecutionCallId()))
                            .getOutcome());
            assertEquals(2, fixture.transport.statusCalls.get());
            assertEquals("success", fixture.executionRepository
                    .findByExecutionCallId(unknown.getExecutionCallId())
                    .getExecutionStatus());
        }
    }

    @Test
    void closingTheServiceAbandonsAnInFlightLookup() {
        Fixture fixture = new Fixture(WORKSPACE_SCOPE);
        ToolExecutionRecord unknown = unknownExecution(fixture);
        CompletableFuture<Map<String, Object>> status =
                new CompletableFuture<>();
        fixture.transport.statusResult = status;
        CompletableFuture<ExecutionReconciliation> lookup =
                fixture.service.reconcileExecution("harness", "runtime",
                        unknown.getExecutionCallId()).toCompletableFuture();

        fixture.close();

        assertEquals("runtime_execution_reconcile_failed",
                failure(lookup.orTimeout(5, TimeUnit.SECONDS)).getCode());
        assertUnknownAndNotReplayed(fixture, unknown);
        assertThrows(IllegalStateException.class,
                () -> fixture.service.reconcileExecution("harness",
                        "runtime", unknown.getExecutionCallId()));
        // A Runtime answer that still arrives is evidence all the same.
        status.complete(Map.of("state", "settled", "result",
                Map.of("executionStatus", "success")));
        assertEquals(ToolExecutionRecord.State.SETTLED,
                fixture.executionRepository.findByExecutionCallId(
                        unknown.getExecutionCallId()).getState());
    }

    @Test
    void runtimeNotStartedAnswerIsTheRuntimesOwnEvidence() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.statusResult = CompletableFuture
                    .completedFuture(Map.of("state", "settled", "result",
                            Map.of("executionStatus", "not_started")));

            ExecutionReconciliation reconciled = join(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));

            assertEquals(ExecutionReconciliation.Outcome.RESOLVED,
                    reconciled.getOutcome());
            assertEquals("not_started",
                    reconciled.getRecord().getExecutionStatus());
            assertEquals(1, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void recordSettledElsewhereDuringALookupIsNotOverwritten() {
        for (String state : List.of("settled", "executing")) {
            try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
                ToolExecutionRecord unknown = unknownExecution(fixture);
                CompletableFuture<Map<String, Object>> status =
                        new CompletableFuture<>();
                fixture.transport.statusResult = status;
                CompletionStage<ExecutionReconciliation> lookup =
                        fixture.service.reconcileExecution("harness",
                                "runtime", unknown.getExecutionCallId());

                fixture.executionRepository.resolveUnknown(unknown,
                        Map.of("executionStatus", "success"), START);
                status.complete("settled".equals(state)
                        ? Map.of("state", state, "result",
                                Map.of("executionStatus", "error"))
                        : Map.of("state", state));

                ExecutionReconciliation reconciled = join(lookup);
                assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                        reconciled.getOutcome(), state);
                assertEquals("success",
                        reconciled.getRecord().getExecutionStatus(), state);
                assertEquals(state, reconciled.getRuntimeState());
                assertEquals(1, fixture.transport.executeCalls.get());
            }
        }
    }

    @Test
    void executionStillWithItsDispatchIsReportedInFlight() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.transport.executeResult = new CompletableFuture<>();
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            ToolExecutionRecord executing = join(
                    fixture.service.createExecution("harness", "runtime",
                            "idempotency", reference("runtime", "digest")));

            ExecutionReconciliation reconciled = join(
                    fixture.service.reconcileExecution("harness", "runtime",
                            executing.getExecutionCallId()));

            assertEquals(ExecutionReconciliation.Outcome.IN_FLIGHT,
                    reconciled.getOutcome());
            assertEquals(ToolExecutionRecord.State.EXECUTING,
                    reconciled.getRecord().getState());
            assertEquals(0, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void lookupCarriesTheRecordedSequence() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            RuntimeSessionRecord session = join(fixture.service.acquire(
                    "harness", "runtime", "bootstrap"));
            seedUnknown(fixture.executionRepository, "sequenced",
                    session.getBindingId(), session.getRuntimeGeneration(),
                    7);

            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    join(fixture.service.reconcileExecution("harness",
                            "runtime", "sequenced")).getOutcome());
            assertEquals(7, fixture.transport.lastAfterSequence);
            assertEquals(0, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void missingBindingRowCannotAnswer() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            join(fixture.service.acquire("harness", "runtime",
                    "bootstrap"));
            seedUnknown(fixture.executionRepository, "orphan",
                    "binding-missing", 1);

            RuntimeBrokerException error = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            "orphan"));

            assertEquals("runtime_execution_evidence_unavailable",
                    error.getCode());
            assertFalse(error.isRetryable());
            assertEquals(0, fixture.transport.statusCalls.get());
            assertEquals(0, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void sameSessionIdHeldByAnotherHarnessIsNotARoute() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            try (RuntimeBrokerService restarted = restartedService(fixture)) {
                // Another scope may reuse the Runtime Session id.
                fixture.resolver.result =
                        CompletableFuture.completedFuture(SESSION_SCOPE);
                join(restarted.acquire("harness-b", "runtime", "bootstrap"));
                RuntimeSessionRecord other = fixture.sessionRepository
                        .findById(SESSION_SCOPE, "runtime");
                fixture.sessionRepository.compareAndSet(other,
                        other.withState(RuntimeSessionRecord.State.RELEASING,
                                START));
                fixture.resolver.result =
                        CompletableFuture.completedFuture(WORKSPACE_SCOPE);

                RuntimeBrokerException error = failure(
                        restarted.reconcileExecution("harness", "runtime",
                                unknown.getExecutionCallId()));

                assertEquals("runtime_reconciliation_required",
                        error.getCode());
                assertTrue(error.isRetryable());
            }
            assertEquals(0, fixture.transport.statusCalls.get());
            assertUnknownAndNotReplayed(fixture, unknown);
        }
    }

    @Test
    void sessionStillBeingAcquiredIsNotWaitedOn() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            fixture.transport.acquireResult = new CompletableFuture<>();
            CompletionStage<RuntimeSessionRecord> acquiring =
                    fixture.service.acquire("harness", "runtime",
                            "bootstrap");
            RuntimeBindingRecord binding = fixture.bindingRepository
                    .findById("binding-1");
            seedUnknown(fixture.executionRepository, "pending-session",
                    binding.getBindingId(), binding.getGeneration());

            RuntimeBrokerException error = assertTimeoutPreemptively(
                    Duration.ofSeconds(5), () -> failure(
                            fixture.service.reconcileExecution("harness",
                                    "runtime", "pending-session")));

            assertEquals("runtime_reconciliation_required",
                    error.getCode());
            assertFalse(acquiring.toCompletableFuture().isDone());
            assertEquals(0, fixture.transport.statusCalls.get());
            assertEquals(0, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void leaseRetiredInThisProcessIsNeverAsked() {
        MutableClock clock = new MutableClock(START);
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE, clock,
                Duration.ofMinutes(1))) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            // Another owner holds the binding, so retiring the dead lease
            // here drops the local route but leaves the row READY.
            clock.advance(Duration.ofMinutes(2));
            assertEquals("other-broker", fixture.bindingRepository
                    .claimOperation("binding-1", "other-broker",
                            Duration.ofMinutes(10))
                    .getOperationOwner());
            fixture.provisioner.usable = false;
            failure(fixture.service.control("harness", "runtime",
                    Map.of("kind", "manifest")));
            fixture.provisioner.usable = true;
            assertEquals(RuntimeBindingRecord.State.READY,
                    fixture.bindingRepository.findById("binding-1")
                            .getState());

            RuntimeBrokerException error = failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));

            // This process released that worker, so it cannot answer even
            // though the lease still reports usable and the row is READY.
            assertEquals("runtime_execution_evidence_unavailable",
                    error.getCode());
            assertFalse(error.isRetryable());
            fixture.provisioner.usable = false;
            int releases = fixture.provisioner.releaseCalls.get();
            for (int poll = 0; poll < 3; poll++) {
                assertEquals("runtime_execution_evidence_unavailable",
                        failure(fixture.service.reconcileExecution("harness",
                                "runtime", unknown.getExecutionCallId()))
                                .getCode());
            }
            // The worker was released once, when the lease was retired.
            assertEquals(releases, fixture.provisioner.releaseCalls.get());
            assertEquals(0, fixture.transport.statusCalls.get());
            assertUnknownAndNotReplayed(fixture, unknown);
        }
    }

    @Test
    void transportStageThatThrowsDoesNotHoldTheLookupSlot() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            fixture.transport.statusResult =
                    new CompletableFuture<Map<String, Object>>() {
                        @Override
                        public CompletableFuture<Map<String, Object>>
                                whenComplete(BiConsumer<
                                        ? super Map<String, Object>,
                                        ? super Throwable> action) {
                            throw new UnsupportedOperationException();
                        }
                    };

            assertEquals("runtime_execution_reconcile_failed", failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())
                            .toCompletableFuture()
                            .orTimeout(5, TimeUnit.SECONDS)).getCode());
            fixture.transport.statusResult = CompletableFuture
                    .completedFuture(Map.of("state", "unknown"));
            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())
                            .toCompletableFuture()
                            .orTimeout(5, TimeUnit.SECONDS).join()
                            .getOutcome());
            assertEquals(2, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void repositoryFailuresAreRetryableReconcileFailures() {
        MutableClock clock = new MutableClock(START);
        HookedExecutionRepository executions =
                new HookedExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        transport.executeResult = CompletableFuture.failedFuture(
                new IllegalStateException("connection lost"));
        try (RuntimeBrokerService service = brokerService(clock, executions,
                transport)) {
            join(service.acquire("harness", "runtime", "bootstrap"));
            ToolExecutionRecord unknown = join(service.createExecution(
                    "harness", "runtime", "idempotency",
                    reference("runtime", "digest")));
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    unknown.getState());
            transport.statusResult = CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result",
                            Map.of("executionStatus", "success")));

            executions.rejectResolve = true;
            RuntimeBrokerException exhausted = failure(
                    service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));
            assertEquals("runtime_execution_reconcile_failed",
                    exhausted.getCode());
            assertTrue(exhausted.isRetryable());

            executions.rejectResolve = false;
            executions.failResolve = true;
            RuntimeBrokerException unwritable = failure(
                    service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));
            assertEquals("runtime_execution_reconcile_failed",
                    unwritable.getCode());
            assertTrue(unwritable.isRetryable());
            assertEquals(ToolExecutionRecord.State.UNKNOWN, executions
                    .findByExecutionCallId(unknown.getExecutionCallId())
                    .getState());
            executions.failResolve = false;

            executions.failReads = true;
            RuntimeBrokerException down = failure(
                    service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId()));
            assertEquals("runtime_execution_reconcile_failed",
                    down.getCode());
            assertTrue(down.isRetryable());
            assertEquals(2, transport.statusCalls.get());

            executions.failReads = false;
            executions.rejectResolve = false;
            assertEquals(ExecutionReconciliation.Outcome.RESOLVED,
                    join(service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())).getOutcome());
            assertEquals(1, transport.executeCalls.get());
        }
    }

    @Test
    void lookupIsScopedToTheCallersSessions() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            join(fixture.service.acquire("harness", "runtime-b",
                    "bootstrap"));

            assertEquals("runtime_execution_conflict", failure(
                    fixture.service.reconcileExecution("other-harness",
                            "runtime", unknown.getExecutionCallId()))
                    .getCode());
            assertEquals("runtime_execution_conflict", failure(
                    fixture.service.reconcileExecution("harness",
                            "runtime-b", unknown.getExecutionCallId()))
                    .getCode());
            assertEquals("runtime_execution_not_found", failure(
                    fixture.service.reconcileExecution("harness", "runtime",
                            "missing")).getCode());
            assertEquals(0, fixture.transport.statusCalls.get());
            assertUnknownAndNotReplayed(fixture, unknown);
        }
    }

    @Test
    void concurrentLookupsOfOneExecutionShareOneRuntimeCall() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            CompletableFuture<Map<String, Object>> status =
                    new CompletableFuture<>();
            fixture.transport.statusResult = status;

            CompletionStage<ExecutionReconciliation> first =
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId());
            CompletionStage<ExecutionReconciliation> second =
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId());
            assertEquals(1, fixture.transport.statusCalls.get());

            status.complete(Map.of("state", "settled", "result",
                    Map.of("executionStatus", "success")));
            assertSame(join(first), join(second));
            assertEquals(ExecutionReconciliation.Outcome.RESOLVED,
                    join(first).getOutcome());

            fixture.transport.statusResult = CompletableFuture
                    .completedFuture(Map.of("state", "unknown"));
            assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                    join(fixture.service.reconcileExecution("harness",
                            "runtime", unknown.getExecutionCallId()))
                            .getOutcome());
            assertEquals(1, fixture.transport.statusCalls.get());
            assertEquals(1, fixture.transport.executeCalls.get());
        }
    }

    @Test
    void pollChainedOnACompletedLookupAsksAgain() {
        try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
            ToolExecutionRecord unknown = unknownExecution(fixture);
            CompletableFuture<Map<String, Object>> status =
                    new CompletableFuture<>();
            fixture.transport.statusResult = status;
            CompletableFuture<ExecutionReconciliation> chained =
                    fixture.service.reconcileExecution("harness", "runtime",
                            unknown.getExecutionCallId())
                            .thenCompose(first -> {
                                fixture.transport.statusResult =
                                        CompletableFuture.completedFuture(
                                                Map.of("state", "unknown"));
                                return fixture.service.reconcileExecution(
                                        "harness", "runtime",
                                        unknown.getExecutionCallId());
                            }).toCompletableFuture();

            status.complete(Map.of("state", "executing"));

            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    chained.orTimeout(5, TimeUnit.SECONDS).join()
                            .getOutcome());
            assertEquals("unknown", chained.join().getRuntimeState());
            assertEquals(2, fixture.transport.statusCalls.get());
        }
    }

    @Test
    void cancelRacingALookupIsReReadBeforeSettling() {
        for (String state : List.of("settled", "executing")) {
            try (Fixture fixture = new Fixture(WORKSPACE_SCOPE)) {
                ToolExecutionRecord unknown = unknownExecution(fixture);
                CompletableFuture<Map<String, Object>> status =
                        new CompletableFuture<>();
                fixture.transport.statusResult = status;
                CompletionStage<ExecutionReconciliation> lookup =
                        fixture.service.reconcileExecution("harness",
                                "runtime", unknown.getExecutionCallId());

                ToolExecutionRecord cancelled = join(
                        fixture.service.cancelExecution("harness", "runtime",
                                unknown.getExecutionCallId()));
                assertEquals(ToolExecutionRecord.State.UNKNOWN,
                        cancelled.getState());
                assertTrue(cancelled.getVersion() > unknown.getVersion());
                status.complete("settled".equals(state)
                        ? Map.of("state", state, "result",
                                Map.of("executionStatus", "cancelled"))
                        : Map.of("state", state));

                ExecutionReconciliation reconciled = join(lookup);
                assertEquals("settled".equals(state)
                        ? ExecutionReconciliation.Outcome.RESOLVED
                        : ExecutionReconciliation.Outcome.UNRESOLVED,
                        reconciled.getOutcome(), state);
                assertTrue(reconciled.getRecord().isCancelRequested(),
                        state);
                assertTrue(reconciled.getRecord().getVersion()
                        >= cancelled.getVersion(), state);
                assertEquals(0, fixture.transport.cancelCalls.get());
                assertEquals(1, fixture.transport.executeCalls.get());
            }
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

        Fixture(RuntimeScope scope, RuntimePublicationVerifier verifier) {
            this(scope, new MutableClock(START), Duration.ofMinutes(1),
                    Duration.ofMinutes(1), verifier);
        }

        Fixture(RuntimeScope scope, Clock clock,
                Duration dispatchLeaseDuration) {
            this(scope, clock, Duration.ofMinutes(1),
                    dispatchLeaseDuration);
        }

        Fixture(RuntimeScope scope, Clock clock,
                Duration operationLeaseDuration,
                Duration dispatchLeaseDuration) {
            this(scope, clock, operationLeaseDuration, dispatchLeaseDuration, null);
        }

        private Fixture(RuntimeScope scope, Clock clock,
                Duration operationLeaseDuration,
                Duration dispatchLeaseDuration,
                RuntimePublicationVerifier verifier) {
            bindingRepository = new InMemoryRuntimeBindingRepository(clock,
                    () -> "binding-" + bindingIds.incrementAndGet());
            executionRepository =
                    new InMemoryToolExecutionRepository(clock);
            resolver = new FakeResolver(scope);
            transport.executionRepository = executionRepository;
            service = verifier == null
                    ? new RuntimeBrokerService(resolver, provisioner, transport,
                            bindingRepository, sessionRepository, executionRepository,
                            "broker", operationLeaseDuration, dispatchLeaseDuration,
                            clock, () -> "execution-" + executionIds.incrementAndGet())
                    : new RuntimeBrokerService(resolver, provisioner, transport,
                            bindingRepository, sessionRepository, executionRepository,
                            "broker", operationLeaseDuration, dispatchLeaseDuration,
                            verifier);
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
        volatile boolean retryFailedConfirm;
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
        public boolean canRetryFailedConfirm(RuntimeLease lease) {
            return retryFailedConfirm && usable;
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
        final AtomicInteger cancelV3Calls = new AtomicInteger();
        final AtomicInteger executeV3Calls = new AtomicInteger();
        final AtomicInteger statusV3Calls = new AtomicInteger();
        final AtomicInteger releaseCalls = new AtomicInteger();
        final AtomicInteger statusCalls = new AtomicInteger();
        volatile long lastAfterSequence = -1;
        volatile boolean defaultStatus;
        volatile RuntimeException statusError;
        volatile CompletableFuture<Map<String, Object>> statusResult =
                CompletableFuture.completedFuture(Map.of("state", "unknown"));
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
        final java.util.List<Map<String, Object>> controls =
                new java.util.ArrayList<>();
        volatile java.util.function.Function<Map<String, Object>,
                CompletionStage<Object>> controlHandler;
        volatile CompletableFuture<Map<String, Object>> executeResult =
                CompletableFuture.completedFuture(
                        Map.of("executionStatus", "success"));
        volatile CompletableFuture<Map<String, Object>> executeV3Result;
        volatile CompletableFuture<Map<String, Object>> cancelResult =
                CompletableFuture.completedFuture(
                        Map.of("state", "cancel_requested"));
        volatile CompletableFuture<Map<String, Object>> acknowledgeV3Result =
                CompletableFuture.completedFuture(Map.of("state", "settled"));
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
            controls.add(operation);
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
            return controlHandler == null ? controlResult
                    : controlHandler.apply(operation);
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
        public CompletionStage<Void> installPublication(RuntimeLease lease,
                RuntimeSession session, RuntimePublicationGrant grant) {
            return executeV3Result == null ? RuntimeTransport.super.installPublication(lease, session, grant)
                    : CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                Map<String, Object> payload, Map<String, Object> capture) {
            executeV3Calls.incrementAndGet();
            return executeV3Result == null ? RuntimeTransport.super.executeV3(lease, session,
                    reference, payload, capture) : executeV3Result;
        }

        @Override
        public CompletionStage<Map<String, Object>> statusV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference, long afterSequence) {
            statusV3Calls.incrementAndGet();
            return statusResult;
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
        public CompletionStage<Map<String, Object>> cancelV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancelV3Calls.incrementAndGet();
            return cancelResult;
        }

        @Override
        public CompletionStage<Map<String, Object>> acknowledgeV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                Map<String, Object> receipt) {
            return acknowledgeV3Result;
        }

        @Override
        public CompletionStage<Map<String, Object>> status(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, long afterSequence) {
            if (defaultStatus) {
                return RuntimeTransport.super.status(lease, session,
                        reference, afterSequence);
            }
            statusCalls.incrementAndGet();
            lastLease = lease;
            lastSession = session;
            lastReference = reference;
            lastAfterSequence = afterSequence;
            if (statusError != null) {
                throw statusError;
            }
            return statusResult;
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
        public ToolExecutionRecord settlePrepared(ToolExecutionRecord expected,
                Map<String, Object> result, Instant settlementTime) {
            return delegate.settlePrepared(expected, result, settlementTime);
        }
        @Override
        public boolean hasActiveByRuntimeSession(String bindingId, long generation,
                String runtimeSessionId) {
            return delegate.hasActiveByRuntimeSession(bindingId, generation, runtimeSessionId);
        }

        @Override
        public boolean hasActiveByRuntimeSession(String bindingId, long generation,
                String runtimeSessionId,
                java.util.Set<String> excludingExecutionCallIds) {
            return delegate.hasActiveByRuntimeSession(bindingId, generation,
                    runtimeSessionId, excludingExecutionCallIds);
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

        @Override
        public ToolExecutionRecord resolveUnsettled(ToolExecutionRecord expected,
                Map<String, Object> result, Instant time) {
            return delegate.resolveUnsettled(expected, result, time);
        }

        @Override
        public List<ToolExecutionRecord> findUnsettled(RuntimeSessionRecord session,
                String afterExecutionCallId, int limit) {
            return delegate.findUnsettled(session, afterExecutionCallId, limit);
        }

        @Override
        public List<ToolExecutionRecord> findBackgroundProcesses(
                RuntimeSessionRecord session, String afterExecutionCallId,
                int limit) {
            return delegate.findBackgroundProcesses(session,
                    afterExecutionCallId, limit);
        }

        @Override
        public boolean hasActiveByBinding(String bindingId,
                long runtimeGeneration) {
            return delegate.hasActiveByBinding(bindingId,
                    runtimeGeneration);
        }
    }

    private static final class HookedExecutionRepository
            implements ToolExecutionRepository {
        private final InMemoryToolExecutionRepository delegate;
        volatile Runnable beforeClaim;
        volatile Runnable afterClaim;
        volatile Runnable afterUnknown;
        volatile boolean rejectWrites;
        volatile boolean rejectResolve;
        volatile boolean failResolve;
        volatile boolean failReads;

        HookedExecutionRepository(Clock clock) {
            delegate = new InMemoryToolExecutionRepository(clock);
        }


        @Override
        public ToolExecutionRecord settlePrepared(ToolExecutionRecord expected,
                Map<String, Object> result, Instant settlementTime) {
            return delegate.settlePrepared(expected, result, settlementTime);
        }
        @Override
        public boolean hasActiveByRuntimeSession(String bindingId, long generation,
                String runtimeSessionId) {
            return delegate.hasActiveByRuntimeSession(bindingId, generation, runtimeSessionId);
        }

        @Override
        public boolean hasActiveByRuntimeSession(String bindingId, long generation,
                String runtimeSessionId,
                java.util.Set<String> excludingExecutionCallIds) {
            return delegate.hasActiveByRuntimeSession(bindingId, generation,
                    runtimeSessionId, excludingExecutionCallIds);
        }

        @Override
        public ToolExecutionRecord findOrCreate(
                ToolExecutionRecord candidate) {
            return delegate.findOrCreate(candidate);
        }

        @Override
        public ToolExecutionRecord findByExecutionCallId(
                String executionCallId) {
            if (failReads) {
                throw new IllegalStateException("database down");
            }
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
            if (rejectResolve) {
                return null;
            }
            if (failResolve) {
                throw new IllegalStateException("database down");
            }
            return delegate.resolveUnknown(expected, resolutionResult,
                    resolutionTime);
        }

        @Override
        public boolean hasActiveByRuntimeSession(String runtimeSessionId) {
            return delegate.hasActiveByRuntimeSession(runtimeSessionId);
        }

        @Override
        public ToolExecutionRecord resolveUnsettled(ToolExecutionRecord expected,
                Map<String, Object> result, Instant time) {
            return delegate.resolveUnsettled(expected, result, time);
        }

        @Override
        public List<ToolExecutionRecord> findUnsettled(RuntimeSessionRecord session,
                String afterExecutionCallId, int limit) {
            return delegate.findUnsettled(session, afterExecutionCallId, limit);
        }

        @Override
        public List<ToolExecutionRecord> findBackgroundProcesses(
                RuntimeSessionRecord session, String afterExecutionCallId,
                int limit) {
            return delegate.findBackgroundProcesses(session,
                    afterExecutionCallId, limit);
        }

        @Override
        public boolean hasActiveByBinding(String bindingId,
                long runtimeGeneration) {
            return delegate.hasActiveByBinding(bindingId,
                    runtimeGeneration);
        }
    }

    private static class StaleBindingRepository
            extends DelegatingBindingRepository {
        volatile RuntimeBindingRecord nextRead;
        volatile Runnable afterReady;

        StaleBindingRepository(Clock clock) {
            super(new InMemoryRuntimeBindingRepository(clock,
                    () -> "binding"));
        }

        @Override
        public RuntimeBindingRecord findOrCreate(
                RuntimeProvisionRequest request) {
            RuntimeBindingRecord stale = nextRead;
            nextRead = null;
            return stale == null ? delegate.findOrCreate(request) : stale;
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
    }

    /**
     * A managed-context binding lost with full stop evidence and one READY
     * session — the fixture shape that drives cleanupLost all the way to
     * the recoverResources leg. The "recovery" claim is released here, so a
     * service can claim it immediately against the returned record.
     */
    private static RuntimeBindingRecord managedStoppedLostBinding(
            RuntimeBindingRepository bindings,
            InMemoryRuntimeSessionRepository sessions, Clock clock) {
        RuntimeScope scope = new RuntimeScope("tenant-m", "workspace-m", "1",
                "/workspace", WorkspaceExecutionProfile.CAPABILITY_DIGEST,
                "session");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                "harness-1", "test-supervisor", "storage-a");
        RuntimeBindingRecord created = bindings.findOrCreate(request);
        RuntimeBindingRecord claimed = bindings.claimOperation(
                created.getBindingId(), "recovery", Duration.ofMinutes(5));
        RuntimeProvisionSeed seed = claimed.getProvisionSeed();
        RuntimeBindingRecord ready = bindings.compareAndSet(claimed,
                claimed.withAttestation(
                        new RuntimeLease(seed.getProvisionalRuntimeId(),
                                URI.create("http://127.0.0.1:4190"),
                                seed.getToken(), seed.getLeaseId(),
                                seed.getEpoch()),
                        new RuntimeResourceHandle("test-supervisor", 1,
                                Map.of("resource", "m")),
                        clock.instant(), clock.instant()));
        RuntimeSessionRecord acquiring = bindings.admitSession(sessions,
                new RuntimeSessionRecord(
                        new RuntimeSession("harness-1", "runtime-1",
                                "bootstrap", scope),
                        ready.getBindingId(), ready.getGeneration(),
                        RuntimeSessionRecord.State.ACQUIRING, 0,
                        clock.instant()));
        sessions.compareAndSet(acquiring, acquiring.withState(
                RuntimeSessionRecord.State.READY, clock.instant()));
        RuntimeBindingRecord lost = bindings.compareAndSet(ready,
                ready.withRecoveryEvidence(
                        RuntimeRecoveryContract.evidence(ready,
                                RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                        RuntimeRecoveryContract.evidence(ready,
                                RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED),
                        clock.instant()));
        bindings.releaseOperation(lost.getBindingId(), "recovery",
                lost.getOperationGeneration());
        return lost;
    }

    /**
     * The guard every lost/ready-binding reclaim test shares: the writer
     * domain must never be re-provisioned, and the kind matches what the
     * fixtures bake into their requests.
     */
    private abstract static class LostDomainProvisioner
            implements RuntimeProvisioner {
        @Override
        public String kind() {
            return "test-supervisor";
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            throw new AssertionError(
                    "Lost writer domain must not be reprovisioned");
        }
    }

    /**
     * A binding repository whose recovery transactions sleep real wall-clock
     * time: the only clocks the outer backstops and step bounds obey.
     */
    private static final class SlowWallRecoveryBindings
            extends DelegatingBindingRepository {
        private final long millis;

        SlowWallRecoveryBindings(RuntimeBindingRepository delegate,
                long millis) {
            super(delegate);
            this.millis = millis;
        }

        @Override
        public RuntimeBindingRecord recoverLost(
                RuntimeSessionRepository sessions,
                ToolExecutionRepository executions,
                RuntimeBindingRecord expected) {
            sleep();
            return delegate.recoverLost(sessions, executions, expected);
        }

        @Override
        public RuntimeBindingRecord finishLostRecovery(
                RuntimeSessionRepository sessions,
                ToolExecutionRepository executions,
                RuntimeBindingRecord expected) {
            sleep();
            return delegate.finishLostRecovery(sessions, executions,
                    expected);
        }

        private void sleep() {
            try {
                Thread.sleep(millis);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * A binding repository whose {@code recoverLost} advances the clock
     * first, simulating the slow recovery transactions of a loaded runner.
     */
    private static final class SlowRecoveryBindingRepository
            extends StaleBindingRepository {
        private final MutableClock clock;
        private final Duration advance;

        SlowRecoveryBindingRepository(MutableClock clock, Duration advance) {
            super(clock);
            this.clock = clock;
            this.advance = advance;
        }

        @Override
        public RuntimeBindingRecord recoverLost(
                RuntimeSessionRepository sessions,
                ToolExecutionRepository executions,
                RuntimeBindingRecord expected) {
            clock.advance(advance);
            return super.recoverLost(sessions, executions, expected);
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
