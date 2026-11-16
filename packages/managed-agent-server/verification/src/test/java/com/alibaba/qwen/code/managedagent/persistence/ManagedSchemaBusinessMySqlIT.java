package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

/** The same business contracts against a separate real MySQL database per test. */
public class ManagedSchemaBusinessMySqlIT extends ManagedSchemaBusinessStoreTest {
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
