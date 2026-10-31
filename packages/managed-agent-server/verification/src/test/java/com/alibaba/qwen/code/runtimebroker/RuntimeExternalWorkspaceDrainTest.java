package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Broker sequencing witnesses; physical SQL ownership and native provider proof need separate integration tests. */
class RuntimeExternalWorkspaceDrainTest {
    @Test
    void lostMandatoryAckNeverStopsAndRetryCommitsReceiptBeforeRetiredCleanup() {
        try (var fixture = new Fixture()) {
            fixture.acquireAndExecute();
            fixture.events.clear();
            fixture.failAck = true;
            fixture.service.requestHarnessDrain("tenant", "harness");
            assertThrows(CompletionException.class, () -> fixture.drain());
            assertFalse(fixture.events.contains("stop"));
            assertNull(fixture.binding().getDrainReceipt());
            fixture.events.clear();
            fixture.failAck = false;
            fixture.drain();
            assertEquals(List.of("ack", "stop", "cleanup"), fixture.events);
            assertEquals(RuntimeBindingRecord.State.RELEASED, fixture.binding().getState());
        }
    }

    @Test
    void refusedDetachEscalatesOnlyAfterAckAndPersistsBeforeStoppedSessionRelease() {
        try (var fixture = new Fixture()) {
            fixture.acquireAndExecute();
            fixture.refuseDetach = true;
            fixture.events.clear();
            fixture.service.requestHarnessDrain("tenant", "harness");
            fixture.drain();
            assertEquals(List.of("detach", "ack", "stop", "cleanup"), fixture.events);
            assertEquals(RuntimeSessionRecord.State.RELEASED, fixture.sessions.findById(fixture.scope, "runtime").getState());
            assertNotNull(fixture.binding().getDrainReceipt());
        }
    }

    @Test
    void restartWithCommittedReceiptMakesNoWorkerCallsAndRetriesOnlyCleanup() {
        try (var fixture = new Fixture()) {
            fixture.acquireAndExecute();
            fixture.failCleanup = true;
            fixture.service.requestHarnessDrain("tenant", "harness");
            assertThrows(CompletionException.class, () -> fixture.drain());
            var receipt = fixture.binding().getDrainReceipt();
            assertNotNull(receipt);
            fixture.service.close();
            fixture.service = fixture.newService();
            fixture.events.clear();
            fixture.failCleanup = false;
            fixture.drain();
            assertEquals(List.of("cleanup"), fixture.events);
            assertEquals(receipt, fixture.binding().getDrainReceipt());
            assertEquals(RuntimeBindingRecord.State.RELEASED, fixture.binding().getState());
        }
    }

    @Test
    void lateNativeStopCannotPersistReceiptOrClearAfterItsClaimExpires() {
        try (var fixture = new Fixture()) {
            fixture.acquireAndExecute();
            fixture.pendingStop = new CompletableFuture<>();
            fixture.events.clear();
            fixture.service.requestHarnessDrain("tenant", "harness");
            var draining = fixture.service.drainHarnessSession("tenant", "harness");
            var original = fixture.binding();
            assertTrue(fixture.events.contains("stop"));
            fixture.clock.now = fixture.clock.now.plusSeconds(120);
            fixture.pendingStop.complete(fixture.receipt(original));
            assertThrows(CompletionException.class, () -> draining.toCompletableFuture().join());
            assertNull(fixture.binding().getDrainReceipt());
            assertFalse(fixture.events.contains("cleanup"));
        }
    }

