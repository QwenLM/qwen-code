package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;

/** Uses only an explicitly supplied disposable empty application catalog. */
class WorkspaceCreationSchemaMySqlIT {
    @Test
    void upgradesPublishedCatalogsWithoutChangingExistingRows() throws Exception {
        var source =
                new DriverManagerDataSource(
                        System.getProperty("mysql.url"),
                        System.getProperty("mysql.user"),
                        System.getProperty("mysql.password", ""));
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
            statement.execute("INSERT INTO ma_session (tenant_id,session_id,agent_id,created_at,updated_at)"
                    + " VALUES ('tenant','session','qwen-code',1,1)");
            statement.execute("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,"
                    + "payload_digest,status,created_at,updated_at) VALUES ('tenant','session','turn',"
                    + "'prompt','[]','digest','COMPLETED',1,1)");
        }
        assertEquals(1, ManagedSchema.schemaVersion(source));
        ManagedSchema.initialize(source);
        assertEquals(5, ManagedSchema.schemaVersion(source));
        try (var connection = source.getConnection();
                var statement = connection.createStatement();
                var input = ManagedSchema.class.getResourceAsStream(ManagedSchema.RESOURCE)) {
            String oldCheck =
                    new String(input.readAllBytes(), StandardCharsets.UTF_8)
                            .lines()
                            .filter(
                                    line ->
                                            line.contains(
                                                    "CONSTRAINT ck_ma_request_namespace CHECK"))
                            .findFirst()
                            .orElseThrow()
                            .trim()
                            .replaceFirst(",$", "");
            statement.execute(
                    "ALTER TABLE ma_request_receipt DROP CONSTRAINT ck_ma_request_namespace");
            statement.execute("ALTER TABLE ma_request_receipt ADD " + oldCheck);
            statement.execute("ALTER TABLE ma_session DROP CONSTRAINT ck_ma_session_model_selection");
            statement.execute("ALTER TABLE ma_turn DROP CONSTRAINT ck_ma_turn_model_selection");
            statement.execute("ALTER TABLE ma_session DROP COLUMN model_id");
            statement.execute("ALTER TABLE ma_session DROP COLUMN model_revision");
            statement.execute("ALTER TABLE ma_turn DROP COLUMN model_id");
            statement.execute("ALTER TABLE ma_turn DROP COLUMN model_revision");
            statement.execute("DROP INDEX ix_ma_session_list ON ma_session");
            statement.execute("CREATE INDEX ix_ma_session_list ON ma_session (tenant_id, updated_at, session_id)");
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
        assertEquals(5, ManagedSchema.schemaVersion(source));
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
                            + " idempotency_digest, request_digest, state, result_json, created_at,"
                            + " updated_at) VALUES (?, ?, 'tenant-key', 'tenant', 'ACTOR', 'scope',"
                            + " 'actor', ?, ?, 'digest', 'PENDING', '{\"name\":\"Existing Workspace"
                            + " \"}', 1, 1)")) {
            statement.setString(1, ManagedSchemaKeys.key(key));
            statement.setString(2, namespace);
            statement.setString(3, key);
            statement.setString(4, ManagedSchemaKeys.key(key));
            statement.executeUpdate();
        }
    }
}
