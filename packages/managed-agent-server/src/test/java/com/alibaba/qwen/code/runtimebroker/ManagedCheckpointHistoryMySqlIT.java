package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class ManagedCheckpointHistoryMySqlIT extends ManagedCheckpointHistorySqlTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void removeOwnedDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
