package com.alibaba.qwen.code.managedagent.store;

import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;

public class ManagedSchemaPublicationMySqlIT extends ManagedSchemaPublicationStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void removeOwnedDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
