package com.alibaba.qwen.code.runtimebroker.managedschema;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.SQLException;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class ManagedSchemaTimeTest {
    @Test
    void readsNullableEpochMillisecondsWithoutTimezoneOrSecondConversion() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:managed-time-" + UUID.randomUUID() + ";MODE=MySQL");
        try (var connection = source.getConnection(); var statement = connection.createStatement();
                var row = statement.executeQuery("SELECT CAST(NULL AS BIGINT) AS missing,"
                        + " CAST(0 AS BIGINT) AS epoch, CAST(2208988800123 AS BIGINT) AS future,"
                        + " CAST(-1 AS BIGINT) AS invalid, CAST(9223372036854775807 AS BIGINT) AS maximum")) {
            assertTrue(row.next());
            assertNull(ManagedSchemaTime.timestamp(row, "missing"));
            assertNull(ManagedSchemaTime.timestamp(row, 1));
            assertEquals(0, ManagedSchemaTime.timestamp(row, "epoch").getTime());
            assertEquals(2_208_988_800_123L, ManagedSchemaTime.timestamp(row, 3).getTime());
            assertEquals(Long.MAX_VALUE, ManagedSchemaTime.timestamp(row, "maximum").getTime());
            assertThrows(SQLException.class, () -> ManagedSchemaTime.timestamp(row, "invalid"));
            assertThrows(SQLException.class, () -> ManagedSchemaTime.timestamp(row, 4));
        }
    }

    @Test
    void databaseClockExpressionReturnsIntegerEpochMilliseconds() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:managed-time-clock-" + UUID.randomUUID() + ";MODE=MySQL");
        long before = System.currentTimeMillis();
        try (var connection = source.getConnection(); var statement = connection.createStatement();
                var row = statement.executeQuery("SELECT " + ManagedSchemaTime.SQL_NOW)) {
            assertTrue(row.next());
            long now = row.getLong(1);
            assertTrue(now >= before && now <= System.currentTimeMillis());
            assertEquals(0, java.math.BigDecimal.valueOf(now).compareTo(row.getBigDecimal(1)));
        }
    }
}
