package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

class ManagedSessionPhysicalFenceMySqlIT extends ManagedSessionPhysicalFenceTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @Test
    void existingReadViewCannotHideAConcurrentPhysicalFreeze() {
        rejectsAConcurrentFenceAfterRepeatableReadSnapshot();
    }

    @Test
    void malformedUnicodeCannotCollapseIntoAnotherWorkspaceIdentity() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                sessions.acquireWriter(
                                                        "unicode-tenant",
                                                        "unicode-session",
                                                        "unicode-writer-token-0123456789abcdef",
                                                        new ManagedSessionStoreModels
                                                                .AcquireWriterRequest(
                                                                "\ud800", "writer", 60_000L))))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
        org.assertj.core.api.Assertions.assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session_head WHERE tenant_id = ?",
                                Integer.class,
                                "unicode-tenant"))
                .isZero();
    }

    @AfterEach
    void cleanup() {
        if (database != null) {
            database.close();
        }
    }
}
