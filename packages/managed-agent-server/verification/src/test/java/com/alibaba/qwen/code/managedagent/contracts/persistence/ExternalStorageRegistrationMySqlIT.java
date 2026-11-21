package com.alibaba.qwen.code.managedagent.contracts.persistence;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationTest;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

class ExternalStorageRegistrationMySqlIT extends ExternalStorageRegistrationTest {
    private IsolatedManagedSchemaMySqlTestDatabase mysql;

    @Override
    public DataSource source() {
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
