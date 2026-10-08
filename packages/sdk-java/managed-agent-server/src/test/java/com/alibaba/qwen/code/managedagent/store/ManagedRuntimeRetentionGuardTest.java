package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class ManagedRuntimeRetentionGuardTest {
    private JdbcDataSource source;
    private JdbcTemplate jdbc;
    private final ManagedRuntimeRetentionGuard guard = new ManagedRuntimeRetentionGuard();

    @BeforeEach
    void setup() {
        source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:runtime-retention-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
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
        return binding;
    }
}
