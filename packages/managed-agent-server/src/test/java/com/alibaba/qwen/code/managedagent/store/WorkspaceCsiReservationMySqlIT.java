package com.alibaba.qwen.code.managedagent.store;

import org.junit.jupiter.api.AfterEach;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class WorkspaceCsiReservationMySqlIT extends WorkspaceCsiReservationStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DriverManagerDataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return (DriverManagerDataSource) database.source();
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
