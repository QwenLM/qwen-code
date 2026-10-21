package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ResidentWorkspaceAdmissionTest {
    private static final RuntimeProvisionRequest REQUEST = new RuntimeProvisionRequest(
            new RuntimeScope("tenant", "workspace", "1", "/workspace",
                    ResidentWorkspaceProfile.CAPABILITY_DIGEST, "workspace"),
            null, "kubernetes-workspace", "storage");

    @Test
    void placementRequiresTheCurrentActiveWorkspaceBeforeCreatingOrReusingASlot() throws Exception {
        var fixture = new Fixture();
        assertClosed(fixture.bindings);
        fixture.workspace("ACTIVE", 1, "storage");
        var original = fixture.bindings.findOrCreate(REQUEST);
        assertEquals(original.getBindingId(), fixture.bindings.findOrCreate(REQUEST).getBindingId());

        fixture.workspace("DRAINING", 1, "storage");
        assertClosed(fixture.bindings);
        fixture.workspace("REMOVED", 1, "storage");
        assertClosed(fixture.bindings);
        fixture.workspace("ACTIVE", 2, "storage");
        assertClosed(fixture.bindings);
        fixture.workspace("ACTIVE", 1, "other-storage");
        assertClosed(fixture.bindings);

        try (var connection = fixture.source.getConnection(); var statement = connection.prepareStatement(
                "SELECT active_binding_id, last_generation FROM ma_runtime_slot WHERE request_key = ?")) {
            statement.setString(1, REQUEST.requestKey());
            try (var row = statement.executeQuery()) {
                assertTrue(row.next());
                assertEquals(original.getBindingId(), row.getString("active_binding_id"));
                assertEquals(1, row.getLong("last_generation"));
            }
        }
    }

    @Test
    void aSealedResidentCannotBeReusedOrClaimedAfterRestart() throws Exception {
        var fixture = new Fixture();
        var original = fixture.ready();
        RuntimeBindingRecord sealed;
        try (var connection = fixture.source.getConnection()) {
            connection.setAutoCommit(false);
            sealed = fixture.bindings.sealForRetirement(connection, original);
            connection.commit();
        }
        assertClosed(fixture.bindings);
        assertNull(fixture.bindings.claimOperation(original.getBindingId(), "broker", Duration.ofMinutes(1)));
        var restarted = new JdbcRuntimeBindingRepository(fixture.source,
                new AesGcmSecretProtector("test", new byte[32]));
        assertClosed(restarted);
        assertNull(restarted.claimOperation(original.getBindingId(), "restarted", Duration.ofMinutes(1)));
        assertEquals(sealed.getVersion(), restarted.findById(original.getBindingId()).getVersion());
        assertNull(fixture.bindings.compareAndSet(original,
                original.withLastHealthAt(Instant.now(), Instant.now())));
    }

    @Test
    @Timeout(10)
    void aClaimWaitingForPlacementObservesTheCommittedRetirementFence() throws Exception {
        var fixture = new Fixture();
        var original = fixture.ready();
        try (var executor = Executors.newSingleThreadExecutor(); var connection = fixture.source.getConnection()) {
            connection.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(connection, "tenant");
            var started = new CountDownLatch(1);
            var claiming = executor.submit(() -> {
                started.countDown();
                return fixture.bindings.claimOperation(original.getBindingId(), "setup", Duration.ofMinutes(1));
            });
            assertTrue(started.await(1, TimeUnit.SECONDS));
            assertThrows(TimeoutException.class, () -> claiming.get(100, TimeUnit.MILLISECONDS));
            var sealed = fixture.bindings.sealForRetirement(connection, original);
            connection.commit();
            assertNull(claiming.get(2, TimeUnit.SECONDS));
            assertEquals(sealed.getVersion(), fixture.bindings.findById(original.getBindingId()).getVersion());
        }
    }

    private static void assertClosed(JdbcRuntimeBindingRepository bindings) {
        var refusal = assertThrows(RuntimeBrokerException.class, () -> bindings.findOrCreate(REQUEST));
        assertEquals("runtime_admission_closed", refusal.getCode());
    }

    private static final class Fixture {
        private final JdbcDataSource source = new JdbcDataSource();
        private final JdbcRuntimeBindingRepository bindings;

        private Fixture() {
            source.setURL("jdbc:h2:mem:resident-admission-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        }

        private void workspace(String state, long generation, String storage) throws Exception {
            try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                    "MERGE INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref, state) KEY (tenant_id, workspace_id)"
                            + " VALUES (?, ?, ?, ?, 'Workspace', ?, ?, ?)")) {
                JdbcRepositorySupport.setIdentity(statement, 1, "tenant");
                JdbcRepositorySupport.setIdentity(statement, 2, "workspace");
                statement.setLong(3, generation);
                JdbcRepositorySupport.setIdentity(statement, 4, storage);
                JdbcRepositorySupport.setIdentity(statement, 5, WorkspaceExecutionProfile.CONFIG_REF);
                JdbcRepositorySupport.setIdentity(statement, 6, WorkspaceExecutionProfile.POLICY_REF);
                statement.setString(7, state);
                statement.executeUpdate();
            }
        }

        private RuntimeBindingRecord ready() throws Exception {
            workspace("ACTIVE", 1, "storage");
            var initial = bindings.findOrCreate(REQUEST);
            var claimed = bindings.claimOperation(initial.getBindingId(), "setup", Duration.ofMinutes(1));
            var seed = claimed.getProvisionSeed();
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            return bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                    new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("pod", "original")),
                    Instant.now(), Instant.now()));
        }
    }
}
