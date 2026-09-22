package com.alibaba.qwen.code.runtimebroker;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Calendar;
import java.util.TimeZone;
import javax.sql.DataSource;

final class JdbcRepositorySupport {
    private static final TimeZone UTC = TimeZone.getTimeZone("UTC");

    private JdbcRepositorySupport() {
    }

    static DataSource requireDataSource(DataSource dataSource) {
        if (dataSource == null) {
            throw new IllegalArgumentException("dataSource is required");
        }
        return dataSource;
    }

    static String requestKey(RuntimeProvisionRequest request) {
        RuntimeScope scope = request.getScope();
        return digest(scope.getTenantId(), scope.getWorkspaceId(),
                scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass(),
                request.getIsolationKey());
    }

    static String scopeKey(RuntimeScope scope) {
        return digest(scope.getTenantId(), scope.getWorkspaceId(),
                scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass());
    }

    static String valueKey(String value) {
        return digest(value);
    }

    static Duration requireDuration(Duration duration) {
        if (duration == null || duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException(
                    "leaseDuration must be positive");
        }
        Duration normalized = duration.truncatedTo(ChronoUnit.MICROS);
        if (normalized.isZero()) {
            throw new IllegalArgumentException(
                    "leaseDuration must be at least one microsecond");
        }
        return normalized;
    }

    static Instant databaseNow(Connection connection) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT CURRENT_TIMESTAMP")) {
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    throw new SQLException("database returned no clock row");
                }
                return result.getTimestamp(1, utcCalendar()).toInstant()
                        .truncatedTo(ChronoUnit.MICROS);
            }
        }
    }

    static void setInstant(PreparedStatement statement, int index,
            Instant value) throws SQLException {
        if (value == null) {
            statement.setTimestamp(index, null);
        } else {
            statement.setTimestamp(index, Timestamp.from(value),
                    utcCalendar());
        }
    }

    static Instant getInstant(ResultSet result, String column)
            throws SQLException {
        Timestamp timestamp = result.getTimestamp(column, utcCalendar());
        return timestamp == null ? null : timestamp.toInstant();
    }

    static <T> T read(DataSource dataSource, SqlWork<T> work) {
        try (Connection connection = dataSource.getConnection()) {
            return work.run(connection);
        } catch (SQLException exception) {
            throw failure(exception);
        }
    }

    static <T> T transaction(DataSource dataSource, SqlWork<T> work) {
        try (Connection connection = dataSource.getConnection()) {
            boolean autoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                T result = work.run(connection);
                connection.commit();
                return result;
            } catch (SQLException exception) {
                rollback(connection, exception);
                throw failure(exception);
            } catch (RuntimeException exception) {
                rollback(connection, exception);
                throw exception;
            } finally {
                connection.setAutoCommit(autoCommit);
            }
        } catch (SQLException exception) {
            throw failure(exception);
        }
    }

    static boolean isConstraintViolation(Throwable failure) {
        Throwable current = failure;
        while (current != null) {
            if (current instanceof SQLException) {
                SQLException sqlFailure = (SQLException) current;
                String state = sqlFailure.getSQLState();
                if (state != null && state.startsWith("23")) {
                    return true;
                }
                SQLException next = sqlFailure.getNextException();
                if (next != null && next != current
                        && isConstraintViolation(next)) {
                    return true;
                }
            }
            current = current.getCause();
        }
        return false;
    }

    static IllegalStateException failure(SQLException exception) {
        return new IllegalStateException(
                "Runtime Broker database operation failed", exception);
    }

    private static String digest(String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String value : values) {
                if (value == null) {
                    digest.update(ByteBuffer.allocate(Integer.BYTES)
                            .putInt(-1).array());
                } else {
                    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                    digest.update(ByteBuffer.allocate(Integer.BYTES)
                            .putInt(bytes.length).array());
                    digest.update(bytes);
                }
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable",
                    exception);
        }
    }

    private static Calendar utcCalendar() {
        return Calendar.getInstance(UTC);
    }

    private static void rollback(Connection connection,
            Exception original) {
        try {
            connection.rollback();
        } catch (SQLException rollbackFailure) {
            original.addSuppressed(rollbackFailure);
        }
    }

    @FunctionalInterface
    interface SqlWork<T> {
        T run(Connection connection) throws SQLException;
    }
}
