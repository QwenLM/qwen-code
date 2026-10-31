package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class ExternalWorkspaceMaterializationMySqlIT extends ExternalWorkspaceMaterializationTest {
    private IsolatedManagedSchemaMySqlTestDatabase mysql;

    @Override
    DataSource source() {
        mysql = new IsolatedManagedSchemaMySqlTestDatabase();
        return mysql.source();
    }

    @AfterEach
    void closeDatabase() {
        if (mysql != null) {
            mysql.close();
        }
    }
}