    @Test
    void lifecycleClaimChangedWhileAckWaitsCannotReachNativeStop() {
        try (var fixture = new Fixture()) {
            fixture.acquireAndExecute();
            fixture.service.release("harness", "runtime").toCompletableFuture().join();
            fixture.service.close();
            fixture.installLifecycleGate();
            fixture.service = fixture.newService();
            fixture.service.requestHarnessDrain("tenant", "harness");
            fixture.events.clear();
            fixture.pendingAck = new CompletableFuture<>();
            var drain = fixture.service.drainHarnessResources("tenant", "harness", fixture.authority, false);
            assertTrue(fixture.events.contains("ack"));
            fixture.lifecycleCurrent = false;
            fixture.pendingAck.complete(null);
            var failure = assertThrows(CompletionException.class, () -> drain.toCompletableFuture().join());
            var denied = org.junit.jupiter.api.Assertions.assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
            assertEquals("runtime_admission_closed", denied.getCode());
            assertFalse(fixture.events.contains("stop"));
            assertFalse(fixture.events.contains("cleanup"));
            assertNull(fixture.binding().getDrainReceipt());
        }
    }

    @Test
    void retiredCleanupKeepsExplicitAuthorityAfterRepositoryDropsTransientScope() {
        try (var fixture = new Fixture()) {
            fixture.acquireAndExecute();
            fixture.failCleanup = true;
            fixture.service.requestHarnessDrain("tenant", "harness");
            assertThrows(CompletionException.class, fixture::drain);
            assertNotNull(fixture.binding().getDrainReceipt());
            fixture.service.close();
            fixture.installLifecycleGate();
            fixture.service = fixture.newService();
            fixture.events.clear();
            fixture.failCleanup = false;
            fixture.expireAtCleanup = true;
            var drain = fixture.service.drainHarnessResources("tenant", "harness", fixture.authority, false);
            var failure = assertThrows(CompletionException.class, () -> drain.toCompletableFuture().join());
            assertEquals(fixture.authority, fixture.cleanupAuthority);
            var denied = org.junit.jupiter.api.Assertions.assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
            assertEquals("runtime_admission_closed", denied.getCode());
            assertEquals(List.of("cleanup-check"), fixture.events, "Saved receipt retries only the guarded cleanup boundary");
            assertNotNull(fixture.binding().getDrainReceipt());
            assertEquals(RuntimeBindingRecord.State.DRAINING, fixture.binding().getState());
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {408, 429, 502, 503, 504})
    void initialRetryableProviderResponseKeepsSeedAndHandleAndRetryOnlyReconcilesOriginal(int status) throws IOException {
        try (var fixture = new Fixture()) {
            fixture.providerResponds(status);
            var error = assertThrows(CompletionException.class,
                    () -> fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join());
            var failure = (RuntimeBrokerException) error.getCause();
            assertEquals(status, failure.getStatusCode());
            assertEquals("runtime_external_provider_failed", failure.getCode());
            assertTrue(failure.isRetryable());
            var original = fixture.bindings.findActive(fixture.request());
            assertEquals(RuntimeBindingRecord.State.PROVISIONING, original.getState());
            assertNotNull(original.getResourceHandle());
            assertNull(original.getOperationOwner());
            fixture.service.close();
            fixture.service = fixture.newService();
            fixture.events.clear();
            fixture.providerClient = null;
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            var ready = fixture.binding();
            assertEquals(original.getProvisionSeed(), ready.getProvisionSeed());
            assertEquals(original.getResourceHandle(), ready.getResourceHandle());
            assertEquals(original.getGeneration(), ready.getGeneration());
            assertFalse(fixture.events.contains("provision"));
            assertFalse(fixture.events.contains("ensure"));
            assertTrue(fixture.events.contains("reconcile"));
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {200, 403})
    void malformedSuccessAndForbiddenProviderResponsesRemainBlocked(int status) throws IOException {
        try (var fixture = new Fixture()) {
            fixture.providerResponds(status);
            var error = assertThrows(CompletionException.class,
                    () -> fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join());
            var failure = (RuntimeBrokerException) error.getCause();
            assertEquals(status == 200 ? 502 : 403, failure.getStatusCode());
            assertFalse(failure.isRetryable());
            assertEquals("runtime_external_provider_failed", failure.getCode());
            var blocked = fixture.binding();
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED, blocked.getState());
            assertNotNull(blocked.getResourceHandle());
            assertNull(blocked.getOperationOwner());
        }
    }

    @Test
    void actualHostedDeferredProducerRejectsNonFileBeforeDispatch() {
        try (var fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"web_fetch\",\"input\":{\"url\":\"https://example.test\"}}";
            var prepared = fixture.prepare(payload);
            fixture.events.clear();
            var error = assertThrows(CompletionException.class, () -> fixture.service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload).toCompletableFuture().join());
            var refusal = (RuntimeBrokerException) error.getCause();
            assertEquals(400, refusal.getStatusCode());
            assertEquals("runtime_payload_invalid", refusal.getCode());
            assertFalse(fixture.events.contains("execute"));
            assertFalse(fixture.events.contains("ack"));
            var settled = fixture.executions.findByExecutionCallId(prepared.getExecutionCallId());
            assertTrue(settled.isSettled());
            assertEquals("not_started", settled.getExecutionStatus());
            assertEquals("workspace_tool_unsupported", ((Map<?, ?>) settled.getResult().get("error")).get("type"));
            assertTrue(fixture.service.release("harness", "runtime").toCompletableFuture().join());
            fixture.service.requestHarnessDrain("tenant", "harness");
            fixture.drain();
            assertEquals(RuntimeSessionRecord.State.RELEASED, fixture.sessions.findById(fixture.scope, "runtime").getState());
            assertEquals(RuntimeBindingRecord.State.RELEASED, fixture.binding().getState());
            assertEquals(List.of("detach", "ack", "stop", "cleanup"), fixture.events);
        }
    }

