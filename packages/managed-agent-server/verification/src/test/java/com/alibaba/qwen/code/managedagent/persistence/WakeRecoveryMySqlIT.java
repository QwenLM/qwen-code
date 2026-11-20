package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

class WakeRecoveryMySqlIT extends WakeRecoveryStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @Test
    void recoveryWaitsForTheSessionBeforeItLocksTheHead() throws Exception {
        var candidate = store.findPending("workspace", 8).getFirst();
        var worker = Executors.newSingleThreadExecutor();
        try (var owner = Objects.requireNonNull(jdbc.getDataSource()).getConnection()) {
            owner.setAutoCommit(false);
            try {
                try (var lock = owner.prepareStatement("SELECT session_id FROM ma_session"
                        + " WHERE tenant_id = 'tenant' AND session_id = 'session' FOR UPDATE")) {
                    try (var row = lock.executeQuery()) {
                        assertThat(row.next()).isTrue();
                    }
                }
                var claim = worker.submit(() -> store.claim(candidate));
                await().atMost(Duration.ofSeconds(10)).until(() -> jdbc.queryForObject(
                        "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE DB = DATABASE()"
                                + " AND COMMAND = 'Query' AND TIME >= 1"
                                + " AND INFO LIKE 'SELECT session_id FROM ma_session%'",
                        Long.class) > 0);
                try (var head = owner.prepareStatement("UPDATE ma_session_head SET gmt_modified = 2")) {
                    head.setQueryTimeout(5);
                    assertThat(head.executeUpdate()).isEqualTo(1);
                }
                owner.commit();
                assertThat(claim.get(10, TimeUnit.SECONDS)).isTrue();
            } finally {
                owner.rollback();
            }
        } finally {
            worker.shutdownNow();
        }
    }

    @AfterEach
    void removeDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
