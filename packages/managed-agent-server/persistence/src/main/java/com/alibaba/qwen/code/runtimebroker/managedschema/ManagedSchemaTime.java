package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;

/** Managed persisted timestamps use nonnegative epoch milliseconds. */
public final class ManagedSchemaTime {
    public static final String SQL_NOW = "CAST(UNIX_TIMESTAMP() AS DECIMAL(20, 0)) * 1000"
            + " + FLOOR(EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) / 1000)";

    /**
     * Marks a ledger that must never become due again. Held below 2^53 so the value
     * still round-trips through JavaScript exactly, unlike Long.MAX_VALUE.
     */
    public static final long NEVER_DUE_MILLIS = 9007199254740991L;

    private ManagedSchemaTime() {}

    public static Timestamp timestamp(ResultSet result, String column) throws SQLException {
        long value = result.getLong(column);
        return result.wasNull() ? null : timestamp(value);
    }

    public static Timestamp timestamp(ResultSet result, int column) throws SQLException {
        long value = result.getLong(column);
        return result.wasNull() ? null : timestamp(value);
    }

    private static Timestamp timestamp(long value) throws SQLException {
        if (value < 0) {
            throw new SQLException("Managed timestamp is outside the nonnegative epoch millisecond range");
        }
        return new Timestamp(value);
    }
}
