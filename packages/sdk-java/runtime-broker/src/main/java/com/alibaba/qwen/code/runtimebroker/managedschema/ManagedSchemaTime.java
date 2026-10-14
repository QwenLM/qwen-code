package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;

/** Managed persisted timestamps use nonnegative epoch milliseconds. */
public final class ManagedSchemaTime {
    public static final String SQL_NOW = "CAST(UNIX_TIMESTAMP() AS DECIMAL(20, 0)) * 1000"
            + " + FLOOR(EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) / 1000)";

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
