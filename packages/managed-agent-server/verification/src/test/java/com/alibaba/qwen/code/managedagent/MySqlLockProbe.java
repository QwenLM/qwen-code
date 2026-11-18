package com.alibaba.qwen.code.managedagent;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

/** InnoDB lock-wait and deadlock observations shared by the MySQL witnesses (#13800). */
public final class MySqlLockProbe {
    /**
     * INNODB_TRX is refreshed at most every ~100 ms, so a poll faster than
     * that only re-reads the same snapshot.
     */
    private static final long POLL_MILLIS = 150;
    private static final int POLL_ATTEMPTS = 60;

    private MySqlLockProbe() { }

    /** Transactions of {@code schema} currently in LOCK WAIT. */
    public static int lockWaits(JdbcTemplate jdbc, String schema) {
        Integer waits = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.INNODB_TRX t"
                + " JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id"
                + " WHERE t.trx_state = 'LOCK WAIT' AND p.DB = ?", Integer.class, schema);
        return waits == null ? 0 : waits;
    }

    /** Capture before releasing test holders so a failed witness retains its lock graph. */
    public static String describeLockWaits(JdbcTemplate jdbc, String schema) {
        try {
            return "InnoDB lock waits for " + schema + ": " + jdbc.queryForList(
                    "SELECT requested.ENGINE_TRANSACTION_ID AS waiting_transaction,"
                            + " waiting_trx.trx_query AS waiting_sql,"
                            + " held.ENGINE_TRANSACTION_ID AS blocking_transaction,"
                            + " blocking_trx.trx_query AS blocking_sql,"
                            + " requested.OBJECT_NAME AS table_name,"
                            + " requested.INDEX_NAME AS requested_index,"
                            + " requested.LOCK_TYPE AS requested_type,"
                            + " requested.LOCK_MODE AS requested_mode,"
                            + " requested.LOCK_DATA AS requested_data,"
                            + " held.INDEX_NAME AS blocking_index, held.LOCK_TYPE AS blocking_type,"
                            + " held.LOCK_MODE AS blocking_mode, held.LOCK_DATA AS blocking_data"
                            + " FROM performance_schema.data_lock_waits waits"
                            + " JOIN performance_schema.data_locks requested ON requested.ENGINE = waits.ENGINE"
                            + " AND requested.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID"
                            + " JOIN performance_schema.data_locks held ON held.ENGINE = waits.ENGINE"
                            + " AND held.ENGINE_LOCK_ID = waits.BLOCKING_ENGINE_LOCK_ID"
                            + " LEFT JOIN information_schema.INNODB_TRX waiting_trx"
                            + " ON waiting_trx.trx_id = waits.REQUESTING_ENGINE_TRANSACTION_ID"
                            + " LEFT JOIN information_schema.INNODB_TRX blocking_trx"
                            + " ON blocking_trx.trx_id = waits.BLOCKING_ENGINE_TRANSACTION_ID"
                            + " WHERE requested.OBJECT_SCHEMA = ? AND held.OBJECT_SCHEMA = ?",
                    schema, schema);
        } catch (DataAccessException error) {
            return "InnoDB lock snapshot unavailable for " + schema + ": " + error;
        }
    }

    /** Waits up to ~9 s until at least {@code expected} transactions of {@code schema} queue. */
    public static void awaitLockWaits(JdbcTemplate jdbc, String schema, int expected, String what)
            throws InterruptedException {
        for (int attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
            if (lockWaits(jdbc, schema) >= expected) {
                return;
            }
            Thread.sleep(POLL_MILLIS);
        }
        throw new AssertionError("Timed out waiting for " + what + " to queue");
    }

    /** The server-wide InnoDB deadlock count. */
    public static long innodbDeadlocks(JdbcTemplate jdbc) {
        Long value = jdbc.query("SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks'",
                result -> result.next() ? result.getLong(2) : null);
        if (value == null) {
            // MySQL 8.4 has no Innodb_deadlocks status variable; its InnoDB
            // metrics count the same events.
            value = jdbc.query("SELECT `count` FROM information_schema.INNODB_METRICS"
                            + " WHERE name = 'lock_deadlocks'",
                    result -> result.next() ? result.getLong(1) : null);
        }
        if (value == null) {
            throw new IllegalStateException("The server exposes no InnoDB deadlock counter");
        }
        return value;
    }
}
