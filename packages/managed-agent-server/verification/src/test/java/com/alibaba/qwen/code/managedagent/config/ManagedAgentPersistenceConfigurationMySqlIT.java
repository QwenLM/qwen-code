package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;

import java.sql.Connection;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedAgentPersistenceConfigurationMySqlIT {
    @Test
    void deploymentManagedSchemaIsOnlyValidated() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            var properties = new ManagedAgentProperties();
            properties.getSchema().setInitializeEnabled(false);
            var configuration = new ManagedAgentPersistenceConfiguration();

            assertThatThrownBy(() -> configuration.managedJdbcTemplate(source, properties))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("Managed schema validation failed");
            assertTables(source, 0);

            ManagedSchema.initialize(source);
            var jdbc = configuration.managedJdbcTemplate(source, properties);
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT 1", Integer.class)).isEqualTo(1);
        }
    }

    private static void assertTables(javax.sql.DataSource source, int expected) throws Exception {
        try (Connection connection = source.getConnection();
                var tables = connection.getMetaData().getTables(connection.getCatalog(), null, "%", new String[] {"TABLE"})) {
            int actual = 0;
            while (tables.next()) {
                actual++;
            }
            assertThat(actual).isEqualTo(expected);
        }
    }
}
