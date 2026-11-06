package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class AgentLockContractMySqlIT extends AgentLockContractTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        trace = new StoreLockTrace(database.source());
        return trace;
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
