package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class ManagedSchemaJournalMySqlIT extends ManagedSchemaJournalAtomicityTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void cleanup() {
        if (database != null) {
            database.close();
        }
    }
}