    @Test
    void anAllowedPreparedExecutionStillBlocksReleaseAndDrain() {
        try (var fixture = new Fixture()) {
            fixture.service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            var prepared = fixture.prepare("{\"toolName\":\"read_file\",\"input\":{\"file_path\":\"note.txt\"}}");
            fixture.events.clear();
            var error = assertThrows(CompletionException.class,
                    () -> fixture.service.release("harness", "runtime").toCompletableFuture().join());
            assertEquals("runtime_session_busy", ((RuntimeBrokerException) error.getCause()).getCode());
            fixture.service.requestHarnessDrain("tenant", "harness");
            assertThrows(CompletionException.class, fixture::drain);
            assertEquals(ToolExecutionRecord.State.PREPARED,
                    fixture.executions.findByExecutionCallId(prepared.getExecutionCallId()).getState());
            assertTrue(fixture.events.isEmpty());
        }
    }

    private static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-10-26T00:00:00Z");
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }

    private static final class Fixture implements AutoCloseable {
        private final MutableClock clock = new MutableClock();
        private final RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        private final InMemoryRuntimeBindingRepository bindings = new InMemoryRuntimeBindingRepository(clock, () -> "binding");
        private RuntimeBindingRepository repository = bindings;
        private final RuntimeLifecycleAuthority authority = new RuntimeLifecycleAuthority("close-operation", 1);
        private boolean lifecycleCurrent = true;
        private boolean expireAtCleanup;
        private RuntimeLifecycleAuthority cleanupAuthority;
        private CompletableFuture<Void> pendingAck;
        private final InMemoryRuntimeSessionRepository sessions = new InMemoryRuntimeSessionRepository();
        private final InMemoryToolExecutionRepository executions = new InMemoryToolExecutionRepository(clock);
        private final List<String> events = new ArrayList<>();
        private boolean failAck;
        private boolean failCleanup;
        private boolean refuseDetach;
        private HttpServer providerServer;
        private ExternalHttpRuntimeClient providerClient;
        private CompletableFuture<RuntimeDrainReceipt> pendingStop;
        private final RuntimeProvisioner provider = new RuntimeProvisioner() {
            public String kind() { return ExternalWorkspaceProvisioner.KIND; }
            public RuntimeProvisionRequest createRequest(RuntimeScope selected, String isolation) { return request(); }
            public boolean supportsDrainedStop() { return true; }
            public boolean supportsStartupRecovery(RuntimeResourceHandle handle) { return handle != null; }
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) { throw new AssertionError("Seed required"); }
            public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
                events.add("ensure");
                return CompletableFuture.completedFuture(new RuntimeResourceHandle(kind(), 1, Map.of("original", seed.getProvisionRequestId())));
            }
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
                events.add("provision");
                return providerClient == null ? CompletableFuture.completedFuture(lease(seed))
                        : providerClient.provision(Map.of("protocolVersion", 1,
                                "provisionRequestId", seed.getProvisionRequestId())).thenApply(ignored -> lease(seed));
            }
            public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                    RuntimeResourceHandle handle, RuntimeLease previous) {
                events.add("reconcile");
                var lease = lease(seed);
                return CompletableFuture.completedFuture(RuntimeObservation.ready(handle, lease.getEndpoint(),
                        lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch()));
            }
            public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
                events.add("stop");
                assertTrue(events.contains("ack"));
                return pendingStop == null ? CompletableFuture.completedFuture(receipt(binding)) : pendingStop;
            }
        };
        private final RuntimeTransport transport = new RuntimeTransport() {
            public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease, RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
                events.add("attest");
                return CompletableFuture.completedFuture(new RuntimeAttestation(lease.getRuntimeInstanceId(), seed.getGatewayIncarnation(),
                        lease.getLeaseId(), lease.getEpoch(), request.getScope(), seed.getProvisionRequestId(), request.getStorageId()));
            }
            public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) { return CompletableFuture.completedFuture(null); }
            public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
                events.add("detach");
                return refuseDetach ? CompletableFuture.failedFuture(new RuntimeBrokerException(503,
                        "managed_runtime_owner_hold_pending", "Original worker still holds resources", true))
                        : CompletableFuture.completedFuture(true);
            }
            public CompletionStage<Boolean> releaseRetired(RuntimeLease lease, RuntimeSession session) {
                cleanupAuthority = session.getScope().getLifecycleAuthority();
                var current = binding();
                assertNotNull(current.getDrainReceipt(), "Receipt must commit before physical cleanup");
                assertTrue(current.getDrainReceipt().matches(current));
                assertTrue(current.hasLiveOperationAt(clock.instant()));
                if (repository != bindings) {
                    if (expireAtCleanup) {
                        events.add("cleanup-check");
                        lifecycleCurrent = false;
                    }
                    requireLifecycle(session.getScope().getLifecycleAuthority());
                }
                events.add("cleanup");
                return failCleanup ? CompletableFuture.failedFuture(new IllegalStateException("Crash boundary after receipt"))
                        : CompletableFuture.completedFuture(true);
            }
            public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) {
                throw new AssertionError("No controls expected");
            }
            public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
                throw new AssertionError("Use real deferred payload route");
            }
            public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> reference, Map<String, Object> payload) {
                events.add("execute");
                return CompletableFuture.completedFuture(Map.of("executionStatus", "success", "responseParts", List.of()));
            }
            public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
                throw new AssertionError("No cancellation expected");
            }
            public CompletionStage<Void> acknowledgeV2(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
                var saved = executions.findByIdempotencyKey("key");
                assertTrue(saved.isSettled());
                assertEquals(saved.getReference(), reference);
                assertFalse(reference.containsKey("toolName"), "Hosted producer does not persist toolName in its reference");
                assertTrue(binding().hasSameLease(lease));
                if (repository != bindings) {
                    requireLifecycle(session.getScope().getLifecycleAuthority());
                }
                events.add("ack");
                if (pendingAck != null) {
                    return pendingAck;
                }
                return failAck ? CompletableFuture.failedFuture(new IllegalStateException("Lost ACK"))
                        : CompletableFuture.completedFuture(null);
            }
        };
        private RuntimeBrokerService service = newService();

        RuntimeBrokerService newService() {
            try {
                var constructor = RuntimeBrokerService.class.getDeclaredConstructor(
                        com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver.class,
                        com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner.class,
                        com.alibaba.qwen.code.runtimebroker.RuntimeTransport.class,
                        com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class,
                        com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class,
                        com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository.class,
                        String.class, Duration.class, Duration.class,
                        Clock.class, java.util.function.Supplier.class);
                constructor.setAccessible(true);
                return constructor.newInstance(
                        (com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver)
                                ignored -> CompletableFuture.completedFuture(scope),
                        provider, transport, repository, sessions, executions, "broker",
                        Duration.ofMinutes(1), Duration.ofMinutes(1), clock,
                        (java.util.function.Supplier<String>) () -> UUID.randomUUID().toString());
            } catch (ReflectiveOperationException error) {
                throw new IllegalStateException("Construct the broker service fixture", error);
            }
        }
        // Lifecycle authorization is an external repository boundary here; MySQL tests
        // separately prove its real row locks and that rejected cleanup retains H.
        void installLifecycleGate() {
            repository = (RuntimeBindingRepository) java.lang.reflect.Proxy.newProxyInstance(
                    RuntimeBindingRepository.class.getClassLoader(), new Class<?>[] {RuntimeBindingRepository.class},
                    (proxy, method, args) -> {
                        if (method.getName().equals("requireHarnessCleanup")) {
                            requireLifecycle((RuntimeLifecycleAuthority) args[args.length - 1]);
                            return null;
                        }
                        try {
                            Object result = method.invoke(bindings, args);
                            // JDBC reloading never returns request-scoped authority, including
                            // the binding returned by receipt CAS and periodic renewal.
                            return result instanceof RuntimeBindingRecord binding ? binding.withLifecycleAuthority(null) : result;
                        } catch (java.lang.reflect.InvocationTargetException failure) {
                            throw failure.getCause();
                        }
                    });
        }
        void requireLifecycle(RuntimeLifecycleAuthority supplied) {
            assertEquals(authority, supplied, "Explicit lifecycle authority must survive repository reloads");
            if (!lifecycleCurrent) {
                throw new RuntimeBrokerException(409, "runtime_admission_closed", "Lifecycle claim changed", false);
            }
        }
        void providerResponds(int status) throws IOException {
            providerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            providerServer.createContext("/provision", exchange -> {
                exchange.getRequestBody().readAllBytes();
                byte[] body = "not-json".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            });
            providerServer.start();
            providerClient = new ExternalHttpRuntimeClient(URI.create("http://127.0.0.1:" + providerServer.getAddress().getPort()),
                    "test-provider-token-1234", Duration.ofSeconds(5));
        }
        RuntimeProvisionRequest request() { return new RuntimeProvisionRequest(scope, "harness", ExternalWorkspaceProvisioner.KIND, "workspace"); }
        RuntimeBindingRecord binding() { return bindings.findById("binding"); }
        RuntimeLease lease(RuntimeProvisionSeed seed) {
            return new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9999"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        }
        RuntimeDrainReceipt receipt(RuntimeBindingRecord binding) {
            return new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                    binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), clock.instant());
        }
        ToolExecutionRecord prepare(String payload) {
            return service.prepareExecution("harness", "runtime", "key", Map.of("sessionId", "runtime", "promptId", "turn",
                    "callId", "call", "argsDigest", "sha256:" + DigestUtils.sha256Hex(payload)), null).toCompletableFuture().join();
        }
        void acquireAndExecute() {
            service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
            String payload = "{\"toolName\":\"write_file\",\"input\":{\"file_path\":\"note.txt\",\"content\":\"saved\"}}";
            var prepared = prepare(payload);
            service.startExecution("harness", "runtime", prepared.getExecutionCallId(), payload).toCompletableFuture().join();
            assertTrue(executions.findByExecutionCallId(prepared.getExecutionCallId()).isSettled());
            assertTrue(events.contains("ack"));
        }
        void drain() { service.drainHarnessSession("tenant", "harness").toCompletableFuture().join(); }
        public void close() {
            service.close();
            if (providerServer != null) {
                providerServer.stop(0);
            }
        }
    }
}
