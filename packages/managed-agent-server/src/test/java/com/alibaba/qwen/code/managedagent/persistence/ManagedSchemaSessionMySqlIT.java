package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

public class ManagedSchemaSessionMySqlIT extends ManagedSchemaSessionStoreTest {
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
