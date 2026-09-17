package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
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

        assertSame(LEASE, provisioner.provision(SCOPE).toCompletableFuture()
                .get(1, TimeUnit.SECONDS));
        RuntimeScope sessionScope = new RuntimeScope("tenant", "workspace",
                "generation-1", "/workspace", "capability-digest",
                "session");
        assertThrows(IllegalArgumentException.class,
                () -> provisioner.provision(sessionScope));
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

    private static RuntimeBrokerService readyService(FakeTransport transport) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                ignored -> CompletableFuture.completedFuture(LEASE),
                transport);
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
}
