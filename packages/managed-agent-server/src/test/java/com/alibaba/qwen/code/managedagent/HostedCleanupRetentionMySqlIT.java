package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class HostedCleanupRetentionMySqlIT extends HostedCleanupRetentionTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void cleanupDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
