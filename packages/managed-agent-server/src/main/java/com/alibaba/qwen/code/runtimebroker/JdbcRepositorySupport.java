package com.alibaba.qwen.code.runtimebroker;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import javax.sql.DataSource;

final class JdbcRepositorySupport {
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
        if (request.isManagedContext()) {
            return digest("managed-context/1", scope.getTenantId(),
                    scope.getWorkspaceId(), scope.getWorkspaceGeneration(),
                    scope.getCanonicalCwd(), scope.getCapabilityDigest(),
                    scope.getIsolationClass(), request.getIsolationKey(),
                    request.getProvisionerKind(), request.getStorageId());
        }
        return digest(scope.getTenantId(), scope.getWorkspaceId(),
                scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass(),
                request.getIsolationKey(), request.getProvisionerKind());
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
        return databaseNowPrecise(connection).truncatedTo(
                ChronoUnit.SECONDS);
    }

    static Instant databaseNowPrecise(Connection connection)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT UNIX_TIMESTAMP(),"
                        + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))")) {
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    throw new SQLException("database returned no clock row");
                }
                long epochSeconds = result.getLong(1);
                if (result.wasNull()) {
                    throw new SQLException("database returned a null clock");
                }
                long micros = result.getLong(2);
                if (result.wasNull() || micros < 0 || micros >= 1_000_000) {
                    throw new SQLException(
                            "database returned invalid clock precision");
                }
                return Instant.ofEpochSecond(epochSeconds, micros / 1_000L * 1_000_000L);
            }
        }
    }

    static Instant leaseUntil(Instant now, Duration duration) {
        Instant deadline = now.plus(duration);
        return deadline.getNano() == 0 ? deadline
                : deadline.truncatedTo(ChronoUnit.SECONDS).plusSeconds(1);
    }

    static void setInstant(PreparedStatement statement, int index,
            Instant value) throws SQLException {
        if (value == null) {
            statement.setNull(index, Types.BIGINT);
        } else {
            long millis;
            try {
                millis = value.toEpochMilli();
            } catch (ArithmeticException error) {
                throw new SQLException("Managed timestamp exceeds the epoch millisecond range", error);
            }
            if (millis < 0) {
                throw new SQLException("Managed timestamp precedes the epoch");
            }
            statement.setLong(index, millis);
        }
    }

    static Instant getInstant(ResultSet result, String column)
            throws SQLException {
        var timestamp = ManagedSchemaTime.timestamp(result, column);
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

    static void setIdentity(java.sql.PreparedStatement statement, int index, String value) throws SQLException {
        statement.setBytes(index, value == null ? null
                : com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(value));
    }

    static void setStringParameter(java.sql.PreparedStatement statement, int index, String value)
            throws SQLException {
        if ("H2".equals(statement.getConnection().getMetaData().getDatabaseProductName())) {
            int type = statement.getParameterMetaData().getParameterType(index);
            if (type == java.sql.Types.BINARY
                    || type == java.sql.Types.VARBINARY
                    || type == java.sql.Types.LONGVARBINARY) {
                setIdentity(statement, index, value);
                return;
            }
        }
        statement.setString(index, value);
    }

    static StoreFailureException failure(SQLException exception) {
        return new StoreFailureException(
                "Runtime Broker database operation failed", exception);
    }

    /**
     * A genuine store outage, distinct from the permanent invariant
     * violations the repositories raise as plain IllegalStateExceptions: the
     * service maps only this type to a retryable 503.
     */
    static final class StoreFailureException extends IllegalStateException {
        StoreFailureException(String message, Throwable cause) {
            super(message, cause);
        }
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
