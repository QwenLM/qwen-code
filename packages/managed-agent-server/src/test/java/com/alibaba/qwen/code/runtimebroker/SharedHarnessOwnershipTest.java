package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

/** A shared Workspace binding answers each Runtime Session for its own Harness Session. */
class SharedHarnessOwnershipTest {
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace");
    private static final RuntimeProvisionRequest SHARED = new RuntimeProvisionRequest(SCOPE, null, "local-process", "storage");

    private final JdbcDataSource source = source();
    private final JdbcRuntimeBindingRepository bindings =
            new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
    private final JdbcRuntimeSessionRepository sessions = new JdbcRuntimeSessionRepository(source);
    private final JdbcToolExecutionRepository executions = new JdbcToolExecutionRepository(source);

    @Test
    void sessionAdmissionFencesOnlyTheClosingHarnessSession() {
        var binding = ready(bindings, SHARED);
        bindings.admitSession(sessions, candidate(binding, "harness-a", "a-1"));
        bindings.requestHarnessDrain("tenant", "harness-a");

        assertClosed(() -> bindings.admitSession(sessions, candidate(binding, "harness-a", "a-2")));
        assertEquals("harness-b",
                bindings.admitSession(sessions, candidate(binding, "harness-b", "b-1")).getSession().getHarnessSessionId());
        assertEquals(RuntimeSessionRecord.State.RELEASED,
                bindings.createSessionTombstone(sessions, released(binding, "harness-a", "a-3")).getState());
    }

    @Test
    void scopeChecksFollowTheNamedHarnessSessionAndRefuseLifecycleAuthority() {
        bindings.requestHarnessDrain("tenant", "harness-a");

        assertClosed(() -> bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-a", null));
        assertClosed(() -> bindings.requireHookAdmission(SHARED, SCOPE, "harness-b",
                new RuntimeLifecycleAuthority("close", 1)));
        assertClosed(() -> bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-b",
                new RuntimeLifecycleAuthority("close", 1)));
        bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-b", null);

        // Unbound and private Kubernetes Workspace placements keep today's unfenced Workspace isolation.
        bindings.requireHarnessAdmission(new RuntimeProvisionRequest(SCOPE, null, "legacy", null), SCOPE, "harness-a", null);
        bindings.requireHarnessAdmission(new RuntimeProvisionRequest(SCOPE, null, "kubernetes-workspace", "storage"),
                SCOPE, "harness-a", null);
        bindings.requireHarnessAdmission(SCOPE, "harness-a", null);
    }

