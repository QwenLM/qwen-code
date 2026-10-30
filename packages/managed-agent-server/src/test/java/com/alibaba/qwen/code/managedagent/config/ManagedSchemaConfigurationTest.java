package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
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
    void initializesFreshCatalogAndRestartsWithoutChangingHistoryOrRows() throws Exception {
        var source = source();
        var flyway = Flyway.configure().dataSource(source)
                .locations(ManagedSchema.FLYWAY_LOCATION).load();
        var strategy = new ManagedSchemaConfiguration().freshManagedSchema(source);
        strategy.migrate(flyway);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                + " gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)", "Tenant ", "Session");
        var session = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session");
        var history = jdbc.queryForList("SELECT * FROM \"flyway_schema_history\" ORDER BY \"installed_rank\"");

        strategy.migrate(flyway);
        ManagedSchema.initialize(source);

        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(1);
        assertThat(sessionListColumns(source)).containsExactly("tenant_id", "gmt_create", "session_id");
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session"))
                .isEqualTo(session)
                .containsEntry("csi_guard", false)
                .containsEntry("runtime_request_key", null)
                .containsEntry("model_id", null)
                .containsEntry("model_revision", 0L)
                .containsEntry("selected_approval_mode", null)
                .containsEntry("approval_revision", 0L)
                .containsEntry("harness_instance_id", null)
                .containsEntry("harness_owner_boot_id", null)
                .containsEntry("harness_placement_epoch", 0L)
                .containsEntry("harness_placement_state", "UNASSIGNED");
        assertThat(jdbc.queryForList("SELECT * FROM \"flyway_schema_history\" ORDER BY \"installed_rank\""))
                .isEqualTo(history);
        assertThat(jdbc.queryForList("SELECT \"version\" FROM \"flyway_schema_history\""
                + " WHERE \"version\" IS NOT NULL", String.class)).containsExactly("1");
    }

    @Test
    void baselinesTheBrokerInitializedCatalogAtVersionOne() throws Exception {
        var source = source();
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                + " gmt_modified) VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1)");
        var flyway = Flyway.configure().dataSource(source)
                .locations(ManagedSchema.FLYWAY_LOCATION).load();
        var strategy = new ManagedSchemaConfiguration().freshManagedSchema(source);
        strategy.migrate(flyway);
        strategy.migrate(flyway);
        assertThat(jdbc.queryForList("SELECT \"version\" FROM \"flyway_schema_history\""
                + " WHERE \"type\" = 'BASELINE'", String.class)).containsExactly("1");
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(1);
        assertThat(sessionListColumns(source)).containsExactly("tenant_id", "gmt_create", "session_id");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isEqualTo(1);
    }

    @Test
    void refusesAPartialCatalogBeforeInvokingFlyway() {
        var source = source();
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.execute("ALTER TABLE ma_session DROP CONSTRAINT ck_ma_public_child_agents");
        jdbc.execute("ALTER TABLE ma_session DROP COLUMN public_child_agents_version");
        var flyway = mock(Flyway.class);
        assertThatThrownBy(() -> new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(flyway))
                .isInstanceOf(IllegalStateException.class).hasMessage("Managed schema validation failed");
        verifyNoInteractions(flyway);
        assertThatThrownBy(() -> jdbc.queryForObject("SELECT public_child_agents_version FROM ma_session", Integer.class))
                .isInstanceOf(org.springframework.dao.DataAccessException.class);
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
                "jdbc:h2:mem:managed-schema-config-"
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
