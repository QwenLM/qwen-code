package com.alibaba.qwen.code.managedagent.store;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class WorkspaceCsiCheckpointMySqlIT extends WorkspaceCsiCheckpointSnapshotStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    DataSource database() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
