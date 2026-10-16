package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedSchemaConfiguration;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Fresh-baseline admission replaces the retired upgrade/backfill witnesses. */
class BackfillWitnessesTest {
    @Test
    void brokerAndServerInitializeTheSameBaselineAndReplayWithoutAddingTables() {
        var source = source();
        ManagedSchema.initialize(source);
        activate(source);
        activate(source);
        ManagedSchema.validate(source);
        assertThat(
                        new JdbcTemplate(source)
                                .queryForObject(
                                        "SELECT COUNT(*) FROM information_schema.tables WHERE"
                                            + " table_schema = 'public' AND table_type='BASE"
                                            + " TABLE'",
                                        Integer.class))
                .isEqualTo(33);
        assertThat(
                        new JdbcTemplate(source)
                                .queryForObject(
                                        "SELECT version FROM flyway_schema_history"
                                                + " WHERE success = TRUE AND type = 'BASELINE'",
                                        String.class))
                .isEqualTo("5");
    }

    @Test
    void serverInitializesAFreshCatalogWithTheSingleVersionedBaseline() {
        var source = source();
        activate(source);
        ManagedSchema.validate(source);
        assertThat(
                        new JdbcTemplate(source)
                                .queryForObject(
                                        "SELECT script FROM flyway_schema_history"
                                                + " WHERE version = '1'",
                                        String.class))
                .isEqualTo("V1__managed_schema.sql");
    }

    @Test
    void legacyAndHistoryOnlyCatalogsAreRejectedBeforeAnySchemaMutation() {
        for (String table : new String[] {"managed_agent_session", "flyway_schema_history"}) {
            var source = source();
            var jdbc = new JdbcTemplate(source);
            jdbc.execute("CREATE TABLE " + table + " (witness INT)");
            jdbc.update("INSERT INTO " + table + " VALUES (42)");
            assertThatThrownBy(() -> activate(source)).isInstanceOf(IllegalStateException.class);
            assertThat(jdbc.queryForObject("SELECT witness FROM " + table, Integer.class))
                    .isEqualTo(42);
            assertThat(
                            jdbc.queryForObject(
                                    "SELECT COUNT(*) FROM information_schema.tables WHERE"
                                        + " table_schema = 'public' AND table_type='BASE TABLE'",
                                    Integer.class))
                    .isEqualTo(1);
        }
    }

    private static void activate(JdbcDataSource source) {
        FlywayMigrationStrategy strategy =
                ReflectionTestUtils.invokeMethod(
                        new ManagedSchemaConfiguration(), "freshManagedSchema", source);
        strategy.migrate(
                Flyway.configure()
                        .dataSource(source)
                        .locations(ManagedSchema.FLYWAY_LOCATION)
                        .load());
    }

    private static JdbcDataSource source() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:baseline-witness-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return source;
    }
}
