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
        var current = jdbc.queryForMap("SELECT IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS"
                + " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", table, column);
        String nullable = "NO".equals(current.get("is_nullable")) ? " NOT NULL" : " NULL";
        Object existingDefault = current.get("column_default");
        String defaultValue = existingDefault == null ? ""
                : " DEFAULT '" + existingDefault.toString().replace("'", "''") + "'";
        jdbc.execute("ALTER TABLE " + table + " MODIFY COLUMN " + column + " " + type + nullable + defaultValue);
    }

    @AfterEach
    void removeOwnedDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
