package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
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
    void upgradesPublishedV1WithoutChangingItsHistoryOrOrdinaryRows() {
        var source = source();
        var flyway =
                Flyway.configure()
                        .dataSource(source)
                        .locations(ManagedSchema.FLYWAY_LOCATION)
                        .target("1")
                        .load();
        flyway.migrate();
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update(
                "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                "Tenant ",
                "Session");
        var history =
                jdbc.queryForMap("SELECT * FROM \"flyway_schema_history\" WHERE \"version\" = '1'");
        var session = jdbc.queryForMap("SELECT * FROM ma_session");
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(1);
        assertThatThrownBy(() -> ManagedSchema.initialize(source))
                .hasRootCauseMessage(
                        "The canonical V1 catalog requires the application's V2 migration");
        var current =
                Flyway.configure()
                        .dataSource(source)
                        .locations(ManagedSchema.FLYWAY_LOCATION)
                        .load();
        new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(current);
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(2);
        assertThat(
                        jdbc.queryForMap(
                                "SELECT * FROM \"flyway_schema_history\" WHERE \"version\" = '1'"))
                .isEqualTo(history);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_session"))
                .containsAllEntriesOf(session)
                .containsEntry("csi_guard", false)
                .containsEntry("runtime_request_key", null);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM \"flyway_schema_history\" WHERE \"success\" ="
                                        + " TRUE AND \"version\" = '2'",
                                Integer.class))
                .isEqualTo(1);
        new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(current);
        ManagedSchema.validate(source);
    }

    @Test
    void baselinesTheActualUnversionedCanonicalCatalog() throws Exception {
        for (boolean baselineOnly : new boolean[] {true, false}) {
            var source = source();
            if (baselineOnly) {
                try (var connection = source.getConnection();
                        var statement = connection.createStatement();
                        var resource =
                                ManagedSchema.class.getResourceAsStream(ManagedSchema.RESOURCE)) {
                    for (String sql :
                            new String(
                                            resource.readAllBytes(),
                                            java.nio.charset.StandardCharsets.UTF_8)
                                    .replaceAll("(?m)^--[^\\n]*", "")
                                    .split(";")) {
                        if (!sql.isBlank()) {
                            statement.execute(sql);
                        }
                    }
                }
            } else {
                ManagedSchema.initialize(source);
            }
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id, session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1)");
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
                    .isEqualTo(baselineOnly ? "1" : "2");
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class))
                    .isEqualTo(1);
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
