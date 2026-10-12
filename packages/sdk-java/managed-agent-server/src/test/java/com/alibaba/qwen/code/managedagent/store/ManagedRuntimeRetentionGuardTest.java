package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
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
        var retired = retire(bindings, request("child"));
        var receipt = retired.getDrainReceipt();
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

    @Test
    void unsettledBackgroundShellRetainsBothIsolationModesUntilSettlement() throws Exception {
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]));
        var executions = new JdbcToolExecutionRepository(source);
        var sessions = new JdbcRuntimeSessionRepository(source);
        var retention = new JdbcRuntimeRetention(source, bindings, guard);
        for (String isolation : java.util.List.of("session", "workspace")) {
            String harness = "root-" + isolation;
            String runtime = "runtime-" + isolation;
            var retired = retire(bindings, request(isolation.equals("session") ? harness : null));
            jdbc.update("INSERT INTO managed_agent_session (tenant_id, session_id, agent_id, status, created_at, updated_at)"
                    + " VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 1, 1)", harness);
            projection("tenant", harness, "background_shell");
            var old = Instant.parse("2000-01-01T00:00:00Z");
            var session = sessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession(harness, runtime, "bootstrap",
                    retired.getRequest().getScope()), retired.getBindingId(), retired.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, old));
            assertThat(sessions.compareAndSet(session, session.withState(RuntimeSessionRecord.State.RELEASED, old)))
                    .isNotNull();
            for (String call : java.util.List.of(isolation + "-call", isolation + "-call:process")) {
                var prepared = executions.findOrCreate(ToolExecutionRecord.prepared(call, call + "-key",
                        retired.getBindingId(), retired.getGeneration(), harness, runtime, "turn", "call", "digest",
                        Map.of("sessionId", runtime, "promptId", "turn", "callId", "call", "argsDigest", "digest")));
                assertThat(executions.settlePrepared(prepared, Map.of("executionStatus", "success"), old)).isNotNull();
            }
            var protectedBatch = retention.sweep(Duration.ofDays(30), 100, null);
            assertThat(protectedBatch.executionsDeleted() + protectedBatch.sessionsDeleted()
                    + protectedBatch.bindingsDeleted()).isZero();
            assertThat(executions.findByExecutionCallId(isolation + "-call:process")).isNotNull();
            assertThat(sessions.findById(retired.getRequest().getScope(), runtime)).isNotNull();
            assertThat(bindings.findById(retired.getBindingId())).isNotNull();
            var replacement = bindings.findOrCreate(retired.getRequest());
            assertThat(replacement.getGeneration()).isEqualTo(retired.getGeneration() + 1);
            jdbc.update("UPDATE qwen_managed_session_extension_record SET task_state = 'failed', settled_at = 2"
                    + " WHERE session_id = ?", harness);
            var collected = retention.sweep(Duration.ofDays(30), 100, null);
            assertThat(collected.executionsDeleted()).isEqualTo(2);
            assertThat(collected.sessionsDeleted()).isEqualTo(1);
            assertThat(collected.bindingsDeleted()).isEqualTo(1);
            assertThat(bindings.findById(retired.getBindingId())).isNull();
            assertThat(executions.findByExecutionCallId(isolation + "-call:process")).isNull();
            assertThat(bindings.findById(replacement.getBindingId())).isNotNull();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_extension_record"
                    + " WHERE session_id = ?", Integer.class, harness)).isEqualTo(1);
        }
    }

    @Test
    void backgroundEvidenceRequiresExactIdentityGenerationKindAndProcessSuffix() throws Exception {
        backgroundEvidence();
        try (var connection = source.getConnection()) {
            var binding = binding("binding", 4);
            assertThat(guard.bindingReferenced(connection, binding)).isTrue();
            assertThat(guard.bindingReferenced(connection, binding("binding", 5))).isFalse();
            for (String column : java.util.List.of("tenant_id", "workspace_id", "session_id", "domain", "task_kind")) {
                jdbc.update("UPDATE qwen_managed_session_extension_record SET " + column + " = CONCAT(" + column + ", ' ')");
                assertThat(guard.bindingReferenced(connection, binding)).as(column).isFalse();
                jdbc.update("UPDATE qwen_managed_session_extension_record SET " + column + " = TRIM(" + column + ")");
            }
            jdbc.update("UPDATE qwen_tool_execution SET binding_id = 'binding '");
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            jdbc.update("UPDATE qwen_tool_execution SET binding_id = 'binding', execution_call_id = 'call:PROCESS'");
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            jdbc.update("UPDATE qwen_tool_execution SET execution_call_id = 'call'");
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            jdbc.update("UPDATE qwen_tool_execution SET execution_call_id = 'call:process'");
            assertThat(guard.bindingReferenced(connection, binding)).isTrue();
        }
    }

    @Test
    void backgroundSettlementIsReadOnTheSweepConnection() throws Exception {
        backgroundEvidence();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            try (var update = connection.prepareStatement("UPDATE qwen_managed_session_extension_record SET settled_at = 2")) {
                update.executeUpdate();
            }
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
            connection.rollback();
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isTrue();
        }
    }

    @Test
    void settledBackgroundVolumeWithOtherSessionNoiseDoesNotTimeoutTheGuard() throws Exception {
        backgroundEvidence();
        jdbc.update("UPDATE qwen_managed_session_extension_record SET task_state = 'succeeded', settled_at = 2");
        var executions = new JdbcToolExecutionRepository(source);
        assertThat(executions.settlePrepared(executions.findByExecutionCallId("call:process"),
                Map.of("executionStatus", "success"), Instant.parse("2000-01-01T00:00:00Z"))).isNotNull();
        duplicateBackgroundRows("qwen_tool_execution", "execution_call_id", "call:process", 2999, false);
        duplicateBackgroundRows("qwen_managed_session_extension_record", "record_id", "run", 2999, false);
        duplicateBackgroundRows("qwen_managed_session_extension_record", "record_id", "run", 20_000, true);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution", Long.class)).isEqualTo(3000L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE execution_state = 'SETTLED'",
                Long.class)).isEqualTo(3000L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_extension_record", Long.class)).isEqualTo(23_000L);
        try (var connection = source.getConnection()) {
            jdbc.execute(connection.getMetaData().getDatabaseProductName().equals("H2") ? "ANALYZE"
                    : "ANALYZE TABLE qwen_tool_execution, qwen_managed_session_extension_record");
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
        }
    }

    @Test
    void backgroundOwnersRemainDistinctUnderPermissiveCollation() throws Exception {
        backgroundEvidence();
        projection("tenant", "HARNESS", "background_shell");
        new JdbcToolExecutionRepository(source).findOrCreate(ToolExecutionRecord.prepared("upper:process", "upper-key",
                "binding", 4, "HARNESS", "runtime", "turn", "call", "digest",
                Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", "digest")));
        try (var connection = source.getConnection()) {
            String ddl = connection.getMetaData().getDatabaseProductName().equals("H2")
                    ? "ALTER TABLE %s ALTER COLUMN %s VARCHAR_IGNORECASE(512)"
                    : "ALTER TABLE %s MODIFY %s VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL";
            jdbc.execute(String.format(ddl, "qwen_tool_execution", "harness_session_id"));
            jdbc.execute(String.format(ddl, "qwen_managed_session_extension_record", "session_id"));
            var folded = jdbc.queryForList("SELECT DISTINCT harness_session_id FROM qwen_tool_execution", String.class);
            assertThat(folded).hasSize(1);
            String unsettled = folded.getFirst().equals("harness") ? "HARNESS" : "harness";
            jdbc.update("UPDATE qwen_managed_session_extension_record SET task_state = 'succeeded', settled_at = 2");
            jdbc.update("UPDATE qwen_managed_session_extension_record SET task_state = 'pending', settled_at = NULL"
                    + " WHERE session_scope_key = ?", ManagedSessionStore.sessionScopeKey("tenant", unsettled));
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isTrue();
            jdbc.update("UPDATE qwen_managed_session_extension_record SET task_state = 'succeeded', settled_at = 2");
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
        }
    }

    private void duplicateBackgroundRows(String table, String key, String value, int count, boolean noise)
            throws Exception {
        try (var connection = source.getConnection();
                var select = connection.prepareStatement("SELECT * FROM " + table + " WHERE " + key + " = ? LIMIT 1")) {
            select.setString(1, value);
            try (var rows = select.executeQuery()) {
                assertThat(rows.next()).isTrue();
                var columns = new ArrayList<String>();
                var seed = new ArrayList<Object>();
                for (int index = 1; index <= rows.getMetaData().getColumnCount(); index++) {
                    columns.add(rows.getMetaData().getColumnName(index));
                    seed.add(rows.getObject(index));
                }
                String sql = "INSERT INTO " + table + " (" + String.join(",", columns) + ") VALUES ("
                        + String.join(",", Collections.nCopies(columns.size(), "?")) + ")";
                try (var insert = connection.prepareStatement(sql)) {
                    for (int index = 0; index < count; index++) {
                        String id = (noise ? "noise-" : "volume-") + index;
                        var row = new ArrayList<>(seed);
                        if (table.equals("qwen_tool_execution")) {
                            String call = id + ":process";
                            row.set(columns.indexOf("execution_call_id"), call);
                            row.set(columns.indexOf("execution_call_id_hash"), brokerHash(call));
                            row.set(columns.indexOf("idempotency_key"), id);
                            row.set(columns.indexOf("idempotency_key_hash"), brokerHash(id));
                        } else {
                            String owner = noise ? "noise-owner-" + index / 20 : "harness";
                            row.set(columns.indexOf("session_id"), owner);
                            row.set(columns.indexOf("session_scope_key"), ManagedSessionStore.sessionScopeKey("tenant", owner));
                            row.set(columns.indexOf("record_id"), id);
                            row.set(columns.indexOf("record_key"), ManagedExtensionProjection.recordKey(owner, "child_run", id));
                        }
                        for (int column = 0; column < row.size(); column++) {
                            insert.setObject(column + 1, row.get(column));
                        }
                        insert.addBatch();
                    }
                    insert.executeBatch();
                }
            }
        }
    }

    private static String brokerHash(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        return ToolPublicationContract.sha256(ByteBuffer.allocate(4 + bytes.length).putInt(bytes.length).put(bytes).array());
    }

    private void backgroundEvidence() {
        projection("tenant", "harness", "background_shell");
        new JdbcToolExecutionRepository(source).findOrCreate(ToolExecutionRecord.prepared("call:process", "key",
                "binding", 4, "harness", "runtime", "turn", "call", "digest",
                Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call", "argsDigest", "digest")));
    }

    private static RuntimeBindingRecord retire(JdbcRuntimeBindingRepository bindings, RuntimeProvisionRequest request)
            throws Exception {
        var created = bindings.findOrCreate(request);
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
        return retired;
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

    private void projection() { projection("tenant", "parent", "child_agent"); }

    private void projection(String tenant, String session, String kind) {
        jdbc.update("INSERT INTO qwen_managed_session_extension_record (session_scope_key, record_key, tenant_id,"
                + " workspace_id, session_id, domain, record_id, operation_hash, revision, record_resource_id,"
                + " task_kind, task_state, runtime_state, delivery_target, delivery_state, created_at)"
                + " VALUES (?, ?, ?, 'workspace', ?, 'child_run', 'run', ?, 1, 'resource',"
                + " ?, 'pending', 'unbound', 'session', 'planned', 1)",
                ManagedSessionStore.sessionScopeKey(tenant, session),
                ManagedExtensionProjection.recordKey(session, "child_run", "run"), tenant, session, "a".repeat(64), kind);
    }
}
