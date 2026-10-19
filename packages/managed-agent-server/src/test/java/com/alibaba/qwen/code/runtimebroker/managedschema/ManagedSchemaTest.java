package com.alibaba.qwen.code.runtimebroker.managedschema;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import javax.sql.DataSource;

class ManagedSchemaTest {
    @Test
    void upgradesV4WithoutChangingExistingSessionOrTurnModels() throws Exception {
        DataSource source = source();
        executeResource(source, ManagedSchema.RESOURCE);
        executeResource(source, ManagedSchema.PRIVATE_AUTHORITY);
        executeResource(source, ManagedSchema.SESSION_LIST);
        executeResource(source, ManagedSchema.WORKSPACE_CREATION);
        assertEquals(4, ManagedSchema.schemaVersion(source));
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            statement.execute("INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                    + " VALUES ('tenant','session','qwen-code',1,1)");
            statement.execute("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,"
                    + "payload_digest,status,gmt_create,gmt_modified) VALUES ('tenant','session','turn',"
                    + "'prompt','[]','digest','COMPLETED',1,1)");
        }
        ManagedSchema.initialize(source);
        assertEquals(10, ManagedSchema.schemaVersion(source));
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            try (var row = statement.executeQuery("SELECT model_id,model_revision FROM ma_session")) {
                assertTrue(row.next());
                assertNull(row.getObject(1));
                assertEquals(0, row.getLong(2));
            }
            try (var row = statement.executeQuery("SELECT model_id,model_revision FROM ma_turn")) {
                assertTrue(row.next());
                assertNull(row.getObject(1));
                assertNull(row.getObject(2));
            }
            assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_session SET model_id='m'"));
            assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_turn SET model_id='m'"));
            assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_turn SET model_revision=1"));
            statement.execute("UPDATE ma_session SET model_id='m',model_revision=1");
            statement.execute("UPDATE ma_turn SET model_id='m',model_revision=1");
            assertThrows(SQLException.class, () -> statement.execute("UPDATE ma_session SET model_revision=9007199254740992"));
        }
        ManagedSchema.validate(source);
    }

    @Test
    void initializesExactly32TablesAndValidatesWithoutRewriting() throws Exception {
        DataSource source = source();
        ManagedSchema.initialize(source);
        ManagedSchema.initialize(source);
        ManagedSchema.validate(source);
        assertEquals(10, ManagedSchema.schemaVersion(source));
        try (var connection = source.getConnection()) {
            assertEquals(
                    ManagedSchemaContract.TABLES, ManagedSchemaCatalog.tables(connection).keySet());
            assertEquals(32, ManagedSchemaCatalog.tables(connection).size());
        }
    }

    @Test
    void upgradesUnversionedV1AndV2WhilePreservingReceipts() throws Exception {
        for (int version : new int[] {1, 2}) {
            DataSource source = source();
            executeResource(source, ManagedSchema.RESOURCE);
            if (version == 2) {
                executeResource(source, ManagedSchema.PRIVATE_AUTHORITY);
            }
            assertEquals(version, ManagedSchema.schemaVersion(source));
            try (var connection = source.getConnection()) {
                receipt(connection, "old", "SESSION_COMMAND");
                assertThrows(
                        SQLException.class,
                        () -> receipt(connection, "unsupported", "WORKSPACE_CREATE"));
            }
            ManagedSchema.initialize(source);
            assertEquals(10, ManagedSchema.schemaVersion(source));
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                receipt(connection, "new", "WORKSPACE_CREATE");
                try (var row = statement.executeQuery("SELECT COUNT(*) FROM ma_request_receipt")) {
                    assertTrue(row.next());
                    assertEquals(2, row.getInt(1));
                }
                for (String invalid : Set.of("WORKSPACE_CREATE ", "workspace_create", "OTHER")) {
                    assertThrows(SQLException.class, () -> receipt(connection, invalid, invalid));
                }
            }
        }
    }

    @Test
    void rejectsSameNameNamespaceConstraintWithAnUnpublishedDefinition() throws Exception {
        DataSource source = initialized();
        String declaration =
                ManagedSchema.ddl()
                        .lines()
                        .filter(line -> line.contains("CONSTRAINT ck_ma_request_namespace CHECK"))
                        .findFirst()
                        .orElseThrow()
                        .trim()
                        .replaceFirst(",$", "");
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute(
                    "ALTER TABLE ma_request_receipt DROP CONSTRAINT ck_ma_request_namespace");
            statement.execute(
                    "ALTER TABLE ma_request_receipt ADD "
                            + declaration.replace("'WORKSPACE_CREATE'", "'WORKSPACE_ATTACK'"));
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.schemaVersion(source));
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
    }

    @Test
    void supportsDriversThatReportUppercaseMetadata() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:managed-schema-upper-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        ManagedSchema.validate(source);
    }

    @Test
    void rejectsForeignLegacyAndPartialSchemasBeforeCreatingAnything() throws Exception {
        for (String table : Set.of("managed_agent_session", "business_data", "ma_session")) {
            DataSource source = source();
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                statement.execute("CREATE TABLE " + table + " (witness INT NOT NULL)");
                statement.execute("INSERT INTO " + table + " VALUES (42)");
            }
            assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                assertEquals(Set.of(table), ManagedSchemaCatalog.tables(connection).keySet());
                try (var row = statement.executeQuery("SELECT witness FROM " + table)) {
                    assertTrue(row.next());
                    assertEquals(42, row.getInt(1));
                }
            }
        }
    }

    @Test
    void rejectsHistoryOnlyDatabaseBeforeCreatingTargetTables() throws Exception {
        DataSource source = source();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE flyway_schema_history (witness INT NOT NULL)");
            statement.execute("INSERT INTO flyway_schema_history VALUES (42)");
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            assertTrue(ManagedSchemaCatalog.tables(connection).isEmpty());
            try (var row = statement.executeQuery("SELECT witness FROM flyway_schema_history")) {
                assertTrue(row.next());
                assertEquals(42, row.getInt(1));
            }
        }
    }

    @Test
    void rejectsColumnAndConstraintDriftWithoutRepairingIt() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute("DROP INDEX ix_ma_read_session");
            statement.execute("ALTER TABLE ma_read_lease DROP COLUMN expires_at");
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
        DataSource missingConstraint = initialized();
        try (var connection = missingConstraint.getConnection();
                var statement = connection.createStatement()) {
            statement.execute("ALTER TABLE ma_operation DROP CONSTRAINT ck_ma_operation_kind");
        }
        assertThrows(
                IllegalStateException.class, () -> ManagedSchema.initialize(missingConstraint));
    }

    @Test
    void requiresIndexedPhysicalStorageScopesWithoutRepairingDrift() throws Exception {
        for (String index :
                Set.of(
                        "ix_ma_runtime_storage_alias_state",
                        "ix_ma_session_storage_scope",
                        "ix_ma_head_workspace",
                        "ix_ma_storage_owner_binding")) {
            DataSource source = initialized();
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                statement.execute("DROP INDEX " + index);
            }
            assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
        }
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute(
                    "ALTER TABLE ma_runtime_binding ALTER COLUMN storage_alias_key SET NOT NULL");
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
        DataSource missingCompletionCheck = initialized();
        try (var connection = missingCompletionCheck.getConnection();
                var statement = connection.createStatement()) {
            statement.execute("ALTER TABLE ma_session DROP CONSTRAINT ck_ma_session_resource_gc");
        }
        assertThrows(
                IllegalStateException.class,
                () -> ManagedSchema.initialize(missingCompletionCheck));
    }

    @Test
    void rejectsTightenedNullableControlHeadFields() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute(
                    "ALTER TABLE ma_session_head ALTER COLUMN journal_revision SET NOT NULL");
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
    }

    @Test
    void rejectsDatetimeLeaseColumns() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute(
                    "ALTER TABLE ma_session_head ALTER COLUMN writer_lease_until DATETIME(0)");
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
    }

    @Test
    void rejectsSameNameConstraintsWithDifferentRules() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute("ALTER TABLE ma_operation DROP CONSTRAINT ck_ma_operation_kind");
            statement.execute(
                    "ALTER TABLE ma_operation ADD CONSTRAINT ck_ma_operation_kind CHECK"
                            + " (claim_generation >= 0)");
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
    }

    @Test
    void rejectsChangedUnderscoredOwnerKindInsteadOfTreatingItAsCharsetMetadata() throws Exception {
        DataSource source = initialized();
        String declaration =
                ManagedSchema.ddl()
                        .lines()
                        .filter(line -> line.contains("CONSTRAINT ck_ma_ref_owner CHECK"))
                        .findFirst()
                        .orElseThrow()
                        .trim()
                        .replaceFirst(",$", "");
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute("ALTER TABLE ma_resource_ref DROP CONSTRAINT ck_ma_ref_owner");
            statement.execute(
                    "ALTER TABLE ma_resource_ref ADD "
                            + declaration.replace("'SESSION_RECORD'", "'SESSION_ATTACK'"));
        }
        assertThrows(IllegalStateException.class, () -> ManagedSchema.initialize(source));
    }

    @Test
    void retainsBytePreciseIdentitiesAndSeparatePublicUniqueness() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection()) {
            session(connection, "tenant", "session", "PUBLIC");
            session(connection, "tenant", "session ", "PUBLIC");
            session(connection, "tenant", "SESSION", "PUBLIC");
            session(connection, "another", "session", "CONTROL");
            assertThrows(
                    SQLException.class, () -> session(connection, "third", "session", "PUBLIC"));
            try (var statement = connection.createStatement();
                    var result =
                            statement.executeQuery(
                                    "SELECT tenant_id, session_id, creator_actor_key FROM"
                                            + " ma_session WHERE session_kind = 'CONTROL'")) {
                assertTrue(result.next());
                Map<String, Object> row = ManagedSchemaRows.read(result);
                assertEquals("another", row.get("tenant_id"));
                assertEquals("session", row.get("session_id"));
                assertNull(row.get("creator_actor_key"));
            }
        }
    }

    @Test
    void requiresCompletePublicBindingsWhileAllowingControlOnlyBindings() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            session(connection, "tenant", "public", "PUBLIC");
            assertThrows(
                    SQLException.class,
                    () -> statement.execute("UPDATE ma_session SET workspace_id = 'workspace'"));
            statement.execute(
                    "UPDATE ma_session SET workspace_id = 'workspace',workspace_generation ="
                            + " 1,workspace_storage_id = 'storage',cwd_relative ="
                            + " '.',context_config_ref = 'config',context_revision ="
                            + " 1,workspace_config_ref = 'config',workspace_policy_ref = 'policy'");
            assertThrows(
                    SQLException.class,
                    () -> statement.execute("UPDATE ma_session SET context_revision = NULL"));
            assertThrows(
                    SQLException.class,
                    () -> statement.execute("UPDATE ma_session SET workspace_generation = 0"));
            session(connection, "tenant", "control", "CONTROL");
            statement.execute(
                    "UPDATE ma_session SET workspace_id = 'control-workspace'"
                            + " WHERE session_kind = 'CONTROL'");
        }
        ManagedSchema.validate(source);
    }

    @Test
    void snapshotPageDirectoryRequiresCompleteTypedMetadataAndUniqueOrdinals() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection()) {
            snapshotPage(connection, "first", "managed-snapshot-page", "snapshot", 0, 1L, 100L);
            assertThrows(
                    SQLException.class,
                    () ->
                            snapshotPage(
                                    connection,
                                    "duplicate",
                                    "managed-snapshot-page",
                                    "snapshot",
                                    0,
                                    1L,
                                    100L));
            assertThrows(
                    SQLException.class,
                    () ->
                            snapshotPage(
                                    connection,
                                    "incomplete",
                                    "managed-snapshot-page",
                                    "snapshot",
                                    null,
                                    1L,
                                    100L));
            assertThrows(
                    SQLException.class,
                    () ->
                            snapshotPage(
                                    connection,
                                    "missing",
                                    "managed-snapshot-page",
                                    null,
                                    null,
                                    null,
                                    null));
            assertThrows(
                    SQLException.class,
                    () ->
                            snapshotPage(
                                    connection,
                                    "backward",
                                    "managed-snapshot-page",
                                    "snapshot",
                                    1,
                                    101L,
                                    100L));
            assertThrows(
                    SQLException.class,
                    () ->
                            snapshotPage(
                                    connection,
                                    "wrong-kind",
                                    "managed-context",
                                    "snapshot",
                                    1,
                                    101L,
                                    200L));
        }
        ManagedSchema.validate(source);
    }

    @Test
    void harnessBarrierHasNoInventedJournalAndStorageFenceHasNoInventedPhysicalOwner()
            throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute(
                    "INSERT INTO ma_session_head"
                        + " (tenant_key,harness_key,tenant_id,session_id,harness_session_id,head_kind,gmt_create,gmt_modified,o3_backfill_pending)"
                        + " VALUES ('tenant',"
                        + "'harness','tenant','harness','harness','HARNESS'," + ManagedSchemaTime.SQL_NOW + "," + ManagedSchemaTime.SQL_NOW + ",FALSE)");
            try (var row =
                    statement.executeQuery(
                            "SELECT journal_revision,writer_generation,activation_epoch FROM"
                                    + " ma_session_head")) {
                assertTrue(row.next());
                assertNull(row.getObject(1));
                assertNull(row.getObject(2));
                assertNull(row.getObject(3));
            }
            assertThrows(
                    SQLException.class,
                    () -> statement.execute("UPDATE ma_session_head SET journal_revision = 0"));
            statement.execute(
                    "INSERT INTO ma_storage (alias_key,tenant_key,storage_key,tenant_id,storage_id)"
                            + " VALUES ('alias','tenant','storage','tenant','storage')");
            try (var row =
                    statement.executeQuery(
                            "SELECT registration_state,physical_key FROM ma_storage")) {
                assertTrue(row.next());
                assertEquals("FENCE_ONLY", row.getString(1));
                assertNull(row.getObject(2));
            }
            assertThrows(
                    SQLException.class,
                    () ->
                            statement.execute(
                                    "UPDATE ma_storage SET registration_state = 'REGISTERED'"));
        }
    }

    @Test
    void enforcesWorkspaceDefaultAndStrictAclRoles() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            workspace(statement, "first", true);
            assertThrows(SQLException.class, () -> workspace(statement, "second", true));
            workspace(statement, "second", false);
            statement.execute(
                    "INSERT INTO ma_workspace_access (tenant_id,workspace_id,actor_id,role)"
                            + " VALUES ('tenant','first','actor','READER')");
            assertThrows(
                    SQLException.class,
                    () ->
                            statement.execute(
                                    "INSERT INTO ma_workspace_access"
                                            + " (tenant_id,workspace_id,actor_id,role) VALUES"
                                            + " ('tenant','first','another','READER ' )"));
        }
    }

    @Test
    void operationKindsCannotBypassCaptureRequestIdentityOrGenerationChecks() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            operation(statement, "one", "OUTPUT_UPLOAD", "same", "capture");
            assertThrows(
                    SQLException.class,
                    () -> operation(statement, "two", "OUTPUT_FINISH", "same", "capture"));
            operation(statement, "three", "OBJECT_PUT", "same", "capture");
            operation(statement, "four", "CAPTURE_GC", "same", "capture");
            assertThrows(
                    SQLException.class,
                    () -> operation(statement, "unknown", "ARBITRARY_WORKFLOW", "unknown", null));
            assertThrows(
                    SQLException.class,
                    () -> operation(statement, "padded", "CLOSE ", "padded", null));
            assertThrows(
                    SQLException.class,
                    () -> statement.execute("UPDATE ma_operation SET claim_generation = -1"));
        }
    }

    // Each migration re-adds ck_ma_operation_kind whole, so one built from a
    // stale chain silently drops a kind a shipped route writes.
    @Test
    void theCurrentOperationKindCheckAdmitsEveryShippedKind() throws Exception {
        DataSource migrated = source();
        Flyway.configure()
                .dataSource(migrated)
                .locations(ManagedSchema.FLYWAY_LOCATION)
                .load()
                .migrate();
        for (DataSource source : new DataSource[] {initialized(), migrated}) {
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                for (var kind : ManagedSchemaContract.OperationKind.values()) {
                    operation(statement, kind.name(), kind.name(), kind.name(), null);
                }
                // SshWorkspaceStore writes this kind as a plain string.
                operation(statement, "WORKSPACE_CREATE", "WORKSPACE_CREATE",
                        "WORKSPACE_CREATE", null);
                assertThrows(SQLException.class,
                        () -> operation(statement, "unknown", "INPUT", "unknown", null));
            }
        }
    }

    @Test
    void hookOnceAndResourceReferencesAreDatabaseConstraints() throws Exception {
        DataSource source = initialized();
        try (var connection = source.getConnection();
                var statement = connection.createStatement()) {
            String prefix =
                    "INSERT INTO ma_session_record"
                        + " (session_scope_key,record_key,tenant_id,workspace_id,session_id,domain,record_id,revision,gmt_create,record_resource_id,hook_once_key_hash)"
                        + " VALUES ";
            statement.execute(
                    prefix
                            + "('scope','record1','tenant','workspace','session','hook','record1',1,0,'body','once')");
            assertThrows(
                    SQLException.class,
                    () ->
                            statement.execute(
                                    prefix
                                            + "('scope','record2','tenant','workspace','session','hook','record2',1,0,'body','once')"));
            assertThrows(
                    SQLException.class,
                    () ->
                            statement.execute(
                                    "INSERT INTO ma_resource_ref"
                                        + " (session_scope_key,owner_kind,owner_key,owner_revision,resource_key,tenant_id,session_id,gmt_create)"
                                        + " VALUES"
                                        + " ('scope','JOURNAL','scope',1,'missing','tenant','session'," + ManagedSchemaTime.SQL_NOW + ")"));
        }
    }

    @Test
    void jdbcRowAdapterPreservesBodiesAndAuthBytesAndNormalizesTemporalValues() throws Exception {
        try (var connection = source().getConnection();
                var statement = connection.createStatement();
                var row =
                        statement.executeQuery(
                                "SELECT CAST(X'0102' AS BLOB) AS inline_bytes, CAST('record' AS CLOB) AS record_json, CAST('tenant ' AS VARBINARY) AS tenant_id, CAST(X'0304' AS VARBINARY) AS actor_key, CAST(CURRENT_TIMESTAMP(6) AS TIMESTAMP) AS observed_at")) {
            assertTrue(row.next());
            var values = ManagedSchemaRows.read(row);
            org.junit.jupiter.api.Assertions.assertArrayEquals(
                    new byte[] {1, 2}, (byte[]) values.get("inline_bytes"));
            org.junit.jupiter.api.Assertions.assertArrayEquals(
                    new byte[] {3, 4}, (byte[]) values.get("actor_key"));
            assertEquals("record", values.get("record_json"));
            assertEquals("tenant ", values.get("tenant_id"));
            assertTrue(values.get("observed_at") instanceof java.sql.Timestamp);
        }
    }

    @Test
    void all63OriginalEntitiesHaveOnlyRealTargetDestinations() throws Exception {
        var inventory = ManagedSchemaMapping.inventory();
        assertEquals(63, inventory.size());
        try (var source = getClass().getResourceAsStream("/original-managed-table-inventory.tsv")) {
            String original =
                    new String(
                            java.util.Objects.requireNonNull(source).readAllBytes(),
                            java.nio.charset.StandardCharsets.UTF_8);
            Set<String> originalNames =
                    original.lines()
                            .filter(line -> !line.startsWith("#") && !line.isBlank())
                            .map(line -> line.split("\\t")[0])
                            .collect(java.util.stream.Collectors.toSet());
            assertEquals(63, originalNames.size());
            assertEquals(originalNames, inventory.keySet());
        }
        assertTrue(
                inventory.values().stream()
                        .allMatch(
                                tables ->
                                        !tables.isEmpty()
                                                && ManagedSchemaContract.TABLES.containsAll(
                                                        tables)));
        assertEquals(
                ManagedSchemaContract.TABLES,
                inventory.values().stream()
                        .flatMap(java.util.Collection::stream)
                        .collect(java.util.stream.Collectors.toSet()));
        assertEquals(Set.of("ma_message"), Set.copyOf(inventory.get("managed_agent_item_part")));
        assertEquals(
                Set.of("ma_storage_owner"),
                Set.copyOf(inventory.get("managed_workspace_execution_lease")));
        assertEquals(
                Set.of("ma_session_head"), Set.copyOf(inventory.get("qwen_runtime_harness_drain")));
        assertEquals(
                Set.of("ma_event_stream", "ma_resource_ref"),
                Set.copyOf(inventory.get("qwen_managed_session_task_journal_cursor")));
    }

    @Test
    void tupleKeysDoNotNormalizeIdentityOrAmbiguouslyConcatenateComponents() {
        assertNotEquals(ManagedSchemaKeys.key("ab", "c"), ManagedSchemaKeys.key("a", "bc"));
        assertNotEquals(
                ManagedSchemaKeys.key("tenant", "session"),
                ManagedSchemaKeys.key("tenant", "session "));
        assertNotEquals(
                ManagedSchemaKeys.key("tenant", "SESSION"),
                ManagedSchemaKeys.key("tenant", "session"));
        assertNotEquals(ManagedSchemaKeys.key("é"), ManagedSchemaKeys.key("e\u0301"));
        assertEquals(64, ManagedSchemaKeys.key("identity").length());
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaKeys.key("\ud800"));
        assertThrows(IllegalArgumentException.class, ManagedSchemaKeys::key);
    }

    private static void snapshotPage(
            Connection connection,
            String key,
            String kind,
            String snapshot,
            Integer ordinal,
            Long first,
            Long last)
            throws SQLException {
        try (var statement =
                connection.prepareStatement(
                        "INSERT INTO ma_resource"
                            + " (resource_key,session_scope_key,tenant_id,session_id,resource_id,kind,schema_version,byte_length,"
                            + "sha256,storage_kind,inline_bytes,state,gmt_create,snapshot_id,snapshot_page_ordinal,snapshot_page_first_sequence,snapshot_page_last_sequence)"
                            + " VALUES"
                            + " (?,'scope',?,?,?,?,1,0,?,'MYSQL_INLINE',?,'REFERENCED'," + ManagedSchemaTime.SQL_NOW + ",?,?,?,?)")) {
            statement.setString(1, key);
            statement.setBytes(2, ManagedSchemaKeys.identity("tenant"));
            statement.setBytes(3, ManagedSchemaKeys.identity("session"));
            statement.setBytes(4, ManagedSchemaKeys.identity(key));
            statement.setBytes(5, ManagedSchemaKeys.identity(kind));
            statement.setString(6, "a".repeat(64));
            statement.setBytes(7, new byte[0]);
            statement.setBytes(8, snapshot == null ? null : ManagedSchemaKeys.identity(snapshot));
            statement.setObject(9, ordinal);
            statement.setObject(10, first);
            statement.setObject(11, last);
            statement.executeUpdate();
        }
    }

    private static void session(Connection connection, String tenant, String session, String kind)
            throws SQLException {
        try (var statement =
                connection.prepareStatement(
                        "INSERT INTO ma_session"
                            + " (tenant_id,session_id,agent_id,session_kind,gmt_create,gmt_modified)"
                            + " VALUES (?,?,?,?,0,0)")) {
            statement.setBytes(1, ManagedSchemaKeys.identity(tenant));
            statement.setBytes(2, ManagedSchemaKeys.identity(session));
            statement.setBytes(3, ManagedSchemaKeys.identity("agent"));
            statement.setString(4, kind);
            statement.executeUpdate();
        }
    }

    private static void workspace(java.sql.Statement statement, String id, boolean isDefault)
            throws SQLException {
        statement.execute(
                "INSERT INTO ma_workspace (tenant_id,workspace_id,workspace_generation,storage_id,"
                        + "display_name,config_ref,policy_ref,state,is_default) VALUES ('tenant','"
                        + id
                        + "',1,'storage','Workspace','config','policy','ACTIVE',"
                        + isDefault
                        + ")");
    }

    private static void operation(
            java.sql.Statement statement, String key, String kind, String id, String capture)
            throws SQLException {
        statement.execute(
                "INSERT INTO ma_operation"
                    + " (operation_key,scope_key,operation_id,operation_kind,tenant_id,"
                    + "target_kind,target_key,request_digest,request_json,state,phase,publication_id,gmt_create,gmt_modified)"
                    + " VALUES ('"
                        + key
                        + "','scope','"
                        + id
                        + "','"
                        + kind
                        + "','tenant','CAPTURE','target','digest','{}','PENDING','ADMITTED',"
                        + (capture == null ? "NULL" : "'" + capture + "'")
                        + ",0,0)");
    }

    private static DataSource initialized() {
        DataSource source = source();
        ManagedSchema.initialize(source);
        return source;
    }

    private static void executeResource(DataSource source, String resource) throws Exception {
        try (var connection = source.getConnection();
                var statement = connection.createStatement();
                var input = ManagedSchema.class.getResourceAsStream(resource)) {
            for (String sql :
                    new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)
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
                            + " idempotency_digest, request_digest, state, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, 'tenant-key', 'tenant', 'ACTOR', 'scope', 'actor', ?,"
                            + " ?, 'digest', 'PENDING', 1, 1)")) {
            statement.setString(1, ManagedSchemaKeys.key(key));
            statement.setString(2, namespace);
            statement.setString(3, key);
            statement.setString(4, ManagedSchemaKeys.key(key));
            statement.executeUpdate();
        }
    }

    private static DataSource source() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:managed-schema-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return source;
    }
}
