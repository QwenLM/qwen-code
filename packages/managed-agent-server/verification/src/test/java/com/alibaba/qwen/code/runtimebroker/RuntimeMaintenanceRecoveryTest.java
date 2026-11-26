package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.h2.jdbcx.JdbcDataSource;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

public class RuntimeMaintenanceRecoveryTest {
    @org.junit.jupiter.api.Test
    public void maintenanceRequiresHolderCleanupAndNeverResolvesOrReprovisions() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:maintenance-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        verifyBatches(new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])),
                new JdbcRuntimeSessionRepository(source), new JdbcToolExecutionRepository(source), UUID.randomUUID().toString());
    }

    @org.junit.jupiter.api.Test
    void recoveryCandidatesSkipHistoryAndPreserveGlobalBinaryCursors() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:recovery-candidates-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        verifyRecoveryCandidates(source);
    }

    public static void verifyRecoveryCandidates(DataSource source) throws Exception {
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        var jdbc = new JdbcTemplate(source);
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var first = new Fixture(bindings, sessions, executions, "first-tenant").binding;
        var second = new Fixture(bindings, sessions, executions, "second-tenant").binding;
        var candidates = Map.of(
                first.getBindingId(), RuntimeBindingRecord.State.READY,
                second.getBindingId(), RuntimeBindingRecord.State.READY,
                "A-candidate", RuntimeBindingRecord.State.LOST,
                "a-candidate", RuntimeBindingRecord.State.DRAINING,
                "Z-candidate", RuntimeBindingRecord.State.PROVISIONING,
                "z-candidate", RuntimeBindingRecord.State.RECOVERY_BLOCKED);
        var expected = candidates.keySet().stream().sorted().toList();
        try (var connection = source.getConnection();
                var insert = connection.prepareStatement(
                        "INSERT INTO ma_runtime_binding (binding_id, request_id, scope_id, tenant_id,"
                                + " workspace_id, workspace_generation, canonical_cwd, capability_digest,"
                                + " isolation_class, isolation_key, provisioner_kind, storage_id,"
                                + " runtime_generation, binding_state, resource_handle_version, resource_handle_json,"
                                + " attestation_generation, is_drain_requested, operation_generation, record_version,"
                                + " last_active_at) SELECT ?, request_id, scope_id, tenant_id, workspace_id,"
                                + " workspace_generation, canonical_cwd, capability_digest, isolation_class,"
                                + " isolation_key, provisioner_kind, storage_id, ?, ?, ?,"
                                + " CASE WHEN ? IS NULL THEN NULL ELSE resource_handle_json END, 0, FALSE, 0, 0,"
                                + " last_active_at FROM ma_runtime_binding WHERE binding_id = ?")) {
            long generation = first.getGeneration();
            for (var candidate : candidates.entrySet()) {
                if (candidate.getValue() != RuntimeBindingRecord.State.READY) {
                    addRecoveryRow(insert, first.getBindingId(), candidate.getKey(), ++generation,
                            candidate.getValue().name(), 2);
                }
            }
            var historyStates = List.of("FAILED", "RELEASED", "OPERATOR_RECOVERY", "PROVISIONING", "PROVISIONING");
            for (int index = 0; index < 5000; index++) {
                int kind = index % historyStates.size();
                Integer version = kind == 4 ? null : Integer.valueOf(kind == 3 ? 1 : 2);
                addRecoveryRow(insert, first.getBindingId(), (index % 2 == 0 ? "0" : "zz") + "-history-" + index,
                        ++generation, historyStates.get(kind), version);
                if ((index + 1) % 500 == 0) {
                    insert.executeBatch();
                }
            }
        }
        assertEquals(5006L, jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding", Long.class));
        assertEquals(1000L, jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_runtime_binding WHERE resource_handle_version IS NULL", Long.class));
        var page = bindings.findRecoveryCandidates("local-process", null, 100);
        assertEquals(expected, page.stream().map(RuntimeBindingRecord::getBindingId).toList());
        assertEquals(expected.stream().map(candidates::get).toList(),
                page.stream().map(RuntimeBindingRecord::getState).toList());
        assertTrue(bindings.findRecoveryCandidates("unsupported-provider", null, 100).isEmpty());
        assertEquals(expected.subList(0, 1), recoveryIds(bindings, null, 1));
        assertEquals(expected.subList(1, expected.size()), recoveryIds(bindings, expected.getFirst(), 100));
        assertEquals(List.of(), recoveryIds(bindings, expected.getLast(), 100));
        assertEquals(expected.stream().filter(id -> id.compareTo("A-candidate") > 0).toList(),
                recoveryIds(bindings, "A-candidate", 100));
        assertEquals(expected.stream().filter(id -> id.compareTo("a-candidate") > 0).toList(),
                recoveryIds(bindings, "a-candidate", 100));
        String cursor = null;
        for (int offset = 0; offset < expected.size(); offset += 2) {
            var batch = recoveryIds(bindings, cursor, 2);
            assertEquals(expected.subList(offset, Math.min(offset + 2, expected.size())), batch);
            cursor = batch.getLast();
        }
        assertTrue(recoveryIds(bindings, cursor, 2).isEmpty());

        String target = "a-candidate";
        long generation = bindings.findById(target).getGeneration();
        String operationRef = ManagedIdentityRefs.tenantOperationRef("WORKSPACE_OPERATOR_RECOVERY",
                first.getRequest().getScope().getTenantId(), "recovery");
        jdbc.update("INSERT INTO ma_operation (operation_ref, operation_id, scope_kind, scope_id, operation_kind, tenant_id,"
                        + " target_kind, target_id, target_revision, state, phase, request_digest, request_json,"
                        + " gmt_create, gmt_modified) VALUES (?, ?, 'TENANT', ?, 'WORKSPACE_OPERATOR_RECOVERY', ?,"
                        + " 'RUNTIME_BINDING', ?, ?, 'DRAINING', 'DRAINING', ?, '{}', 1, 1)",
                operationRef, "recovery".getBytes(StandardCharsets.UTF_8),
                first.getRequest().getScope().getTenantId(),
                first.getRequest().getScope().getTenantId(),
                target.getBytes(StandardCharsets.UTF_8), generation, "c".repeat(64));
        var withoutTarget = expected.stream().filter(id -> !id.equals(target)).toList();
        assertEquals(withoutTarget, recoveryIds(bindings, null, 100));
        int targetIndex = expected.indexOf(target);
        assertEquals(List.of(expected.get(targetIndex + 1)),
                recoveryIds(bindings, expected.get(targetIndex - 1), 1));
        jdbc.update("UPDATE ma_operation SET target_revision = ? WHERE operation_ref = ?", generation + 1, operationRef);
        assertEquals(expected, recoveryIds(bindings, null, 100));
        jdbc.update("UPDATE ma_operation SET target_revision = ?, state = 'FAILED' WHERE operation_ref = ?",
                generation, operationRef);
        assertEquals(withoutTarget, recoveryIds(bindings, null, 100));
        jdbc.update("UPDATE ma_operation SET state = 'COMPLETED' WHERE operation_ref = ?", operationRef);
        assertEquals(expected, recoveryIds(bindings, null, 100));
        jdbc.update("UPDATE ma_operation SET state = 'DRAINING', operation_kind = 'WORKSPACE_RETIREMENT'"
                + " WHERE operation_ref = ?", operationRef);
        assertEquals(expected, recoveryIds(bindings, null, 100));
        jdbc.update("UPDATE ma_runtime_binding SET binding_state = 'RELEASED' WHERE binding_id = ?",
                target.getBytes(StandardCharsets.UTF_8));
        assertEquals(withoutTarget, recoveryIds(bindings, null, 100));
        jdbc.update("UPDATE ma_runtime_binding SET binding_state = 'DRAINING' WHERE binding_id = ?",
                target.getBytes(StandardCharsets.UTF_8));
        assertEquals(expected, recoveryIds(bindings, null, 100));
    }

    private static void addRecoveryRow(PreparedStatement insert, String seed, String id, long generation,
            String state, Integer handleVersion) throws SQLException {
        insert.setBytes(1, id.getBytes(StandardCharsets.UTF_8));
        insert.setLong(2, generation);
        insert.setString(3, state);
        insert.setObject(4, handleVersion, java.sql.Types.INTEGER);
        insert.setObject(5, handleVersion, java.sql.Types.INTEGER);
        insert.setBytes(6, seed.getBytes(StandardCharsets.UTF_8));
        insert.addBatch();
    }

    private static List<String> recoveryIds(RuntimeBindingRepository bindings, String cursor, int limit) {
        return bindings.findRecoveryCandidates("local-process", cursor, limit).stream()
                .map(RuntimeBindingRecord::getBindingId).toList();
    }

    public static void verifyBatches(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
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
    void managedGenerationWithoutCleanupCallbackStaysPinned() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:missing-cleanup-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var fixture = new Fixture(bindings, sessions, executions, "missing-cleanup");
        var lost = fixture.lose();
        bindings.releaseOperation(lost.getBindingId(), "fixture", lost.getOperationGeneration());
        RuntimeProvisioner withoutCleanup = new RuntimeProvisioner() {
            @Override
            public String kind() { return "local-process"; }
            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                throw new AssertionError("Maintenance cannot provision");
            }
            @Override
            public boolean supportsStartupRecovery(RuntimeResourceHandle handle) { return true; }
        };
        try (var service = service(bindings, sessions, executions, withoutCleanup, Duration.ofSeconds(5))) {
            var error = assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> service.recoverBinding(lost.getBindingId(), lost.getGeneration())
                            .toCompletableFuture().get(5, TimeUnit.SECONDS));
            assertEquals("runtime_broker_recovery_blocked",
                    assertInstanceOf(RuntimeBrokerException.class, error.getCause()).getCode());
            assertEquals(RuntimeBindingRecord.State.LOST, bindings.findById(lost.getBindingId()).getState());
            assertEquals(1, sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration()));
        }
    }

    public static RuntimeProvisioner provisioner(java.util.function.Function<RuntimeBindingRecord, CompletionStage<Void>> cleanup) {
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

    public static final class Fixture {
        public final RuntimeBindingRepository bindings;
        public final RuntimeSessionRepository sessions;
        public final ToolExecutionRepository executions;
        public final String id;
        public final RuntimeBindingRecord binding;
        public final RuntimeSessionRecord session;

        public Fixture(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
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

        public void prepare(String call) {
            bindings.admitExecution(sessions, executions, ToolExecutionRecord.prepared(id + "-" + call,
                    id + "-" + call, binding.getBindingId(), binding.getGeneration(), id, session.getRuntimeSessionId(),
                    "turn", call, "digest", Map.of("sessionId", session.getRuntimeSessionId(),
                            "promptId", "turn", "callId", call, "argsDigest", "digest")));
        }

        public RuntimeBindingRecord lose() {
            return bindings.compareAndSet(binding, binding.withRecoveryEvidence(
                    RuntimeRecoveryContract.evidence(binding, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    RuntimeRecoveryContract.evidence(binding, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED), Instant.now()));
        }
    }
}
