package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
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

    private static RuntimeBrokerService readyService(FakeTransport transport) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                ignored -> CompletableFuture.completedFuture(LEASE),
                transport);
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

    private static final class FakeTransport implements RuntimeTransport {
        private final AtomicInteger acquisitions = new AtomicInteger();
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger cancellations = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();
        private final CompletableFuture<Map<String, Object>> execution =
                new CompletableFuture<>();

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
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            cancellations.incrementAndGet();
            return CompletableFuture.completedFuture(cancellationStatus());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            releases.incrementAndGet();
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class LifecycleProvisioner
            implements RuntimeProvisioner {
        private final AtomicInteger provisions = new AtomicInteger();
        private final AtomicInteger healthChecks = new AtomicInteger();
        private final AtomicInteger drains = new AtomicInteger();
        private final AtomicInteger releases = new AtomicInteger();
        private final AtomicInteger closes = new AtomicInteger();
        private volatile CompletableFuture<Boolean> health =
                CompletableFuture.completedFuture(true);

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            provisions.incrementAndGet();
            return CompletableFuture.completedFuture(LEASE);
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
            return CompletableFuture.completedFuture(null);
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
}
