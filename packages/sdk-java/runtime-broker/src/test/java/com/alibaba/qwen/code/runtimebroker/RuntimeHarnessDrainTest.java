package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class RuntimeHarnessDrainTest {
    private final JdbcDataSource source = source();
    private final RuntimeBindingRepository bindings = new JdbcRuntimeBindingRepository(source,
            new AesGcmSecretProtector("test", new byte[32]));
    private final RuntimeSessionRepository sessions = new JdbcRuntimeSessionRepository(source);
    private final ToolExecutionRepository executions = new JdbcToolExecutionRepository(source);
    private final RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
    private final RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope, "harness", "local-process", "storage");
    private final Provider provisioner = new Provider();
    private final Transport transport = new Transport();

    @Test
    void fenceSurvivesRestartAndBlocksLateWarmAndAdmissions() throws Exception {
        var binding = ready();
        bindings.requestHarnessDrain("tenant", "harness");
        var restored = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        assertTrue(restored.isHarnessDraining("tenant", "harness"));
        assertFalse(restored.isHarnessDraining("Tenant", "harness"));
        assertThrows(RuntimeBrokerException.class, () -> restored.findOrCreate(request));
        var candidate = candidate(binding, "late");
        assertThrows(RuntimeBrokerException.class, () -> restored.admitSession(sessions, candidate));
        var resolved = new CompletableFuture<RuntimeScope>();
        try (var service = new RuntimeBrokerService(ignored -> resolved, provisioner, transport,
                bindings, sessions, executions, "late-warmer", Duration.ofSeconds(2), Duration.ofSeconds(2))) {
            var late = service.warm("harness").toCompletableFuture();
            resolved.complete(scope);
            var rejected = assertThrows(Exception.class, late::get);
            assertEquals("runtime_admission_closed", ((RuntimeBrokerException) rejected.getCause()).getCode());
        }
        assertEquals(0, provisioner.stops);
        assertEquals(0, provisioner.observations);
        assertEquals(1, restored.findByHarnessSession("tenant", "harness", null, 50).size());
    }

    @Test
    void releasesAllOriginalSessionsWithoutScopeResolutionAndPersistsStop() throws Exception {
        var binding = ready();
        for (String id : java.util.List.of("one", "two")) {
            bindings.admitSession(sessions, candidate(binding, id));
        }
        var stopped = new CompletableFuture<RuntimeDrainReceipt>();
        provisioner.stop = stopped;
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            var close = service.drainHarnessSession("tenant", "harness").toCompletableFuture();
            assertFalse(close.isDone());
            assertEquals(0, sessions.countActiveByBinding(binding.getBindingId(), binding.getGeneration()));
            assertEquals(RuntimeBindingRecord.State.DRAINING, bindings.findById(binding.getBindingId()).getState());
            stopped.complete(receipt(binding));
            close.get();
            var retired = bindings.findById(binding.getBindingId());
            assertEquals(RuntimeBindingRecord.State.RELEASED, retired.getState());
            assertNotNull(retired.getDrainReceipt());
            assertNull(retired.getLossEvidence());
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            assertEquals(1, provisioner.stops);
            assertEquals(2, transport.releases);
        }
    }

    @Test
    void noRuntimeCloseDoesNotProvisionAnything() throws Exception {
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            assertEquals(0, provisioner.stops);
            assertEquals(0, transport.releases);
        }
    }

    @ParameterizedTest
    @CsvSource({"PROVISIONING,false", "PROVISIONING,true", "RECOVERY_BLOCKED,false", "RECOVERY_BLOCKED,true"})
    @DisabledOnOs(OS.WINDOWS)
    void closeRetiresUnstartedBindingsBeforeTheirHandleWasSaved(String state, boolean intentExists,
            @TempDir Path directory) throws Exception {
        var initial = bindings.findOrCreate(request);
        var seed = initial.getProvisionSeed();
        var store = new LocalRuntimeStore(directory.toRealPath(), DurableLocalProcessRuntimeProvisionerTest.HOST);
        try (var local = new LocalProcessRuntimeProvisioner(java.util.List.of("must-not-run"), directory,
                new HttpRuntimeTransport(), null, store)) {
            if (intentExists) {
                local.ensureResource(request, seed, null).toCompletableFuture().get(5, TimeUnit.SECONDS);
            }
            if ("RECOVERY_BLOCKED".equals(state)) {
                var claimed = bindings.claimOperation(initial.getBindingId(), "setup", Duration.ofSeconds(10));
                var blocked = bindings.compareAndSet(claimed,
                        claimed.withState(RuntimeBindingRecord.State.RECOVERY_BLOCKED, null, Instant.now()));
                assertNotNull(blocked);
                bindings.releaseOperation(blocked.getBindingId(), "setup", blocked.getOperationGeneration());
            }
            assertNull(bindings.findById(initial.getBindingId()).getResourceHandle());
            try (var service = new RuntimeBrokerService(ignored -> CompletableFuture.failedFuture(new AssertionError()),
                    local, transport, bindings, sessions, executions, "drainer",
                    Duration.ofSeconds(2), Duration.ofSeconds(2))) {
                service.requestHarnessDrain("tenant", "harness");
                service.drainHarnessSession("tenant", "harness").toCompletableFuture().get(5, TimeUnit.SECONDS);
                var retired = bindings.findById(initial.getBindingId());
                assertEquals(RuntimeBindingRecord.State.RELEASED, retired.getState());
                assertNotNull(retired.getDrainReceipt());
                assertTrue(retired.getDrainReceipt().matches(retired));
                assertNull(retired.getLossEvidence());
                var registration = store.locked(request, seed, retired.getResourceHandle(), false,
                        (resource, saved) -> saved);
                assertEquals(LocalRuntimeStore.State.RETIRED, registration.state());
                assertEquals(0, registration.pid());
                assertNull(registration.process());
                assertEquals(0, transport.releases);
                var delayed = assertThrows(ExecutionException.class,
                        () -> local.provision(request, seed).toCompletableFuture().get(5, TimeUnit.SECONDS));
                assertEquals("runtime_broker_recovery_blocked",
                        assertInstanceOf(RuntimeBrokerException.class, delayed.getCause()).getCode());
                assertThrows(RuntimeBrokerException.class, () -> bindings.findOrCreate(request));
                service.drainHarnessSession("tenant", "harness").toCompletableFuture().get(5, TimeUnit.SECONDS);
            }
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"stop", "reconcile", "release"})
    void stalledDrainReleasesItsClaimAndFencesLateCompletion(String step) throws Exception {
        var binding = ready();
        if (!"stop".equals(step)) {
            bindings.admitSession(sessions, candidate(binding, "original"));
        }
        var stopped = new CompletableFuture<RuntimeDrainReceipt>();
        var observed = new CompletableFuture<RuntimeObservation>();
        var released = new CompletableFuture<Boolean>();
        provisioner.stop = "stop".equals(step) ? stopped : null;
        provisioner.observation = "reconcile".equals(step) ? observed : null;
        transport.releaseResponse = "release".equals(step) ? released : null;
        try (var first = service(Duration.ofMillis(600)); var second = service()) {
            first.requestHarnessDrain("tenant", "harness");
            var close = first.drainHarnessSession("tenant", "harness").toCompletableFuture();
            var timeout = assertThrows(ExecutionException.class, () -> close.get(6, TimeUnit.SECONDS));
            var failure = assertInstanceOf(RuntimeBrokerException.class, timeout.getCause());
            assertEquals("runtime_broker_reconcile_timeout", failure.getCode());
            assertTrue(failure.isRetryable());
            assertNull(bindings.findById(binding.getBindingId()).getOperationOwner());
            assertNull(bindings.findById(binding.getBindingId()).getDrainReceipt());
            provisioner.observation = null;
            transport.releaseResponse = null;
            var replacementStop = new CompletableFuture<RuntimeDrainReceipt>();
            provisioner.stop = replacementStop;
            var replacement = second.drainHarnessSession("tenant", "harness").toCompletableFuture();
            var current = bindings.findById(binding.getBindingId());
            stopped.complete(receipt(binding));
            observed.complete(RuntimeObservation.ready(binding.getResourceHandle(), binding.getLease().getEndpoint(),
                    binding.getLease().getRuntimeInstanceId(), binding.getLease().getLeaseId(), binding.getLease().getEpoch()));
            released.complete(true);
            assertFalse(replacement.isDone());
            assertEquals(current.getOperationGeneration(), bindings.findById(binding.getBindingId()).getOperationGeneration());
            assertEquals(RuntimeBindingRecord.State.DRAINING, bindings.findById(binding.getBindingId()).getState());
            assertNull(bindings.findById(binding.getBindingId()).getDrainReceipt());
            replacementStop.complete(receipt(binding));
            replacement.get(5, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.RELEASED, bindings.findById(binding.getBindingId()).getState());
        }
    }

    @ParameterizedTest
    @CsvSource({"false,RECOVERY_BLOCKED", "true,RECOVERY_BLOCKED", "false,LOST", "true,LOST"})
    void drainingBlocksRivalStoragePlacementUntilStopIsProven(boolean jdbc, String state) throws Exception {
        RuntimeBindingRepository registry = jdbc ? bindings : new InMemoryRuntimeBindingRepository();
        var ready = ready(registry);
        var claimed = registry.claimOperation(ready.getBindingId(), "block", Duration.ofSeconds(10));
        var blocked = registry.compareAndSet(claimed, claimed.withState(RuntimeBindingRecord.State.valueOf(state),
                claimed.getLease(), Instant.now()));
        assertNotNull(blocked);
        var binding = registry.releaseOperation(blocked.getBindingId(), "block", blocked.getOperationGeneration());
        var rivalScope = new RuntimeScope("tenant", "other-workspace", "1", "/different-path",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var rival = new RuntimeProvisionRequest(rivalScope, "rival", "local-process", "storage");
        assertEquals("runtime_placement_recovery_required",
                assertThrows(RuntimeBrokerException.class, () -> registry.findOrCreate(rival)).getCode());
        var stop = new CompletableFuture<RuntimeDrainReceipt>();
        provisioner.stop = stop;
        try (var service = new RuntimeBrokerService(ignored -> CompletableFuture.failedFuture(new AssertionError()),
                provisioner, transport, registry, sessions, executions, "drainer", Duration.ofSeconds(2), Duration.ofSeconds(2))) {
            service.requestHarnessDrain("tenant", "harness");
            var close = service.drainHarnessSession("tenant", "harness").toCompletableFuture();
            assertEquals("LOST".equals(state) ? RuntimeBindingRecord.State.LOST : RuntimeBindingRecord.State.DRAINING,
                    registry.findById(binding.getBindingId()).getState());
            assertEquals("runtime_placement_recovery_required",
                    assertThrows(RuntimeBrokerException.class, () -> registry.findOrCreate(rival)).getCode());
            registry.findOrCreate(new RuntimeProvisionRequest(rivalScope, "unrelated", "local-process", "other-storage"));
            stop.completeExceptionally(LocalRuntimeStore.blocked());
            var failure = assertThrows(ExecutionException.class, close::get);
            assertEquals("runtime_broker_recovery_blocked", ((RuntimeBrokerException) failure.getCause()).getCode());
            assertNull(registry.findById(binding.getBindingId()).getDrainReceipt());
            assertEquals("runtime_placement_recovery_required",
                    assertThrows(RuntimeBrokerException.class, () -> registry.findOrCreate(rival)).getCode());
            provisioner.stop = null;
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            assertEquals(RuntimeBindingRecord.State.RELEASED, registry.findById(binding.getBindingId()).getState());
            assertNotNull(registry.findOrCreate(rival));
        }
    }

    @Test
    void closeDoesNotReuseTheSameBrokersProvisioningClaim() throws Exception {
        provisioner.resource = new CompletableFuture<>();
        try (var service = warmingService()) {
            var warm = service.warm("harness").toCompletableFuture();
            var original = bindings.findByHarnessSession("tenant", "harness", null, 50).getFirst();
            provisioner.original = original;
            service.requestHarnessDrain("tenant", "harness");
            assertThrows(Exception.class, () -> service.drainHarnessSession("tenant", "harness")
                    .toCompletableFuture().get());
            assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                    bindings.findById(original.getBindingId()).getState());
            assertEquals(0, provisioner.stops);
            provisioner.resource.completeExceptionally(new RuntimeBrokerException(503,
                    "fixture_unavailable", "Resource reply failed", true));
            assertThrows(Exception.class, warm::get);
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            assertEquals(RuntimeBindingRecord.State.RELEASED, bindings.findById(original.getBindingId()).getState());
        }
    }

    @Test
    void oldProvisioningReplyCannotLaunchAfterAnotherBrokerRetiresItsIntent() throws Exception {
        provisioner.resource = new CompletableFuture<>();
        try (var originalService = warmingService(); var replacement = service()) {
            var warm = originalService.warm("harness").toCompletableFuture();
            var original = bindings.findByHarnessSession("tenant", "harness", null, 50).getFirst();
            provisioner.original = original;
            replacement.requestHarnessDrain("tenant", "harness");
            try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                    "UPDATE qwen_runtime_binding SET operation_lease_until = TIMESTAMP '2000-01-01 00:00:00' WHERE binding_id = ?")) {
                statement.setString(1, original.getBindingId());
                statement.executeUpdate();
            }
            replacement.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            provisioner.resource.complete(handle());
            assertThrows(Exception.class, warm::get);
            var retired = bindings.findById(original.getBindingId());
            assertEquals(RuntimeBindingRecord.State.RELEASED, retired.getState());
            assertNotNull(retired.getDrainReceipt());
            assertNull(retired.getLossEvidence());
            assertEquals(1, provisioner.stops);
            assertEquals(0, provisioner.provisions);
        }
    }

    @Test
    void lostBindingWithAnUnreleasedSessionStillRequiresRecovery() throws Exception {
        var binding = ready();
        var session = bindings.admitSession(sessions, candidate(binding, "one"));
        var claimed = bindings.claimOperation(binding.getBindingId(), "setup", Duration.ofSeconds(10));
        var lost = bindings.compareAndSet(claimed, claimed.withState(RuntimeBindingRecord.State.LOST,
                claimed.getLease(), Instant.now()));
        bindings.releaseOperation(lost.getBindingId(), "setup", lost.getOperationGeneration());
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            var failure = assertThrows(ExecutionException.class,
                    () -> service.drainHarnessSession("tenant", "harness").toCompletableFuture().get());
            assertEquals("workspace_close_execution_unsettled",
                    assertInstanceOf(RuntimeBrokerException.class, failure.getCause()).getCode());
            assertTrue(sessions.findById(scope, session.getRuntimeSessionId()).isActive());
            assertEquals(RuntimeBindingRecord.State.LOST, bindings.findById(binding.getBindingId()).getState());
            assertNull(bindings.findById(binding.getBindingId()).getDrainReceipt());
            assertEquals(0, transport.releases);
            assertEquals(0, provisioner.stops);
        }
    }

    @Test
    void unknownExecutionBlocksReleaseAndStop() throws Exception {
        var binding = ready();
        var session = bindings.admitSession(sessions, candidate(binding, "one"));
        var prepared = ToolExecutionRecord.prepared("execution", "key", binding.getBindingId(), binding.getGeneration(),
                "harness", "one", "prompt", "call", "digest", java.util.Map.of("sessionId", "one", "promptId", "prompt", "callId", "call", "argsDigest", "digest"));
        executions.findOrCreate(prepared);
        var claimed = executions.claimDispatch("execution", "dispatcher", Duration.ofSeconds(10));
        assertNotNull(executions.compareAndSet(claimed, claimed.withUnknown(), "dispatcher", claimed.getDispatchGeneration()));
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            assertThrows(Exception.class, () -> service.drainHarnessSession("tenant", "harness").toCompletableFuture().get());
            assertTrue(sessions.findById(scope, session.getRuntimeSessionId()).isActive());
            assertEquals(0, provisioner.stops);
            assertEquals(0, transport.releases);
        }
    }

    @Test
    void lostStopReplyRetriesOriginalGeneration() throws Exception {
        var binding = ready();
        provisioner.loseReply = true;
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            assertThrows(Exception.class, () -> service.drainHarnessSession("tenant", "harness").toCompletableFuture().get());
        }
        try (var restored = service()) {
            var before = bindings.findById(binding.getBindingId());
            var observed = restored.recoverBinding(binding.getBindingId(), binding.getGeneration())
                    .toCompletableFuture().get();
            assertEquals(before.getVersion(), observed.getVersion());
            assertNull(observed.getLossEvidence());
            assertEquals(0, provisioner.observations);
            restored.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            assertEquals(binding.getGeneration(), bindings.findById(binding.getBindingId()).getGeneration());
            assertEquals(2, provisioner.stops);
        }
    }

    @Test
    void lostReleaseReplyPinsTheWorkerUntilTheSavedSessionIsConfirmed() throws Exception {
        var binding = ready();
        var session = bindings.admitSession(sessions, candidate(binding, "original"));
        transport.loseReleaseReply = true;
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            assertThrows(Exception.class, () -> service.drainHarnessSession("tenant", "harness").toCompletableFuture().get());
            assertEquals(RuntimeSessionRecord.State.RELEASING, sessions.findById(scope, "original").getState());
            assertEquals(0, provisioner.stops);
        }
        try (var replacement = service()) {
            replacement.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            var released = sessions.findById(scope, session.getRuntimeSessionId());
            assertEquals(RuntimeSessionRecord.State.RELEASED, released.getState());
            assertEquals(binding.getGeneration(), released.getRuntimeGeneration());
            assertEquals(2, transport.releases);
            assertEquals(1, provisioner.stops);
        }
    }

    @Test
    void claimCleanupFailureDoesNotMaskPersistedDrainCompletion() throws Exception {
        var binding = ready();
        var tracked = (RuntimeBindingRepository) Proxy.newProxyInstance(RuntimeBindingRepository.class.getClassLoader(),
                new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, arguments) -> {
                    if (method.getName().equals("releaseOperation")) {
                        throw new IllegalStateException("Claim cleanup connection failed");
                    }
                    try {
                        return method.invoke(bindings, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
        try (var service = new RuntimeBrokerService(ignored -> CompletableFuture.failedFuture(new AssertionError()),
                provisioner, transport, tracked, sessions, executions, "drainer", Duration.ofSeconds(2), Duration.ofSeconds(2))) {
            service.requestHarnessDrain("tenant", "harness");
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().get(5, TimeUnit.SECONDS);
            var retired = bindings.findById(binding.getBindingId());
            assertEquals(RuntimeBindingRecord.State.RELEASED, retired.getState());
            assertTrue(retired.getDrainReceipt().matches(binding));
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().get(5, TimeUnit.SECONDS);
            assertEquals(1, provisioner.stops);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void unusableOriginalWorkerBlocksCloseWithoutReenteringItsClaim(boolean cachedContext) throws Exception {
        var binding = ready();
        var claims = new AtomicInteger();
        var releases = new AtomicInteger();
        var tracked = (RuntimeBindingRepository) Proxy.newProxyInstance(RuntimeBindingRepository.class.getClassLoader(),
                new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, arguments) -> {
                    if (method.getName().equals("claimOperation")) {
                        claims.incrementAndGet();
                    }
                    if (method.getName().equals("releaseOperation")) {
                        releases.incrementAndGet();
                    }
                    try {
                        return method.invoke(bindings, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
        try (var service = new RuntimeBrokerService(ignored -> {
            assertTrue(cachedContext, "Restored close must not resolve current authorization or mount");
            return CompletableFuture.completedFuture(scope);
        }, provisioner, transport, tracked, sessions, executions, UUID.randomUUID().toString(),
                Duration.ofSeconds(30), Duration.ofSeconds(30))) {
            if (cachedContext) {
                transport.allowAcquire = true;
                assertEquals(RuntimeSessionRecord.State.READY,
                        service.acquire("harness", "original", "bootstrap").toCompletableFuture().get().getState());
                transport.allowAcquire = false;
                assertEquals(1, transport.acquires);
            } else {
                var saved = bindings.admitSession(sessions, candidate(binding, "original"));
                assertNotNull(sessions.compareAndSet(saved, saved.withState(RuntimeSessionRecord.State.READY, Instant.now())));
            }
            int claimsBefore = claims.get();
            int releasesBefore = releases.get();
            int observationsBefore = provisioner.observations;
            int acquiresBefore = transport.acquires;
            int attestationsBefore = transport.attestations;
            provisioner.usable = false;
            service.requestHarnessDrain("tenant", "harness");
            var failure = assertThrows(Exception.class,
                    () -> service.drainHarnessSession("tenant", "harness").toCompletableFuture().get());
            var error = assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
            var blocked = bindings.findById(binding.getBindingId());
            assertAll(
                    () -> assertEquals("workspace_close_identity_unverified", error.getCode()),
                    () -> assertEquals(409, error.getStatusCode()),
                    () -> assertFalse(error.isRetryable()),
                    () -> assertEquals(RuntimeSessionRecord.State.READY, sessions.findById(scope, "original").getState()),
                    () -> assertEquals(RuntimeBindingRecord.State.DRAINING, blocked.getState()),
                    () -> assertTrue(blocked.isDrainRequested()),
                    () -> assertNull(blocked.getLossEvidence()),
                    () -> assertNull(blocked.getDrainReceipt()),
                    () -> assertNull(blocked.getOperationOwner()),
                    () -> assertEquals(claimsBefore + 1, claims.get(), "Close must claim only once"),
                    () -> assertEquals(releasesBefore + 1, releases.get(), "Close must release only its own final claim"),
                    () -> assertEquals(observationsBefore + (cachedContext ? 0 : 1), provisioner.observations),
                    () -> assertEquals(acquiresBefore, transport.acquires),
                    () -> assertEquals(attestationsBefore, transport.attestations),
                    () -> assertEquals(0, provisioner.provisions),
                    () -> assertEquals(0, provisioner.stops),
                    () -> assertEquals(0, transport.releases));
            var next = bindings.claimOperation(binding.getBindingId(), "next-broker", Duration.ofSeconds(10));
            assertNotNull(next);
            assertNotNull(bindings.releaseOperation(next.getBindingId(), "next-broker", next.getOperationGeneration()));
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void classifiesReleaseFailureWithoutDroppingTheOriginalSession(boolean retryable) throws Exception {
        var binding = ready();
        bindings.admitSession(sessions, candidate(binding, "original"));
        transport.releaseFailure = new RuntimeBrokerException(retryable ? 503 : 409,
                retryable ? "runtime_transport_unavailable" : "runtime_transport_conflict",
                "Original activation could not be cleared", retryable);
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            var failure = assertThrows(Exception.class,
                    () -> service.drainHarnessSession("tenant", "harness").toCompletableFuture().get());
            var error = assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
            assertEquals(retryable ? "runtime_transport_unavailable" : "workspace_close_identity_unverified", error.getCode());
            assertEquals(retryable ? 503 : 409, error.getStatusCode());
            assertEquals(retryable, error.isRetryable());
            var saved = sessions.findById(scope, "original");
            assertEquals(RuntimeSessionRecord.State.RELEASING, saved.getState());
            assertEquals(binding.getGeneration(), saved.getRuntimeGeneration());
            assertTrue(saved.isActive());
            var blocked = bindings.findById(binding.getBindingId());
            assertEquals(RuntimeBindingRecord.State.DRAINING, blocked.getState());
            assertNull(blocked.getDrainReceipt());
            assertNull(blocked.getLossEvidence());
            assertNull(blocked.getOperationOwner());
            assertEquals(1, transport.releases);
            assertEquals(0, transport.acquires);
            assertEquals(0, transport.attestations);
            assertEquals(0, provisioner.provisions);
            assertEquals(0, provisioner.stops);
            if (retryable) {
                transport.releaseFailure = null;
                service.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
                assertEquals(RuntimeSessionRecord.State.RELEASED, sessions.findById(scope, "original").getState());
                var closed = bindings.findById(binding.getBindingId());
                assertEquals(RuntimeBindingRecord.State.RELEASED, closed.getState());
                assertNotNull(closed.getDrainReceipt());
                assertEquals(2, transport.releases);
                assertEquals(1, provisioner.stops);
                assertEquals(0, transport.acquires);
                assertEquals(0, provisioner.provisions);
            }
        }
    }

    @Test
    void closingFenceStillAllowsAlreadyProvenLossToFinishExistingRecovery() throws Exception {
        var binding = ready();
        var claimed = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(10));
        var seed = binding.getProvisionSeed();
        var loss = evidence(seed, binding.getResourceHandle(), RuntimeRecoveryEvidence.Fact.JOURNAL_LOST);
        var stopped = evidence(seed, binding.getResourceHandle(), RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED);
        var lost = bindings.compareAndSet(claimed, claimed.withRecoveryEvidence(loss, stopped, Instant.now()));
        bindings.releaseOperation(lost.getBindingId(), "operator", lost.getOperationGeneration());
        try (var service = service()) {
            service.requestHarnessDrain("tenant", "harness");
            var recovered = service.recoverBinding(binding.getBindingId(), binding.getGeneration()).toCompletableFuture().get();
            assertEquals(RuntimeBindingRecord.State.RELEASED, recovered.getState());
            assertEquals(stopped, recovered.getStopEvidence());
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().get();
            assertEquals(0, provisioner.stops);
            assertEquals(0, provisioner.observations);
        }
    }

    private RuntimeRecoveryEvidence evidence(RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            RuntimeRecoveryEvidence.Fact fact) {
        return new RuntimeRecoveryEvidence(fact.name(), fact, "operator-attested:original", Instant.now(), "original-host",
                seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(),
                seed.getLeaseId(), seed.getEpoch(), handle);
    }

    private RuntimeBrokerService service() {
        return service(Duration.ofSeconds(2));
    }

    private RuntimeBrokerService service(Duration leaseDuration) {
        return new RuntimeBrokerService(ignored -> CompletableFuture.failedFuture(
                new IllegalStateException("Current authorization/mount is unavailable")), provisioner, transport,
                bindings, sessions, executions, UUID.randomUUID().toString(), leaseDuration, leaseDuration);
    }

    private RuntimeBrokerService warmingService() {
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provisioner, transport,
                bindings, sessions, executions, UUID.randomUUID().toString(), Duration.ofSeconds(30), Duration.ofSeconds(30));
    }

    private RuntimeBindingRecord ready() {
        return ready(bindings);
    }

    private RuntimeBindingRecord ready(RuntimeBindingRepository registry) {
        var initial = registry.findOrCreate(request);
        var claimed = registry.claimOperation(initial.getBindingId(), "setup", Duration.ofSeconds(10));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9999"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var handle = handle();
        var ready = registry.compareAndSet(claimed, claimed.withAttestation(lease, handle, Instant.now(), Instant.now()));
        provisioner.original = ready;
        return registry.releaseOperation(ready.getBindingId(), "setup", ready.getOperationGeneration());
    }

    private RuntimeSessionRecord candidate(RuntimeBindingRecord binding, String id) {
        return new RuntimeSessionRecord(new RuntimeSession("harness", id, "bootstrap", scope), binding.getBindingId(),
                binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
    }

    private RuntimeDrainReceipt receipt(RuntimeBindingRecord binding) {
        return new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                binding.getProvisionSeed().getProvisionRequestId(),
                binding.getResourceHandle() == null ? handle() : binding.getResourceHandle(), Instant.now());
    }

    private RuntimeResourceHandle handle() {
        return new RuntimeResourceHandle("local-process", 2, java.util.Map.of("resource", "original"));
    }

    private class Provider implements RuntimeProvisioner {
        RuntimeBindingRecord original;
        CompletableFuture<RuntimeDrainReceipt> stop;
        CompletableFuture<RuntimeObservation> observation;
        CompletableFuture<RuntimeResourceHandle> resource;
        boolean loseReply;
        boolean usable = true;
        int stops;
        int observations;
        int provisions;
        public String kind() { return "local-process"; }
        public boolean supportsStartupRecovery(RuntimeResourceHandle handle) { return handle != null; }
        public java.util.concurrent.CompletionStage<Void> recoverResources(RuntimeBindingRecord binding) {
            assertTrue(binding.hasStoppedWriters());
            return CompletableFuture.completedFuture(null);
        }
        public boolean supportsDrainedStop() { return true; }
        public RuntimeProvisionRequest createRequest(RuntimeScope scope, String id) { return request; }
        public java.util.concurrent.CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed, RuntimeResourceHandle known) { return resource; }
        public java.util.concurrent.CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            provisions++;
            throw new AssertionError("Close must not provision");
        }
        public java.util.concurrent.CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lease) {
            observations++;
            assertEquals(original.getProvisionSeed(), seed);
            if (observation != null) {
                return observation;
            }
            return CompletableFuture.completedFuture(RuntimeObservation.ready(handle, lease.getEndpoint(),
                    lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch()));
        }
        public boolean isUsable(RuntimeLease lease) { return usable; }
        public java.util.concurrent.CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
            assertEquals(original.getBindingId(), binding.getBindingId());
            assertEquals(original.getGeneration(), binding.getGeneration());
            assertTrue(binding.isDrainRequested());
            stops++;
            if (loseReply && stops == 1) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(503,
                        "workspace_close_stop_unconfirmed", "Lost stop reply", true));
            }
            return stop == null ? CompletableFuture.completedFuture(receipt(binding)) : stop;
        }
    }

    private static class Transport implements RuntimeTransport {
        int releases;
        int acquires;
        int attestations;
        boolean allowAcquire;
        boolean loseReleaseReply;
        RuntimeBrokerException releaseFailure;
        CompletableFuture<Boolean> releaseResponse;
        public java.util.concurrent.CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            assertTrue(allowAcquire, "Close must not attest or reacquire");
            attestations++;
            return CompletableFuture.completedFuture(new RuntimeAttestation(lease.getRuntimeInstanceId(),
                    seed.getGatewayIncarnation(), lease.getLeaseId(), lease.getEpoch(), request.getScope(),
                    seed.getProvisionRequestId(), request.getStorageId()));
        }
        public java.util.concurrent.CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            acquires++;
            if (allowAcquire) {
                return CompletableFuture.completedFuture(null);
            }
            throw new AssertionError("Close must not acquire");
        }
        public java.util.concurrent.CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
                java.util.Map<String, Object> operation) { throw new AssertionError("Close must not control"); }
        public java.util.concurrent.CompletionStage<java.util.Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, java.util.Map<String, Object> ref) { throw new AssertionError("Close must not execute"); }
        public java.util.concurrent.CompletionStage<java.util.Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, java.util.Map<String, Object> ref) { throw new AssertionError("Idle close must not cancel"); }
        public java.util.concurrent.CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            releases++;
            if (releaseResponse != null) {
                return releaseResponse;
            }
            if (releaseFailure != null) {
                return CompletableFuture.failedFuture(releaseFailure);
            }
            if (loseReleaseReply && releases == 1) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(503,
                        "runtime_session_release_failed", "Release reply was lost", true));
            }
            return CompletableFuture.completedFuture(true);
        }
    }

    private static JdbcDataSource source() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:close-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(source);
        return source;
    }
}
