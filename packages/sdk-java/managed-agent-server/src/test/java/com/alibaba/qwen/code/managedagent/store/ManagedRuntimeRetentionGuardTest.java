package com.alibaba.qwen.code.managedagent.store;

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
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

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

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedRuntimeRetentionGuardTest {
    private DataSource source;
    private JdbcTemplate jdbc;
    private final ManagedRuntimeRetentionGuard guard = new ManagedRuntimeRetentionGuard();

    @BeforeEach
    void setup() {
        source = dataSource();
        Flyway.configure()
                .dataSource(source)
                .locations("classpath:db/managed-schema")
                .load()
                .migrate();
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
        var bindings =
                new JdbcRuntimeBindingRepository(
                        source, new AesGcmSecretProtector("key", new byte[32]));
        var retired = retire(bindings, request("child"));
        var receipt = retired.getDrainReceipt();
        jdbc.update(
                "INSERT INTO ma_delivery (delivery_key, delivery_kind, tenant_id, delivery_id, source_session_id, source_scope_key, payload_json, transport_state, reception_state, consumption_state, gmt_create, gmt_modified) VALUES (?, 'CHILD_RESULT', 'tenant', 'run', 'child', ?, '{}', 'orphaned', 'orphaned', 'orphaned', 1, 1)",
                "a".repeat(64),
                "b".repeat(64));
        var retention = new JdbcRuntimeRetention(source, bindings, guard);
        assertThat(retention.sweep(Duration.ofDays(30), 1, null).bindingsDeleted()).isZero();
        assertThat(bindings.findById(retired.getBindingId()).getDrainReceipt()).isEqualTo(receipt);
        projection();
        assertThat(retention.sweep(Duration.ofDays(30), 1, null).bindingsDeleted()).isZero();
        assertThat(bindings.findById(retired.getBindingId()).getGeneration()).isEqualTo(retired.getGeneration());
        jdbc.update("UPDATE ma_session_record SET task_state = 'cancelled', settled_at = 2");
        assertThat(retention.sweep(Duration.ofDays(30), 1, null).bindingsDeleted()).isEqualTo(1);
        assertThat(bindings.findById(retired.getBindingId())).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_delivery", Integer.class))
                .isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class))
                .isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record", Integer.class))
                .isEqualTo(1);
    }

    @Test
    void retainedPrivatePinKeepsAnExistingTerminalFamilyWhileOrdinaryHistoryExpires()
            throws Exception {
        var bindings =
                new JdbcRuntimeBindingRepository(
                        source, new AesGcmSecretProtector("key", new byte[32]));
        var pinned = retire(bindings, request("pinned-history"));
        var ordinary = retire(bindings, request("ordinary-history"));
        jdbc.update(
                "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified, runtime_request_key) VALUES ('tenant', 'pinned-history', 'qwen-code', 'CLOSED', 1, 1, ?)",
                "a".repeat(64));
        var retention = new JdbcRuntimeRetention(source, bindings, guard);
        assertThat(retention.sweep(Duration.ofDays(30), 100, null).bindingsDeleted()).isEqualTo(1);
        assertThat(bindings.findById(pinned.getBindingId())).isNotNull();
        assertThat(bindings.findById(ordinary.getBindingId())).isNull();
        assertThat(jdbc.queryForObject("SELECT runtime_request_key FROM ma_session", String.class))
                .isEqualTo("a".repeat(64));
    }

    @Test
    void nativeAuthorizationEvidenceKeepsAnExistingTerminalExecution() throws Exception {
        var bindings =
                new JdbcRuntimeBindingRepository(
                        source, new AesGcmSecretProtector("key", new byte[32]));
        var retired = retire(bindings, request("grant-history"));
        new JdbcToolExecutionRepository(source)
                .findOrCreate(
                        ToolExecutionRecord.prepared(
                                "historical-call",
                                "key",
                                retired.getBindingId(),
                                retired.getGeneration(),
                                "grant-history",
                                "runtime",
                                "turn",
                                "call",
                                "digest",
                                Map.of(
                                        "sessionId",
                                        "runtime",
                                        "promptId",
                                        "turn",
                                        "callId",
                                        "call",
                                        "argsDigest",
                                        "digest")));
        // Historical evidence fixture; this does not establish actual SQL grant admission.
        jdbc.update(
                "UPDATE ma_tool_execution SET execution_state = 'SETTLED', execution_status ="
                    + " 'not_started', settled_at = 946684800000,"
                    + " native_authorization_json = ?",
                "{\"retained\":true}");
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns() + " FROM ma_tool_execution");
        var retention = new JdbcRuntimeRetention(source, bindings, guard);
        var result = retention.sweep(Duration.ofDays(30), 100, null);
        assertThat(result.executionsDeleted()).isZero();
        assertThat(result.bindingsDeleted()).isZero();
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns() + " FROM ma_tool_execution"))
                .usingRecursiveComparison()
                .isEqualTo(before);
    }

    @Test
    void aDifferentRawIdentityCannotEndChildProtection() throws Exception {
        child();
        projection();
        jdbc.update("UPDATE ma_session_record SET task_state = 'cancelled', settled_at = 2");
        var binding = mock(RuntimeBindingRecord.class);
        when(binding.getRequest()).thenReturn(request("child"));
        try (var connection = source.getConnection()) {
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            for (String column :
                    java.util.List.of("tenant_id", "session_id", "domain", "record_id")) {
                String original =
                        jdbc.queryForObject(
                                "SELECT " + column + " FROM ma_session_record",
                                (row, index) -> row.getString(1));
                jdbc.update(
                        "UPDATE ma_session_record SET " + column + " = ?",
                        original.toUpperCase(java.util.Locale.ROOT));
                assertThat(guard.bindingReferenced(connection, binding)).as(column).isTrue();
                jdbc.update("UPDATE ma_session_record SET " + column + " = ?", original);
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
        jdbc.update(
                "INSERT INTO ma_storage_owner (storage_key, storage_kind, binding_id,"
                    + " runtime_generation) VALUES (?, 'CSI', 'binding', 4)",
                "a".repeat(64));
        try (var connection = source.getConnection()) {
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isTrue();
            assertThat(guard.bindingReferenced(connection, binding("binding", 5))).isFalse();
            assertThat(guard.bindingReferenced(connection, binding("other", 4))).isFalse();
        }
    }

    @Test
    void localHolderAndCsiRetirementRetainBindings() throws Exception {
        jdbc.update("INSERT INTO ma_storage_owner"
                + " (storage_key, holder_key, binding_id, runtime_generation, runtime_session_id)"
                + " VALUES (?, ?, 'local', 1, 'session')", "a".repeat(64), "b".repeat(64));
        operation("CSI_RETIREMENT", "csi-retirement", "csi", 2);
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
            jdbc.update(
                    "UPDATE ma_output_capture SET execution_key = ?, retention_state = 'COLLECTED'",
                    rawHash);
            assertThat(guard.executionReferenced(connection, call)).isTrue();
            assertThat(guard.executionReferenced(connection, "other")).isFalse();
        }
    }

    @Test
    void acknowledgementUsesRawHashAndSeesTheCallersUncommittedReference() throws Exception {
        try (Connection connection = source.getConnection()) {
            connection.setAutoCommit(false);
            String hash = ToolPublicationContract.sha256("call".getBytes(StandardCharsets.UTF_8));
            insertOperation(connection, "CSI_RETIREMENT", "retirement", "binding", 1);
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO ma_operation_work (operation_key, work_kind, target_key, target_id, tenant_id, state, payload_json, gmt_create, gmt_modified) VALUES (?, 'CSI_WORKER_ACK', ?, 'call', 'tenant', 'COMPLETE', '{}', 1, 1)")) {
                insert.setString(1, operationKey("CSI_RETIREMENT", "retirement"));
                insert.setString(2, hash);
                insert.executeUpdate();
            }
            assertThat(guard.executionReferenced(connection, "call")).isTrue();
            connection.rollback();
            assertThat(guard.executionReferenced(connection, "call")).isFalse();
        }
    }

    @Test
    void sharedWorkReferencesRequireTheCsiOperationAndAckKinds() throws Exception {
        operation("CSI_RETIREMENT", "retirement", "binding", 4);
        String hash = ToolPublicationContract.sha256("call".getBytes(StandardCharsets.UTF_8));
        jdbc.update(
                "INSERT INTO ma_operation_work (operation_key, work_kind, target_key, target_id, tenant_id, state, payload_json, gmt_create, gmt_modified) VALUES (?, 'EXECUTION_ACK', ?, 'call', 'tenant', 'COMPLETE', '{}', 1, 1)",
                operationKey("CSI_RETIREMENT", "retirement"),
                hash);
        try (var connection = source.getConnection()) {
            assertThat(guard.executionReferenced(connection, "call")).isFalse();
            jdbc.update("UPDATE ma_operation_work SET work_kind = 'CSI_WORKER_ACK'");
            assertThat(guard.executionReferenced(connection, "call")).isTrue();
            jdbc.update("UPDATE ma_operation SET operation_kind = 'WORKSPACE_OPERATOR_RECOVERY'");
            assertThat(guard.executionReferenced(connection, "call")).isFalse();
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
            jdbc.update(
                    "UPDATE ma_operation SET operation_kind = 'CSI_RETIREMENT', target_revision ="
                        + " 5");
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
            assertThat(guard.bindingReferenced(connection, binding("binding", 5))).isTrue();
        }
    }

    @Test
    void anActionVariantCannotBeMistakenForAnUnsettledBackgroundRun() throws Exception {
        backgroundEvidence();
        try (var connection = source.getConnection()) {
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isTrue();
            jdbc.update("UPDATE ma_session_record SET record_kind = 'ACTION', action_id = 'action',"
                    + " action_version = 1, options_json = '{}'");
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
            jdbc.update("UPDATE ma_session_record SET record_kind = 'DOMAIN'");
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isTrue();
        }
    }

    @Test
    void unsettledBackgroundShellRetainsBothIsolationModesUntilSettlement() throws Exception {
        var bindings =
                new JdbcRuntimeBindingRepository(
                        source, new AesGcmSecretProtector("key", new byte[32]));
        var executions = new JdbcToolExecutionRepository(source);
        var sessions = new JdbcRuntimeSessionRepository(source);
        var retention = new JdbcRuntimeRetention(source, bindings, guard);
        for (String isolation : java.util.List.of("session", "workspace")) {
            String harness = "root-" + isolation;
            String runtime = "runtime-" + isolation;
            var retired = retire(bindings, request(isolation.equals("session") ? harness : null));
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified) VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 1, 1)",
                    harness);
            projection("tenant", harness, "background_shell");
            var old = Instant.parse("2000-01-01T00:00:00Z");
            var session =
                    sessions.findOrCreate(
                            new RuntimeSessionRecord(
                                    new RuntimeSession(
                                            harness,
                                            runtime,
                                            "bootstrap",
                                            retired.getRequest().getScope()),
                                    retired.getBindingId(),
                                    retired.getGeneration(),
                                    RuntimeSessionRecord.State.ACQUIRING,
                                    0,
                                    old));
            assertThat(sessions.compareAndSet(session, session.withState(RuntimeSessionRecord.State.RELEASED, old)))
                    .isNotNull();
            for (String call :
                    java.util.List.of(isolation + "-call", isolation + "-call:process")) {
                var prepared =
                        executions.findOrCreate(
                                ToolExecutionRecord.prepared(
                                        call,
                                        call + "-key",
                                        retired.getBindingId(),
                                        retired.getGeneration(),
                                        harness,
                                        runtime,
                                        "turn",
                                        "call",
                                        "digest",
                                        Map.of(
                                                "sessionId",
                                                runtime,
                                                "promptId",
                                                "turn",
                                                "callId",
                                                "call",
                                                "argsDigest",
                                                "digest")));
                assertThat(
                                executions.settlePrepared(
                                        prepared, Map.of("executionStatus", "success"), old))
                        .isNotNull();
            }
            var protectedBatch = retention.sweep(Duration.ofDays(30), 100, null);
            assertThat(protectedBatch.executionsDeleted() + protectedBatch.sessionsDeleted()
                    + protectedBatch.bindingsDeleted()).isZero();
            assertThat(executions.findByExecutionCallId(isolation + "-call:process")).isNotNull();
            assertThat(sessions.findById(retired.getRequest().getScope(), runtime)).isNotNull();
            assertThat(bindings.findById(retired.getBindingId())).isNotNull();
            var replacement = bindings.findOrCreate(retired.getRequest());
            assertThat(replacement.getGeneration()).isEqualTo(retired.getGeneration() + 1);
            jdbc.update("UPDATE ma_session_record SET task_state = 'failed', settled_at = 2"
                    + " WHERE session_id = ?", harness);
            var collected = retention.sweep(Duration.ofDays(30), 100, null);
            assertThat(collected.executionsDeleted()).isEqualTo(2);
            assertThat(collected.sessionsDeleted()).isEqualTo(1);
            assertThat(collected.bindingsDeleted()).isEqualTo(1);
            assertThat(bindings.findById(retired.getBindingId())).isNull();
            assertThat(executions.findByExecutionCallId(isolation + "-call:process")).isNull();
            assertThat(bindings.findById(replacement.getBindingId())).isNotNull();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record"
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
            for (String column :
                    java.util.List.of(
                            "tenant_id", "workspace_id", "session_id", "domain", "task_kind")) {
                jdbc.update(
                        "UPDATE ma_session_record SET "
                                + column
                                + " = CONCAT("
                                + column
                                + ", ' ')");
                assertThat(guard.bindingReferenced(connection, binding)).as(column).isFalse();
                jdbc.update("UPDATE ma_session_record SET " + column + " = TRIM(" + column + ")");
            }
            jdbc.update("UPDATE ma_tool_execution SET binding_id = 'binding '");
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            jdbc.update(
                    "UPDATE ma_tool_execution SET binding_id = 'binding', execution_call_id ="
                        + " 'call:PROCESS'");
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            jdbc.update("UPDATE ma_tool_execution SET execution_call_id = 'call'");
            assertThat(guard.bindingReferenced(connection, binding)).isFalse();
            jdbc.update("UPDATE ma_tool_execution SET execution_call_id = 'call:process'");
            assertThat(guard.bindingReferenced(connection, binding)).isTrue();
        }
    }

    @Test
    void backgroundSettlementIsReadOnTheSweepConnection() throws Exception {
        backgroundEvidence();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            try (var update =
                    connection.prepareStatement("UPDATE ma_session_record SET settled_at = 2")) {
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
        jdbc.update("UPDATE ma_session_record SET task_state = 'succeeded', settled_at = 2");
        var executions = new JdbcToolExecutionRepository(source);
        assertThat(
                        executions.settlePrepared(
                                executions.findByExecutionCallId("call:process"),
                                Map.of("executionStatus", "success"),
                                Instant.parse("2000-01-01T00:00:00Z")))
                .isNotNull();
        duplicateBackgroundRows(
                "ma_tool_execution", "execution_call_id", "call:process", 2999, false);
        duplicateBackgroundRows("ma_session_record", "record_id", "run", 2999, false);
        duplicateBackgroundRows("ma_session_record", "record_id", "run", 20_000, true);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution", Long.class))
                .isEqualTo(3000L);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_tool_execution WHERE execution_state ="
                                    + " 'SETTLED'",
                                Long.class))
                .isEqualTo(3000L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record", Long.class))
                .isEqualTo(23_000L);
        try (var connection = source.getConnection()) {
            jdbc.execute(connection.getMetaData().getDatabaseProductName().equals("H2") ? "ANALYZE"
                    : "ANALYZE TABLE ma_tool_execution, ma_session_record");
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
        }
    }

    @Test
    void backgroundOwnersRemainDistinctUnderPermissiveCollation() throws Exception {
        backgroundEvidence();
        projection("tenant", "HARNESS", "background_shell");
        new JdbcToolExecutionRepository(source)
                .findOrCreate(
                        ToolExecutionRecord.prepared(
                                "upper:process",
                                "upper-key",
                                "binding",
                                4,
                                "HARNESS",
                                "runtime",
                                "turn",
                                "call",
                                "digest",
                                Map.of(
                                        "sessionId",
                                        "runtime",
                                        "promptId",
                                        "turn",
                                        "callId",
                                        "call",
                                        "argsDigest",
                                        "digest")));
        try (var connection = source.getConnection()) {
            String ddl =
                    connection.getMetaData().getDatabaseProductName().equals("H2")
                            ? "ALTER TABLE %s ALTER COLUMN %s VARCHAR_IGNORECASE(512)"
                            : "ALTER TABLE %s MODIFY %s VARCHAR(512) CHARACTER SET utf8mb4 COLLATE"
                                  + " utf8mb4_general_ci NOT NULL";
            jdbc.execute(String.format(ddl, "ma_tool_execution", "harness_session_id"));
            jdbc.execute(String.format(ddl, "ma_session_record", "session_id"));
            var folded =
                    jdbc.queryForList(
                            "SELECT DISTINCT harness_session_id FROM ma_tool_execution",
                            String.class);
            assertThat(folded).hasSize(1);
            String unsettled = folded.getFirst().equals("harness") ? "HARNESS" : "harness";
            jdbc.update("UPDATE ma_session_record SET task_state = 'succeeded', settled_at = 2");
            jdbc.update(
                    "UPDATE ma_session_record SET task_state = 'pending', settled_at = NULL"
                            + " WHERE session_scope_key = ?",
                    ManagedSessionStore.sessionScopeKey("tenant", unsettled));
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isTrue();
            jdbc.update("UPDATE ma_session_record SET task_state = 'succeeded', settled_at = 2");
            assertThat(guard.bindingReferenced(connection, binding("binding", 4))).isFalse();
        }
    }

    private void duplicateBackgroundRows(String table, String key, String value, int count, boolean noise)
            throws Exception {
        try (var connection = source.getConnection();
                var select =
                        connection.prepareStatement(
                                "SELECT * FROM " + table + " WHERE " + key + " = ? LIMIT 1")) {
            select.setString(1, value);
            try (var rows = select.executeQuery()) {
                assertThat(rows.next()).isTrue();
                var columns = new ArrayList<String>();
                var seed = new ArrayList<Object>();
                for (int index = 1; index <= rows.getMetaData().getColumnCount(); index++) {
                    columns.add(rows.getMetaData().getColumnName(index));
                    seed.add(rows.getObject(index));
                }
                String sql =
                        "INSERT INTO "
                                + table
                                + " ("
                                + String.join(",", columns)
                                + ") VALUES ("
                                + String.join(",", Collections.nCopies(columns.size(), "?"))
                                + ")";
                try (var insert = connection.prepareStatement(sql)) {
                    for (int index = 0; index < count; index++) {
                        String id = (noise ? "noise-" : "volume-") + index;
                        var row = new ArrayList<>(seed);
                        if (table.equals("ma_tool_execution")) {
                            String call = id + ":process";
                            row.set(columns.indexOf("execution_call_id"), call);
                            row.set(columns.indexOf("execution_call_id_hash"), brokerHash(call));
                            row.set(columns.indexOf("idempotency_key"), id);
                            row.set(columns.indexOf("idempotency_key_hash"), brokerHash(id));
                        } else {
                            String owner = noise ? "noise-owner-" + index / 20 : "harness";
                            row.set(columns.indexOf("session_id"), owner);
                            row.set(
                                    columns.indexOf("session_scope_key"),
                                    ManagedSessionStore.sessionScopeKey("tenant", owner));
                            row.set(columns.indexOf("record_id"), id);
                            row.set(
                                    columns.indexOf("record_key"),
                                    ManagedExtensionProjection.recordKey(owner, "child_run", id));
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
        new JdbcToolExecutionRepository(source)
                .findOrCreate(
                        ToolExecutionRecord.prepared(
                                "call:process",
                                "key",
                                "binding",
                                4,
                                "harness",
                                "runtime",
                                "turn",
                                "call",
                                "digest",
                                Map.of(
                                        "sessionId",
                                        "runtime",
                                        "promptId",
                                        "turn",
                                        "callId",
                                        "call",
                                        "argsDigest",
                                        "digest")));
    }

    private static RuntimeBindingRecord retire(JdbcRuntimeBindingRepository bindings, RuntimeProvisionRequest request)
            throws Exception {
        var created = bindings.findOrCreate(request);
        var claim =
                bindings.claimOperation(created.getBindingId(), "fixture", Duration.ofSeconds(2));
        var seed = claim.getProvisionSeed();
        var ready =
                bindings.compareAndSet(
                        claim,
                        claim.withAttestation(
                                new RuntimeLease(
                                        seed.getProvisionalRuntimeId(),
                                        URI.create("http://127.0.0.1:9"),
                                        seed.getToken(),
                                        seed.getLeaseId(),
                                        seed.getEpoch()),
                                new RuntimeResourceHandle(
                                        "local-process", 1, Map.of("worker", "fixture")),
                                Instant.now(),
                                Instant.now()));
        var draining = bindings.compareAndSet(ready, ready.withDrainRequested(true, Instant.now()));
        var receipt = new RuntimeDrainReceipt(draining.getBindingId(), draining.getGeneration(),
                seed.getProvisionRequestId(), draining.getResourceHandle(), Instant.now());
        var retired =
                bindings.compareAndSet(
                        draining,
                        draining.withDrainReceipt(receipt)
                                .withState(
                                        RuntimeBindingRecord.State.RELEASED,
                                        draining.getLease(),
                                        Instant.parse("2000-01-01T00:00:00Z")));
        assertThat(retired).isNotNull();
        await().atMost(Duration.ofSeconds(5)).until(() -> !retired.getOperationLeaseUntil().isAfter(Instant.now()));
        return retired;
    }

    private static String operationKey(String kind, String id) {
        return WorkspaceOperations.key(WorkspaceOperations.Kind.valueOf(kind), "tenant", id);
    }

    private void operation(String kind, String id, String binding, long generation) throws Exception {
        try (var connection = source.getConnection()) {
            insertOperation(connection, kind, id, binding, generation);
        }
    }

    private static void insertOperation(Connection connection, String kind, String id, String binding, long generation)
            throws Exception {
        try (var insert =
                connection.prepareStatement(
                        "INSERT INTO ma_operation (operation_key, operation_id, scope_key, operation_kind, tenant_id, target_kind, target_key, target_id, target_revision, state, phase, request_digest, request_json, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'tenant', 'RUNTIME_BINDING', ?, ?, ?, 'DRAINING', 'DRAINING', ?, '{}', 1, 1)")) {
            insert.setString(1, operationKey(kind, id));
            insert.setBytes(2, id.getBytes(StandardCharsets.UTF_8));
            insert.setString(3, WorkspaceOperations.hash("tenant"));
            insert.setString(4, kind);
            insert.setString(5, WorkspaceOperations.hash(binding));
            insert.setBytes(6, binding.getBytes(StandardCharsets.UTF_8));
            insert.setLong(7, generation);
            insert.setString(8, "a".repeat(64));
            insert.executeUpdate();
        }
    }

    private void publication(String key) {
        jdbc.update(
                "INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id,"
                    + " session_id, publication_id, execution_key, capture_id, binding_json,"
                    + " binding_digest, token_hash, state, capture_bytes, producer_bytes,"
                    + " admission_bytes) VALUES (?, ?, 'tenant', 'workspace', 'session',"
                    + " 'publication', ?, 'capture', 'payload-is-not-parsed', ?, ?, 'FENCED', 0, 0,"
                    + " 0)",
                "a".repeat(64),
                "b".repeat(64),
                key,
                "c".repeat(64),
                "d".repeat(64));
    }

    private static RuntimeBindingRecord binding(String id, long generation) {
        var binding = mock(RuntimeBindingRecord.class);
        when(binding.getBindingId()).thenReturn(id);
        when(binding.getGeneration()).thenReturn(generation);
        when(binding.getRequest()).thenReturn(request(null));
        return binding;
    }

    private static RuntimeProvisionRequest request(String isolationKey) {
        return new RuntimeProvisionRequest(
                new RuntimeScope(
                        "tenant",
                        "workspace",
                        "1",
                        "/workspace",
                        "sha256:" + "a".repeat(64),
                        isolationKey == null ? "workspace" : "session"),
                isolationKey,
                "local-process",
                "storage");
    }

    private static String childSql() {
        return "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified, parent_session_id, parent_child_run_id, root_session_id, child_depth) VALUES ('tenant', 'child', 'qwen-code', 'CLOSED', 1, 1, 'parent', 'run', 'parent', 1)";
    }

    private void child() { jdbc.update(childSql()); }

    private void projection() { projection("tenant", "parent", "child_agent"); }

    private void projection(String tenant, String session, String kind) {
        jdbc.update(
                "INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, record_id, operation_hash, revision, record_resource_id, task_kind, task_state, runtime_state, delivery_target, delivery_state, gmt_create) VALUES (?, ?, ?, 'workspace', ?, 'child_run', 'run', ?, 1, 'resource', ?, 'pending', 'unbound', 'session', 'planned', 1)",
                ManagedSessionStore.sessionScopeKey(tenant, session),
                ManagedExtensionProjection.recordKey(session, "child_run", "run"),
                tenant,
                session,
                "a".repeat(64),
                kind);
    }
}
