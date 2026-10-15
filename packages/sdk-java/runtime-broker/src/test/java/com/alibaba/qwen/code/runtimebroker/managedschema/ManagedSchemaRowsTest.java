package com.alibaba.qwen.code.runtimebroker.managedschema;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Timestamp;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class ManagedSchemaRowsTest {
    @Test
    void keepsDatetimeWallClockValuesIndependentOfDriverTimestampZone() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:datetime-wall-clock;MODE=MySQL");
        try (var connection = source.getConnection(); var statement = connection.createStatement();
                var result = statement.executeQuery("SELECT TIMESTAMP '2026-10-14 01:02:03.123456'"
                        + " AS observed_at, CAST(NULL AS TIMESTAMP) AS missing_at")) {
            result.next();
            var metadata = result.getMetaData();
            var datetime = (ResultSetMetaData) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {ResultSetMetaData.class}, (proxy, method, args) ->
                            method.getName().equals("getColumnTypeName") ? "DATETIME" : method.invoke(metadata, args));
            var driver = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {ResultSet.class}, (proxy, method, args) -> {
                        if (method.getName().equals("getMetaData")) {
                            return datetime;
                        }
                        if (method.getName().equals("getTimestamp")) {
                            throw new SQLException("Driver timestamp depends on its connection time zone");
                        }
                        try {
                            return method.invoke(result, args);
                        } catch (InvocationTargetException exception) {
                            throw exception.getCause();
                        }
                    });
            var row = ManagedSchemaRows.read(driver);
            assertEquals(Timestamp.valueOf("2026-10-14 01:02:03.123456"), row.get("observed_at"));
            assertNull(row.get("missing_at"));
        }
    }

    @Test
    void mapsDriverIndependentScalarsWithoutDecodingActorOrPayloadBytes() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:row-types;MODE=MySQL");
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE fixture (tenant_id VARBINARY(64), actor_id VARBINARY(64),"
                    + " record_bytes BLOB, revision BIGINT, enabled TINYINT, workspace_bound BOOLEAN,"
                    + " committed_sequence BIGINT, gmt_create BIGINT UNSIGNED)");
            byte[] actor = {(byte) 0xff, 0};
            byte[] payload = {0, (byte) 0xfe, 10};
            long timestamp = java.time.Instant.parse("2026-10-14T01:02:03.123Z").toEpochMilli();
            try (var insert = connection.prepareStatement("INSERT INTO fixture VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setBytes(1, "tenant-用户 ".getBytes(StandardCharsets.UTF_8));
                insert.setBytes(2, actor);
                insert.setBytes(3, payload);
                insert.setLong(4, 9_007_199_254_740_993L);
                insert.setInt(5, 1);
                insert.setObject(6, null);
                insert.setObject(7, null);
                insert.setLong(8, timestamp);
                insert.executeUpdate();
            }
            try (var result = statement.executeQuery("SELECT tenant_id, actor_id, record_bytes,"
                    + " revision, enabled, workspace_bound, committed_sequence, gmt_create,"
                    + " CASE WHEN enabled = 1 THEN 1 ELSE 0 END AS quarantined FROM fixture")) {
                result.next();
                ResultSet driver = differentObjectTypes(result);
                var row = ManagedSchemaRows.read(driver);
                assertEquals("tenant-用户 ", row.get("tenant_id"));
                assertArrayEquals(actor, (byte[]) row.get("actor_id"));
                assertArrayEquals(payload, (byte[]) row.get("record_bytes"));
                assertEquals(9_007_199_254_740_993L, row.get("revision"));
                assertEquals(Boolean.TRUE, row.get("enabled"));
                assertEquals(1, row.get("quarantined"));
                assertNull(row.get("workspace_bound"));
                assertNull(row.get("committed_sequence"));
                assertEquals(timestamp, row.get("gmt_create"));
            }
        }
    }

    @Test
    void rejectsInvalidIdentityBytesAndPreservesNullIdentities() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:invalid-row-identity;MODE=MySQL");
        try (var connection = source.getConnection(); var statement = connection.createStatement();
                var result = statement.executeQuery("SELECT X'ff' AS tenant_id, NULL AS session_id")) {
            result.next();
            assertThrows(SQLException.class, () -> ManagedSchemaRows.identity(result, "tenant_id"));
            assertNull(ManagedSchemaRows.identity(result, "session_id"));
        }
    }

    private static ResultSet differentObjectTypes(ResultSet result) {
        return (ResultSet) Proxy.newProxyInstance(ManagedSchemaRowsTest.class.getClassLoader(),
                new Class<?>[] {ResultSet.class}, (proxy, method, arguments) -> {
                    try {
                        Object value = method.invoke(result, arguments);
                        if (method.getName().equals("getObject") && value instanceof Long number) {
                            return BigInteger.valueOf(number);
                        }
                        if (method.getName().equals("getObject") && value instanceof Boolean flag) {
                            return flag ? (byte) 1 : (byte) 0;
                        }
                        return value;
                    } catch (InvocationTargetException exception) {
                        throw exception.getCause();
                    }
                });
    }
}
