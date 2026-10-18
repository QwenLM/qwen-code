package com.alibaba.qwen.code.runtimebroker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.IsolatedManagedSchemaMySqlTestDatabase;
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

/** Uses its own disposable empty application catalog. */
class WorkspaceCreationSchemaMySqlIT {
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
            assertEquals(10, ManagedSchema.schemaVersion(source));
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
            assertEquals(10, ManagedSchema.schemaVersion(source));
            assertThat(jdbc.queryForMap("SELECT * FROM ma_operation"))
                    .usingRecursiveComparison().isEqualTo(existing);
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
            ManagedSchema.initialize(source);
            assertEquals(10, ManagedSchema.schemaVersion(source));
            try (var connection = source.getConnection();
                    var statement = connection.createStatement();
                    var input = ManagedSchema.class.getResourceAsStream(ManagedSchema.RESOURCE)) {
                String baseline = new String(input.readAllBytes(), StandardCharsets.UTF_8);
                statement.execute(
                        "ALTER TABLE ma_request_receipt DROP CONSTRAINT ck_ma_request_namespace");
                statement.execute("ALTER TABLE ma_request_receipt ADD "
                        + baselineCheck(baseline, "ck_ma_request_namespace"));
                statement.execute("DROP INDEX ix_ma_runtime_session_harness ON ma_runtime_session");
                statement.execute("ALTER TABLE ma_operation DROP CONSTRAINT ck_ma_operation_kind");
                statement.execute("ALTER TABLE ma_operation ADD "
                        + baselineCheck(baseline, "ck_ma_operation_kind"));
                statement.execute("DROP INDEX ix_ma_storage_owner_host ON ma_storage_owner");
                statement.execute("ALTER TABLE ma_session DROP CONSTRAINT ck_ma_session_plan");
                statement.execute("ALTER TABLE ma_turn DROP CONSTRAINT ck_ma_turn_plan");
                statement.execute("ALTER TABLE ma_session DROP COLUMN plan_enabled");
                statement.execute("ALTER TABLE ma_turn DROP COLUMN plan_enabled");
                statement.execute("ALTER TABLE ma_session DROP CONSTRAINT ck_ma_session_approval_selection");
                statement.execute("ALTER TABLE ma_turn DROP CONSTRAINT ck_ma_turn_approval_selection");
                statement.execute("ALTER TABLE ma_session DROP COLUMN selected_approval_mode");
                statement.execute("ALTER TABLE ma_session DROP COLUMN approval_revision");
                statement.execute("ALTER TABLE ma_turn DROP COLUMN approval_mode");
                statement.execute("ALTER TABLE ma_turn DROP COLUMN approval_revision");
                statement.execute("ALTER TABLE ma_session DROP CONSTRAINT ck_ma_session_model_selection");
                statement.execute("ALTER TABLE ma_turn DROP CONSTRAINT ck_ma_turn_model_selection");
                statement.execute("ALTER TABLE ma_session DROP COLUMN model_id");
                statement.execute("ALTER TABLE ma_session DROP COLUMN model_revision");
                statement.execute("ALTER TABLE ma_turn DROP COLUMN model_id");
                statement.execute("ALTER TABLE ma_turn DROP COLUMN model_revision");
                statement.execute("DROP INDEX ix_ma_session_list ON ma_session");
                statement.execute("CREATE INDEX ix_ma_session_list ON ma_session (tenant_id, gmt_modified, session_id)");
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
            assertEquals(10, ManagedSchema.schemaVersion(source));
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

    private static String baselineCheck(String ddl, String name) {
        return ddl.lines()
                .filter(line -> line.contains("CONSTRAINT " + name + " CHECK"))
                .findFirst()
                .orElseThrow()
                .trim()
                .replaceFirst(",$", "");
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
