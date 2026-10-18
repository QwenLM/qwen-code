package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class ManagedSchemaConfigurationTest {
    @Test
    void upgradesPublishedCatalogsWithoutChangingHistoryOrOrdinaryRows() throws Exception {
        for (int version : new int[] {1, 2, 3, 4, 5, 6, 7, 8, 9}) {
            var source = source();
            Flyway.configure()
                    .dataSource(source)
                    .locations(ManagedSchema.FLYWAY_LOCATION)
                    .target(Integer.toString(version))
                    .load()
                    .migrate();
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                            + " gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                    "Tenant ",
                    "Session");
            var history =
                    jdbc.queryForList(
                            "SELECT * FROM \"flyway_schema_history\" ORDER BY \"installed_rank\"");
            var lastInstalledRank =
                    jdbc.queryForObject(
                            "SELECT MAX(\"installed_rank\") FROM \"flyway_schema_history\"",
                            Integer.class);
            var session = jdbc.queryForMap("SELECT "
                    + ManagedSchemaProjection.SESSION.columns().replace(
                            ", runtime_request_key, csi_guard", "")
                            .replace(", model_id, model_revision", "")
                            .replace(", selected_approval_mode, approval_revision, plan_enabled", "") + " FROM ma_session");
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(version);
            assertThatThrownBy(() -> ManagedSchema.initialize(source))
                    .hasRootCauseMessage(
                            "The canonical V"
                                    + version
                                    + " catalog requires the application's V"
                                    + (version + 1) + " migration");
            var current =
                    Flyway.configure()
                            .dataSource(source)
                            .locations(ManagedSchema.FLYWAY_LOCATION)
                            .load();
            new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(current);
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(10);
            assertThat(sessionListColumns(source)).containsExactly("tenant_id", "gmt_create", "session_id");
            assertThat(
                            jdbc.queryForList(
                                    "SELECT * FROM \"flyway_schema_history\" WHERE"
                                        + " \"installed_rank\" <= ? ORDER BY \"installed_rank\"",
                                    lastInstalledRank))
                    .isEqualTo(history);
            assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session"))
                    .containsAllEntriesOf(session)
                    .containsEntry("csi_guard", false)
                    .containsEntry("runtime_request_key", null)
                    .containsEntry("model_id", null)
                    .containsEntry("model_revision", 0L)
                    .containsEntry("selected_approval_mode", null)
                    .containsEntry("approval_revision", 0L);
            assertThat(
                            jdbc.queryForObject(
                                    "SELECT COUNT(*) FROM \"flyway_schema_history\" WHERE"
                                            + " \"success\" = TRUE AND \"version\" = '3'",
                                    Integer.class))
                    .isEqualTo(1);
            new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(current);
            ManagedSchema.validate(source);
        }
    }

    @Test
    void baselinesTheActualUnversionedCanonicalCatalog() throws Exception {
        for (int version : new int[] {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}) {
            var source = source();
            if (version < 10) {
                executeResource(source, ManagedSchema.RESOURCE);
                if (version >= 2) {
                    executeResource(source, ManagedSchema.PRIVATE_AUTHORITY);
                }
                if (version >= 3) {
                    executeResource(source, ManagedSchema.SESSION_LIST);
                }
                if (version >= 4) {
                    executeResource(source, ManagedSchema.WORKSPACE_CREATION);
                }
                if (version >= 5) {
                    executeResource(source, ManagedSchema.MODEL_SELECTION);
                }
                if (version >= 6) {
                    executeResource(source, ManagedSchema.APPROVAL_SELECTION);
                }
                if (version >= 7) {
                    executeResource(source, ManagedSchema.SSH_WORKSPACE);
                }
                if (version >= 8) {
                    executeResource(source, ManagedSchema.TURN_COMMAND_OPERATIONS);
                }
                if (version >= 9) {
                    executeResource(source, ManagedSchema.RUNTIME_SESSION_HARNESS);
                }
            } else {
                ManagedSchema.initialize(source);
            }
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified) VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1)");
            var flyway =
                    Flyway.configure()
                            .dataSource(source)
                            .locations(ManagedSchema.FLYWAY_LOCATION)
                            .load();
            new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(flyway);
            assertThat(
                            jdbc.queryForObject(
                                    "SELECT \"version\" FROM \"flyway_schema_history\" WHERE"
                                            + " \"type\" = 'BASELINE'",
                                    String.class))
                    .isEqualTo(Integer.toString(version));
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(10);
            assertThat(sessionListColumns(source)).containsExactly("tenant_id", "gmt_create", "session_id");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class))
                    .isEqualTo(1);
        }
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

    // V1 and V2 are published, so the gmt_create list keyset arrives as an
    // additive V3 that rebuilds the list index in place of editing either.
    @Test
    void rebuildsTheSessionListIndexOverAPublishedV2Catalog() throws Exception {
        var source = source();
        Flyway.configure()
                .dataSource(source)
                .locations(ManagedSchema.FLYWAY_LOCATION)
                .target("2")
                .load()
                .migrate();
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update(
                "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                        + " gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 2)",
                "tenant",
                "session");
        var published =
                jdbc.queryForList(
                        "SELECT * FROM \"flyway_schema_history\" WHERE \"version\" IN ('1', '2')"
                                + " ORDER BY \"installed_rank\"");
        var session = jdbc.queryForMap("SELECT "
                    + ManagedSchemaProjection.SESSION.columns().replace(
                            ", runtime_request_key, csi_guard", "")
                            .replace(", model_id, model_revision", "")
                            .replace(", selected_approval_mode, approval_revision, plan_enabled", "") + " FROM ma_session");
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(2);
        assertThat(sessionListColumns(source))
                .containsExactly("tenant_id", "gmt_modified", "session_id");
        assertThatThrownBy(() -> ManagedSchema.initialize(source))
                .hasRootCauseMessage(
                        "The canonical V2 catalog requires the application's V3 migration");

        new ManagedSchemaConfiguration()
                .freshManagedSchema(source)
                .migrate(
                        Flyway.configure()
                                .dataSource(source)
                                .locations(ManagedSchema.FLYWAY_LOCATION)
                                .load());

        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(10);
        assertThat(sessionListColumns(source))
                .containsExactly("tenant_id", "gmt_create", "session_id");
        assertThat(
                        jdbc.queryForList(
                                "SELECT * FROM \"flyway_schema_history\" WHERE \"version\" IN"
                                        + " ('1', '2') ORDER BY \"installed_rank\""))
                .isEqualTo(published);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session")).containsAllEntriesOf(session);
        ManagedSchema.validate(source);
    }

    @Test
    void upgradesPublishedV3ThroughV10WithoutChangingHistory() {
        var source = source();
        Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION)
                .target("3").load().migrate();
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(3);
        var published = jdbc.queryForList("SELECT * FROM \"flyway_schema_history\" WHERE \"version\" IN ('1', '2', '3') ORDER BY \"installed_rank\"");
        assertThatThrownBy(() -> ManagedSchema.initialize(source))
                .hasRootCauseMessage("The canonical V3 catalog requires the application's V4 migration");
        new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(
                Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load());
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(10);
        assertThat(jdbc.queryForList("SELECT * FROM \"flyway_schema_history\" WHERE \"version\" IN ('1', '2', '3') ORDER BY \"installed_rank\""))
                .isEqualTo(published);
        assertThat(jdbc.queryForList("SELECT \"version\" FROM \"flyway_schema_history\" WHERE \"version\" IS NOT NULL ORDER BY \"installed_rank\"", String.class))
                .containsExactly("1", "2", "3", "4", "5", "6", "7", "8", "9", "10");
        ManagedSchema.validate(source);
    }

    // An unversioned published catalog (Broker-initialized before V3
    // shipped) is brought forward through every later step by the Broker's
    // own initializer, whether it stopped at V1 or at V2.
    @Test
    void initializesUnversionedPublishedCatalogsForward() throws Exception {
        List<List<String>> published =
                List.of(
                        List.of(ManagedSchema.RESOURCE),
                        List.of(ManagedSchema.RESOURCE, ManagedSchema.PRIVATE_AUTHORITY));
        for (List<String> resources : published) {
            var source = source();
            try (var connection = source.getConnection();
                    var statement = connection.createStatement()) {
                for (String resource : resources) {
                    try (var stream = ManagedSchema.class.getResourceAsStream(resource)) {
                        for (String sql :
                                new String(
                                                stream.readAllBytes(),
                                                java.nio.charset.StandardCharsets.UTF_8)
                                        .replaceAll("(?m)^--[^\\n]*", "")
                                        .split(";")) {
                            if (!sql.isBlank()) {
                                statement.execute(sql);
                            }
                        }
                    }
                }
            }
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(resources.size());
            assertThat(sessionListColumns(source))
                    .containsExactly("tenant_id", "gmt_modified", "session_id");

            ManagedSchema.initialize(source);

            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(10);
            assertThat(sessionListColumns(source))
                    .containsExactly("tenant_id", "gmt_create", "session_id");
        }
    }

    private static List<String> sessionListColumns(DataSource source) throws SQLException {
        try (var connection = source.getConnection();
                var rows =
                        connection
                                .getMetaData()
                                .getIndexInfo(null, null, "ma_session", false, false)) {
            var columns = new ArrayList<String>();
            while (rows.next()) {
                if ("ix_ma_session_list".equalsIgnoreCase(rows.getString("INDEX_NAME"))) {
                    columns.add(rows.getString("COLUMN_NAME").toLowerCase(java.util.Locale.ROOT));
                }
            }
            return columns;
        }
    }

    private static JdbcDataSource source() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:csi-upgrade-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @Test
    void rejectsSystemAndMissingCatalogsBeforeReadingTablesOrInvokingFlyway() throws Exception {
        for (String product : new String[] {"MySQL", "MariaDB"}) {
            for (String catalog :
                    new String[] {
                        "mysql", "SYS", "information_schema", "performance_schema", null, ""
                    }) {
                DataSource source = mock(DataSource.class);
                Connection connection = mock(Connection.class);
                DatabaseMetaData metadata = mock(DatabaseMetaData.class);
                Flyway flyway = mock(Flyway.class);
                when(source.getConnection()).thenReturn(connection);
                when(connection.getMetaData()).thenReturn(metadata);
                when(metadata.getDatabaseProductName()).thenReturn(product);
                when(connection.getCatalog()).thenReturn(catalog);

                assertThatThrownBy(
                                () ->
                                        new ManagedSchemaConfiguration()
                                                .freshManagedSchema(source)
                                                .migrate(flyway))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessage("Managed schema admission failed")
                        .hasRootCauseMessage(
                                "Managed schema requires a dedicated application catalog;"
                                        + " system or missing catalog refused before DDL: "
                                        + catalog);

                verify(source).getConnection();
                verify(connection).getMetaData();
                verify(connection).getCatalog();
                verify(connection).close();
                verify(metadata).getDatabaseProductName();
                verifyNoMoreInteractions(source, connection, metadata);
                verifyNoInteractions(flyway);
            }
        }
    }
}
