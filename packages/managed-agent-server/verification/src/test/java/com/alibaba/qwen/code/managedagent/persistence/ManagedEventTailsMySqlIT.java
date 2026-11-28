package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The batched event tail read under real MySQL, whose row-constructor
 * {@code IN} and binary collation H2 only approximates.
 */
class ManagedEventTailsMySqlIT {
    private IsolatedManagedSchemaMySqlTestDatabase database;
    private ManagedEventTailsFixture fixture;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        fixture = new ManagedEventTailsFixture(database.source());
    }

    @AfterEach
    void cleanUp() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    void readsEachRequestedTailAcrossTenantsOnly() {
        fixture.readsEachRequestedTailAcrossTenantsOnly();
    }

    @Test
    void splitsALargeRequestIntoBatches() {
        fixture.splitsALargeRequestIntoBatches();
    }
}
