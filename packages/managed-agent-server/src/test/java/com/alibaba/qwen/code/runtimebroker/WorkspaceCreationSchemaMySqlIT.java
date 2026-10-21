package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
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
    void preservesUnverifiedCleanupCoverageWhileUpgradingV12() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION)
                    .target("12").load().migrate();
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
                    + " 'hosted-turn-cleanup', 1, 0, ?, 'MYSQL_INLINE', ?, 'legacy', 'REFERENCED', 1)",
                    org.apache.commons.codec.digest.DigestUtils.sha256Hex(new byte[0]), new byte[0]);
            jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                    + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                    + " journal_revision, resource_id, gmt_create) VALUES ('scope', 'JOURNAL',"
                    + " 'owner', 1, 'resource', 'tenant', 'workspace', 'session', 1, 'descriptor', 1)");
            var head = jdbc.queryForMap("SELECT * FROM ma_session_head");
            var reference = jdbc.queryForMap("SELECT * FROM ma_resource_ref");

            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load().migrate();

            ManagedSchema.validate(source);
            assertEquals(15, ManagedSchema.schemaVersion(source));
            var upgradedHead = jdbc.queryForMap("SELECT * FROM ma_session_head");
            assertThat(upgradedHead).containsEntry("cleanup_head_revision", null);
            upgradedHead.remove("cleanup_head_revision");
            assertThat(upgradedHead).usingRecursiveComparison().isEqualTo(head);
            var upgradedReference = jdbc.queryForMap("SELECT * FROM ma_resource_ref");
            assertThat(upgradedReference).containsEntry("runtime_binding_key", null);
            upgradedReference.remove("runtime_binding_key");
            assertThat(upgradedReference).usingRecursiveComparison().isEqualTo(reference);
        }
    }

    @Test
    void addsSshRegistrationAfterPublishedApprovalSelectionWithoutChangingHistory() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .target("6")
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
            var session = jdbc.queryForMap("SELECT * FROM ma_session");
            var turn = jdbc.queryForMap("SELECT * FROM ma_turn");
            var history = jdbc.queryForList("SELECT * FROM flyway_schema_history ORDER BY installed_rank");
            var lastInstalledRank = jdbc.queryForObject(
                    "SELECT MAX(installed_rank) FROM flyway_schema_history", Integer.class);
            assertEquals(6, ManagedSchema.schemaVersion(source));

            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .load()
                    .migrate();

            ManagedSchema.validate(source);
            assertEquals(15, ManagedSchema.schemaVersion(source));
            var upgradedSession = jdbc.queryForMap("SELECT * FROM ma_session");
            assertThat(upgradedSession.remove("plan_enabled")).isEqualTo(false);
            var upgradedTurn = jdbc.queryForMap("SELECT * FROM ma_turn");
            assertThat(upgradedTurn).containsKey("plan_enabled");
            assertThat(upgradedTurn.remove("plan_enabled")).isNull();
            assertThat(upgradedSession)
                    .usingRecursiveComparison().isEqualTo(session);
            assertThat(upgradedTurn)
                    .usingRecursiveComparison().isEqualTo(turn);
            assertEquals(history, jdbc.queryForList("SELECT * FROM flyway_schema_history"
                    + " WHERE installed_rank <= ? ORDER BY installed_rank", lastInstalledRank));
            assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM flyway_schema_history"
                    + " WHERE version='7' AND success=TRUE", Integer.class));
        }
    }

    @Test
    void addsTurnCommandKindsOverACatalogAlreadyHoldingEveryEarlierKind() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .target("7")
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
            assertEquals(15, ManagedSchema.schemaVersion(source));
            var upgraded = jdbc.queryForMap("SELECT * FROM ma_operation");
            assertThat(upgraded.keySet()).containsAll(existing.keySet());
            upgraded.keySet().retainAll(existing.keySet());
            assertThat(upgraded).usingRecursiveComparison().isEqualTo(existing);
            operation(jdbc, "created", "WORKSPACE_CREATE");
            operation(jdbc, "input", "SUBMIT_INPUT");
            operation(jdbc, "cancel", "CANCEL");
            assertThrows(DataAccessException.class, () -> operation(jdbc, "unknown", "INPUT"));
        }
    }

    @Test
    void upgradesPublishedCatalogsWithoutChangingExistingRows() throws Exception {
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
            try (var connection = source.getConnection()) {
                executeResource(connection, ManagedSchema.PRIVATE_AUTHORITY);
                assertThrows(
                        SQLException.class, () -> receipt(connection, "not-yet", "WORKSPACE_CREATE"));
            }
            assertEquals(2, ManagedSchema.schemaVersion(source));
            try (var connection = source.getConnection()) {
                executeResource(connection, ManagedSchema.SESSION_LIST);
            }
            assertEquals(3, ManagedSchema.schemaVersion(source));
            try (var connection = source.getConnection()) {
                executeResource(connection, ManagedSchema.WORKSPACE_CREATION);
            }
            assertEquals(4, ManagedSchema.schemaVersion(source));
            ManagedSchema.initialize(source);
            ManagedSchema.validate(source);
            assertEquals(15, ManagedSchema.schemaVersion(source));
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                receipt(
                        connection,
                        "created",
                        ManagedSchemaContract.ReceiptNamespace.WORKSPACE_CREATE.name());
                assertThrows(
                        SQLException.class, () -> receipt(connection, "unknown", "WORKSPACE_ATTACK"));
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
                assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_session SET model_id='m'"));
                assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_turn SET model_id='m'"));
                assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_turn SET model_revision=1"));
                statement.execute("UPDATE ma_session SET model_id='m',model_revision=1");
                statement.execute("UPDATE ma_turn SET model_id='m',model_revision=1");
                assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_session SET model_revision=9007199254740992"));
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
