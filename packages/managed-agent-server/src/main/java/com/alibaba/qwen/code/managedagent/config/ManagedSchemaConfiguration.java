package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.SQLException;

@Configuration
public class ManagedSchemaConfiguration {
    @Bean
    JdbcTemplate managedJdbcTemplate(DataSource source) {
        return new ManagedSchemaJdbcTemplate(source);
    }

    @Bean
    FlywayMigrationStrategy freshManagedSchema(DataSource source) {
        return flyway -> {
            boolean populated;
            boolean history;
            try (Connection connection = source.getConnection()) {
                ManagedSchema.requireApplicationCatalog(connection);
                populated = false;
                try (var tables =
                        connection
                                .getMetaData()
                                .getTables(
                                        connection.getCatalog(),
                                        connection.getSchema(),
                                        null,
                                        new String[] {"TABLE", "VIEW"})) {
                    history = false;
                    while (tables.next()) {
                        if ("flyway_schema_history"
                                .equalsIgnoreCase(tables.getString("TABLE_NAME"))) {
                            if ("VIEW".equalsIgnoreCase(tables.getString("TABLE_TYPE"))) {
                                throw new SQLException("Managed schema history cannot be a view");
                            }
                            history = true;
                        } else {
                            populated = true;
                        }
                    }
                }
            } catch (SQLException error) {
                throw new IllegalStateException("Managed schema admission failed", error);
            }
            if (!populated && history) {
                throw new IllegalStateException(
                        "A history-only catalog is not a fresh Managed database");
            }
            // Broker may have initialized the same canonical baseline first.
            if (populated) {
                int version = ManagedSchema.schemaVersion(source);
                if (!history) {
                    org.flywaydb.core.Flyway.configure()
                            .configuration(flyway.getConfiguration())
                            .baselineVersion(Integer.toString(version))
                            .load()
                            .baseline();
                }
            }
            flyway.migrate();
            ManagedSchema.validate(source);
        };
    }
}
