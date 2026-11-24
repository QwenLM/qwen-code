package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

class ManagedAgentEventSequenceConcurrencyMySqlIT extends ManagedAgentEventSequenceConcurrencyTest {
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

    @Override
    protected Long currentSessionId(JdbcTemplate jdbc) {
        return jdbc.queryForObject("SELECT CONNECTION_ID()", Long.class);
    }

    @Override
    protected void awaitSessionLockWait(JdbcTemplate jdbc, Long blockerId) {
        String sql;
        if (jdbc.queryForObject("SELECT VERSION()", String.class).contains("MariaDB")) {
            sql = "SELECT COUNT(*) FROM information_schema.INNODB_LOCK_WAITS w"
                    + " JOIN information_schema.INNODB_LOCKS l ON l.LOCK_ID = w.REQUESTED_LOCK_ID"
                    + " JOIN information_schema.INNODB_TRX t ON t.TRX_ID = w.BLOCKING_TRX_ID"
                    + " WHERE t.TRX_MYSQL_THREAD_ID = ?"
                    + " AND l.LOCK_TABLE = CONCAT('`', DATABASE(), '`.`ma_session`')";
        } else {
            sql = "SELECT COUNT(*) FROM performance_schema.data_lock_waits w"
                    + " JOIN performance_schema.threads t ON t.thread_id = w.blocking_thread_id"
                    + " JOIN performance_schema.data_locks l ON l.engine_lock_id = w.requesting_engine_lock_id"
                    + " WHERE t.processlist_id = ? AND l.object_schema = DATABASE()"
                    + " AND l.object_name = 'ma_session'";
        }
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(jdbc.queryForObject(sql, Long.class, blockerId))
                        .isEqualTo(1));
    }
}
