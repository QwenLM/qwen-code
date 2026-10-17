package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.HashSet;

import javax.sql.DataSource;

/** Requires a dedicated empty database; never cleans, upgrades or repairs an existing schema. */
class ManagedSchemaMySqlIT {
    @Test
    void refusesSystemCatalogsBeforeChangingAnyTables() throws Exception {
        String url = required("mysql.url");
        int path = url.indexOf('/', "jdbc:mysql://".length());
        int query = url.indexOf('?', path);
        for (String catalog :
                new String[] {"mysql", "sys", "information_schema", "performance_schema"}) {
            DataSource source =
                    new DriverManagerDataSource(
                            url.substring(0, path + 1)
                                    + catalog
                                    + (query < 0 ? "" : url.substring(query)),
                            required("mysql.user"),
                            System.getProperty("mysql.password", ""));
            var before = catalogTables(source, catalog);
            var error =
                    assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            assertTrue(error.getCause().getMessage().contains("refused before DDL"));
            assertThrows(IllegalStateException.class, () -> ManagedSchema.validate(source));
            assertEquals(before, catalogTables(source, catalog));
        }
    }

    private static java.util.Set<String> catalogTables(DataSource source, String catalog)
            throws SQLException {
        var tables = new HashSet<String>();
        try (var connection = source.getConnection();
                var query =
                        connection.prepareStatement(
                                "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables"
                                        + " WHERE TABLE_SCHEMA=?")) {
            query.setString(1, catalog);
            try (var rows = query.executeQuery()) {
                while (rows.next()) {
                    tables.add(rows.getString(1) + ":" + rows.getString(2));
                }
            }
        }
        return tables;
    }