    @Test
    void cleanupAuthorityFollowsTheRuntimeSessionsHarnessClaim() throws Exception {
        var binding = ready(bindings, SHARED);
        var authority = new RuntimeLifecycleAuthority("close", 1);
        assertClosed(() -> bindings.requireHarnessCleanup(SHARED, SCOPE, "harness-a", authority));
        bindings.requestHarnessDrain("tenant", "harness-a");
        try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                "UPDATE ma_session_head SET operation_id = ?, claim_generation = 1, claim_lease_until = ?"
                        + " WHERE tenant_id = ? AND harness_session_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, "close");
            statement.setLong(2, System.currentTimeMillis() + 30_000);
            JdbcRepositorySupport.setIdentity(statement, 3, "tenant");
            JdbcRepositorySupport.setIdentity(statement, 4, "harness-a");
            assertEquals(1, statement.executeUpdate());
        }
        bindings.requireHarnessCleanup(SHARED, SCOPE, "harness-a", authority);
        assertClosed(() -> bindings.requireHarnessCleanup(SHARED, SCOPE, "harness-a",
                new RuntimeLifecycleAuthority("other", 1)));
        assertClosed(() -> bindings.requireHarnessCleanup(SHARED, SCOPE, "harness-a",
                new RuntimeLifecycleAuthority("close", 2)));
        assertClosed(() -> bindings.requireHarnessCleanup(SHARED, SCOPE, "harness-b", authority));
        assertClosed(() -> bindings.requireHookAdmission(SHARED, SCOPE, "harness-a", authority));
        assertClosed(() -> bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-a", authority));
        assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(binding.getBindingId()).getState());
    }

    @Test
    void lifecycleWorkPlacesOnASharedBindingUnderTheClosingSessionsClaim() throws Exception {
        var binding = ready(bindings, SHARED);
        var authority = new RuntimeLifecycleAuthority("close", 1);
        assertClosed(() -> bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-a", authority));
        assertClosed(() -> bindings.requireHookAdmission(SHARED, SCOPE, "harness-a", authority));
        JdbcRepositorySupport.transaction(source, connection -> {
            JdbcRuntimeBindingRepository.beginHarnessLifecycle(connection, "tenant", "harness-a", "close");
            return null;
        });
        try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                "UPDATE ma_session_head SET claim_generation = 1, claim_lease_until = ?"
                        + " WHERE tenant_id = ? AND harness_session_id = ?")) {
            statement.setLong(1, System.currentTimeMillis() + 30_000);
            JdbcRepositorySupport.setIdentity(statement, 2, "tenant");
            JdbcRepositorySupport.setIdentity(statement, 3, "harness-a");
            assertEquals(1, statement.executeUpdate());
        }
        bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-a", authority);
        bindings.requireHookAdmission(SHARED, SCOPE, "harness-a", authority);
        assertClosed(() -> bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-a",
                new RuntimeLifecycleAuthority("other", 1)));
        assertClosed(() -> bindings.requireHarnessAdmission(SHARED, SCOPE, "harness-a",
                new RuntimeLifecycleAuthority("close", 2)));
        assertClosed(() -> bindings.requireHookAdmission(SHARED, SCOPE, "harness-b", authority));
        assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(binding.getBindingId()).getState());
    }

    @Test
    void scopeOnlyAdmissionFencesBoundWorkspaceScopesByTheHarnessClaim() throws Exception {
        var binding = ready(bindings, SHARED);
        var authority = new RuntimeLifecycleAuthority("close", 1);
        // The scope-only admission used by authorizeLifecycle and findOrCreate no longer
        // refuses a bound Workspace scope outright; the Harness claim fences it.
        assertClosed(() -> bindings.requireHarnessAdmission(SCOPE, "harness-a", authority));
        JdbcRepositorySupport.transaction(source, connection -> {
            JdbcRuntimeBindingRepository.beginHarnessLifecycle(connection, "tenant", "harness-a", "close");
            return null;
        });
        try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                "UPDATE ma_session_head SET claim_generation = 1, claim_lease_until = ?"
                        + " WHERE tenant_id = ? AND harness_session_id = ?")) {
            statement.setLong(1, System.currentTimeMillis() + 30_000);
            JdbcRepositorySupport.setIdentity(statement, 2, "tenant");
            JdbcRepositorySupport.setIdentity(statement, 3, "harness-a");
            assertEquals(1, statement.executeUpdate());
        }
        bindings.requireHarnessAdmission(SCOPE, "harness-a", authority);
        assertClosed(() -> bindings.requireHarnessAdmission(SCOPE, "harness-a",
                new RuntimeLifecycleAuthority("other", 1)));
        assertClosed(() -> bindings.requireHarnessAdmission(SCOPE, "harness-a",
                new RuntimeLifecycleAuthority("close", 2)));
        assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(binding.getBindingId()).getState());
    }

    @Test
    void executionAdmissionUsesTheExecutionsHarnessSession() {
        var binding = ready(bindings, SHARED);
        var a = sessionReady(bindings.admitSession(sessions, candidate(binding, "harness-a", "a-1")));
        var b = sessionReady(bindings.admitSession(sessions, candidate(binding, "harness-b", "b-1")));
        bindings.requestHarnessDrain("tenant", "harness-a");

        assertClosed(() -> bindings.admitExecution(sessions, executions, execution(binding, a, "call-a")));
        assertEquals(ToolExecutionRecord.State.PREPARED,
                bindings.admitExecution(sessions, executions, execution(binding, b, "call-b")).getState());
    }

    @Test
    void inMemoryRepositoryFencesTheSameHarnessSession() {
        var registry = new InMemoryRuntimeBindingRepository();
        var saved = new InMemoryRuntimeSessionRepository();
        var binding = ready(registry, SHARED);
        registry.requestHarnessDrain("tenant", "harness-a");

        assertClosed(() -> registry.admitSession(saved, candidate(binding, "harness-a", "a-1")));
        assertNotNull(registry.admitSession(saved, candidate(binding, "harness-b", "b-1")));
    }

    @Test
    void originalOwnerPathsAnswerOnlyTheRuntimeSessionsHarnessSession() throws Exception {
        var binding = ready(bindings, SHARED);
        sessionReady(bindings.admitSession(sessions, candidate(binding, "harness-a", "a-1")));
        bindings.createSessionTombstone(sessions, released(binding, "harness-a", "a-done"));
        try (var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(SCOPE),
                new UnusedProvisioner(), new UnusedTransport(), bindings, sessions, executions,
                UUID.randomUUID().toString(), Duration.ofSeconds(30), Duration.ofSeconds(30))) {
            assertEquals(true, service.releaseOriginal("harness-a", "a-done", binding.getBindingId(),
                    binding.getGeneration()).toCompletableFuture().get());
            assertConflict("workspace_close_identity_unverified",
                    service.acquireRecovery("harness-b", "a-1", binding.getBindingId(), binding.getGeneration()));
            assertConflict("runtime_session_conflict",
                    service.releaseOriginal("harness-b", "a-1", binding.getBindingId(), binding.getGeneration()));
            assertConflict("runtime_session_conflict",
                    service.releaseOriginal("harness-b", "unused", binding.getBindingId(), binding.getGeneration()));
        }
        assertNull(sessions.findById(SCOPE, "unused"));
    }

    private static RuntimeBindingRecord ready(RuntimeBindingRepository registry, RuntimeProvisionRequest request) {
        var initial = registry.findOrCreate(request);
        var claimed = registry.claimOperation(initial.getBindingId(), "setup", Duration.ofSeconds(10));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9999"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var handle = new RuntimeResourceHandle("local-process", 2, Map.of("resource", "original"));
        var attested = registry.compareAndSet(claimed, claimed.withAttestation(lease, handle, Instant.now(), Instant.now()));
        return registry.releaseOperation(attested.getBindingId(), "setup", attested.getOperationGeneration());
    }

    private RuntimeSessionRecord sessionReady(RuntimeSessionRecord acquiring) {
        return sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
    }

    private static RuntimeSessionRecord candidate(RuntimeBindingRecord binding, String harness, String id) {
        return new RuntimeSessionRecord(new RuntimeSession(harness, id, "bootstrap", SCOPE), binding.getBindingId(),
                binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
    }

    private static RuntimeSessionRecord released(RuntimeBindingRecord binding, String harness, String id) {
        return new RuntimeSessionRecord(new RuntimeSession(harness, id, "bootstrap", SCOPE), binding.getBindingId(),
                binding.getGeneration(), RuntimeSessionRecord.State.RELEASED, 0, Instant.now());
    }

    private static ToolExecutionRecord execution(RuntimeBindingRecord binding, RuntimeSessionRecord session, String call) {
        String harness = session.getSession().getHarnessSessionId();
        return ToolExecutionRecord.prepared(call, call + "-key", binding.getBindingId(), binding.getGeneration(),
                harness, session.getRuntimeSessionId(), "turn", call, "digest",
                Map.of("sessionId", session.getRuntimeSessionId(), "promptId", "turn", "callId", call,
                        "argsDigest", "digest"));
    }

    private static void assertClosed(Executable executable) {
        assertEquals("runtime_admission_closed", assertThrows(RuntimeBrokerException.class, executable).getCode());
    }

    private static void assertConflict(String code, CompletionStage<?> stage) {
        var failure = assertThrows(ExecutionException.class, () -> stage.toCompletableFuture().get());
        assertEquals(code, assertInstanceOf(RuntimeBrokerException.class, failure.getCause()).getCode());
    }

    private static JdbcDataSource source() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:shared-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        return source;
    }

    private static final class UnusedProvisioner implements RuntimeProvisioner {
        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            return CompletableFuture.failedFuture(new AssertionError("no provisioning expected"));
        }
    }

    private static final class UnusedTransport implements RuntimeTransport {
        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.failedFuture(new AssertionError("no acquire expected"));
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.failedFuture(new AssertionError("no control expected"));
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return CompletableFuture.failedFuture(new AssertionError("no execute expected"));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return CompletableFuture.failedFuture(new AssertionError("no cancel expected"));
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.failedFuture(new AssertionError("no release expected"));
        }
    }
}
