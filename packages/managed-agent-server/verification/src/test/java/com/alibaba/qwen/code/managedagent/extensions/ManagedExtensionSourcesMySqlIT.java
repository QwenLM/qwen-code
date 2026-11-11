package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;

class ManagedExtensionSourcesMySqlIT extends ManagedExtensionPackageServiceTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected javax.sql.DataSource dataSource() {
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
