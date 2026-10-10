package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import com.alibaba.fastjson2.JSON;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

class RuntimeRecoveryTest {
    @Test
    void memoryRepositoryHonorsRecoveryContract() throws Exception {
        RuntimeRecoveryContract.verify(new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(), new InMemoryToolExecutionRepository(), "memory-recovery");
    }

    @Test
    void memoryRepositoryHonorsBeginSessionReleaseContract() {
        RuntimeRecoveryContract.verifyBeginSessionRelease(
                new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "memory-release");
    }

    @Test
    void persistedLossEndsExecutionBeforeAnUnavailableObserverResponds() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, "slow-observer");
        ToolExecutionRecord prepared = fixture.prepare("call");
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.releaseOperation(lost.getBindingId(), "recovery", lost.getOperationGeneration());
        var observation = new java.util.concurrent.CompletableFuture<RuntimeObservation>();
        RuntimeProvisioner provisioner = new RuntimeProvisioner() {
            @Override
            public String kind() { return "test-supervisor"; }
            @Override
            public java.util.concurrent.CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                throw new AssertionError("Lost writer domain must not be reprovisioned");
            }
            @Override
            public java.util.concurrent.CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lease) {
                return observation;
            }
        };
        RuntimeTransport noTransport = (RuntimeTransport) Proxy.newProxyInstance(
                RuntimeTransport.class.getClassLoader(), new Class<?>[] {RuntimeTransport.class},
                (proxy, method, args) -> { throw new AssertionError("Unexpected transport: " + method); });
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                id -> java.util.concurrent.CompletableFuture.completedFuture(lost.getRequest().getScope()),
                provisioner, noTransport, bindings, sessions, executions,
                "restarted", Duration.ofSeconds(1), Duration.ofSeconds(1))) {
            var warming = service.warm(prepared.getHarnessSessionId()).toCompletableFuture();
            assertEquals(ToolExecutionRecord.State.ABANDONED,
                    executions.findByExecutionCallId(prepared.getExecutionCallId()).getState());
            assertEquals(RuntimeBindingRecord.State.LOST, bindings.findById(lost.getBindingId()).getState());
            assertEquals(1, sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration()));
            assertFalse(warming.isDone());
            assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> warming.get(3, java.util.concurrent.TimeUnit.SECONDS));
            assertNull(bindings.findById(lost.getBindingId()).getOperationOwner());
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void terminalHttpReadsUseSavedOwnershipAfterRestartAndRelease(boolean deferred) throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, "http-recovery");
        Map<String, Object> reference = Map.of("sessionId", fixture.session.getRuntimeSessionId(),
                "promptId", "turn", "callId", "call", "argsDigest", "sha256:" + "0".repeat(64));
        var storedReference = new java.util.LinkedHashMap<>(reference);
        if (deferred) {
            storedReference.put("dispatchMode", "deferred");
        }
        ToolExecutionRecord prepared = bindings.admitExecution(sessions, executions,
                ToolExecutionRecord.prepared("http-call", "http-key", fixture.binding.getBindingId(),
                        fixture.binding.getGeneration(), fixture.session.getSession().getHarnessSessionId(),
                        fixture.session.getRuntimeSessionId(), "turn", "call", (String) reference.get("argsDigest"),
                        storedReference));
        RuntimeBindingRecord lost = fixture.lose(false);
        bindings.recoverLost(sessions, executions, lost);
        RuntimeTransport noTransport = (RuntimeTransport) Proxy.newProxyInstance(
                RuntimeTransport.class.getClassLoader(), new Class<?>[] {RuntimeTransport.class},
                (proxy, method, args) -> { throw new AssertionError("Unexpected transport: " + method); });
        try (RuntimeBrokerService restarted = new RuntimeBrokerService(
                id -> { throw new AssertionError("Current authorization/mapping must not rewrite old receipts"); },
                new StaticRuntimeProvisioner(fixture.binding.getLease()), noTransport,
                bindings, sessions, executions, "restarted", Duration.ofSeconds(10), Duration.ofSeconds(10));
                RuntimeBrokerHttpServer server = new RuntimeBrokerHttpServer(
                        new InetSocketAddress("127.0.0.1", 0), "test-token", restarted);
                HttpClient client = HttpClient.newHttpClient()) {
            server.start();
            for (boolean released : new boolean[] {false, true}) {
                if (released) {
                    RuntimeBindingRecord proof = bindings.compareAndSet(lost, lost.withRecoveryEvidence(null,
                            RuntimeRecoveryContract.evidence(lost, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED),
                            java.time.Instant.now()));
                    bindings.recoverLost(sessions, executions, proof);
                }
                String path = RuntimeBrokerHttpServer.ROUTE_PREFIX + "/executions/" + prepared.getExecutionCallId();
                var response = client.send(HttpRequest.newBuilder(server.getBaseUri().resolve(path
                                + "?requestId=read&harnessSessionId=" + prepared.getHarnessSessionId()
                                + "&runtimeSessionId=" + prepared.getRuntimeSessionId()))
                        .header("Authorization", "Bearer test-token").GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                assertEquals(409, response.statusCode(), response.body());
                var body = JSON.parseObject(response.body());
                assertEquals("runtime_broker_execution_unknown", body.getString("code"));
                assertTrue(body.getJSONObject("details").getBooleanValue("terminal"));
                assertEquals("runtime_lost", body.getJSONObject("details").getString("reason"));
                assertFalse(response.body().contains("test-host"));
                assertFalse(response.body().contains("test-supervisor"));
                assertEquals(ToolExecutionRecord.State.ABANDONED, restarted.cancelExecution(
                        prepared.getHarnessSessionId(), prepared.getRuntimeSessionId(), prepared.getExecutionCallId())
                        .toCompletableFuture().join().getState());
                var retried = deferred
                        ? restarted.prepareExecution(prepared.getHarnessSessionId(), prepared.getRuntimeSessionId(),
                                prepared.getIdempotencyKey(), reference)
                        : restarted.createExecution(prepared.getHarnessSessionId(), prepared.getRuntimeSessionId(),
                                prepared.getIdempotencyKey(), reference);
                assertEquals(prepared.getExecutionCallId(), retried.toCompletableFuture().join().getExecutionCallId());
                assertEquals(ExecutionReconciliation.Outcome.ABANDONED, restarted.reconcileExecution(
                        prepared.getHarnessSessionId(), prepared.getRuntimeSessionId(), prepared.getExecutionCallId())
                        .toCompletableFuture().join().getOutcome());
                assertThrows(java.util.concurrent.CompletionException.class, () -> restarted.getExecution(
                        "different-harness", prepared.getRuntimeSessionId(), prepared.getExecutionCallId())
                        .toCompletableFuture().join());
                assertThrows(java.util.concurrent.CompletionException.class, () -> restarted.createExecution(
                        prepared.getHarnessSessionId(), prepared.getRuntimeSessionId(), prepared.getIdempotencyKey(), Map.of())
                        .toCompletableFuture().join());
            }
        }
    }

}
