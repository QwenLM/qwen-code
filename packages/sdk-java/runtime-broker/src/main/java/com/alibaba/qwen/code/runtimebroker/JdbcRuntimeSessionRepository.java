package com.alibaba.qwen.code.runtimebroker;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import javax.sql.DataSource;

/** JDBC logical Runtime Session repository. */
public final class JdbcRuntimeSessionRepository
        implements RuntimeSessionRepository {
    private static final String SESSION_COLUMNS = String.join(", ",
            "scope_key", "runtime_session_id", "tenant_id", "workspace_id",
            "workspace_generation", "canonical_cwd", "capability_digest",
            "isolation_class", "harness_session_id", "turn_kind",
            "binding_id", "runtime_generation", "session_state",
            "record_version", "last_active_at");

    private final DataSource dataSource;

    public JdbcRuntimeSessionRepository(DataSource dataSource) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
    }

    @Override
    public RuntimeSessionRecord findOrCreate(
            RuntimeSessionRecord candidate) {
        requireCandidate(candidate);
        RuntimeScope scope = candidate.getSession().getScope();
        RuntimeSessionRecord existing = findById(scope,
                candidate.getRuntimeSessionId());
        if (existing != null) {
            return requireSameIdentity(existing, candidate);
        }
        try {
            return JdbcRepositorySupport.transaction(dataSource,
                    connection -> {
                        insertSession(connection, candidate);
                        return candidate;
                    });
        } catch (IllegalStateException failure) {
            if (!JdbcRepositorySupport.isConstraintViolation(failure)) {
                throw failure;
            }
            RuntimeSessionRecord winner = findById(scope,
                    candidate.getRuntimeSessionId());
            if (winner == null) {
                throw failure;
            }
            return requireSameIdentity(winner, candidate);
        }
    }

    @Override
    public RuntimeSessionRecord findById(RuntimeScope scope,
            String runtimeSessionId) {
        if (scope == null) {
            throw new IllegalArgumentException("scope is required");
        }
        String id = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            RuntimeSessionRecord record = selectSession(connection, scope,
                    id, false);
            if (record != null
                    && (!scope.equals(record.getSession().getScope())
                            || !id.equals(record.getRuntimeSessionId()))) {
                throw new IllegalStateException(
                        "Runtime Session identifier collision");
            }
            return record;
        });
    }

    @Override
    public RuntimeSessionRecord compareAndSet(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement) {
        requireReplacement(expected, replacement);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            RuntimeSessionRecord current = selectSession(connection,
                    expected.getSession().getScope(),
                    expected.getRuntimeSessionId(), true);
            if (current == null || !current.sameIdentity(expected)
                    || current.getVersion() != expected.getVersion()) {
                return null;
            }
            if (!current.isActive() && replacement.isActive()) {
                throw new IllegalArgumentException(
                        "terminal Session cannot be reactivated");
            }
            RuntimeSessionRecord updated = replacement.withVersion(
                    expected.getVersion() + 1);
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE qwen_runtime_session SET session_state = ?, "
                            + "record_version = ?, last_active_at = ? "
                            + "WHERE scope_key = ? "
                            + "AND runtime_session_id = ?")) {
                statement.setString(1, updated.getState().name());
                statement.setLong(2, updated.getVersion());
                JdbcRepositorySupport.setInstant(statement, 3,
                        updated.getLastActiveAt());
                statement.setString(4, JdbcRepositorySupport.scopeKey(
                        updated.getSession().getScope()));
                statement.setString(5, updated.getRuntimeSessionId());
                if (statement.executeUpdate() != 1) {
                    throw new SQLException("Runtime Session update failed");
                }
            }
            return updated;
        });
    }

    @Override
    public long countActiveByBinding(String bindingId,
            long runtimeGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        return JdbcRepositorySupport.read(dataSource, connection -> {
            long count = 0;
            String sql = "SELECT binding_id FROM qwen_runtime_session "
                    + "WHERE binding_id = ? AND runtime_generation = ? "
                    + "AND session_state NOT IN ('RELEASED', 'FAILED')";
            try (PreparedStatement statement = connection.prepareStatement(
                    sql)) {
                statement.setString(1, id);
                statement.setLong(2, runtimeGeneration);
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        if (id.equals(result.getString("binding_id"))) {
                            count++;
                        }
                    }
                }
            }
            return count;
        });
    }

    private static RuntimeSessionRecord selectSession(Connection connection,
            RuntimeScope scope, String runtimeSessionId, boolean forUpdate)
            throws SQLException {
        String sql = "SELECT " + SESSION_COLUMNS
                + " FROM qwen_runtime_session WHERE scope_key = ? "
                + "AND runtime_session_id = ?"
                + (forUpdate ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, JdbcRepositorySupport.scopeKey(scope));
            statement.setString(2, runtimeSessionId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                RuntimeSessionRecord record = mapSession(result);
                if (!scope.equals(record.getSession().getScope())
                        || !runtimeSessionId.equals(
                                record.getRuntimeSessionId())) {
                    throw new IllegalStateException(
                            "Runtime Session identifier collision");
                }
                return record;
            }
        }
    }

    private static void insertSession(Connection connection,
            RuntimeSessionRecord record) throws SQLException {
        String sql = "INSERT INTO qwen_runtime_session (" + SESSION_COLUMNS
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        RuntimeSession session = record.getSession();
        RuntimeScope scope = session.getScope();
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, JdbcRepositorySupport.scopeKey(scope));
            statement.setString(2, session.getRuntimeSessionId());
            statement.setString(3, scope.getTenantId());
            statement.setString(4, scope.getWorkspaceId());
            statement.setString(5, scope.getWorkspaceGeneration());
            statement.setString(6, scope.getCanonicalCwd());
            statement.setString(7, scope.getCapabilityDigest());
            statement.setString(8, scope.getIsolationClass());
            statement.setString(9, session.getHarnessSessionId());
            statement.setString(10, session.getTurnKind());
            statement.setString(11, record.getBindingId());
            statement.setLong(12, record.getRuntimeGeneration());
            statement.setString(13, record.getState().name());
            statement.setLong(14, record.getVersion());
            JdbcRepositorySupport.setInstant(statement, 15,
                    record.getLastActiveAt());
            statement.executeUpdate();
        }
    }

    private static RuntimeSessionRecord mapSession(ResultSet result)
            throws SQLException {
        RuntimeScope scope = new RuntimeScope(result.getString("tenant_id"),
                result.getString("workspace_id"),
                result.getString("workspace_generation"),
                result.getString("canonical_cwd"),
                result.getString("capability_digest"),
                result.getString("isolation_class"));
        if (!JdbcRepositorySupport.scopeKey(scope).equals(
                result.getString("scope_key"))) {
            throw new IllegalStateException(
                    "Runtime Session scope hash is invalid");
        }
        RuntimeSession session = new RuntimeSession(
                result.getString("harness_session_id"),
                result.getString("runtime_session_id"),
                result.getString("turn_kind"), scope);
        return new RuntimeSessionRecord(session,
                result.getString("binding_id"),
                result.getLong("runtime_generation"),
                RuntimeSessionRecord.State.valueOf(
                        result.getString("session_state")),
                result.getLong("record_version"),
                JdbcRepositorySupport.getInstant(result, "last_active_at"));
    }

    private static RuntimeSessionRecord requireSameIdentity(
            RuntimeSessionRecord existing,
            RuntimeSessionRecord candidate) {
        if (!existing.sameIdentity(candidate)) {
            throw new IllegalArgumentException(
                    "runtimeSessionId is bound to another Session identity");
        }
        return existing;
    }

    private static void requireCandidate(RuntimeSessionRecord candidate) {
        if (candidate == null || candidate.getVersion() != 0
                || candidate.getState()
                        != RuntimeSessionRecord.State.ACQUIRING) {
            throw new IllegalArgumentException(
                    "candidate must be a new acquiring Session");
        }
    }

    private static void requireReplacement(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || replacement.getVersion() != expected.getVersion()) {
            throw new IllegalArgumentException(
                    "replacement must preserve Session identity and version");
        }
    }
}
