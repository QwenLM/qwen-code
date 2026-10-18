package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

import static org.assertj.core.api.Assertions.assertThat;

class SshWorkspaceMySqlIT extends SshWorkspaceStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    DataSource source() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        var source = database.source();
        Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION)
                .target("3").load().migrate();
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(3);
        Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load().migrate();
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(10);
        ManagedSchema.validate(source);
        return source;
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
