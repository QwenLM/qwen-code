package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class HarnessEventIngestMySqlIT extends HarnessEventIngestTest {
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
