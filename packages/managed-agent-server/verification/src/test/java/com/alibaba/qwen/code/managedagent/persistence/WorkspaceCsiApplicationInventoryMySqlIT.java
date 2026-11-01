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
        boolean notNull = "NO".equals(current.get("is_nullable"));
        jdbc.execute("ALTER TABLE " + table + " MODIFY COLUMN " + column + " " + type
                + (notNull ? " NOT NULL" : " NULL")
                + defaultClause(current.get("column_default"), type, notNull));
    }

    // A MODIFY resets the default unless it is repeated, and MariaDB reports an
    // absent default as the string "NULL" where MySQL reports SQL NULL. Rebuild
    // the clause with the quoting the new type needs; expressions stay bare.
    private static String defaultClause(Object existing, String type, boolean notNull) {
        if (existing == null || "NULL".equalsIgnoreCase(existing.toString())) {
            return notNull ? "" : " DEFAULT NULL";
        }
        String value = existing.toString();
        if (value.matches("(?i)current_timestamp(\\(\\d*\\))?")
                || type.matches("(?i)(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|"
                        + "NUMERIC|FLOAT|DOUBLE|REAL|BOOLEAN|BOOL|BIT).*")) {
            return " DEFAULT " + value;
        }
        return " DEFAULT '" + value.replace("'", "''") + "'";
    }

    @AfterEach
    void removeOwnedDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
