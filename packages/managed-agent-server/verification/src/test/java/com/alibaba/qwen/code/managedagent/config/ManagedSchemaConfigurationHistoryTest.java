package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedSchemaConfigurationHistoryTest {
    @Test
    void keepsTheHostsHistoryOutOfTheManagedChain() throws Exception {
        // The catalog is already initialized and carries the host's own Flyway
        // ledger at version 12. The strategy must validate the Managed schema and
        // leave; running baseline/migrate would read that ledger as its own.
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:cfg-history-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1");
        try (Connection connection = source.getConnection();
                var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE da_business (witness INT)");
            statement.execute("CREATE TABLE flyway_schema_history (installed_rank INT PRIMARY KEY,"
                    + " version VARCHAR(50), description VARCHAR(200), type VARCHAR(20),"
                    + " script VARCHAR(1000), checksum INT, installed_by VARCHAR(100),"
                    + " installed_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP, execution_time INT,"
                    + " success BOOLEAN)");
            statement.execute("INSERT INTO flyway_schema_history (installed_rank, version,"
                    + " description, type, script, checksum, installed_by, execution_time, success)"
                    + " VALUES (1, '12', 'host', 'SQL', 'host.sql', 0, 'host', 1, TRUE)");
        }
        ManagedSchema.initialize(source);
        Flyway flyway = Flyway.configure()
                .dataSource(source)
                .locations(ManagedSchema.FLYWAY_LOCATION)
                .load();
        new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(flyway);
        try (Connection connection = source.getConnection();
                var statement = connection.createStatement();
                var rows = statement.executeQuery(
                        "SELECT version FROM flyway_schema_history ORDER BY installed_rank")) {
            assertTrue(rows.next());
            assertEquals("12", rows.getString(1));
            assertEquals(false, rows.next());
        }
    }
}
