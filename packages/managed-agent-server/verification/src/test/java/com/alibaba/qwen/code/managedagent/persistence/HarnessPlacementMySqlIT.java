package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

/** Runs the placement/grant/release cases against the real canonical MySQL schema. */
public class HarnessPlacementMySqlIT extends HarnessPlacementStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource source() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void cleanup() {
        if (database != null) {
            database.close();
        }
    }
}
