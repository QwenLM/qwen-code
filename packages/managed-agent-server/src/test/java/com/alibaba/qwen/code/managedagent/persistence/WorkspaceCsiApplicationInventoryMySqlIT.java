package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;

class WorkspaceCsiApplicationInventoryMySqlIT extends WorkspaceCsiApplicationInventoryTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        initialize(database.source());
    }

    @Override
    void alterColumn(String table, String column, String type) {
        jdbc.execute("ALTER TABLE " + table + " MODIFY COLUMN " + column + " " + type);
    }

    @AfterEach
    void removeOwnedDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
