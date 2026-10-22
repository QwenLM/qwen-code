package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

/** The D7-2 parked-title behaviors on InnoDB. */
class ManagedRenameReconciliationMySqlIT extends ManagedRenameReconciliationTest {
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
