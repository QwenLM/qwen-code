package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class ManagedRuntimeRetentionGuardTest {
    private DataSource source;
    private JdbcTemplate jdbc;
    private final ManagedRuntimeRetentionGuard guard = new ManagedRuntimeRetentionGuard();

    @BeforeEach
    void setup() {
        source = dataSource();
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
    }

    DataSource dataSource() {
        var dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:runtime-retention-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return dataSource;
    }

    @Test
    void unsettledChildRetainsDrainedBindingUntilCanonicalRunSettles() throws Exception {
        child();
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]));
        var created = bindings.findOrCreate(request("child"));
        var claim = bindings.claimOperation(created.getBindingId(), "fixture", Duration.ofSeconds(2));
        var seed = claim.getProvisionSeed();
        var ready = bindings.compareAndSet(claim, claim.withAttestation(new RuntimeLease(seed.getProvisionalRuntimeId(),
                URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()),
                new RuntimeResourceHandle("local-process", 1, Map.of("worker", "fixture")), Instant.now(), Instant.now()));
        var draining = bindings.compareAndSet(ready, ready.withDrainRequested(true, Instant.now()));
        var receipt = new RuntimeDrainReceipt(draining.getBindingId(), draining.getGeneration(),
                seed.getProvisionRequestId(), draining.getResourceHandle(), Instant.now());
        var retired = bindings.compareAndSet(draining, draining.withDrainReceipt(receipt)
                .withState(RuntimeBindingRecord.State.RELEASED, draining.getLease(), Instant.parse("2000-01-01T00:00:00Z")));
        assertThat(retired).isNotNull();
        await().atMost(Duration.ofSeconds(5)).until(() -> !retired.getOperationLeaseUntil().isAfter(Instant.now()));
        jdbc.update("INSERT INTO qwen_managed_child_result_relay (tenant_id, parent_session_id, child_run_id,"
                + " creation_key, child_session_id, state, created_at, updated_at)"
                + " VALUES ('tenant', 'parent', 'run', 'creation', 'child', 'orphaned', 1, 1)");
        var retention = new JdbcRuntimeRetention(source, bindings, guard);
        assertThat(retention.sweep(Duration.ofDays(30), 1, null).bindingsDeleted()).isZero();
        assertThat(bindings.findById(retired.getBindingId()).getDrainReceipt()).isEqualTo(receipt);
        projection();
        assertThat(retention.sweep(Duration.ofDays(30), 1, null).bindingsDeleted()).isZero();
        assertThat(bindings.findById(retired.getBindingId()).getGeneration()).isEqualTo(retired.getGeneration());
        jdbc.update("UPDATE qwen_managed_session_extension_record SET task_state = 'cancelled', settled_at = 2");
        assertThat(retention.sweep(Duration.ofDays(30), 1, null).bindingsDeleted()).isEqualTo(1);
        assertThat(bindings.findById(retired.getBindingId())).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_child_result_relay", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_extension_record", Integer.class)).isEqualTo(1);
    }

    @Test
    void aDifferentRawIdentityCannotEndChildProtection() throws Exception {
        child();
        projection();
        jdbc.update("UPDATE qwen_managed_session_extension_record SET task_state = 'cancelled', settled_at = 2");
        var binding = mock(RuntimeBindingRecord.class);
        when(binding.getRequest()).thenReturn(request("child"));
        try (var connection = source.getConnection()) {
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            for (String column : java.util.List.of("tenant_id", "session_id", "domain", "record_id")) {
                jdbc.update("UPDATE qwen_managed_session_extension_record SET " + column + " = UPPER(" + column + ")");
                assertThat(guard.bindingReferenced(connection, binding)).as(column).isTrue();
                jdbc.update("UPDATE qwen_managed_session_extension_record SET " + column + " = LOWER(" + column + ")");
            }
        }
    }

    @Test
    void childLineageIsReadOnTheSweepConnection() throws Exception {
        var binding = mock(RuntimeBindingRecord.class);
        when(binding.getRequest()).thenReturn(request("child"));
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            try (var insert = connection.prepareStatement(childSql())) {
                insert.executeUpdate();
            }
            assertThat(guard.bindingReferenced(connection, binding)).isTrue();
            connection.rollback();
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
        }
    }

    @Test
    void aCsiReservationWithNoHolderStillRetainsItsExactBinding() throws Exception {
        jdbc.update("INSERT INTO managed_workspace_execution_lease"
                + " (storage_key, storage_kind, binding_id, runtime_generation) VALUES (?, 'CSI', 'binding', 4)",
                "a".repeat(64));
        try (var connection = source.getConnection()) {
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isTrue();
            assertThat(guard.bindingReferenced(connection, binding("binding", 5))).isFalse();
            assertThat(guard.bindingReferenced(connection, binding("other", 4))).isFalse();
        }
    }

    @Test
    void localHolderAndCsiRetirementRetainBindings() throws Exception {
        jdbc.update("INSERT INTO managed_workspace_execution_lease"
                + " (storage_key, holder_key, binding_id, runtime_generation, runtime_session_id)"
                + " VALUES (?, ?, 'local', 1, 'session')", "a".repeat(64), "b".repeat(64));
        jdbc.update("INSERT INTO managed_workspace_csi_retirement"
                + " (retirement_id, binding_id, runtime_generation, physical_key, phase, identity_json)"
                + " VALUES (?, 'csi', 2, ?, 'DRAINING', '{}')", UUID.randomUUID().toString(), "c".repeat(64));
        try (var connection = source.getConnection()) {
            assertThat(guard.bindingReferenced(connection, binding("local", 1))).isTrue();
            assertThat(guard.bindingReferenced(connection, binding("csi", 2))).isTrue();
            assertThat(guard.bindingReferenced(connection, binding("absent", 1))).isFalse();
        }
    }

    @Test
    void collectedPublicationUsesRawHashWithoutReadingItsPayload() throws Exception {
        String call = "execution-雪";
        byte[] bytes = call.getBytes(StandardCharsets.UTF_8);
        String brokerHash = ToolPublicationContract.sha256(ByteBuffer.allocate(4 + bytes.length)
                .putInt(bytes.length).put(bytes).array());
        String rawHash = ToolPublicationContract.sha256(bytes);
        assertThat(brokerHash).isNotEqualTo(rawHash);
        publication(brokerHash);
        try (var connection = source.getConnection()) {
            assertThat(guard.executionReferenced(connection, call)).isFalse();
            jdbc.update("UPDATE qwen_tool_publication SET execution_key = ?, retention_state = 'COLLECTED'", rawHash);
            assertThat(guard.executionReferenced(connection, call)).isTrue();
            assertThat(guard.executionReferenced(connection, "other")).isFalse();
        }
    }

    @Test
    void acknowledgementUsesRawHashAndSeesTheCallersUncommittedReference() throws Exception {
        try (Connection connection = source.getConnection()) {
            connection.setAutoCommit(false);
            String hash = ToolPublicationContract.sha256("call".getBytes(StandardCharsets.UTF_8));
            try (var insert = connection.prepareStatement("INSERT INTO managed_workspace_csi_worker_ack"
                    + " (retirement_id, execution_call_id_hash, execution_call_id, evidence_json,"
                    + " evidence_digest, recorded_at_epoch_micros) VALUES (?, ?, 'call', '{}', ?, 1)")) {
                insert.setString(1, UUID.randomUUID().toString());
                insert.setString(2, hash);
                insert.setString(3, "a".repeat(64));
                insert.executeUpdate();
            }
            assertThat(guard.executionReferenced(connection, "call")).isTrue();
            connection.rollback();
            assertThat(guard.executionReferenced(connection, "call")).isFalse();
        }
    }

    private void publication(String key) {
        jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id,"
                + " session_id, publication_id, execution_key, capture_id, binding_json, binding_digest,"
                + " token_hash, state, capture_bytes, producer_bytes, admission_bytes)"
                + " VALUES (?, ?, 'tenant', 'workspace', 'session', 'publication', ?, 'capture',"
                + " 'payload-is-not-parsed', ?, ?, 'FENCED', 0, 0, 0)",
                "a".repeat(64), "b".repeat(64), key, "c".repeat(64), "d".repeat(64));
    }

    private static RuntimeBindingRecord binding(String id, long generation) {
        var binding = mock(RuntimeBindingRecord.class);
        when(binding.getBindingId()).thenReturn(id);
        when(binding.getGeneration()).thenReturn(generation);
        when(binding.getRequest()).thenReturn(request(null));
        return binding;
    }

    private static RuntimeProvisionRequest request(String isolationKey) {
        return new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                "sha256:" + "a".repeat(64), isolationKey == null ? "workspace" : "session"),
                isolationKey, "local-process", "storage");
    }

    private static String childSql() {
        return "INSERT INTO managed_agent_session (tenant_id, session_id, agent_id, status, created_at, updated_at,"
                + " parent_session_id, parent_child_run_id, root_session_id, child_depth)"
                + " VALUES ('tenant', 'child', 'qwen-code', 'CLOSED', 1, 1, 'parent', 'run', 'parent', 1)";
    }

    private void child() { jdbc.update(childSql()); }

    private void projection() {
        jdbc.update("INSERT INTO qwen_managed_session_extension_record (session_scope_key, record_key, tenant_id,"
                + " workspace_id, session_id, domain, record_id, operation_hash, revision, record_resource_id,"
                + " task_kind, task_state, runtime_state, delivery_target, delivery_state, created_at)"
                + " VALUES (?, ?, 'tenant', 'workspace', 'parent', 'child_run', 'run', ?, 1, 'resource',"
                + " 'child_agent', 'pending', 'unbound', 'session', 'planned', 1)",
                ManagedSessionStore.sessionScopeKey("tenant", "parent"),
                ManagedExtensionProjection.recordKey("parent", "child_run", "run"), "a".repeat(64));
    }
}