    @Test
    void baselineAndConstraintsWorkOnRealMySql() throws Exception {
        DataSource source =
                new DriverManagerDataSource(
                        required("mysql.url"),
                        required("mysql.user"),
                        System.getProperty("mysql.password", ""));
        ManagedSchema.initialize(source);
        ManagedSchema.initialize(source);
        ManagedSchema.validate(source);
        String prefix = "schema-it-" + java.util.UUID.randomUUID();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            boolean mariaDb = connection.getMetaData().getDatabaseProductVersion()
                    .contains("MariaDB");
            String dropCheck = mariaDb ? "DROP CONSTRAINT " : "DROP CHECK ";
            var tables = new HashSet<String>();
            try (var rows =
                    connection
                            .getMetaData()
                            .getTables(
                                    connection.getCatalog(), null, "%", new String[] {"TABLE"})) {
                while (rows.next()) {
                    if (!"flyway_schema_history".equals(rows.getString("TABLE_NAME"))) {
                        tables.add(rows.getString("TABLE_NAME"));
                    }
                }
            }
            assertEquals(ManagedSchemaContract.TABLES, tables);
            verifyMaximumStorageScopeKeys(connection, prefix);
            verifyCaptureTimestampDefaults(connection, prefix);
            statement.execute("DROP INDEX ix_ma_storage_owner_binding ON ma_storage_owner");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute(
                        ManagedSchema.ddl()
                                .lines()
                                .filter(
                                        line ->
                                                line.startsWith(
                                                        "CREATE INDEX ix_ma_storage_owner_binding "))
                                .findFirst()
                                .orElseThrow());
            }
            ManagedSchema.initialize(source);
            try (var row = statement.executeQuery("SELECT CAST(18446744073709551615 AS UNSIGNED) AS invalid_time")) {
                assertTrue(row.next());
                assertThrows(SQLException.class, () -> ManagedSchemaTime.timestamp(row, "invalid_time"));
            }
            assertThrows(SQLException.class, () -> statement.execute(
                    "INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                            + " VALUES ('" + prefix + "negative','session','agent',-1,0)"));
            try (var row =
                    statement.executeQuery(
                            "SELECT CURRENT_TIMESTAMP(6) AS observed_at, CAST('tenant ' AS BINARY) AS tenant_id, X'0102' AS inline_bytes, X'0304' AS actor_key")) {
                assertTrue(row.next());
                var values = ManagedSchemaRows.read(row);
                assertTrue(values.get("observed_at") instanceof java.sql.Timestamp);
                assertEquals("tenant ", values.get("tenant_id"));
                org.junit.jupiter.api.Assertions.assertArrayEquals(
                        new byte[] {1, 2}, (byte[]) values.get("inline_bytes"));
                org.junit.jupiter.api.Assertions.assertArrayEquals(
                        new byte[] {3, 4}, (byte[]) values.get("actor_key"));
            }
            try (var row = statement.executeQuery("SELECT VERSION()")) {
                assertTrue(row.next());
                System.out.println("Managed schema MySQL DDL server version: " + row.getString(1));
            }
            statement.execute(
                    "INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                            + " VALUES ('"
                            + prefix
                            + "tenant','"
                            + prefix
                            + "session','agent',0,0)");
            statement.execute(
                    "INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                            + " VALUES ('"
                            + prefix
                            + "tenant','"
                            + prefix
                            + "session ','agent',0,0)");
            assertThrows(
                    SQLException.class,
                    () ->
                            statement.execute(
                                    "INSERT INTO ma_operation"
                                        + " (operation_key,scope_key,operation_id,operation_kind,tenant_id,target_kind,target_key,request_digest,request_json,state,phase,gmt_create,gmt_modified)"
                                        + " VALUES ('invalid','scope','invalid','CLOSE"
                                        + " ','tenant','SESSION','target','digest','{}','PENDING','ADMITTED',0,0)"));
            assertThrows(
                    SQLException.class,
                    () ->
                            statement.execute(
                                    "INSERT INTO ma_resource_ref"
                                        + " (session_scope_key,owner_kind,owner_key,owner_revision,resource_key,tenant_id,session_id,gmt_create)"
                                        + " VALUES"
                                        + " ('scope','JOURNAL','scope',1,'missing','tenant','session'," + ManagedSchemaTime.SQL_NOW + ")"));
            byte[] largeBody = new byte[17 * 1024 * 1024];
            largeBody[0] = 1;
            largeBody[largeBody.length - 1] = 2;
            String resourceKey =
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            prefix, "large-message");
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO ma_resource (resource_key,session_scope_key,"
                                + "tenant_id,session_id,resource_id,kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create)"
                                + " VALUES"
                                + " (?,?,?,?,?,'message-body/1',1,?,?,'MYSQL_INLINE',?,'PUBLISHED'," + ManagedSchemaTime.SQL_NOW + ")")) {
                insert.setString(1, resourceKey);
                insert.setString(
                        2,
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                prefix));
                insert.setString(3, prefix + "tenant");
                insert.setString(4, prefix + "session");
                insert.setString(5, "large-message");
                insert.setLong(6, largeBody.length);
                insert.setString(
                        7,
                        java.util.HexFormat.of()
                                .formatHex(
                                        java.security.MessageDigest.getInstance("SHA-256")
                                                .digest(largeBody)));
                insert.setBytes(8, largeBody);
                insert.executeUpdate();
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT byte_length,OCTET_LENGTH(inline_bytes) FROM ma_resource WHERE"
                                    + " resource_key=?")) {
                read.setString(1, resourceKey);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    assertEquals(largeBody.length, row.getLong(1));
                    assertEquals(largeBody.length, row.getLong(2));
                }
            }
            try (var remove =
                    connection.prepareStatement("DELETE FROM ma_resource WHERE resource_key=?")) {
                remove.setString(1, resourceKey);
                remove.executeUpdate();
            }
            statement.execute("CREATE TABLE managed_schema_foreign_witness (value INT NOT NULL)");
            try {
                statement.execute("INSERT INTO managed_schema_foreign_witness VALUES (42)");
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
                try (var row =
                        statement.executeQuery(
                                "SELECT value FROM managed_schema_foreign_witness")) {
                    assertTrue(row.next());
                    assertEquals(42, row.getInt(1));
                }
            } finally {
                statement.execute("DROP TABLE managed_schema_foreign_witness");
            }
            ManagedSchema.initialize(source);
            statement.execute(
                    "ALTER TABLE ma_runtime_binding MODIFY provision_seeded BOOLEAN GENERATED"
                            + " ALWAYS AS (provision_seed_ciphertext IS NULL)");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute(
                        "ALTER TABLE ma_runtime_binding MODIFY provision_seeded BOOLEAN GENERATED"
                                + " ALWAYS AS (provision_seed_ciphertext IS NOT NULL)");
            }
            ManagedSchema.initialize(source);
            statement.execute(
                    "ALTER TABLE ma_session_head MODIFY writer_lease_until BIGINT NULL");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute(
                        "ALTER TABLE ma_session_head MODIFY writer_lease_until BIGINT UNSIGNED NULL");
            }
            ManagedSchema.initialize(source);
            if (mariaDb) {
                String url = required("mysql.url");
                DataSource disabledChecks = new DriverManagerDataSource(
                        url + (url.contains("?") ? "&" : "?")
                                + "sessionVariables=check_constraint_checks=0",
                        required("mysql.user"), System.getProperty("mysql.password", ""));
                assertThrows(IllegalStateException.class,
                        () -> ManagedSchema.initialize(disabledChecks));
            } else {
                statement.execute(
                        "ALTER TABLE ma_operation ALTER CHECK ck_ma_operation_kind NOT ENFORCED");
                try {
                    assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
                } finally {
                    statement.execute(
                            "ALTER TABLE ma_operation ALTER CHECK ck_ma_operation_kind ENFORCED");
                }
            }
            String pageCheck =
                    ManagedSchema.ddl()
                            .lines()
                            .filter(
                                    line ->
                                            line.contains(
                                                    "CONSTRAINT ck_ma_resource_snapshot_page"
                                                            + " CHECK"))
                            .findFirst()
                            .orElseThrow()
                            .trim()
                            .replaceFirst(",$", "");
            statement.execute("ALTER TABLE ma_resource " + dropCheck + "ck_ma_resource_snapshot_page");
            statement.execute(
                    "ALTER TABLE ma_resource ADD "
                            + pageCheck.replace("'MYSQL_INLINE'", "'MYSQL_BROKEN'"));
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute(
                        "ALTER TABLE ma_resource " + dropCheck + "ck_ma_resource_snapshot_page");
                statement.execute("ALTER TABLE ma_resource ADD " + pageCheck);
            }
            statement.execute("ALTER TABLE ma_session_head " + dropCheck + "ck_ma_head_counters");
            statement.execute(
                    "ALTER TABLE ma_session_head ADD CONSTRAINT ck_ma_head_counters CHECK"
                            + " ((claim_generation >= 0 AND writer_generation IS NULL OR"
                            + " writer_generation >= 0) AND (activation_epoch IS NULL OR"
                            + " activation_epoch >= 0))");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute("ALTER TABLE ma_session_head " + dropCheck + "ck_ma_head_counters");
                statement.execute(
                        "ALTER TABLE ma_session_head ADD CONSTRAINT ck_ma_head_counters CHECK"
                                + " (claim_generation >= 0 AND (writer_generation IS NULL OR"
                                + " writer_generation >= 0) AND (activation_epoch IS NULL OR"
                                + " activation_epoch >= 0))");
            }
            statement.execute("ALTER TABLE ma_tenant_guard ENGINE=MyISAM");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute("ALTER TABLE ma_tenant_guard ENGINE=InnoDB");
            }
            ManagedSchema.initialize(source);
        }
    }

    private static void verifyCaptureTimestampDefaults(java.sql.Connection connection, String prefix)
            throws SQLException {
        String scope = ManagedSchemaKeys.key(prefix, "capture-time");
        try (var statement = connection.createStatement()) {
            long before;
            try (var row = statement.executeQuery("SELECT " + ManagedSchemaTime.SQL_NOW)) {
                assertTrue(row.next());
                before = row.getLong(1);
            }
            try (var insert = connection.prepareStatement(
                    "INSERT INTO ma_output_capture (scope_key,tenant_key,tenant_id,workspace_id,session_id,"
                            + "publication_id,execution_key,capture_id,binding_json,binding_digest,token_hash,state,"
                            + "capture_bytes,producer_bytes,admission_bytes) VALUES (?,?,?,?,?,?,?,?,'{}',?,?,'OPEN',1,1,1)")) {
                for (int index = 1; index <= 10; index++) {
                    insert.setString(index, scope);
                }
                assertEquals(1, insert.executeUpdate());
            }
            try (var query = connection.prepareStatement("SELECT gmt_create,gmt_modified,"
                    + ManagedSchemaTime.SQL_NOW + " AS db_now FROM ma_output_capture WHERE scope_key=?")) {
                query.setString(1, scope);
                try (var row = query.executeQuery()) {
                    assertTrue(row.next());
                    long created = row.getLong("gmt_create");
                    assertEquals(created, row.getLong("gmt_modified"));
                    assertTrue(created >= before && created <= row.getLong("db_now"));
                    assertEquals(created, ManagedSchemaTime.timestamp(row, "gmt_create").getTime());
                }
            } finally {
                try (var remove = connection.prepareStatement("DELETE FROM ma_output_capture WHERE scope_key=?")) {
                    remove.setString(1, scope);
                    remove.executeUpdate();
                }
            }
        }
    }

    private static void verifyMaximumStorageScopeKeys(java.sql.Connection connection, String prefix)
            throws Exception {
        byte[] tenant =
                (prefix + "t".repeat(512 - prefix.length())).getBytes(StandardCharsets.UTF_8);
        byte[] session =
                (prefix + "s".repeat(512 - prefix.length())).getBytes(StandardCharsets.UTF_8);
        byte[] storage = "v".repeat(1024).getBytes(StandardCharsets.UTF_8);
        byte[] binding =
                (prefix + "b".repeat(2048 - prefix.length())).getBytes(StandardCharsets.UTF_8);
        String alias = ManagedSchemaKeys.key(prefix, "storage-alias");
        String tenantKey = ManagedSchemaKeys.key(new String(tenant, StandardCharsets.UTF_8));
        String harnessKey = ManagedSchemaKeys.key(new String(session, StandardCharsets.UTF_8));
        try (var insert =
                connection.prepareStatement(
                        "INSERT INTO"
                            + " ma_session(tenant_id,session_id,session_kind,workspace_storage_id,gmt_create,gmt_modified)"
                            + " VALUES(?,?,'CONTROL',?,0,0)")) {
            insert.setBytes(1, tenant);
            insert.setBytes(2, session);
            insert.setBytes(3, storage);
            insert.executeUpdate();
        }
        try {
            try (var invalid =
                    connection.prepareStatement(
                            "UPDATE ma_session SET resource_gc_completed=2 WHERE tenant_id=? AND"
                                    + " session_id=?")) {
                invalid.setBytes(1, tenant);
                invalid.setBytes(2, session);
                assertThrows(SQLException.class, invalid::executeUpdate);
            }
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO"
                                + " ma_session_head(tenant_id,session_id,workspace_id,tenant_key,"
                                + "harness_key,harness_session_id,head_kind,storage_version,state,"
                                + "writer_generation,journal_revision,committed_sequence,activation_epoch,gmt_create,gmt_modified)"
                                + " VALUES(?,?,?,?,?,?,'MANAGED_SESSION',1,'OPEN',"
                                + "0,0,0,0," + ManagedSchemaTime.SQL_NOW + "," + ManagedSchemaTime.SQL_NOW + ")")) {
                insert.setBytes(1, tenant);
                insert.setBytes(2, session);
                insert.setBytes(3, binding);
                insert.setString(4, tenantKey);
                insert.setString(5, harnessKey);
                insert.setBytes(6, session);
                insert.executeUpdate();
            }
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO"
                                + " ma_runtime_binding(binding_id,request_key,scope_key,tenant_id,"
                                + "workspace_id,workspace_generation,canonical_cwd,capability_digest,"
                                + "isolation_class,provisioner_kind,storage_id,storage_alias_key,runtime_generation,"
                                + "binding_state,attestation_generation,drain_requested,operation_generation,record_version,last_active_at)"
                                + " VALUES(?,?,?,?,?,?,'cwd',?,'WORKSPACE',"
                                + "'schema-test',?,?,1,'ACTIVE',0,FALSE,0,0," + ManagedSchemaTime.SQL_NOW + ")")) {
                insert.setBytes(1, binding);
                insert.setString(2, ManagedSchemaKeys.key(prefix, "request"));
                insert.setString(3, ManagedSchemaKeys.key(prefix, "scope"));
                insert.setBytes(4, tenant);
                insert.setBytes(5, session);
                insert.setBytes(6, new byte[] {'1'});
                insert.setBytes(7, new byte[] {'c'});
                insert.setBytes(8, storage);
                insert.setString(9, alias);
                insert.executeUpdate();
            }
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO ma_storage_owner(storage_key,binding_id,runtime_generation)"
                                    + " VALUES(?,?,1)")) {
                insert.setString(1, alias);
                insert.setBytes(2, binding);
                insert.executeUpdate();
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT storage_key FROM ma_storage_owner FORCE"
                                    + " INDEX(ix_ma_storage_owner_binding) WHERE binding_id=? AND"
                                    + " runtime_generation=1")) {
                read.setBytes(1, binding);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    assertEquals(alias, row.getString(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT session_id FROM ma_session_head FORCE"
                                    + " INDEX(ix_ma_head_workspace) WHERE tenant_key=? AND"
                                    + " workspace_id=?")) {
                read.setString(1, tenantKey);
                read.setBytes(2, binding);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    org.junit.jupiter.api.Assertions.assertArrayEquals(session, row.getBytes(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT session_id FROM ma_session FORCE"
                                    + " INDEX(ix_ma_session_storage_scope) WHERE tenant_id=? AND"
                                    + " workspace_storage_id=? AND resource_gc_completed=0")) {
                read.setBytes(1, tenant);
                read.setBytes(2, storage);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    org.junit.jupiter.api.Assertions.assertArrayEquals(session, row.getBytes(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT binding_id FROM ma_runtime_binding FORCE"
                                    + " INDEX(ix_ma_runtime_storage_alias_state) WHERE"
                                    + " storage_alias_key=? AND binding_state='ACTIVE' AND"
                                    + " provision_seeded=FALSE")) {
                read.setString(1, alias);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    org.junit.jupiter.api.Assertions.assertArrayEquals(binding, row.getBytes(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT runtime_session_id FROM ma_runtime_session FORCE"
                                    + " INDEX(ix_ma_runtime_session_harness) WHERE"
                                    + " harness_session_id=? AND tenant_id=?")) {
                read.setBytes(1, session);
                read.setBytes(2, tenant);
                try (var row = read.executeQuery()) {
                    assertFalse(row.next());
                }
            }
        } finally {
            try (var remove =
                    connection.prepareStatement(
                            "DELETE FROM ma_storage_owner WHERE storage_key=?")) {
                remove.setString(1, alias);
                remove.executeUpdate();
            }
            try (var remove =
                    connection.prepareStatement(
                            "DELETE FROM ma_runtime_binding WHERE binding_id=?")) {
                remove.setBytes(1, binding);
                remove.executeUpdate();
            }
            try (var remove =
                    connection.prepareStatement(
                            "DELETE FROM ma_session_head WHERE tenant_key=? AND harness_key=?")) {
                remove.setString(1, tenantKey);
                remove.setString(2, harnessKey);
                remove.executeUpdate();
            }
            try (var remove =
                    connection.prepareStatement(
                            "DELETE FROM ma_session WHERE tenant_id=? AND session_id=?")) {
                remove.setBytes(1, tenant);
                remove.setBytes(2, session);
                remove.executeUpdate();
            }
        }
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(
                    name + " is required for the isolated MySQL schema test");
        }
        return value;
    }
}
