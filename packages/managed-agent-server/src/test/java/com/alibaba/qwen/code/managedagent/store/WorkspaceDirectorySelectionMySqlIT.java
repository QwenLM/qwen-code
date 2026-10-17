package com.alibaba.qwen.code.managedagent.store;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class WorkspaceDirectorySelectionMySqlIT extends WorkspaceCreationStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
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
