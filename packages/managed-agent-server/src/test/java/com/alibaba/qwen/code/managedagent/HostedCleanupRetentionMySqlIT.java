package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import javax.sql.DataSource;

class HostedCleanupRetentionMySqlIT extends HostedCleanupRetentionTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    @Test
    @Timeout(60)
    void owedCleanupPreservesExactReleasedOwnerAcrossSweepAndReopen() {
        super.owedCleanupPreservesExactReleasedOwnerAcrossSweepAndReopen();
    }

    @Override
    @Test
    @Timeout(60)
    void oneConfirmationCannotReleaseAnotherCleanupDebt() {
        super.oneConfirmationCannotReleaseAnotherCleanupDebt();
    }

    @Override
    @Test
    @Timeout(60)
    void rollbackKeepsTheJournalAndItsCleanupProjectionAtomic() {
        super.rollbackKeepsTheJournalAndItsCleanupProjectionAtomic();
    }

    @Override
    @Test
    @Timeout(60)
    void unverifiedHistoricalJournalRetainsItsBindingWithoutRestamping() {
        super.unverifiedHistoricalJournalRetainsItsBindingWithoutRestamping();
    }

    @Override
    @Test
    @Timeout(60)
    void sharedBindingRetainsItsOriginalSessionUntilCleanupConfirmation() {
        super.sharedBindingRetainsItsOriginalSessionUntilCleanupConfirmation();
    }

    @Override
    @Test
    @Timeout(60)
    void cleanupIdentityCannotChangeItsDescriptor() {
        super.cleanupIdentityCannotChangeItsDescriptor();
    }

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void cleanupDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
