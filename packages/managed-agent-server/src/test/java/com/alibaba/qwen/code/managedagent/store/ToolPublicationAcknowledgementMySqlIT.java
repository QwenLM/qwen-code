package com.alibaba.qwen.code.managedagent.store;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

/** Runs the complete acknowledgement fault contract on one fresh MySQL database per case. */
class ToolPublicationAcknowledgementMySqlIT extends ToolPublicationAcknowledgementTest {
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
