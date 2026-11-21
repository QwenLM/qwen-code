package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.HashSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Destructive schema checks use their own database; system catalogs remain untouched. */
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
    void refusesNonStrictConnectionsAndRejectsNegativeUnsignedWrites() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase();
                var connection = database.source().getConnection();
                var statement = connection.createStatement()) {
            var source = new SingleConnectionDataSource(connection, true);
            String originalMode;
            try (var result = statement.executeQuery("SELECT @@SESSION.sql_mode")) {
                assertTrue(result.next());
                originalMode = result.getString(1);
            }
            try {
                statement.execute("SET SESSION sql_mode = ''");
                var freshError = assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
                assertTrue(freshError.getCause().getMessage().contains("requires strict SQL mode"));
                assertTrue(catalogTables(database.source(), connection.getCatalog()).isEmpty());
                for (String mode : new String[] {"STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"}) {
                    statement.execute("SET SESSION sql_mode = '" + mode + "'");
                    ManagedSchema.initialize(source);
                    statement.execute("INSERT INTO ma_read_lease"
                            + " (lease_id, tenant_id, session_id, retirement_generation, expires_at)"
                            + " VALUES ('" + mode + "', REPEAT('a',36), REPEAT('b',64), 7, 1)");
                    var rangeError = assertThrows(SQLException.class, () -> statement.execute(
                            "UPDATE ma_read_lease SET retirement_generation = -1 WHERE lease_id = '" + mode + "'"));
                    assertEquals(1264, rangeError.getErrorCode());
                    try (var result = statement.executeQuery(
                            "SELECT retirement_generation FROM ma_read_lease WHERE lease_id = '" + mode + "'")) {
                        assertTrue(result.next());
                        assertEquals(7, result.getLong(1));
                    }
                }
                var before = catalogTables(database.source(), connection.getCatalog());
                statement.execute("SET SESSION sql_mode = ''");
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
                var validationError = assertThrows(IllegalStateException.class, () -> ManagedSchema.validate(source));
                assertTrue(validationError.getCause().getMessage().contains("requires strict SQL mode"));
                assertEquals(before, catalogTables(database.source(), connection.getCatalog()));
            } finally {
                try (var restore = connection.prepareStatement("SET SESSION sql_mode = ?")) {
                    restore.setString(1, originalMode);
                    restore.execute();
                }
            }
        }
    }

    @Test
    void baselineAndConstraintsWorkOnRealMySql() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            verifyBaselineAndConstraints(database.source());
        }
    }

    private static void verifyBaselineAndConstraints(DataSource source) throws Exception {
        ManagedSchema.initialize(source);
        ManagedSchema.initialize(source);
        ManagedSchema.validate(source);
        String prefix = "schema-it-" + java.util.UUID.randomUUID();
        String tenant = prefix.substring(0, 36);
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
            statement.execute("DROP INDEX idx_ma_storage_owner_binding ON ma_storage_owner");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute(
                        ManagedSchema.ddl()
                                .lines()
                                .filter(
                                        line ->
                                                line.startsWith(
                                                        "CREATE INDEX idx_ma_storage_owner_binding "))
                                .findFirst()
                                .orElseThrow());
            }
            ManagedSchema.initialize(source);
            statement.execute("DROP INDEX idx_ma_storage_owner_host ON ma_storage_owner");
            statement.execute("CREATE INDEX idx_ma_storage_owner_host ON ma_storage_owner (mount_host_id, storage_kind)");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.validate(source));
            } finally {
                statement.execute("DROP INDEX idx_ma_storage_owner_host ON ma_storage_owner");
                statement.execute(ManagedSchema.ddl().lines()
                        .filter(line -> line.startsWith("CREATE INDEX idx_ma_storage_owner_host "))
                        .findFirst().orElseThrow());
            }
            ManagedSchema.validate(source);
            try (var row = statement.executeQuery("SELECT CAST(18446744073709551615 AS UNSIGNED) AS invalid_time")) {
                assertTrue(row.next());
                assertThrows(SQLException.class, () -> ManagedSchemaTime.timestamp(row, "invalid_time"));
            }
            assertThrows(SQLException.class, () -> statement.execute(
                    "INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                            + " VALUES ('" + tenant + "','session','agent',-1,0)"));
            try (var row =
                    statement.executeQuery(
                            "SELECT CURRENT_TIMESTAMP(6) AS observed_at, CAST('tenant ' AS BINARY) AS tenant_id, X'0102' AS inline_bytes, X'0304' AS record_bytes")) {
                assertTrue(row.next());
                var values = ManagedSchemaRows.read(row);
                assertTrue(values.get("observed_at") instanceof java.sql.Timestamp);
                assertEquals("tenant ", values.get("tenant_id"));
                org.junit.jupiter.api.Assertions.assertArrayEquals(
                        new byte[] {1, 2}, (byte[]) values.get("inline_bytes"));
                org.junit.jupiter.api.Assertions.assertArrayEquals(
                        new byte[] {3, 4}, (byte[]) values.get("record_bytes"));
            }
            try (var row = statement.executeQuery("SELECT VERSION()")) {
                assertTrue(row.next());
                System.out.println("Managed schema MySQL DDL server version: " + row.getString(1));
            }
            statement.execute(
                    "INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                            + " VALUES ('"
                            + tenant
                            + "','"
                            + prefix
                            + "session','agent',0,0)");
            assertThrows(SQLException.class,
                    () -> statement.execute("UPDATE ma_session SET child_depth=-1"));
            assertThrows(SQLException.class,
                    () -> statement.execute("UPDATE ma_session SET is_recovery_protected=2"));
            try (var rows = statement.executeQuery("SELECT id FROM ma_session")) {
                assertTrue(rows.next());
                assertTrue(rows.getLong(1) > 0);
            }
            statement.execute(
                    "INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                            + " VALUES ('"
                            + tenant
                            + "','"
                            + prefix
                            + "session ','agent',0,0)");
            assertThrows(
                    SQLException.class,
                    () ->
                            statement.execute(
                                    "INSERT INTO ma_operation"
                                        + " (operation_ref,scope_kind,scope_id,operation_id,operation_kind,tenant_id,target_kind,target_id,request_digest,request_json,state,phase,gmt_create,gmt_modified)"
                                        + " VALUES ('invalid','SESSION','scope','invalid','CLOSE"
                                        + " ','tenant','SESSION','target','digest','{}','PENDING','ADMITTED',0,0)"));
            statement.execute(
                    "INSERT INTO ma_resource_ref"
                        + " (owner_kind,owner_ref,owner_revision,resource_id,tenant_id,session_id,gmt_create)"
                        + " VALUES"
                        + " ('JOURNAL','scope',1,'missing','tenant','session'," + ManagedSchemaTime.SQL_NOW + ")");
            byte[] largeBody = new byte[17 * 1024 * 1024];
            largeBody[0] = 1;
            largeBody[largeBody.length - 1] = 2;
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO ma_resource ("
                                + "tenant_id,session_id,resource_id,kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create)"
                                + " VALUES"
                                + " (?,?,?,'message-body/1',1,?,?,'MYSQL_INLINE',?,'PUBLISHED'," + ManagedSchemaTime.SQL_NOW + ")")) {
                insert.setString(1, tenant);
                insert.setString(2, prefix + "session");
                insert.setString(3, "large-message");
                insert.setLong(4, largeBody.length);
                insert.setString(
                        5,
                        java.util.HexFormat.of()
                                .formatHex(
                                        java.security.MessageDigest.getInstance("SHA-256")
                                                .digest(largeBody)));
                insert.setBytes(6, largeBody);
                insert.executeUpdate();
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT byte_length,OCTET_LENGTH(inline_bytes) FROM ma_resource WHERE"
                                    + " tenant_id=? AND session_id=? AND resource_id=?")) {
                read.setString(1, tenant);
                read.setString(2, prefix + "session");
                read.setString(3, "large-message");
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    assertEquals(largeBody.length, row.getLong(1));
                    assertEquals(largeBody.length, row.getLong(2));
                }
            }
            try (var remove =
                    connection.prepareStatement(
                            "DELETE FROM ma_resource WHERE tenant_id=? AND session_id=? AND resource_id=?")) {
                remove.setString(1, tenant);
                remove.setString(2, prefix + "session");
                remove.setString(3, "large-message");
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
                    "ALTER TABLE ma_runtime_binding MODIFY is_provision_seeded TINYINT UNSIGNED GENERATED"
                            + " ALWAYS AS (provision_seed_ciphertext IS NULL)");
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute(
                        "ALTER TABLE ma_runtime_binding MODIFY is_provision_seeded TINYINT UNSIGNED GENERATED"
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
            for (String[] column : new String[][] {
                {"is_plan_enabled", "TINYINT NOT NULL DEFAULT 0", "TINYINT UNSIGNED NOT NULL DEFAULT 0"},
                {"child_depth", "INT NULL", "INT UNSIGNED NULL"}
            }) {
                statement.execute("ALTER TABLE ma_session MODIFY " + column[0] + " " + column[1]);
                try {
                    assertThrows(IllegalStateException.class, () -> ManagedSchema.validate(source));
                } finally {
                    statement.execute("ALTER TABLE ma_session MODIFY " + column[0] + " " + column[2]);
                }
                ManagedSchema.validate(source);
            }
            if (mariaDb) {
                String url = connection.getMetaData().getURL();
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
            String operationCheck = ManagedSchema.ddl().lines()
                    .filter(line -> line.contains("CONSTRAINT ck_ma_operation_kind CHECK"))
                    .findFirst().orElseThrow().trim().replaceFirst(",$", "");
            statement.execute("ALTER TABLE ma_operation " + dropCheck + "ck_ma_operation_kind");
            statement.execute("ALTER TABLE ma_operation ADD "
                    + operationCheck.replace("'CLOSE'", "'BROKE'"));
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute("ALTER TABLE ma_operation " + dropCheck + "ck_ma_operation_kind");
                statement.execute("ALTER TABLE ma_operation ADD " + operationCheck);
            }
            String resourceCheck =
                    ManagedSchema.ddl()
                            .lines()
                            .filter(
                                    line ->
                                            line.contains(
                                                    "CONSTRAINT ck_ma_resource_length"
                                                            + " CHECK"))
                            .findFirst()
                            .orElseThrow()
                            .trim()
                            .replaceFirst(",$", "");
            statement.execute("ALTER TABLE ma_resource " + dropCheck + "ck_ma_resource_length");
            statement.execute(
                    "ALTER TABLE ma_resource ADD "
                            + resourceCheck.replace("byte_length >= 0", "byte_length >= -1"));
            try {
                assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            } finally {
                statement.execute(
                        "ALTER TABLE ma_resource " + dropCheck + "ck_ma_resource_length");
                statement.execute("ALTER TABLE ma_resource ADD " + resourceCheck);
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
            try (var rs = statement.executeQuery(
                    "SELECT CHARACTER_MAXIMUM_LENGTH, COLLATION_NAME FROM information_schema.columns"
                            + " WHERE table_schema = DATABASE() AND table_name = 'ma_tenant_guard'"
                            + " AND column_name = 'tenant_id'")) {
                org.junit.jupiter.api.Assertions.assertTrue(rs.next());
                org.junit.jupiter.api.Assertions.assertEquals(96L, rs.getLong(1));
                org.junit.jupiter.api.Assertions.assertEquals("utf8mb4_0900_bin", rs.getString(2));
            }
        }
    }

    private static void verifyCaptureTimestampDefaults(java.sql.Connection connection, String prefix)
            throws SQLException {
        String tenant = prefix.substring(0, 36);
        String scope = ManagedIdentityRefs.publicationScopeRef(tenant, "workspace", "session");
        try (var statement = connection.createStatement()) {
            long before;
            try (var row = statement.executeQuery("SELECT " + ManagedSchemaTime.SQL_NOW)) {
                assertTrue(row.next());
                before = row.getLong(1);
            }
            try (var insert = connection.prepareStatement(
                    "INSERT INTO ma_output_capture (scope_ref,tenant_id,workspace_id,session_id,"
                            + "publication_id,execution_call_id,capture_id,binding_json,binding_digest,token_hash,state,"
                            + "capture_bytes,producer_bytes,admission_bytes) VALUES (?,?,?,?,?,?,?,'{}',?,?,'OPEN',1,1,1)")) {
                insert.setString(1, scope);
                insert.setString(2, tenant);
                insert.setString(3, "workspace");
                insert.setString(4, "session");
                insert.setString(5, "publication");
                insert.setString(6, "execution");
                insert.setString(7, "capture");
                insert.setString(8, ManagedSchemaKeys.key(prefix, "binding"));
                insert.setString(9, ManagedSchemaKeys.key(prefix, "token"));
                assertEquals(1, insert.executeUpdate());
            }
            try (var query = connection.prepareStatement("SELECT gmt_create,gmt_modified,"
                    + ManagedSchemaTime.SQL_NOW + " AS db_now FROM ma_output_capture WHERE scope_ref=?")) {
                query.setString(1, scope);
                try (var row = query.executeQuery()) {
                    assertTrue(row.next());
                    long created = row.getLong("gmt_create");
                    assertEquals(created, row.getLong("gmt_modified"));
                    assertTrue(created >= before && created <= row.getLong("db_now"));
                    assertEquals(created, ManagedSchemaTime.timestamp(row, "gmt_create").getTime());
                }
            } finally {
                try (var remove = connection.prepareStatement("DELETE FROM ma_output_capture WHERE scope_ref=?")) {
                    remove.setString(1, scope);
                    remove.executeUpdate();
                }
            }
        }
    }

    private static void verifyMaximumStorageScopeKeys(java.sql.Connection connection, String prefix)
            throws Exception {
        // Opaque identities padded to each column's budget: the probe exercises
        // indexed access at maximum width, not reference shape.
        String tenant = prefix.substring(0, 36);
        String session = prefix + "s".repeat(64 - prefix.length());
        byte[] storage = "v".repeat(1024).getBytes(StandardCharsets.UTF_8);
        byte[] bindingStorage = "v".repeat(256).getBytes(StandardCharsets.UTF_8);
        byte[] workspace =
                (prefix + "w".repeat(512 - prefix.length())).getBytes(StandardCharsets.UTF_8);
        byte[] binding =
                (prefix + "b".repeat(2048 - prefix.length())).getBytes(StandardCharsets.UTF_8);
        String request = "r".repeat(3000);
        String scope = "c".repeat(2048);
        String physical = "p".repeat(512);
        try (var insert =
                connection.prepareStatement(
                        "INSERT INTO"
                            + " ma_session(tenant_id,session_id,session_kind,workspace_storage_id,gmt_create,gmt_modified)"
                            + " VALUES(?,?,'CONTROL',?,0,0)")) {
            insert.setString(1, tenant);
            insert.setString(2, session);
            insert.setBytes(3, storage);
            insert.executeUpdate();
        }
        try {
            try (var invalid =
                    connection.prepareStatement(
                            "UPDATE ma_session SET is_resource_gc_completed=2 WHERE tenant_id=? AND"
                                    + " session_id=?")) {
                invalid.setString(1, tenant);
                invalid.setString(2, session);
                assertThrows(SQLException.class, invalid::executeUpdate);
            }
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO"
                                + " ma_session_head(tenant_id,session_id,workspace_id,"
                                + "harness_session_id,head_kind,state,"
                                + "writer_generation,journal_revision,committed_sequence,activation_epoch,gmt_create,gmt_modified)"
                                + " VALUES(?,?,?,?,'MANAGED_SESSION','OPEN',"
                                + "0,0,0,0," + ManagedSchemaTime.SQL_NOW + "," + ManagedSchemaTime.SQL_NOW + ")")) {
                insert.setString(1, tenant);
                insert.setString(2, session);
                insert.setBytes(3, workspace);
                insert.setString(4, session);
                insert.executeUpdate();
            }
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO"
                                + " ma_runtime_binding(binding_id,request_id,scope_id,tenant_id,"
                                + "workspace_id,workspace_generation,canonical_cwd,capability_digest,"
                                + "isolation_class,provisioner_kind,storage_id,runtime_generation,"
                                + "binding_state,attestation_generation,is_drain_requested,operation_generation,record_version,last_active_at)"
                                + " VALUES(?,?,?,?,?,?,'cwd',?,'WORKSPACE',"
                                + "'schema-test',?,1,'ACTIVE',0,FALSE,0,0," + ManagedSchemaTime.SQL_NOW + ")")) {
                insert.setBytes(1, binding);
                insert.setString(2, request);
                insert.setString(3, scope);
                insert.setString(4, tenant);
                insert.setString(5, session);
                insert.setBytes(6, new byte[] {'1'});
                insert.setBytes(7, new byte[] {'c'});
                insert.setBytes(8, bindingStorage);
                insert.executeUpdate();
            }
            try (var insert =
                    connection.prepareStatement(
                            "INSERT INTO ma_storage_owner(physical_id,binding_id,runtime_generation)"
                                    + " VALUES(?,?,1)")) {
                insert.setString(1, physical);
                insert.setBytes(2, binding);
                insert.executeUpdate();
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT physical_id FROM ma_storage_owner FORCE"
                                    + " INDEX(idx_ma_storage_owner_binding) WHERE binding_id=? AND"
                                    + " runtime_generation=1")) {
                read.setBytes(1, binding);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    assertEquals(physical, row.getString(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT session_id FROM ma_session_head FORCE"
                                    + " INDEX(idx_ma_head_workspace) WHERE tenant_id=? AND"
                                    + " workspace_id=?")) {
                read.setString(1, tenant);
                read.setBytes(2, workspace);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    assertEquals(session, row.getString(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT session_id FROM ma_session FORCE"
                                    + " INDEX(idx_ma_session_storage_scope) WHERE tenant_id=? AND"
                                    + " workspace_storage_id=? AND is_resource_gc_completed=0")) {
                read.setString(1, tenant);
                read.setBytes(2, storage);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    assertEquals(session, row.getString(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT binding_id FROM ma_runtime_binding FORCE"
                                    + " INDEX(idx_ma_runtime_storage_alias_state) WHERE"
                                    + " tenant_id=? AND storage_id=? AND binding_state='ACTIVE' AND"
                                    + " is_provision_seeded=FALSE")) {
                read.setString(1, tenant);
                read.setBytes(2, bindingStorage);
                try (var row = read.executeQuery()) {
                    assertTrue(row.next());
                    org.junit.jupiter.api.Assertions.assertArrayEquals(binding, row.getBytes(1));
                    assertFalse(row.next());
                }
            }
            try (var read =
                    connection.prepareStatement(
                            "SELECT runtime_session_id FROM ma_runtime_session FORCE"
                                    + " INDEX(idx_ma_runtime_session_harness) WHERE"
                                    + " harness_session_id=? AND tenant_id=?")) {
                read.setString(1, session);
                read.setString(2, tenant);
                try (var row = read.executeQuery()) {
                    assertFalse(row.next());
                }
            }
        } finally {
            try (var remove =
                    connection.prepareStatement(
                            "DELETE FROM ma_storage_owner WHERE physical_id=?")) {
                remove.setString(1, physical);
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
                            "DELETE FROM ma_session_head WHERE tenant_id=? AND harness_session_id=?")) {
                remove.setString(1, tenant);
                remove.setString(2, session);
                remove.executeUpdate();
            }
            try (var remove =
                    connection.prepareStatement(
                            "DELETE FROM ma_session WHERE tenant_id=? AND session_id=?")) {
                remove.setString(1, tenant);
                remove.setString(2, session);
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
