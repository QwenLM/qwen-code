package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class RuntimeBrokerServiceTest {
    private static final String HARNESS_SESSION = "harness-session";
    private static final String RUNTIME_SESSION = "runtime-session";
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant",
            "workspace", "generation-1", "/workspace",
            "capability-digest", "workspace");
    private static final RuntimeLease LEASE = new RuntimeLease("runtime-1",
            URI.create("http://127.0.0.1:4183"), "runtime-token",
            "lease-1", 1);

    @Test
    void usesManagedRuntimeTurnKinds() {
        RuntimeSession continuation = new RuntimeSession(HARNESS_SESSION,
                RUNTIME_SESSION, "continuation", SCOPE);

        assertEquals("continuation", continuation.getTurnKind());
        assertThrows(IllegalArgumentException.class,
                () -> new RuntimeSession(HARNESS_SESSION, RUNTIME_SESSION,
                        "followup", SCOPE));
    }

    @Test
    void staticProvisionerReturnsTheConfiguredLease() throws Exception {
        StaticRuntimeProvisioner provisioner =
                new StaticRuntimeProvisioner(LEASE);

        assertEquals("static", provisioner.kind());
        assertNotEquals(provisioner.runtimeTemplateDigest(),
                new StaticRuntimeProvisioner(new RuntimeLease(
                        LEASE.getRuntimeInstanceId(), LEASE.getEndpoint(),
                        "rotated-token", LEASE.getLeaseId(),
                        LEASE.getEpoch())).runtimeTemplateDigest());
        assertSame(LEASE, provisioner.provision(new RuntimeProvisionRequest(
                SCOPE, null)).toCompletableFuture().get(1, TimeUnit.SECONDS));
        RuntimeScope sessionScope = new RuntimeScope("tenant", "workspace",
                "generation-1", "/workspace", "capability-digest",
                "session");
        assertThrows(IllegalArgumentException.class,
                () -> provisioner.provision(new RuntimeProvisionRequest(
                        sessionScope, HARNESS_SESSION)));
    }

    @Test
    void provisionRequestIncludesTheSessionIsolationKey() {
        RuntimeProvisionRequest workspace = new RuntimeProvisionRequest(SCOPE,
                null);
        RuntimeScope sessionScope = new RuntimeScope("tenant", "workspace",
                "generation-1", "/workspace", "capability-digest",
                "session");
        RuntimeProvisionRequest alpha = new RuntimeProvisionRequest(
                sessionScope, "harness-alpha");
        RuntimeProvisionRequest sameAlpha = new RuntimeProvisionRequest(
                sessionScope, "harness-alpha");
        RuntimeProvisionRequest beta = new RuntimeProvisionRequest(
                sessionScope, "harness-beta");

        assertEquals(SCOPE, workspace.getScope());
        assertEquals(alpha, sameAlpha);
        assertEquals(alpha.hashCode(), sameAlpha.hashCode());
        assertFalse(alpha.equals(beta));
        assertThrows(IllegalArgumentException.class,
                () -> new RuntimeProvisionRequest(sessionScope, null));
        assertThrows(IllegalArgumentException.class,
                () -> new RuntimeProvisionRequest(SCOPE, HARNESS_SESSION));
    }

    @Test
    void warmupAndAcquireShareOneDelayedRuntimeWithoutBlockingModelWork()
            throws Exception {
        CompletableFuture<RuntimeLease> delayedRuntime =
                new CompletableFuture<>();
        AtomicInteger provisions = new AtomicInteger();
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                ignored -> {
                    provisions.incrementAndGet();
                    return delayedRuntime;
                }, transport);

        CompletionStage<Void> warmup = service.warm(HARNESS_SESSION);
        long modelStartedAt = System.nanoTime();
        CompletionStage<Void> acquisition = service.acquire(HARNESS_SESSION,
                RUNTIME_SESSION, "bootstrap");

        assertTrue(modelStartedAt > 0);
        assertFalse(warmup.toCompletableFuture().isDone());
        assertFalse(acquisition.toCompletableFuture().isDone());
        assertEquals(1, provisions.get());
        assertEquals(0, transport.acquisitions.get());

        delayedRuntime.complete(LEASE);
        warmup.toCompletableFuture().get(1, TimeUnit.SECONDS);
        acquisition.toCompletableFuture().get(1, TimeUnit.SECONDS);

        assertEquals(1, provisions.get());
        assertEquals(1, transport.acquisitions.get());
    }

    @Test
    void sessionIsolationDoesNotReuseBindingsAcrossHarnessSessions()
            throws Exception {
        RuntimeScope sessionScope = new RuntimeScope("tenant", "workspace",
                "generation-1", "/workspace", "capability-digest",
                "session");
        AtomicInteger provisions = new AtomicInteger();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope),
                ignored -> {
                    provisions.incrementAndGet();
                    return CompletableFuture.completedFuture(LEASE);
                }, new FakeTransport());

        service.warm("harness-a").toCompletableFuture()
                .get(1, TimeUnit.SECONDS);
        service.warm("harness-b").toCompletableFuture()
                .get(1, TimeUnit.SECONDS);
        service.warm("harness-a").toCompletableFuture()
                .get(1, TimeUnit.SECONDS);

        assertEquals(2, provisions.get());
    }

    @Test
    void rejectsBindingRepositoryIdentityCollision() {
        RuntimeProvisionRequest conflicting = new RuntimeProvisionRequest(
                new RuntimeScope("tenant", "other-workspace", "generation-2",
                        "/other-workspace", "other-capability", "workspace"),
                null);
        RuntimeBindingRecord wrong = new InMemoryRuntimeBindingRepository()
                .findOrCreate(conflicting);
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                ignored -> CompletableFuture.completedFuture(LEASE),
                new FakeTransport(), new FixedBindingRepository(wrong),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-one");
        try {
            Exception failure = assertThrows(Exception.class,
                    () -> service.warm(HARNESS_SESSION).toCompletableFuture()
                            .get(1, TimeUnit.SECONDS));

            RuntimeBrokerException cause = (RuntimeBrokerException)
                    failure.getCause();
            assertEquals("runtime_broker_binding_conflict", cause.getCode());
        } finally {
            service.close();
        }
    }

    @Test
    void preparedExecutionDoesNotDispatchUntilExplicitStart()
            throws Exception {
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);

        Map<String, Object> prepared = service.prepareExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        String executionCallId = (String) prepared.get("executionCallId");

        assertEquals("prepared", status(prepared).get("state"));
        assertEquals("prepared", status(service.getExecution(
                HARNESS_SESSION, RUNTIME_SESSION, executionCallId, null))
                        .get("state"));
        assertEquals(0, transport.executions.get());

        service.startExecution(HARNESS_SESSION, RUNTIME_SESSION,
                executionCallId);
        service.startExecution(HARNESS_SESSION, RUNTIME_SESSION,
                executionCallId);
        waitForCount(transport.executions, 1);
        assertEquals(1, transport.executions.get());

        transport.execution.complete(executionResult("success"));
        assertEquals("success", result(waitForSettled(service,
                executionCallId)).get("executionStatus"));
        service.close();
    }

    @Test
    void executionLedgerDispatchesOnePhysicalExecutionPerKey()
            throws Exception {
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);

        Map<String, Object> first = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        Map<String, Object> duplicate = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));

        assertEquals(first.get("executionCallId"),
                duplicate.get("executionCallId"));
        assertEquals(1, transport.executions.get());
        RuntimeBrokerException conflict = assertThrows(
                RuntimeBrokerException.class,
                () -> service.createExecution("key-1", HARNESS_SESSION,
                        RUNTIME_SESSION, "turn-1", "tool-1", "changed",
                        reference("changed")));
        assertEquals(409, conflict.getStatusCode());

        transport.execution.complete(executionResult("success"));
        String executionCallId = (String) first.get("executionCallId");
        Map<String, Object> settled = waitForSettled(service,
                executionCallId);
        assertEquals("success", result(settled).get("executionStatus"));

        assertTrue(service.release(HARNESS_SESSION, RUNTIME_SESSION)
                .toCompletableFuture().get(1, TimeUnit.SECONDS));
        assertEquals(1, transport.releases.get());
    }

    @Test
    void twoBrokersShareProvisioningAndExecutionRepositoryClaims()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        CompletableFuture<RuntimeLease> provisioned =
                new CompletableFuture<>();
        AtomicInteger provisions = new AtomicInteger();
        RuntimeProvisioner provisioner = request -> {
            provisions.incrementAndGet();
            return provisioned;
        };
        ConcurrentTransport transport = new ConcurrentTransport();
        RuntimeBrokerService first = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                "broker-a");
        RuntimeBrokerService second = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                "broker-b");
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            CompletionStage<Void> firstWarm = first.warm(HARNESS_SESSION);
            CompletionStage<Void> secondWarm = second.warm(HARNESS_SESSION);
            assertEquals(1, provisions.get());
            provisioned.complete(LEASE);
            CompletableFuture.allOf(firstWarm.toCompletableFuture(),
                    secondWarm.toCompletableFuture()).get(1,
                            TimeUnit.SECONDS);
            first.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            second.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);

            Future<Map<String, Object>> firstCreate = executor.submit(() ->
                    first.createExecution("shared-key", HARNESS_SESSION,
                            RUNTIME_SESSION, "turn-1", "tool-1", "args-1",
                            reference("args-1")));
            Future<Map<String, Object>> secondCreate = executor.submit(() ->
                    second.createExecution("shared-key", HARNESS_SESSION,
                            RUNTIME_SESSION, "turn-1", "tool-1", "args-1",
                            reference("args-1")));
            Map<String, Object> firstExecution = firstCreate.get(1,
                    TimeUnit.SECONDS);
            Map<String, Object> secondExecution = secondCreate.get(1,
                    TimeUnit.SECONDS);

            assertEquals(firstExecution.get("executionCallId"),
                    secondExecution.get("executionCallId"));
            assertEquals(1, transport.executions.get());
            transport.execution.complete(executionResult("success"));
            assertEquals("success", result(waitForSettled(second,
                    (String) firstExecution.get("executionCallId")))
                            .get("executionStatus"));
            assertEquals(1, transport.executions.get());
        } finally {
            executor.shutdownNow();
            first.close();
            second.close();
        }
    }

    @Test
    void dispatcherThatLosesItsClaimDoesNotExecute() throws Exception {
        MutableClock clock = new MutableClock(Instant.parse(
                "2026-09-18T00:00:00Z"));
        TakeoverExecutionRepository executions =
                new TakeoverExecutionRepository(clock);
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = durableService("broker-a",
                request -> CompletableFuture.completedFuture(LEASE),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(), executions);
        try {
            service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            Map<String, Object> created = service.createExecution("key-1",
                    HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                    "args-1", reference("args-1"));

            executions.awaitTakeover();

            assertEquals(0, transport.executions.get());
            ToolExecutionRecord current = executions.findByExecutionCallId(
                    (String) created.get("executionCallId"));
            assertEquals(ToolExecutionRecord.State.EXECUTING,
                    current.getState());
            assertEquals("broker-b", current.getDispatchOwner());
            assertEquals(2, current.getDispatchGeneration());
        } finally {
            service.close();
        }
    }

    @Test
    void provisioningOwnerRenewsItsOperationLease() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        CompletableFuture<RuntimeLease> provisioned =
                new CompletableFuture<>();
        AtomicInteger provisions = new AtomicInteger();
        RuntimeProvisioner provisioner = request -> {
            provisions.incrementAndGet();
            return provisioned;
        };
        RuntimeBrokerService first = durableService("broker-a", provisioner,
                new FakeTransport(), bindings, sessions, executions,
                Duration.ofMillis(150), Duration.ofMillis(300));
        RuntimeBrokerService second = durableService("broker-b", provisioner,
                new FakeTransport(), bindings, sessions, executions,
                Duration.ofMillis(150), Duration.ofMillis(300));
        try {
            CompletionStage<Void> firstWarm = first.warm(HARNESS_SESSION);
            Thread.sleep(350);
            CompletionStage<Void> secondWarm = second.warm(HARNESS_SESSION);

            assertEquals(1, provisions.get());
            provisioned.complete(LEASE);
            CompletableFuture.allOf(firstWarm.toCompletableFuture(),
                    secondWarm.toCompletableFuture()).get(1,
                            TimeUnit.SECONDS);
            assertEquals(1, provisions.get());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void staleProvisioningFailureCannotFenceNewOwner() throws Exception {
        MutableClock clock = new MutableClock(Instant.parse(
                "2026-09-18T00:00:00Z"));
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository(clock, () -> "binding");
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(clock);
        CompletableFuture<RuntimeLease> firstProvision =
                new CompletableFuture<>();
        CompletableFuture<RuntimeLease> secondProvision =
                new CompletableFuture<>();
        AtomicInteger provisions = new AtomicInteger();
        RuntimeProvisioner provisioner = request ->
                provisions.incrementAndGet() == 1
                        ? firstProvision : secondProvision;
        RuntimeBrokerService first = durableService("broker-a", provisioner,
                new FakeTransport(), bindings, sessions, executions,
                Duration.ofMillis(300), Duration.ofMillis(300));
        RuntimeBrokerService second = durableService("broker-b", provisioner,
                new FakeTransport(), bindings, sessions, executions,
                Duration.ofMillis(300), Duration.ofMillis(300));
        try {
            first.warm(HARNESS_SESSION);
            assertEquals(1, provisions.get());
            first.close();
            clock.advance(Duration.ofSeconds(1));

            CompletionStage<Void> recovered = second.warm(HARNESS_SESSION);
            assertEquals(2, provisions.get());
            firstProvision.completeExceptionally(
                    new IllegalStateException("stale failure"));
            secondProvision.complete(LEASE);

            recovered.toCompletableFuture().get(1, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY,
                    bindings.findById("binding").getState());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void lostExecuteResponseRecoversTheOriginalRuntimeResult()
            throws Exception {
        ResponseLossTransport transport = new ResponseLossTransport();
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);

        Map<String, Object> created = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        Map<String, Object> settled = waitForSettled(service,
                (String) created.get("executionCallId"));

        assertEquals("success", result(settled).get("executionStatus"));
        assertEquals(1, transport.executions.get());
        assertTrue(transport.statuses.get() >= 2);
    }

    @Test
    void expiredExecutingDispatchBecomesUnknownWithoutReexecution()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        MutableClock clock = new MutableClock(Instant.parse(
                "2026-09-18T00:00:00Z"));
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(clock);
        TakeoverTransport transport = new TakeoverTransport();
        RuntimeProvisioner provisioner = request ->
                CompletableFuture.completedFuture(LEASE);
        RuntimeBrokerService first = durableService("broker-a", provisioner,
                transport, bindings, sessions, executions);
        RuntimeBrokerService second = durableService("broker-b", provisioner,
                transport, bindings, sessions, executions);
        try {
            first.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            second.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            Map<String, Object> created = first.createExecution("key-1",
                    HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                    "args-1", reference("args-1"));
            waitForCount(transport.executions, 1);
            Map<String, Object> observed = second.createExecution("key-1",
                    HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                    "args-1", reference("args-1"));
            assertEquals(created.get("executionCallId"),
                    observed.get("executionCallId"));

            first.close();
            clock.advance(Duration.ofSeconds(2));
            RuntimeBrokerException unknown = assertThrows(
                    RuntimeBrokerException.class,
                    () -> second.getExecution(HARNESS_SESSION,
                            RUNTIME_SESSION,
                            (String) created.get("executionCallId"), null));
            assertEquals("runtime_broker_execution_unknown",
                    unknown.getCode());
            Map<String, Object> resolved = second.resolveUnknownExecution(
                    HARNESS_SESSION, RUNTIME_SESSION,
                    (String) created.get("executionCallId"),
                    UnknownExecutionResolution.ACCEPTED_UNKNOWN);
            assertEquals("runtime_broker_execution_unknown",
                    result(resolved).get("errorCode"));
            assertEquals(1, transport.executions.get());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void activeDispatchOwnerForwardsCancellationRequestedByAnotherBroker()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        ConcurrentTransport transport = new ConcurrentTransport();
        RuntimeProvisioner provisioner = request ->
                CompletableFuture.completedFuture(LEASE);
        RuntimeBrokerService first = durableService("broker-a", provisioner,
                transport, bindings, sessions, executions);
        RuntimeBrokerService second = durableService("broker-b", provisioner,
                transport, bindings, sessions, executions);
        try {
            first.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            second.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            Map<String, Object> created = first.createExecution("key-1",
                    HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                    "args-1", reference("args-1"));
            waitForCount(transport.executions, 1);

            Map<String, Object> requested = second.cancelExecution(
                    HARNESS_SESSION, RUNTIME_SESSION,
                    (String) created.get("executionCallId"))
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            assertTrue((Boolean) status(requested).get("cancelRequested"));

            Map<String, Object> settled = waitForSettled(second,
                    (String) created.get("executionCallId"));
            assertEquals("cancelled",
                    result(settled).get("executionStatus"));
            assertEquals(1, transport.executions.get());
            assertEquals(1, transport.cancellations.get());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void nonterminalExecutionBecomesUnknownWhenBindingIsLost()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        ConcurrentTransport transport = new ConcurrentTransport();
        RuntimeBrokerService service = durableService("broker-a",
                request -> CompletableFuture.completedFuture(LEASE),
                transport, bindings, sessions, executions);
        try {
            service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            Map<String, Object> created = service.createExecution("key-1",
                    HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                    "args-1", reference("args-1"));
            String executionCallId = (String) created.get("executionCallId");
            waitForCount(transport.executions, 1);

            RuntimeBindingRecord binding = bindings.findActive(
                    new RuntimeProvisionRequest(SCOPE, null));
            RuntimeBindingRecord failed = bindings.compareAndSet(binding,
                    binding.withState(RuntimeBindingRecord.State.FAILED,
                            binding.getLease(), Instant.now()));
            assertEquals(RuntimeBindingRecord.State.FAILED,
                    failed.getState());

            RuntimeBrokerException unknown = assertThrows(
                    RuntimeBrokerException.class,
                    () -> service.getExecution(HARNESS_SESSION,
                            RUNTIME_SESSION, executionCallId, null));

            assertEquals("runtime_broker_execution_unknown",
                    unknown.getCode());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    executions.findByExecutionCallId(executionCallId)
                            .getState());
            assertEquals(1, transport.executions.get());
            assertNull(executions.claimDispatch(executionCallId,
                    "broker-b", Duration.ofSeconds(30)));

            Map<String, Object> resolved = service.resolveUnknownExecution(
                    HARNESS_SESSION, RUNTIME_SESSION, executionCallId,
                    UnknownExecutionResolution.CONFIRMED_NOT_EXECUTED);
            assertEquals("not_started",
                    result(resolved).get("executionStatus"));
            assertEquals("confirmed_not_executed",
                    result(resolved).get("resolution"));
            assertEquals(resolved, service.resolveUnknownExecution(
                    HARNESS_SESSION, RUNTIME_SESSION, executionCallId,
                    UnknownExecutionResolution.CONFIRMED_NOT_EXECUTED));
            RuntimeBrokerException conflict = assertThrows(
                    RuntimeBrokerException.class,
                    () -> service.resolveUnknownExecution(HARNESS_SESSION,
                            RUNTIME_SESSION, executionCallId,
                            UnknownExecutionResolution.ACCEPTED_UNKNOWN));
            assertEquals("runtime_broker_resolution_conflict",
                    conflict.getCode());
            assertEquals(1, transport.executions.get());
        } finally {
            service.close();
        }
    }

    @Test
    void unknownExecutionCanBeAcceptedWithoutReplay() {
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        ToolExecutionRecord prepared = executions.findOrCreate(
                ToolExecutionRecord.prepared(
                "execution-accepted", "key-accepted", "binding-accepted",
                1, HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1")));
        ToolExecutionRecord claimed = executions.claimDispatch(
                prepared.getExecutionCallId(), "test-owner",
                Duration.ofMinutes(1));
        executions.compareAndSet(claimed, claimed.withUnknown(),
                "test-owner", claimed.getDispatchGeneration());
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = durableService("broker-a",
                request -> CompletableFuture.completedFuture(LEASE),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(), executions);
        try {
            Map<String, Object> resolved = service.resolveUnknownExecution(
                    HARNESS_SESSION, RUNTIME_SESSION, "execution-accepted",
                    UnknownExecutionResolution.ACCEPTED_UNKNOWN);

            assertEquals("error", result(resolved).get("executionStatus"));
            assertEquals("runtime_broker_execution_unknown",
                    result(resolved).get("errorCode"));
            assertEquals("accepted_unknown",
                    result(resolved).get("resolution"));
            assertEquals(resolved, service.resolveUnknownExecution(
                    HARNESS_SESSION, RUNTIME_SESSION, "execution-accepted",
                    UnknownExecutionResolution.ACCEPTED_UNKNOWN));
            assertEquals(0, transport.executions.get());
        } finally {
            service.close();
        }
    }

    @Test
    void reconcileSettlesUnknownExecutionFromRuntimeEvidence()
            throws Exception {
        EvidenceTransport transport = new EvidenceTransport(
                invocationStatus("settled", false,
                        executionResult("success")));
        UnknownFixture fixture = unknownFixture(transport);
        try {
            ExecutionReconciliation resolved = fixture.service
                    .reconcileExecution(HARNESS_SESSION, RUNTIME_SESSION,
                            fixture.executionCallId)
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);

            assertEquals(ExecutionReconciliation.Outcome.RESOLVED,
                    resolved.getOutcome());
            assertEquals("settled", resolved.getRuntimeState());
            ToolExecutionRecord settled = fixture.executions
                    .findByExecutionCallId(fixture.executionCallId);
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    settled.getState());
            assertEquals("success", settled.getExecutionStatus());
            assertEquals(1, transport.statuses.get());
            assertEquals(0, transport.executions.get());

            ExecutionReconciliation repeated = fixture.service
                    .reconcileExecution(HARNESS_SESSION, RUNTIME_SESSION,
                            fixture.executionCallId)
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            assertEquals(ExecutionReconciliation.Outcome.ALREADY_SETTLED,
                    repeated.getOutcome());
            assertNull(repeated.getRuntimeState());
            assertEquals(1, transport.statuses.get());
        } finally {
            fixture.service.close();
        }
    }

    @Test
    void reconcileKeepsUnknownWithoutTerminalRuntimeEvidence()
            throws Exception {
        for (String state : List.of("unknown", "prepared", "executing",
                "cancel_requested")) {
            EvidenceTransport transport = new EvidenceTransport(
                    invocationStatus(state, false, null));
            UnknownFixture fixture = unknownFixture(transport);
            try {
                ExecutionReconciliation unresolved = fixture.service
                        .reconcileExecution(HARNESS_SESSION,
                                RUNTIME_SESSION, fixture.executionCallId)
                        .toCompletableFuture().get(1, TimeUnit.SECONDS);

                assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                        unresolved.getOutcome(), state);
                assertEquals(state, unresolved.getRuntimeState());
                assertEquals(ToolExecutionRecord.State.UNKNOWN,
                        fixture.executions.findByExecutionCallId(
                                fixture.executionCallId).getState());
                assertEquals(0, transport.executions.get());
            } finally {
                fixture.service.close();
            }
        }
    }

    @Test
    void reconcileRejectsAnInvalidRuntimeStatus() throws Exception {
        Map<String, Object> settledWithoutResult = invocationStatus(
                "settled", false, null);
        Map<String, Object> resultWhileExecuting = invocationStatus(
                "executing", false, executionResult("success"));
        Map<String, Object> unsupportedResult = invocationStatus("settled",
                false, executionResult("maybe"));
        for (Map<String, Object> status : List.of(settledWithoutResult,
                resultWhileExecuting, unsupportedResult)) {
            EvidenceTransport transport = new EvidenceTransport(status);
            UnknownFixture fixture = unknownFixture(transport);
            try {
                ExecutionException failure = assertThrows(
                        ExecutionException.class,
                        () -> fixture.service.reconcileExecution(
                                HARNESS_SESSION, RUNTIME_SESSION,
                                fixture.executionCallId)
                                .toCompletableFuture()
                                .get(1, TimeUnit.SECONDS));
                RuntimeBrokerException error =
                        (RuntimeBrokerException) failure.getCause();
                assertEquals("runtime_broker_execution_status_invalid",
                        error.getCode());
                assertFalse(error.isRetryable());
                assertEquals(ToolExecutionRecord.State.UNKNOWN,
                        fixture.executions.findByExecutionCallId(
                                fixture.executionCallId).getState());
            } finally {
                fixture.service.close();
            }
        }
    }

    @Test
    void reconcileStopsWhenTheOriginalGenerationIsRetired()
            throws Exception {
        EvidenceTransport transport = new EvidenceTransport(
                invocationStatus("settled", false,
                        executionResult("success")));
        UnknownFixture fixture = unknownFixture(transport);
        try {
            RuntimeBindingRecord binding = fixture.bindings.findById(
                    fixture.bindingId);
            fixture.bindings.compareAndSet(binding, binding.withState(
                    RuntimeBindingRecord.State.FAILED, binding.getLease(),
                    Instant.now()));

            RuntimeBrokerException error = assertThrows(
                    RuntimeBrokerException.class,
                    () -> fixture.service.reconcileExecution(HARNESS_SESSION,
                            RUNTIME_SESSION, fixture.executionCallId));

            assertEquals("runtime_broker_execution_evidence_unavailable",
                    error.getCode());
            assertFalse(error.isRetryable());
            assertEquals(0, transport.statuses.get());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.executions.findByExecutionCallId(
                            fixture.executionCallId).getState());
        } finally {
            fixture.service.close();
        }
    }

    @Test
    void reconcileAnswersANonUnknownRecordWithoutALookup() throws Exception {
        EvidenceTransport transport = new EvidenceTransport(
                invocationStatus("settled", false,
                        executionResult("success")));
        RuntimeBrokerService service = readyService(transport);
        try {
            service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            Map<String, Object> prepared = service.prepareExecution("key-1",
                    HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                    "args-1", reference("args-1"));

            ExecutionReconciliation inFlight = service.reconcileExecution(
                    HARNESS_SESSION, RUNTIME_SESSION,
                    (String) prepared.get("executionCallId"))
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);

            assertEquals(ExecutionReconciliation.Outcome.IN_FLIGHT,
                    inFlight.getOutcome());
            assertEquals(0, transport.statuses.get());
            RuntimeBrokerException foreign = assertThrows(
                    RuntimeBrokerException.class,
                    () -> service.reconcileExecution("other-harness",
                            RUNTIME_SESSION,
                            (String) prepared.get("executionCallId")));
            assertEquals("runtime_broker_execution_not_found",
                    foreign.getCode());
        } finally {
            service.close();
        }
    }

    @Test
    void cancelReachesARunningInvocationAfterItsClaimLapses()
            throws Exception {
        LapsedFixture fixture = lapsedFixture();
        try {
            // The fenced record surfaces as UNKNOWN, as it does to every
            // other reader, but the physical cancel is still delivered.
            assertUnknownAfterCancel(fixture);

            assertEquals(1, fixture.transport.cancellations.get());
            ToolExecutionRecord fenced = fixture.executions
                    .findByExecutionCallId(fixture.executionCallId);
            // The Runtime's settled answer is never written by a cancel
            // whose claim lapsed; only reconciliation may settle it.
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fenced.getState());
            assertTrue(fenced.isCancelRequested());
            assertEquals(1, fixture.transport.executions.get());
        } finally {
            fixture.service.close();
        }
    }

    @Test
    void cancelReachesARunningInvocationAnotherBrokerFenced()
            throws Exception {
        LapsedFixture fixture = lapsedFixture();
        try {
            assertNull(fixture.executions.claimDispatch(
                    fixture.executionCallId, "broker-b",
                    Duration.ofSeconds(30)));
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.executions.findByExecutionCallId(
                            fixture.executionCallId).getState());

            assertUnknownAfterCancel(fixture);

            assertEquals(1, fixture.transport.cancellations.get());
            ToolExecutionRecord fenced = fixture.executions
                    .findByExecutionCallId(fixture.executionCallId);
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fenced.getState());
            assertTrue(fenced.isCancelRequested());
        } finally {
            fixture.service.close();
        }
    }

    @Test
    void cancelDoesNotCallTheRuntimeForAnUnknownRecordNothingHereRuns()
            throws Exception {
        EvidenceTransport transport = new EvidenceTransport(
                invocationStatus("executing", false, null));
        UnknownFixture fixture = unknownFixture(transport);
        try {
            RuntimeBrokerException unknown = assertThrows(
                    RuntimeBrokerException.class,
                    () -> fixture.service.cancelExecution(HARNESS_SESSION,
                            RUNTIME_SESSION, fixture.executionCallId));
            assertEquals("runtime_broker_execution_unknown",
                    unknown.getCode());
            assertEquals(0, transport.cancellations.get());
        } finally {
            fixture.service.close();
        }
    }

    @Test
    void cancellationTerminalWinsOverLateExecutionCompletion()
            throws Exception {
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);
        Map<String, Object> created = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        String executionCallId = (String) created.get("executionCallId");

        Map<String, Object> cancelled = service.cancelExecution(
                HARNESS_SESSION, RUNTIME_SESSION, executionCallId)
                .toCompletableFuture().get(1, TimeUnit.SECONDS);
        assertEquals("cancelled",
                result(cancelled).get("executionStatus"));

        transport.execution.complete(executionResult("success"));
        Map<String, Object> afterLateCompletion = service.getExecution(
                HARNESS_SESSION, RUNTIME_SESSION, executionCallId, null);
        assertEquals("cancelled",
                result(afterLateCompletion).get("executionStatus"));
        assertEquals(1, transport.cancellations.get());
    }

    @Test
    void cancellationAcceptsUnknownRuntimeStatus() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.cancelResponse = Map.of("state", "unknown");
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);
        Map<String, Object> created = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        String executionCallId = (String) created.get("executionCallId");

        Map<String, Object> cancelling = service.cancelExecution(
                HARNESS_SESSION, RUNTIME_SESSION, executionCallId)
                .toCompletableFuture().get(1, TimeUnit.SECONDS);

        assertEquals("cancel_requested", status(cancelling).get("state"));
        assertEquals(true, status(cancelling).get("cancelRequested"));
        assertEquals(1, transport.cancellations.get());
    }

    @Test
    void anInvalidCancellationAnswerFailsTheReturnedStage() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.cancelResponse = Map.of("state", "vanished");
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);
        Map<String, Object> created = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        String executionCallId = (String) created.get("executionCallId");

        CompletionStage<Map<String, Object>> cancellation =
                service.cancelExecution(HARNESS_SESSION, RUNTIME_SESSION,
                        executionCallId);

        ExecutionException failure = assertThrows(ExecutionException.class,
                () -> cancellation.toCompletableFuture()
                        .get(1, TimeUnit.SECONDS));
        assertEquals("runtime_broker_cancel_failed",
                ((RuntimeBrokerException) failure.getCause()).getCode());
    }

    @Test
    void aReleaseTheRuntimeRejectsFailsTheReturnedStage() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.releaseResponse = CompletableFuture.failedFuture(
                new RuntimeBrokerException(503, "managed_runtime_unavailable",
                        "unavailable", true));
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);

        CompletionStage<Boolean> release = service.release(HARNESS_SESSION,
                RUNTIME_SESSION);

        ExecutionException failure = assertThrows(ExecutionException.class,
                () -> release.toCompletableFuture().get(1, TimeUnit.SECONDS));
        assertEquals("managed_runtime_unavailable",
                ((RuntimeBrokerException) failure.getCause()).getCode());
        transport.releaseResponse = null;
        assertTrue(service.release(HARNESS_SESSION, RUNTIME_SESSION)
                .toCompletableFuture().get(1, TimeUnit.SECONDS));
    }

    @Test
    void cancellationBeforeRuntimeReadinessPreventsPhysicalDispatch()
            throws Exception {
        CompletableFuture<RuntimeLease> delayed = new CompletableFuture<>();
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                ignored -> delayed, transport);
        CompletionStage<Void> acquisition = service.acquire(HARNESS_SESSION,
                RUNTIME_SESSION, "bootstrap");
        Map<String, Object> created = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        String executionCallId = (String) created.get("executionCallId");
        CompletionStage<Map<String, Object>> cancellation =
                service.cancelExecution(HARNESS_SESSION, RUNTIME_SESSION,
                        executionCallId);

        delayed.complete(LEASE);
        acquisition.toCompletableFuture().get(1, TimeUnit.SECONDS);
        Map<String, Object> cancelled = cancellation.toCompletableFuture()
                .get(1, TimeUnit.SECONDS);

        assertEquals("cancelled",
                result(cancelled).get("executionStatus"));
        assertEquals(0, transport.executions.get());
        assertEquals(0, transport.cancellations.get());
    }

    @Test
    void rejectsCrossHarnessSessionAccess() throws Exception {
        FakeTransport transport = new FakeTransport();
        RuntimeBrokerService service = readyService(transport);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);

        RuntimeBrokerException conflict = assertThrows(
                RuntimeBrokerException.class,
                () -> service.control("another-harness", RUNTIME_SESSION,
                        operation("manifest")));
        assertEquals(409, conflict.getStatusCode());
    }

    @Test
    void removesFailedProvisioningSoTheSameScopeCanRetry() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                ignored -> {
                    if (attempts.incrementAndGet() == 1) {
                        CompletableFuture<RuntimeLease> failed =
                                new CompletableFuture<>();
                        failed.completeExceptionally(new IllegalStateException(
                                "first attempt failed"));
                        return failed;
                    }
                    return CompletableFuture.completedFuture(LEASE);
                }, new FakeTransport());

        assertThrows(Exception.class, () -> service.warm(HARNESS_SESSION)
                .toCompletableFuture().get(1, TimeUnit.SECONDS));
        service.warm(HARNESS_SESSION).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);
        assertEquals(2, attempts.get());
    }

    @Test
    void warmBindingIsReleasedAfterItsIdleDeadline() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new FakeTransport(), Duration.ofMillis(25),
                Duration.ofSeconds(1), scheduler);
        try {
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);
            waitForCount(provisioner.releases, 1);
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);

            assertEquals(2, provisioner.provisions.get());
            assertEquals(1, provisioner.drains.get());
        } finally {
            service.close();
        }
    }

    @Test
    void activeSessionDefersIdleReleaseUntilLogicalRelease() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new FakeTransport(), Duration.ofMillis(25),
                Duration.ofSeconds(1), scheduler);
        try {
            service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            Thread.sleep(75);
            assertEquals(0, provisioner.releases.get());

            assertTrue(service.release(HARNESS_SESSION, RUNTIME_SESSION)
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));
            waitForCount(provisioner.releases, 1);
        } finally {
            service.close();
        }
    }

    @Test
    void drainHarnessReleasesWarmBindingWithoutWaitingForIdleDeadline()
            throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeScope sessionScope = sessionScope();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope),
                provisioner, new FakeTransport(), Duration.ofHours(1),
                Duration.ofSeconds(1), scheduler);
        try {
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);

            service.drainHarness(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);

            assertEquals(1, provisioner.drains.get());
            assertEquals(1, provisioner.releases.get());
        } finally {
            service.close();
        }
    }

    @Test
    void resumedHarnessCanWarmANewRuntimeAfterDrain() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), Duration.ofHours(1),
                Duration.ofSeconds(1), scheduler);
        try {
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);
            service.drainHarness(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);

            service.resumeHarness(HARNESS_SESSION);
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);

            assertEquals(2, provisioner.provisions.get());
            assertEquals(1, provisioner.releases.get());
        } finally {
            service.close();
        }
    }

    @Test
    void drainHarnessWaitsForInFlightProvisioningBeforeRelease()
            throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        provisioner.provision = new CompletableFuture<>();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), Duration.ofHours(1),
                Duration.ofSeconds(1), scheduler);
        try {
            CompletionStage<Void> warming = service.warm(HARNESS_SESSION);
            CompletionStage<Void> draining = service.drainHarness(
                    HARNESS_SESSION);

            assertFalse(draining.toCompletableFuture().isDone());
            provisioner.provision.complete(LEASE);
            warming.toCompletableFuture().get(1, TimeUnit.SECONDS);
            draining.toCompletableFuture().get(1, TimeUnit.SECONDS);

            assertEquals(1, provisioner.drains.get());
            assertEquals(1, provisioner.releases.get());
        } finally {
            service.close();
        }
    }

    @Test
    void drainHarnessPreventsDelayedWarmFromCreatingABinding()
            throws Exception {
        CompletableFuture<RuntimeScope> scope = new CompletableFuture<>();
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> scope, provisioner, new FakeTransport());
        try {
            CompletionStage<Void> warming = service.warm(HARNESS_SESSION);

            service.drainHarness(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);
            scope.complete(SCOPE);

            assertThrows(Exception.class, () -> warming.toCompletableFuture()
                    .get(1, TimeUnit.SECONDS));
            assertEquals(0, provisioner.provisions.get());
        } finally {
            service.close();
        }
    }

    @Test
    void drainHarnessCompletesWhenInFlightProvisioningFails()
            throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        provisioner.provision = new CompletableFuture<>();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), Duration.ofHours(1),
                Duration.ofSeconds(1), scheduler);
        try {
            CompletionStage<Void> warming = service.warm(HARNESS_SESSION);
            CompletionStage<Void> draining = service.drainHarness(
                    HARNESS_SESSION);

            provisioner.provision.completeExceptionally(
                    new IllegalStateException("provision failed"));
            assertThrows(Exception.class, () -> warming.toCompletableFuture()
                    .get(1, TimeUnit.SECONDS));
            draining.toCompletableFuture().get(1, TimeUnit.SECONDS);

            assertEquals(0, provisioner.drains.get());
            assertEquals(0, provisioner.releases.get());
        } finally {
            service.close();
        }
    }

    @Test
    void drainHarnessWaitsForLogicalSessionsToRelease() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeScope sessionScope = sessionScope();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope),
                provisioner, new FakeTransport(), Duration.ofHours(1),
                Duration.ofSeconds(1), scheduler);
        try {
            service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);

            CompletionStage<Void> draining = service.drainHarness(
                    HARNESS_SESSION);
            assertEquals(0, provisioner.releases.get());

            assertTrue(service.release(HARNESS_SESSION, RUNTIME_SESSION)
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));
            draining.toCompletableFuture().get(1, TimeUnit.SECONDS);

            assertEquals(1, provisioner.drains.get());
            assertEquals(1, provisioner.releases.get());
        } finally {
            service.close();
        }
    }

    @Test
    void anotherBrokerWaitsForDrainingGenerationBeforeWarmingReplacement()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        RuntimeBrokerService first = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "broker-a");
        RuntimeBrokerService second = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "broker-b");
        try {
            first.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            CompletionStage<Void> draining = first.drainHarness(
                    HARNESS_SESSION);

            CompletionStage<Void> replacementWarm = second.warm(
                    HARNESS_SESSION);
            assertFalse(replacementWarm.toCompletableFuture().isDone());
            assertEquals(1, provisioner.provisions.get());

            assertTrue(first.release(HARNESS_SESSION, RUNTIME_SESSION)
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));
            draining.toCompletableFuture().get(1, TimeUnit.SECONDS);
            replacementWarm.toCompletableFuture().get(1, TimeUnit.SECONDS);

            assertEquals(2, provisioner.provisions.get());
            assertEquals(1, provisioner.releases.get());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void twoBrokersDrainOnePhysicalRuntimeOnce() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        provisioner.drainResult = new CompletableFuture<>();
        RuntimeBrokerService first = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "broker-a");
        RuntimeBrokerService second = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "broker-b");
        try {
            first.warm(HARNESS_SESSION).toCompletableFuture().get(1,
                    TimeUnit.SECONDS);
            second.warm(HARNESS_SESSION).toCompletableFuture().get(1,
                    TimeUnit.SECONDS);

            CompletionStage<Void> firstDrain = first.drainHarness(
                    HARNESS_SESSION);
            CompletionStage<Void> secondDrain = second.drainHarness(
                    HARNESS_SESSION);
            waitForCount(provisioner.drains, 1);
            assertEquals(0, provisioner.releases.get());

            provisioner.drainResult.complete(null);
            CompletableFuture.allOf(firstDrain.toCompletableFuture(),
                    secondDrain.toCompletableFuture()).get(1,
                            TimeUnit.SECONDS);
            assertEquals(1, provisioner.drains.get());
            assertEquals(1, provisioner.releases.get());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void brokerCanDrainPersistedRuntimeItDidNotPreviouslyObserve()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        RuntimeBrokerService first = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "broker-a");
        RuntimeBrokerService second = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(sessionScope()),
                provisioner, new FakeTransport(), bindings, sessions,
                executions, "broker-b");
        try {
            first.warm(HARNESS_SESSION).toCompletableFuture().get(1,
                    TimeUnit.SECONDS);

            second.drainHarness(HARNESS_SESSION).toCompletableFuture().get(1,
                    TimeUnit.SECONDS);

            assertEquals(1, provisioner.drains.get());
            assertEquals(1, provisioner.releases.get());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void releasingSessionCannotBeReacquiredByAnotherBroker() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        ReleaseBlockingTransport transport = new ReleaseBlockingTransport();
        RuntimeProvisioner provisioner = request ->
                CompletableFuture.completedFuture(LEASE);
        RuntimeBrokerService first = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                "broker-a");
        RuntimeBrokerService second = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                "broker-b");
        try {
            first.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            second.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            CompletionStage<Boolean> releasing = first.release(
                    HARNESS_SESSION, RUNTIME_SESSION);

            Exception failedAcquire = assertThrows(Exception.class,
                    () -> second.acquire(HARNESS_SESSION, RUNTIME_SESSION,
                            "bootstrap").toCompletableFuture().get(1,
                                    TimeUnit.SECONDS));
            RuntimeBrokerException conflict = (RuntimeBrokerException)
                    failedAcquire.getCause();
            assertEquals("runtime_broker_session_conflict",
                    conflict.getCode());

            transport.release.complete(true);
            assertTrue(releasing.toCompletableFuture().get(1,
                    TimeUnit.SECONDS));
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void anotherBrokerCanResumeInterruptedSessionRelease() throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        RecoverableReleaseTransport transport =
                new RecoverableReleaseTransport();
        RuntimeProvisioner provisioner = request ->
                CompletableFuture.completedFuture(LEASE);
        RuntimeBrokerService first = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                "broker-a");
        RuntimeBrokerService second = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions,
                "broker-b");
        try {
            first.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);
            first.release(HARNESS_SESSION, RUNTIME_SESSION);
            assertEquals(RuntimeSessionRecord.State.RELEASING,
                    sessions.findById(RUNTIME_SESSION).getState());
            first.close();

            assertTrue(second.release(HARNESS_SESSION, RUNTIME_SESSION)
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));
            assertEquals(2, transport.releases.get());
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    sessions.findById(RUNTIME_SESSION).getState());
        } finally {
            first.close();
            second.close();
        }
    }

    @Test
    void staleBindingRunsHealthBeforeLogicalAcquire() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new FakeTransport(), Duration.ofSeconds(1),
                Duration.ofMillis(10), scheduler);
        try {
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);
            Thread.sleep(25);
            service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS);

            assertEquals(1, provisioner.healthChecks.get());
        } finally {
            service.close();
        }
    }

    @Test
    void healthFailureDrainsWithoutRetryingTheAcquire() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        provisioner.health = CompletableFuture.completedFuture(false);
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new FakeTransport(), Duration.ofSeconds(1),
                Duration.ofMillis(10), scheduler);
        try {
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);
            Thread.sleep(25);

            assertThrows(Exception.class,
                    () -> service.acquire(HARNESS_SESSION, RUNTIME_SESSION,
                            "bootstrap").toCompletableFuture()
                            .get(1, TimeUnit.SECONDS));
            waitForCount(provisioner.releases, 1);

            assertEquals(1, provisioner.provisions.get());
            assertEquals(1, provisioner.healthChecks.get());
            assertEquals(1, provisioner.drains.get());
        } finally {
            service.close();
        }
    }

    @Test
    void concurrentAcquiresShareOneStaleHealthCheck() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        ScheduledExecutorService scheduler = scheduler();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new FakeTransport(), Duration.ofSeconds(1),
                Duration.ofMillis(10), scheduler);
        try {
            service.warm(HARNESS_SESSION).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);
            Thread.sleep(25);
            provisioner.health = new CompletableFuture<>();

            CompletionStage<Void> first = service.acquire(HARNESS_SESSION,
                    "runtime-one", "bootstrap");
            CompletionStage<Void> second = service.acquire(HARNESS_SESSION,
                    "runtime-two", "bootstrap");

            assertEquals(1, provisioner.healthChecks.get());
            provisioner.health.complete(true);
            first.toCompletableFuture().get(1, TimeUnit.SECONDS);
            second.toCompletableFuture().get(1, TimeUnit.SECONDS);
            assertEquals(1, provisioner.healthChecks.get());
        } finally {
            service.close();
        }
    }

    @Test
    void closeRejectsNewWorkAndClosesTheProvisioner() throws Exception {
        LifecycleProvisioner provisioner = new LifecycleProvisioner();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new FakeTransport());
        service.warm(HARNESS_SESSION).toCompletableFuture()
                .get(1, TimeUnit.SECONDS);

        service.close();
        service.close();

        RuntimeBrokerException failure = assertThrows(
                RuntimeBrokerException.class,
                () -> service.warm(HARNESS_SESSION));
        assertEquals("runtime_broker_closed", failure.getCode());
        assertEquals(1, provisioner.closes.get());
    }

    private static RuntimeBrokerService readyService(
            RuntimeTransport transport) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                ignored -> CompletableFuture.completedFuture(LEASE),
                transport);
    }

    private static RuntimeBrokerService durableService(String owner,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions) {
        return durableService(owner, provisioner, transport, bindings,
                sessions, executions, Duration.ofMinutes(10),
                Duration.ofMillis(300));
    }

    private static RuntimeBrokerService durableService(String owner,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, Duration operationLease,
            Duration dispatchLease) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport, bindings, sessions, executions, owner,
                operationLease, dispatchLease,
                Duration.ofMinutes(5), Duration.ofSeconds(30), scheduler());
    }

    private static RuntimeScope sessionScope() {
        return new RuntimeScope("tenant", "workspace", "generation-1",
                "/workspace", "capability-digest", "session");
    }

    private static ScheduledExecutorService scheduler() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "runtime-broker-test");
            thread.setDaemon(true);
            return thread;
        });
    }

    private static void waitForCount(AtomicInteger value, int expected)
            throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            if (value.get() == expected) {
                return;
            }
            Thread.sleep(5);
        }
        throw new AssertionError("counter did not reach " + expected);
    }

    private static Map<String, Object> reference(String argsDigest) {
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("sessionId", RUNTIME_SESSION);
        reference.put("promptId", "turn-1");
        reference.put("callId", "tool-1");
        reference.put("capabilityDigest", "capability-digest");
        reference.put("policyRevision", "policy-1");
        reference.put("invocationId", "invocation-1");
        reference.put("argsDigest", argsDigest);
        return reference;
    }

    private static Map<String, Object> operation(String kind) {
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("kind", kind);
        return operation;
    }

    private static Map<String, Object> executionResult(String status) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("executionStatus", status);
        return result;
    }

    private static Map<String, Object> cancellationStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", "settled");
        status.put("cancelRequested", true);
        status.put("result", executionResult("cancelled"));
        return status;
    }

    private static Map<String, Object> invocationStatus(String state,
            boolean cancelRequested, Map<String, Object> executionResult) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", state);
        status.put("cancelRequested", cancelRequested);
        status.put("lastSeq", 0);
        status.put("firstAvailableSeq", 1);
        status.put("progressGap", false);
        status.put("progress", java.util.List.of());
        if (executionResult != null) {
            status.put("result", executionResult);
        }
        return status;
    }

    private static Map<String, Object> waitForSettled(
            RuntimeBrokerService service, String executionCallId)
            throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            Map<String, Object> snapshot = service.getExecution(
                    HARNESS_SESSION, RUNTIME_SESSION, executionCallId, null);
            if ("settled".equals(status(snapshot).get("state"))) {
                return snapshot;
            }
            Thread.sleep(5);
        }
        throw new AssertionError("execution did not settle");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> status(Map<String, Object> snapshot) {
        return (Map<String, Object>) snapshot.get("status");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> result(Map<String, Object> snapshot) {
        return (Map<String, Object>) status(snapshot).get("result");
    }

    private record UnknownFixture(RuntimeBrokerService service,
            InMemoryRuntimeBindingRepository bindings,
            InMemoryToolExecutionRepository executions, String bindingId,
            String executionCallId) {
    }

    /**
     * Acquires a Session on a live binding and records an execution against
     * that binding generation that another dispatcher left UNKNOWN.
     */
    private static UnknownFixture unknownFixture(RuntimeTransport transport)
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        RuntimeBrokerService service = durableService("broker-a",
                request -> CompletableFuture.completedFuture(LEASE),
                transport, bindings, new InMemoryRuntimeSessionRepository(),
                executions);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);
        RuntimeBindingRecord binding = bindings.findActive(
                new RuntimeProvisionRequest(SCOPE, null));
        ToolExecutionRecord prepared = executions.findOrCreate(
                ToolExecutionRecord.prepared("execution-unknown",
                        "key-unknown", binding.getBindingId(),
                        binding.getGeneration(), HARNESS_SESSION,
                        RUNTIME_SESSION, "turn-1", "tool-1", "args-1",
                        reference("args-1")));
        ToolExecutionRecord claimed = executions.claimDispatch(
                prepared.getExecutionCallId(), "lost-owner",
                Duration.ofMinutes(1));
        executions.compareAndSet(claimed, claimed.withUnknown(),
                "lost-owner", claimed.getDispatchGeneration());
        return new UnknownFixture(service, bindings, executions,
                binding.getBindingId(), prepared.getExecutionCallId());
    }

    private record LapsedFixture(RuntimeBrokerService service,
            ConcurrentTransport transport,
            InMemoryToolExecutionRepository executions,
            String executionCallId) {
    }

    /**
     * Starts one invocation that never completes, then lets its dispatch
     * claim lapse by the repository clock while it is still running here.
     */
    private static LapsedFixture lapsedFixture() throws Exception {
        MutableClock clock = new MutableClock(Instant.parse(
                "2026-09-24T00:00:00Z"));
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(clock);
        ConcurrentTransport transport = new ConcurrentTransport();
        RuntimeBrokerService service = durableService("broker-a",
                request -> CompletableFuture.completedFuture(LEASE),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(), executions);
        service.acquire(HARNESS_SESSION, RUNTIME_SESSION, "bootstrap")
                .toCompletableFuture().get(1, TimeUnit.SECONDS);
        Map<String, Object> created = service.createExecution("key-1",
                HARNESS_SESSION, RUNTIME_SESSION, "turn-1", "tool-1",
                "args-1", reference("args-1"));
        waitForCount(transport.executions, 1);
        String executionCallId = (String) created.get("executionCallId");
        assertEquals(ToolExecutionRecord.State.EXECUTING,
                executions.findByExecutionCallId(executionCallId).getState());
        clock.advance(Duration.ofSeconds(2));
        return new LapsedFixture(service, transport, executions,
                executionCallId);
    }

    private static void assertUnknownAfterCancel(LapsedFixture fixture) {
        Throwable failure = assertThrows(Exception.class,
                () -> fixture.service.cancelExecution(HARNESS_SESSION,
                        RUNTIME_SESSION, fixture.executionCallId)
                        .toCompletableFuture().get(1, TimeUnit.SECONDS));
        if (failure instanceof ExecutionException) {
            failure = failure.getCause();
        }
        assertEquals("runtime_broker_execution_unknown",
                ((RuntimeBrokerException) failure).getCode());
    }

    private static final class EvidenceTransport implements RuntimeTransport {
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger statuses = new AtomicInteger();
        private final AtomicInteger cancellations = new AtomicInteger();
        private final Map<String, Object> answer;

        EvidenceTransport(Map<String, Object> answer) {
            this.answer = answer;
        }

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            return new CompletableFuture<>();
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            statuses.incrementAndGet();
            return CompletableFuture.completedFuture(answer);
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancellations.incrementAndGet();
            return CompletableFuture.completedFuture(cancellationStatus());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class FakeTransport implements RuntimeTransport {
        private final AtomicInteger acquisitions = new AtomicInteger();
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger cancellations = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();
        private final CompletableFuture<Map<String, Object>> execution =
                new CompletableFuture<>();
        private volatile Map<String, Object> cancelResponse;
        private volatile CompletableFuture<Boolean> releaseResponse;

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            acquisitions.incrementAndGet();
            assertSame(LEASE, lease);
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation("manifest"));
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            return execution;
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            if (execution.isDone() && !execution.isCompletedExceptionally()) {
                return CompletableFuture.completedFuture(invocationStatus(
                        "settled", false, execution.getNow(null)));
            }
            return CompletableFuture.completedFuture(invocationStatus(
                    executions.get() == 0 ? "prepared" : "executing",
                    false, null));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancellations.incrementAndGet();
            Map<String, Object> response = cancelResponse;
            return CompletableFuture.completedFuture(response == null
                    ? cancellationStatus() : response);
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            releases.incrementAndGet();
            CompletableFuture<Boolean> response = releaseResponse;
            return response == null ? CompletableFuture.completedFuture(true)
                    : response;
        }
    }

    private static final class ConcurrentTransport
            implements RuntimeTransport {
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger cancellations = new AtomicInteger();
        private final CompletableFuture<Map<String, Object>> execution =
                new CompletableFuture<>();

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            return execution;
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            if (execution.isDone()) {
                return CompletableFuture.completedFuture(invocationStatus(
                        "settled", false, execution.getNow(null)));
            }
            return CompletableFuture.completedFuture(invocationStatus(
                    executions.get() == 0 ? "prepared" : "executing",
                    false, null));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancellations.incrementAndGet();
            return CompletableFuture.completedFuture(cancellationStatus());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class ResponseLossTransport
            implements RuntimeTransport {
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger statuses = new AtomicInteger();
        private volatile Map<String, Object> result;

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            result = executionResult("success");
            CompletableFuture<Map<String, Object>> lost =
                    new CompletableFuture<>();
            lost.completeExceptionally(new IllegalStateException(
                    "response lost"));
            return lost;
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            statuses.incrementAndGet();
            Map<String, Object> current = result;
            return CompletableFuture.completedFuture(current == null
                    ? invocationStatus("prepared", false, null)
                    : invocationStatus("settled", false, current));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(cancellationStatus());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class TakeoverTransport implements RuntimeTransport {
        private final AtomicInteger executions = new AtomicInteger();
        private volatile Map<String, Object> result;

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            result = executionResult("success");
            return new CompletableFuture<>();
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            Map<String, Object> current = result;
            return CompletableFuture.completedFuture(current == null
                    ? invocationStatus("prepared", false, null)
                    : invocationStatus("settled", false, current));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(cancellationStatus());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class ReleaseBlockingTransport
            implements RuntimeTransport {
        private final CompletableFuture<Boolean> release =
                new CompletableFuture<>();

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(
                    executionResult("success"));
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            return CompletableFuture.completedFuture(
                    invocationStatus("prepared", false, null));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(cancellationStatus());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return release;
        }
    }

    private static final class RecoverableReleaseTransport
            implements RuntimeTransport {
        private final AtomicInteger releases = new AtomicInteger();
        private final CompletableFuture<Boolean> interrupted =
                new CompletableFuture<>();

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(
                    executionResult("success"));
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            return CompletableFuture.completedFuture(
                    invocationStatus("prepared", false, null));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(cancellationStatus());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return releases.incrementAndGet() == 1 ? interrupted
                    : CompletableFuture.completedFuture(true);
        }
    }

    private static final class TakeoverExecutionRepository
            implements ToolExecutionRepository {
        private final MutableClock clock;
        private final InMemoryToolExecutionRepository delegate;
        private final CompletableFuture<Void> takeoverCompleted =
                new CompletableFuture<>();
        private boolean takeoverPending = true;

        TakeoverExecutionRepository(MutableClock clock) {
            this.clock = clock;
            delegate = new InMemoryToolExecutionRepository(clock);
        }

        void awaitTakeover() throws Exception {
            takeoverCompleted.get(5, TimeUnit.SECONDS);
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
                ToolExecutionRecord expected, ToolExecutionRecord replacement,
                String owner, long dispatchGeneration) {
            if (takeoverPending && "broker-a".equals(owner)
                    && replacement.getState()
                            == ToolExecutionRecord.State.EXECUTING) {
                takeoverPending = false;
                clock.advance(Duration.ofSeconds(2));
                ToolExecutionRecord claimed = delegate.claimDispatch(
                        expected.getExecutionCallId(), "broker-b",
                        Duration.ofMinutes(1));
                delegate.compareAndSet(claimed, claimed.withState(
                        ToolExecutionRecord.State.EXECUTING, false),
                        "broker-b", claimed.getDispatchGeneration());
                takeoverCompleted.complete(null);
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
        public boolean hasActiveByBinding(String bindingId,
                long runtimeGeneration) {
            return delegate.hasActiveByBinding(bindingId, runtimeGeneration);
        }
    }

    private static final class MutableClock extends Clock {
        private Instant current;

        MutableClock(Instant current) {
            this.current = current;
        }

        synchronized void advance(Duration duration) {
            current = current.plus(duration);
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
        public synchronized Instant instant() {
            return current;
        }
    }

    private static final class LifecycleProvisioner
            implements RuntimeProvisioner {
        private final AtomicInteger provisions = new AtomicInteger();
        private final AtomicInteger healthChecks = new AtomicInteger();
        private final AtomicInteger drains = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();
        private final AtomicInteger closes = new AtomicInteger();
        private volatile CompletableFuture<RuntimeLease> provision =
                CompletableFuture.completedFuture(LEASE);
        private volatile CompletableFuture<Boolean> health =
                CompletableFuture.completedFuture(true);
        private volatile CompletableFuture<Void> drainResult =
                CompletableFuture.completedFuture(null);

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            provisions.incrementAndGet();
            return provision;
        }

        @Override
        public CompletionStage<Boolean> health(RuntimeLease lease) {
            healthChecks.incrementAndGet();
            return health;
        }

        @Override
        public CompletionStage<Void> drain(RuntimeProvisionRequest request,
                RuntimeLease lease) {
            drains.incrementAndGet();
            return drainResult;
        }

        @Override
        public CompletionStage<Void> release(RuntimeProvisionRequest request,
                RuntimeLease lease) {
            releases.incrementAndGet();
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public void close() {
            closes.incrementAndGet();
        }
    }

    private static final class FixedBindingRepository
            implements RuntimeBindingRepository {
        private final RuntimeBindingRecord record;

        private FixedBindingRepository(RuntimeBindingRecord record) {
            this.record = record;
        }

        @Override
        public RuntimeBindingRecord findOrCreate(
                RuntimeProvisionRequest request) {
            return record;
        }

        @Override
        public RuntimeBindingRecord findActive(
                RuntimeProvisionRequest request) {
            return record;
        }

        @Override
        public List<RuntimeBindingRecord> findActiveByIsolationKey(
                String isolationKey) {
            return List.of(record);
        }

        @Override
        public RuntimeBindingRecord findById(String bindingId) {
            return record;
        }

        @Override
        public RuntimeBindingRecord compareAndSet(
                RuntimeBindingRecord expected,
                RuntimeBindingRecord replacement) {
            throw new UnsupportedOperationException();
        }

        @Override
        public RuntimeBindingRecord claimOperation(String bindingId,
                String owner, Duration leaseDuration) {
            throw new UnsupportedOperationException();
        }

        @Override
        public RuntimeBindingRecord renewOperation(String bindingId,
                String owner, long operationGeneration,
                Duration leaseDuration) {
            throw new UnsupportedOperationException();
        }

        @Override
        public RuntimeBindingRecord releaseOperation(String bindingId,
                String owner, long operationGeneration) {
            throw new UnsupportedOperationException();
        }
    }
}
