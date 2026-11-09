package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Uses its own disposable empty application catalog. */
class WorkspaceCreationSchemaMySqlIT {
    @Test
    void preservesUnverifiedCleanupCoverageAcrossRestart() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load().migrate();
            var jdbc = new JdbcTemplate(source);
            jdbc.update("INSERT INTO ma_session_head (head_kind, tenant_key, harness_key, tenant_id,"
                    + " harness_session_id, workspace_id, session_id, storage_version, state,"
                    + " writer_generation, writer_id, writer_lease_until, lease_token_hash,"
                    + " journal_revision, committed_sequence, last_commit_digest, activation_epoch,"
                    + " compacted_through_revision, recovery_status, gmt_create, gmt_modified)"
                    + " VALUES ('MANAGED_SESSION', ?, ?, 'tenant', 'session', 'workspace', 'session',"
                    + " 1, 'SEALED', 1, 'original', 946684800000, ?, 1, 1, ?, 1, 0, 'READY', 1, 1)",
                    ManagedSchemaKeys.key("tenant"), ManagedSchemaKeys.key("session"),
                    "a".repeat(64), "b".repeat(64));
            jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                    + " workspace_id, session_id, resource_id, kind, schema_version, byte_length,"
                    + " sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create)"
                    + " VALUES ('resource', 'scope', 'tenant', 'workspace', 'session', 'descriptor',"
                    + " 'hosted-turn-cleanup', 1, 0, ?, 'MYSQL_INLINE', ?, 'published', 'REFERENCED', 1)",
                    org.apache.commons.codec.digest.DigestUtils.sha256Hex(new byte[0]), new byte[0]);
            jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                    + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                    + " journal_revision, resource_id, gmt_create) VALUES ('scope', 'JOURNAL',"
                    + " 'owner', 1, 'resource', 'tenant', 'workspace', 'session', 1, 'descriptor', 1)");
            var head = jdbc.queryForMap("SELECT * FROM ma_session_head");
            var reference = jdbc.queryForMap("SELECT * FROM ma_resource_ref");

            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load().migrate();

            ManagedSchema.validate(source);
            assertEquals(1, ManagedSchema.schemaVersion(source));
            var upgradedHead = jdbc.queryForMap("SELECT * FROM ma_session_head");
            assertThat(upgradedHead).containsEntry("cleanup_head_revision", null);
            assertThat(upgradedHead).usingRecursiveComparison().isEqualTo(head);
            var upgradedReference = jdbc.queryForMap("SELECT * FROM ma_resource_ref");
            assertThat(upgradedReference).containsEntry("runtime_binding_key", null);
            assertThat(upgradedReference).usingRecursiveComparison().isEqualTo(reference);
        }
    }

    @Test
    void preservesApprovalSelectionAndHistoryAcrossRestart() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .load()
                    .migrate();
            var jdbc = new JdbcTemplate(source);
            jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,"
                    + "selected_approval_mode,approval_revision,gmt_create,gmt_modified)"
                    + " VALUES ('tenant','session','qwen-code','yolo',3,1,1)");
            jdbc.update("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,"
                    + "payload_digest,status,approval_mode,approval_revision,gmt_create,gmt_modified)"
                    + " VALUES ('tenant','session','turn','prompt','[]','digest',"
                    + "'COMPLETED','auto-edit',2,1,1)");
            String rules = "{\"allow\":[\"Read\"],\"ask\":[],\"deny\":[]}";
            jdbc.update("UPDATE ma_session SET selected_approval_mode='auto', permission_rules_json=?", rules);
            jdbc.update("UPDATE ma_turn SET approval_mode='auto', permission_rules_json=?", rules);
            var session = jdbc.queryForMap("SELECT * FROM ma_session");
            var turn = jdbc.queryForMap("SELECT * FROM ma_turn");
            var history = jdbc.queryForList("SELECT * FROM flyway_schema_history ORDER BY installed_rank");
            var lastInstalledRank = jdbc.queryForObject(
                    "SELECT MAX(installed_rank) FROM flyway_schema_history", Integer.class);
            assertEquals(1, ManagedSchema.schemaVersion(source));

            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .load()
                    .migrate();

            ManagedSchema.validate(source);
            assertEquals(1, ManagedSchema.schemaVersion(source));
            var upgradedSession = jdbc.queryForMap("SELECT * FROM ma_session");
            // public_child_agents_version is INT UNSIGNED, so Connector/J
            // boxes it as Long while the signed tinyint stays Integer (R3-27).
            assertThat(upgradedSession).containsEntry("is_plan_enabled", 0)
                    .containsEntry("public_child_agents_version", 0L);
            var upgradedTurn = jdbc.queryForMap("SELECT * FROM ma_turn");
            assertThat(upgradedTurn).containsKey("is_plan_enabled");
            assertThat(upgradedTurn).containsEntry("is_plan_enabled", null);
            assertThat(upgradedSession)
                    .usingRecursiveComparison().isEqualTo(session);
            assertThat(upgradedTurn)
                    .usingRecursiveComparison().isEqualTo(turn);
            assertEquals(history, jdbc.queryForList("SELECT * FROM flyway_schema_history"
                    + " WHERE installed_rank <= ? ORDER BY installed_rank", lastInstalledRank));
            assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM flyway_schema_history"
                    + " WHERE version='1' AND success=TRUE", Integer.class));
        }
    }

    @Test
    void preservesOperationKindsAndRejectsUnknownKinds() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .load()
                    .migrate();
            var jdbc = new JdbcTemplate(source);
            operation(jdbc, "existing", "WORKSPACE_CREATE");
            var existing = jdbc.queryForMap("SELECT * FROM ma_operation");

            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .load()
                    .migrate();

            ManagedSchema.validate(source);
            assertEquals(1, ManagedSchema.schemaVersion(source));
            var upgraded = jdbc.queryForMap("SELECT * FROM ma_operation");
            assertThat(upgraded.keySet()).containsAll(existing.keySet());
            upgraded.keySet().retainAll(existing.keySet());
            assertThat(upgraded).usingRecursiveComparison().isEqualTo(existing);
            operation(jdbc, "created", "WORKSPACE_CREATE");
            operation(jdbc, "input", "SUBMIT_INPUT");
            operation(jdbc, "cancel", "CANCEL");
            // The baseline carries no CHECK on operation_kind: the domain
            // rule lives in ManagedSchemaIntegrity, so the unknown kind is
            // refused there with a complete candidate (R3-27).
            var rejected = assertThrows(IllegalArgumentException.class,
                    () -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                            "ma_operation",
                            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.row(
                                    "attempt_count", 0L, "claim_generation", 0L,
                                    "execution_mode", "SYNC", "is_verification_ready", false,
                                    "operation_kind", "INPUT", "payload_version", 1L)));
            assertTrue(rejected.getMessage().contains("ck_ma_operation_kind"));
        }
    }

    @Test
    void preservesReceiptsAndModelConstraintsAcrossRestart() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                ManagedSchema.requireApplicationCatalog(connection);
                try (var result =
                        statement.executeQuery(
                                "SELECT COUNT(*) FROM information_schema.tables"
                                        + " WHERE table_schema = DATABASE()")) {
                    assertTrue(result.next());
                    assertEquals(0, result.getInt(1), "A disposable empty catalog is required");
                }
                executeResource(connection, ManagedSchema.RESOURCE);
                receipt(connection, "existing", "SESSION_COMMAND");
                statement.execute("INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                        + " VALUES ('tenant','session','qwen-code',1,1)");
                statement.execute("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,"
                        + "payload_digest,status,gmt_create,gmt_modified) VALUES ('tenant','session','turn',"
                        + "'prompt','[]','digest','COMPLETED',1,1)");
            }
            assertEquals(1, ManagedSchema.schemaVersion(source));
            ManagedSchema.initialize(source);
            ManagedSchema.validate(source);
            assertEquals(1, ManagedSchema.schemaVersion(source));
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                receipt(
                        connection,
                        "created",
                        ManagedSchemaContract.ReceiptNamespace.WORKSPACE_CREATE.name());
                // The baseline carries no CHECK on the receipt namespace: the
                // domain rule lives in ManagedSchemaIntegrity, so the unknown
                // namespace is refused there with a complete candidate (R3-27).
                var rejected = assertThrows(IllegalArgumentException.class,
                        () -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                                "ma_request_receipt",
                                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.row(
                                        "is_workspace_bound", 0L,
                                        "namespace", "WORKSPACE_ATTACK",
                                        "scope_kind", "ACTOR")));
                assertTrue(rejected.getMessage().contains("ck_ma_request_namespace"));
                try (var result =
                        statement.executeQuery(
                                "SELECT result_json FROM ma_request_receipt"
                                        + " WHERE namespace = 'SESSION_COMMAND'")) {
                    assertTrue(result.next());
                    assertEquals("{\"name\":\"Existing Workspace \"}", result.getString(1));
                }
                try (var result = statement.executeQuery("SELECT COUNT(*) FROM ma_request_receipt")) {
                    assertTrue(result.next());
                    assertEquals(2, result.getInt(1));
                }
                try (var result = statement.executeQuery("SELECT model_id,model_revision FROM ma_session")) {
                    assertTrue(result.next());
                    assertNull(result.getObject(1));
                    assertEquals(0, result.getLong(2));
                }
                try (var result = statement.executeQuery("SELECT model_id,model_revision FROM ma_turn")) {
                    assertTrue(result.next());
                    assertNull(result.getObject(1));
                    assertNull(result.getObject(2));
                }
                // The baseline declares no CHECK constraints (the catalog
                // validator refuses them outright): the model-selection
                // domain rules live in ManagedSchemaIntegrity, so the
                // half-selected and out-of-range candidates are refused
                // there, not by the engine (R3-27, same shape as the
                // namespace case above).
                var sessionCandidate = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.row(
                        "agent_id", null,
                        "approval_revision", 0L,
                        "context_config_ref", null,
                        "context_revision", null,
                        "cwd_relative", null,
                        "harness_instance_id", null,
                        "harness_owner_boot_id", null,
                        "harness_placement_epoch", 0L,
                        "harness_placement_state", "UNASSIGNED",
                        "is_plan_enabled", 0L,
                        "is_recovery_protected", 0L,
                        "is_resource_gc_completed", 0L,
                        "model_id", null,
                        "model_revision", 0L,
                        "permission_rules_json", null,
                        "public_child_agents_version", 0L,
                        "selected_approval_mode", null,
                        "session_kind", "CONTROL",
                        "workspace_config_ref", null,
                        "workspace_generation", null,
                        "workspace_id", null,
                        "workspace_policy_ref", null,
                        "workspace_storage_id", null);
                sessionCandidate.put("model_id", "m".getBytes(StandardCharsets.UTF_8));
                var sessionRejected = assertThrows(IllegalArgumentException.class,
                        () -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                                "ma_session", sessionCandidate));
                assertTrue(sessionRejected.getMessage().contains("ck_ma_session_model_selection"));
                sessionCandidate.put("model_revision", 9007199254740992L);
                var sessionRangeRejected = assertThrows(IllegalArgumentException.class,
                        () -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                                "ma_session", sessionCandidate));
                assertTrue(sessionRangeRejected.getMessage().contains("ck_ma_session_model_selection"));
                sessionCandidate.put("model_revision", 1L);
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                        "ma_session", sessionCandidate);
                var turnCandidate = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.row(
                        "approval_mode", null,
                        "approval_revision", null,
                        "is_plan_enabled", null,
                        "is_submission_attempted", 0L,
                        "model_id", null,
                        "model_revision", null,
                        "permission_rules_json", null);
                turnCandidate.put("model_id", "m".getBytes(StandardCharsets.UTF_8));
                var turnRejected = assertThrows(IllegalArgumentException.class,
                        () -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                                "ma_turn", turnCandidate));
                assertTrue(turnRejected.getMessage().contains("ck_ma_turn_model_selection"));
                turnCandidate.put("model_revision", 1L);
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                        "ma_turn", turnCandidate);
                statement.execute("UPDATE ma_session SET model_id='m',model_revision=1");
                statement.execute("UPDATE ma_turn SET model_id='m',model_revision=1");
            }
        }
    }

    private static void executeResource(Connection connection, String resource) throws Exception {
        try (var statement = connection.createStatement();
                var input = ManagedSchema.class.getResourceAsStream(resource)) {
            for (String sql :
                    new String(input.readAllBytes(), StandardCharsets.UTF_8)
                            .replaceAll("(?m)^--[^\\n]*", "")
                            .split(";")) {
                if (!sql.isBlank()) {
                    statement.execute(sql);
                }
            }
        }
    }

    private static void receipt(Connection connection, String key, String namespace)
            throws SQLException {
        try (var statement =
                connection.prepareStatement(
                        "INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_key,"
                            + " tenant_id, scope_kind, scope_key, scope_id, idempotency_key,"
                            + " idempotency_digest, request_digest, state, result_json, gmt_create,"
                            + " gmt_modified) VALUES (?, ?, 'tenant-key', 'tenant', 'ACTOR', 'scope',"
                            + " 'actor', ?, ?, 'digest', 'PENDING', '{\"name\":\"Existing Workspace"
                            + " \"}', 1, 1)")) {
            statement.setString(1, ManagedSchemaKeys.key(key));
            statement.setString(2, namespace);
            statement.setString(3, key);
            statement.setString(4, ManagedSchemaKeys.key(key));
            statement.executeUpdate();
        }
    }

    private static void operation(JdbcTemplate jdbc, String key, String kind) {
        jdbc.update("INSERT INTO ma_operation (operation_key,scope_key,operation_id,operation_kind,"
                + "tenant_id,target_kind,target_key,request_digest,request_json,state,phase,"
                + "gmt_create,gmt_modified) VALUES (?,'scope',?,?,'tenant','TURN','target',"
                + "'digest','{}','PENDING','ADMITTED',1,1)", ManagedSchemaKeys.key(key), key, kind);
    }
}
