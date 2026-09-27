package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.Proxy;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class RuntimeMaintenanceRecoveryTest {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void maintenanceRequiresHolderCleanupAndNeverResolvesOrReprovisions(boolean jdbc) throws Exception {
        if (jdbc) {
            var source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:maintenance-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            JdbcRuntimeBrokerSchema.initialize(source);
            verifyBatches(new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])),
                    new JdbcRuntimeSessionRepository(source), new JdbcToolExecutionRepository(source), UUID.randomUUID().toString());
        } else {
            verifyBatches(new InMemoryRuntimeBindingRepository(), new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(), UUID.randomUUID().toString());
        }
    }

    static void verifyBatches(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String id) throws Exception {
        var fixture = new Fixture(bindings, sessions, executions, id);
        assertTrue(bindings.findRecoveryCandidates("local-process", null, 100).stream()
                .anyMatch(record -> record.getBindingId().equals(fixture.binding.getBindingId())));
        assertTrue(bindings.findRecoveryCandidates("unsupported-provider", null, 100).isEmpty());
        assertTrue(bindings.findRecoveryCandidates("local-process", fixture.binding.getBindingId(), 1).stream()
                .allMatch(record -> record.getBindingId().compareTo(fixture.binding.getBindingId()) > 0));
        for (int index = 0; index < 205; index++) {
            fixture.prepare("call-" + index);
        }
        var lost = fixture.lose();
        var oldLoss = lost.getLossEvidence();
        assertEquals(RuntimeBindingRecord.State.LOST, bindings.recoverLost(sessions, executions, lost).getState());
        assertTrue(executions.hasActiveByBinding(lost.getBindingId(), lost.getGeneration()));
        assertEquals(1, sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration()));
        assertThrows(RuntimeBrokerException.class, () -> bindings.completeSessionRelease(sessions, fixture.session));
        bindings.releaseOperation(lost.getBindingId(), "fixture", lost.getOperationGeneration());
        AtomicInteger cleared = new AtomicInteger();
        RuntimeProvisioner provisioner = provisioner(saved -> {
            assertFalse(executions.hasActiveByBinding(saved.getBindingId(), saved.getGeneration()));
            if (cleared.getAndIncrement() == 0) {
                return CompletableFuture.failedFuture(new IllegalStateException("cleanup committed; reply lost"));
            }
            return CompletableFuture.completedFuture(null);
        });
        try (var service = service(bindings, sessions, executions, provisioner, Duration.ofSeconds(10))) {
            assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> service.recoverBinding(lost.getBindingId(), lost.getGeneration()).toCompletableFuture()
                            .get(5, TimeUnit.SECONDS));
            assertEquals(1, cleared.get());
            assertEquals(RuntimeBindingRecord.State.LOST, bindings.findById(lost.getBindingId()).getState());
            assertEquals(1, sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration()));
            var released = service.recoverBinding(lost.getBindingId(), lost.getGeneration()).toCompletableFuture()
                    .get(5, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.RELEASED, released.getState());
            assertEquals(oldLoss, released.getLossEvidence());
            assertEquals(lost.getBindingId(), released.getBindingId());
            assertEquals(0, sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration()));
            assertNull(bindings.findActive(lost.getRequest()));
            assertTrue(bindings.findRecoveryCandidates("local-process", null, 100).stream()
                    .noneMatch(record -> record.getBindingId().equals(lost.getBindingId())));
            assertEquals(2, cleared.get());
            assertEquals(RuntimeBindingRecord.State.RELEASED, service.recoverBinding(lost.getBindingId(),
                    lost.getGeneration()).toCompletableFuture().join().getState());
            assertEquals(2, cleared.get());
            for (int index = 0; index < 205; index++) {
                var receipt = executions.findByIdempotencyKey(id + "-call-" + index);
                assertEquals(ToolExecutionRecord.State.ABANDONED, receipt.getState());
                assertNull(receipt.getResult());
            }
        }
    }

    @org.junit.jupiter.api.Test
    void lateCleanupCompletionCannotRetireAnExpiredClaim() throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var fixture = new Fixture(bindings, sessions, executions, "late");
        var lost = fixture.lose();
        bindings.releaseOperation(lost.getBindingId(), "fixture", lost.getOperationGeneration());
        var pending = new CompletableFuture<Void>();
        try (var service = service(bindings, sessions, executions, provisioner(saved -> pending), Duration.ofMillis(100))) {
            var recovery = service.recoverBinding(lost.getBindingId(), lost.getGeneration()).toCompletableFuture();
            assertThrows(java.util.concurrent.ExecutionException.class, () -> recovery.get(3, TimeUnit.SECONDS));
            pending.complete(null);
            assertEquals(RuntimeBindingRecord.State.LOST, bindings.findById(lost.getBindingId()).getState());
            assertEquals(1, sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration()));
            assertNull(bindings.findById(lost.getBindingId()).getOperationOwner());
        }
    }

    static RuntimeProvisioner provisioner(java.util.function.Function<RuntimeBindingRecord, CompletionStage<Void>> cleanup) {
        return new RuntimeProvisioner() {
            @Override
            public String kind() { return "local-process"; }
            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                throw new AssertionError("Maintenance cannot provision");
            }
            @Override
            public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle known) {
                throw new AssertionError("Maintenance cannot ensure resources");
            }
            @Override
            public boolean supportsStartupRecovery(RuntimeResourceHandle handle) { return handle.getVersion() == 2; }
            @Override
            public CompletionStage<Void> recoverResources(RuntimeBindingRecord saved) { return cleanup.apply(saved); }
        };
    }

    private static RuntimeBrokerService service(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeProvisioner provisioner, Duration lease) {
        RuntimeTransport transport = (RuntimeTransport) Proxy.newProxyInstance(RuntimeTransport.class.getClassLoader(),
                new Class<?>[] {RuntimeTransport.class}, (proxy, method, arguments) -> {
                    throw new AssertionError("Maintenance cannot call a dead worker: " + method);
                });
        return new RuntimeBrokerService(id -> { throw new AssertionError("Maintenance cannot resolve current grants"); },
                provisioner, transport, bindings, sessions, executions, "maintenance", lease, lease);
    }

    static final class Fixture {
        final RuntimeBindingRepository bindings;
        final RuntimeSessionRepository sessions;
        final ToolExecutionRepository executions;
        final String id;
        final RuntimeBindingRecord binding;
        final RuntimeSessionRecord session;

        Fixture(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
                ToolExecutionRepository executions, String id) {
            this.bindings = bindings;
            this.sessions = sessions;
            this.executions = executions;
            this.id = id;
            var scope = new RuntimeScope(id, "workspace", "1", "/workspace",
                    WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            var created = bindings.findOrCreate(new RuntimeProvisionRequest(scope, id, "local-process", "storage"));
            var claim = bindings.claimOperation(created.getBindingId(), "fixture", Duration.ofMinutes(5));
            var seed = claim.getProvisionSeed();
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            binding = bindings.compareAndSet(claim, claim.withAttestation(lease,
                    new RuntimeResourceHandle("local-process", 2, Map.of("test", id)), Instant.now(), Instant.now()));
            var acquiring = bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession(id, id + "-runtime", "bootstrap", scope), binding.getBindingId(), binding.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
            session = sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        }

        void prepare(String call) {
            bindings.admitExecution(sessions, executions, ToolExecutionRecord.prepared(id + "-" + call,
                    id + "-" + call, binding.getBindingId(), binding.getGeneration(), id, session.getRuntimeSessionId(),
                    "turn", call, "digest", Map.of("sessionId", session.getRuntimeSessionId(),
                            "promptId", "turn", "callId", call, "argsDigest", "digest")));
        }

        RuntimeBindingRecord lose() {
            return bindings.compareAndSet(binding, binding.withRecoveryEvidence(
                    RuntimeRecoveryContract.evidence(binding, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    RuntimeRecoveryContract.evidence(binding, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED), Instant.now()));
        }
    }
}
