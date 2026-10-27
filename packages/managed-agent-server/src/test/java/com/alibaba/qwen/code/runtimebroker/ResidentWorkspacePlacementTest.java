package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ResidentWorkspacePlacementTest {
    private static final List<RuntimeBindingRecord.State> RETAINED = List.of(
            RuntimeBindingRecord.State.DRAINING, RuntimeBindingRecord.State.LOST,
            RuntimeBindingRecord.State.RECOVERY_BLOCKED, RuntimeBindingRecord.State.OPERATOR_RECOVERY,
            RuntimeBindingRecord.State.FAILED);

    @Test
    void independentResidentMountPathsDoNotAliasInMemory() {
        for (var state : RETAINED) {
            var bindings = new InMemoryRuntimeBindingRepository();
            verify(bindings, "tenant", state);
        }
    }

    @Test
    void independentResidentMountPathsDoNotAliasInJdbcAfterRestart() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:resident-placement-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        verify(source);
    }

    static void verify(DataSource source) throws Exception {
        ManagedSchema.initialize(source);
        for (var state : RETAINED) {
            String tenant = "resident-placement-" + UUID.randomUUID();
            workspace(source, tenant, "original", "storage-original");
            workspace(source, tenant, "independent", "storage-independent");
            workspace(source, tenant, "same-storage", "storage-original");
            var bindings = repository(source);
            var original = retain(bindings, request(tenant, "original", "storage-original", true), state);
            var restarted = repository(source);
            var independent = restarted.findOrCreate(request(tenant, "independent", "storage-independent", true));
            assertNotEquals(original.getBindingId(), independent.getBindingId());
            assertEquals(1, independent.getGeneration());
            assertEquals(state, restarted.findById(original.getBindingId()).getState());
            assertFenced(restarted, request(tenant, "same-storage", "storage-original", true));
            assertFenced(restarted, request(tenant, "local", "storage-local", false));
        }
        String tenant = "local-placement-" + UUID.randomUUID();
        workspace(source, tenant, "resident", "storage-resident");
        var bindings = repository(source);
        retain(bindings, request(tenant, "local", "storage-local", false), RuntimeBindingRecord.State.DRAINING);
        assertFenced(repository(source), request(tenant, "resident", "storage-resident", true));
    }

    private static void verify(RuntimeBindingRepository bindings, String tenant, RuntimeBindingRecord.State state) {
        var original = retain(bindings, request(tenant, "original", "storage-original", true), state);
        var independent = request(tenant, "independent", "storage-independent", true);
        assertFalse(original.blocksPlacement(independent));
        assertTrue(original.blocksPlacement(request(tenant, "same-storage", "storage-original", true)));
        assertTrue(original.blocksPlacement(request(tenant, "original", "storage-independent", true)));
        assertTrue(original.blocksPlacement(request(tenant, "local", "storage-local", false)));
        assertFalse(original.blocksPlacement(request("other-tenant", "independent", "storage-independent", true)));
        assertNotEquals(original.getBindingId(), bindings.findOrCreate(independent).getBindingId());
        assertFenced(bindings, request(tenant, "same-storage", "storage-original", true));
        assertFenced(bindings, request(tenant, "local", "storage-local", false));
    }

    private static RuntimeBindingRecord retain(RuntimeBindingRepository bindings, RuntimeProvisionRequest request,
            RuntimeBindingRecord.State state) {
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "setup", Duration.ofMinutes(1));
        return bindings.compareAndSet(claimed, claimed.withState(state, null, Instant.now()));
    }

    private static RuntimeProvisionRequest request(String tenant, String workspace, String storage, boolean resident) {
        return new RuntimeProvisionRequest(new RuntimeScope(tenant, workspace, "1", "/workspace",
                resident ? ResidentWorkspaceProfile.CAPABILITY_DIGEST : WorkspaceExecutionProfile.CAPABILITY_DIGEST,
                resident ? "workspace" : "session"), resident ? null : "harness",
                resident ? "kubernetes-workspace" : "local-process", storage);
    }

    private static void assertFenced(RuntimeBindingRepository bindings, RuntimeProvisionRequest request) {
        var refusal = assertThrows(RuntimeBrokerException.class, () -> bindings.findOrCreate(request));
        assertEquals("runtime_placement_recovery_required", refusal.getCode());
    }

    private static JdbcRuntimeBindingRepository repository(DataSource source) {
        return new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("placement", new byte[32]));
    }

    private static void workspace(DataSource source, String tenant, String workspace, String storage) throws Exception {
        try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state) VALUES (?, ?, 1, ?, 'Workspace', ?, ?, 'ACTIVE')")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenant);
            JdbcRepositorySupport.setIdentity(statement, 2, workspace);
            JdbcRepositorySupport.setIdentity(statement, 3, storage);
            JdbcRepositorySupport.setIdentity(statement, 4, WorkspaceExecutionProfile.CONFIG_REF);
            JdbcRepositorySupport.setIdentity(statement, 5, WorkspaceExecutionProfile.POLICY_REF);
            statement.executeUpdate();
        }
    }
}
