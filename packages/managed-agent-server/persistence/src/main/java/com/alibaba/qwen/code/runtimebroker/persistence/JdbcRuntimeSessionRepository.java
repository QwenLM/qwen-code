package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/** JDBC logical Runtime Session repository. */
public final class JdbcRuntimeSessionRepository
        implements RuntimeSessionRepository {
    static final String SESSION_COLUMNS = String.join(", ",
            "scope_id", "runtime_session_id", "tenant_id", "workspace_id",
            "workspace_generation", "canonical_cwd", "capability_digest",
            "isolation_class", "harness_session_id", "turn_kind",
            "binding_id", "runtime_generation", "session_state",
            "record_version", "last_active_at");

    private final DataSource dataSource;

    public JdbcRuntimeSessionRepository(DataSource dataSource) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
    }

    public boolean usesDataSource(DataSource source) {
        return dataSource == source;
    }

    public RuntimeSessionRecord findByIdForUpdate(Connection connection,
            RuntimeScope scope, String runtimeSessionId) throws SQLException {
        if (connection == null || connection.getAutoCommit() || scope == null) {
            throw new IllegalArgumentException("An active transaction and scope are required");
        }
        return selectSession(connection, scope,
                BrokerValues.requireRuntimeSessionId(runtimeSessionId, "runtimeSessionId"), true, 10);
    }

    static List<RuntimeSessionRecord> lockActiveSessions(Connection connection,
            RuntimeBindingRecord binding) throws SQLException {
        List<RuntimeSessionRecord> batch = new ArrayList<>();
        String sql = "SELECT " + SESSION_COLUMNS + " FROM ma_runtime_session "
                + "WHERE binding_id = ? AND runtime_generation = ? "
                + "AND session_state NOT IN ('RELEASED', 'FAILED') "
                + "ORDER BY scope_id, runtime_session_id LIMIT 100 FOR UPDATE";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            JdbcRepositorySupport.setIdentity(statement, 1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    RuntimeSessionRecord record = mapSession(result);
                    if (record.getBindingId().equals(binding.getBindingId())) {
                        batch.add(record);
                    }
                }
            }
        }
        return batch;
    }

    static void releaseLost(Connection connection, List<RuntimeSessionRecord> batch,
            Instant now) throws SQLException {
        for (RuntimeSessionRecord session : batch) {
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE ma_runtime_session SET session_state = 'RELEASED', "
                            + "record_version = record_version + 1, last_active_at = ? "
                            + "WHERE scope_id = ? AND runtime_session_id = ?")) {
                JdbcRepositorySupport.setInstant(statement, 1, now);
                JdbcRepositorySupport.setIdentity(statement, 2, JdbcRepositorySupport.scopeKey(session.getSession().getScope()));
                JdbcRepositorySupport.setIdentity(statement, 3, session.getRuntimeSessionId());
                if (statement.executeUpdate() != 1) {
                    throw new SQLException("Lost Session release failed");
                }
            }
        }
    }

    static boolean hasActiveByBinding(Connection connection, RuntimeBindingRecord binding)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT binding_id FROM ma_runtime_session WHERE binding_id = ? "
                        + "AND runtime_generation = ? AND session_state NOT IN ('RELEASED', 'FAILED')")) {
            JdbcRepositorySupport.setIdentity(statement, 1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    if (binding.getBindingId().equals(ManagedSchemaRows.identity(result, "binding_id"))) {
                        return true;
                    }
                }
            }
        }
        return false;
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
        String id = BrokerValues.requireRuntimeSessionId(runtimeSessionId,
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
    public RuntimeSessionRecord findHistorical(String tenantId, String harnessSessionId, String runtimeSessionId) {
        BrokerValues.requireId(tenantId, "tenantId");
        BrokerValues.requireHarnessSessionId(harnessSessionId, "harnessSessionId");
        BrokerValues.requireRuntimeSessionId(runtimeSessionId, "runtimeSessionId");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<RuntimeSessionRecord> matches = new ArrayList<>();
            try (PreparedStatement statement = connection.prepareStatement("SELECT " + SESSION_COLUMNS
                    + " FROM ma_runtime_session WHERE tenant_id = ? AND harness_session_id = ? AND runtime_session_id = ?")) {
                JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
                JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
                JdbcRepositorySupport.setIdentity(statement, 3, runtimeSessionId);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        var record = mapSession(rows);
                        if (tenantId.equals(record.getSession().getScope().getTenantId())
                                && harnessSessionId.equals(record.getSession().getHarnessSessionId())
                                && runtimeSessionId.equals(record.getRuntimeSessionId())) {
                            matches.add(record);
                            if (matches.size() > 1) {
                                throw new RuntimeBrokerException(409, "runtime_session_ambiguous",
                                        "Historical Runtime Session is ambiguous", false);
                            }
                        }
                    }
                }
            }
            return matches.isEmpty() ? null : matches.getFirst();
        });
    }

    @Override
    public List<RuntimeSessionRecord> findHistoricalByIds(String tenantId,
            String harnessSessionId, Collection<String> runtimeSessionIds) {
        String tenant = BrokerValues.requireId(tenantId, "tenantId");
        String harness = BrokerValues.requireHarnessSessionId(harnessSessionId, "harnessSessionId");
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        for (String runtimeSessionId : runtimeSessionIds) {
            ids.add(BrokerValues.requireRuntimeSessionId(runtimeSessionId, "runtimeSessionId"));
        }
        if (ids.isEmpty()) {
            return List.of();
        }
        List<String> ordered = List.copyOf(ids);
        return JdbcRepositorySupport.read(dataSource, connection -> {
            Map<String, RuntimeSessionRecord> found = new HashMap<>();
            for (int from = 0; from < ordered.size(); from += 100) {
                List<String> chunk = ordered.subList(from,
                        Math.min(from + 100, ordered.size()));
                String placeholders = String.join(", ",
                        Collections.nCopies(chunk.size(), "?"));
                String sql = "SELECT " + SESSION_COLUMNS
                        + " FROM ma_runtime_session WHERE tenant_id = ?"
                        + " AND harness_session_id = ? AND runtime_session_id IN ("
                        + placeholders + ")";
                try (PreparedStatement statement = connection.prepareStatement(sql)) {
                    JdbcRepositorySupport.setIdentity(statement, 1, tenant);
                    JdbcRepositorySupport.setIdentity(statement, 2, harness);
                    for (int index = 0; index < chunk.size(); index++) {
                        JdbcRepositorySupport.setIdentity(statement, 3 + index,
                                chunk.get(index));
                    }
                    try (ResultSet rows = statement.executeQuery()) {
                        while (rows.next()) {
                            var record = mapSession(rows);
                            if (!tenant.equals(record.getSession().getScope().getTenantId())
                                    || !harness.equals(record.getSession().getHarnessSessionId())
                                    || !ids.contains(record.getRuntimeSessionId())) {
                                continue;
                            }
                            if (found.putIfAbsent(record.getRuntimeSessionId(), record) != null) {
                                throw new RuntimeBrokerException(409, "runtime_session_ambiguous",
                                        "Historical Runtime Session is ambiguous", false);
                            }
                        }
                    }
                }
            }
            List<RuntimeSessionRecord> orderedResult = new ArrayList<>();
            for (String id : ordered) {
                RuntimeSessionRecord record = found.get(id);
                if (record != null) {
                    orderedResult.add(record);
                }
            }
            return orderedResult;
        });
    }

    @Override
    public RuntimeSessionRecord compareAndSet(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement) {
        requireReplacement(expected, replacement);
        return JdbcRepositorySupport.transaction(dataSource, connection ->
            compareAndSet(connection, expected, replacement));
    }

    static RuntimeSessionRecord compareAndSet(Connection connection, RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement) throws SQLException {
        requireReplacement(expected, replacement);
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
                "UPDATE ma_runtime_session SET session_state = ?, "
                        + "record_version = ?, last_active_at = ? "
                        + "WHERE scope_id = ? "
                        + "AND runtime_session_id = ?")) {
            statement.setString(1, updated.getState().name());
            statement.setLong(2, updated.getVersion());
            JdbcRepositorySupport.setInstant(statement, 3,
                    updated.getLastActiveAt());
            JdbcRepositorySupport.setIdentity(statement, 4, JdbcRepositorySupport.scopeKey(
                    updated.getSession().getScope()));
            JdbcRepositorySupport.setIdentity(statement, 5, updated.getRuntimeSessionId());
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Runtime Session update failed");
            }
        }
        return updated;
    }

    @Override
    public List<RuntimeSessionRecord> findByBinding(String bindingId, long generation,
            String afterSessionId, int limit) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Drain batch must contain 1-100 Sessions");
        }
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<RuntimeSessionRecord> result = new ArrayList<>();
            try (PreparedStatement statement = connection.prepareStatement("SELECT " + SESSION_COLUMNS
                    + " FROM ma_runtime_session WHERE binding_id = ? AND runtime_generation = ?"
                    + " AND runtime_session_id > ? ORDER BY runtime_session_id LIMIT ?")) {
                JdbcRepositorySupport.setIdentity(statement, 1, bindingId);
                statement.setLong(2, generation);
                JdbcRepositorySupport.setIdentity(statement, 3, afterSessionId == null ? "" : afterSessionId);
                statement.setInt(4, limit);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        result.add(mapSession(rows));
                    }
                }
            }
            return List.copyOf(result);
        });
    }

    @Override
    public List<RuntimeSessionRecord> findActiveByHarnessSession(String tenantId, String harnessSessionId,
            RuntimeSessionRecord after, int limit) {
        return findActiveByHarnessSession(tenantId, harnessSessionId, after, limit, null);
    }

    @Override
    public List<RuntimeSessionRecord> findActiveByHarnessSession(String tenantId, String harnessSessionId,
            RuntimeSessionRecord after, int limit, String excludeTurnKind) {
        BrokerValues.requireId(tenantId, "tenantId");
        BrokerValues.requireHarnessSessionId(harnessSessionId, "harnessSessionId");
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Release batch must contain 1-100 Sessions");
        }
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<RuntimeSessionRecord> result = new ArrayList<>();
            try (PreparedStatement statement = connection.prepareStatement("SELECT " + SESSION_COLUMNS
                    + " FROM ma_runtime_session WHERE harness_session_id = ? AND tenant_id = ?"
                    + " AND session_state NOT IN ('RELEASED', 'FAILED')"
                    + " AND (scope_id > ? OR scope_id = ? AND runtime_session_id > ?)"
                    + (excludeTurnKind == null ? "" : " AND turn_kind <> ?")
                    + " ORDER BY scope_id, runtime_session_id LIMIT ?")) {
                String afterScope = after == null ? "" : JdbcRepositorySupport.scopeKey(after.getSession().getScope());
                JdbcRepositorySupport.setIdentity(statement, 1, harnessSessionId);
                JdbcRepositorySupport.setIdentity(statement, 2, tenantId);
                JdbcRepositorySupport.setIdentity(statement, 3, afterScope);
                JdbcRepositorySupport.setIdentity(statement, 4, afterScope);
                JdbcRepositorySupport.setIdentity(statement, 5, after == null ? "" : after.getRuntimeSessionId());
                if (excludeTurnKind == null) {
                    statement.setInt(6, limit);
                } else {
                    statement.setString(6, excludeTurnKind);
                    statement.setInt(7, limit);
                }
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        result.add(mapSession(rows));
                    }
                }
            }
            return List.copyOf(result);
        });
    }

    @Override
    public long countActiveByBinding(String bindingId,
            long runtimeGeneration) {
        String id = BrokerValues.requireBindingId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        return JdbcRepositorySupport.read(dataSource, connection -> {
            long count = 0;
            String sql = "SELECT binding_id FROM ma_runtime_session "
                    + "WHERE binding_id = ? AND runtime_generation = ? "
                    + "AND session_state NOT IN ('RELEASED', 'FAILED')";
            try (PreparedStatement statement = connection.prepareStatement(
                    sql)) {
                JdbcRepositorySupport.setIdentity(statement, 1, id);
                statement.setLong(2, runtimeGeneration);
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        if (id.equals(ManagedSchemaRows.identity(result, "binding_id"))) {
                            count++;
                        }
                    }
                }
            }
            return count;
        });
    }

    static RuntimeSessionRecord selectSession(Connection connection,
            RuntimeScope scope, String runtimeSessionId, boolean forUpdate)
            throws SQLException {
        return selectSession(connection, scope, runtimeSessionId, forUpdate, 0);
    }

    private static RuntimeSessionRecord selectSession(Connection connection,
            RuntimeScope scope, String runtimeSessionId, boolean forUpdate,
            int queryTimeout) throws SQLException {
        String sql = "SELECT " + SESSION_COLUMNS
                + " FROM ma_runtime_session WHERE scope_id = ? "
                + "AND runtime_session_id = ?"
                + (forUpdate ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            if (queryTimeout > 0) {
                statement.setQueryTimeout(queryTimeout);
            }
            JdbcRepositorySupport.setIdentity(statement, 1, JdbcRepositorySupport.scopeKey(scope));
            JdbcRepositorySupport.setIdentity(statement, 2, runtimeSessionId);
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

    static void insertSession(Connection connection,
            RuntimeSessionRecord record) throws SQLException {
        String sql = "INSERT INTO ma_runtime_session (" + SESSION_COLUMNS
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        RuntimeSession session = record.getSession();
        RuntimeScope scope = session.getScope();
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            JdbcRepositorySupport.setIdentity(statement, 1, JdbcRepositorySupport.scopeKey(scope));
            JdbcRepositorySupport.setIdentity(statement, 2, session.getRuntimeSessionId());
            JdbcRepositorySupport.setIdentity(statement, 3, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 4, scope.getWorkspaceId());
            JdbcRepositorySupport.setIdentity(statement, 5, scope.getWorkspaceGeneration());
            statement.setString(6, scope.getCanonicalCwd());
            JdbcRepositorySupport.setIdentity(statement, 7, scope.getCapabilityDigest());
            statement.setString(8, scope.getIsolationClass());
            JdbcRepositorySupport.setIdentity(statement, 9, session.getHarnessSessionId());
            statement.setString(10, session.getTurnKind());
            JdbcRepositorySupport.setIdentity(statement, 11, record.getBindingId());
            statement.setLong(12, record.getRuntimeGeneration());
            statement.setString(13, record.getState().name());
            statement.setLong(14, record.getVersion());
            JdbcRepositorySupport.setInstant(statement, 15,
                    record.getLastActiveAt());
            statement.executeUpdate();
        }
    }

    static RuntimeSessionRecord mapSession(ResultSet result)
            throws SQLException {
        RuntimeScope scope = new RuntimeScope(result.getString("tenant_id"),
                result.getString("workspace_id"),
                ManagedSchemaRows.identity(result, "workspace_generation"),
                ManagedSchemaRows.identity(result, "canonical_cwd"),
                ManagedSchemaRows.identity(result, "capability_digest"),
                ManagedSchemaRows.identity(result, "isolation_class"));
        if (!JdbcRepositorySupport.scopeKey(scope).equals(
                ManagedSchemaRows.identity(result, "scope_id"))) {
            throw new IllegalStateException(
                    "Runtime Session scope hash is invalid");
        }
        RuntimeSession session = new RuntimeSession(
                result.getString("harness_session_id"),
                result.getString("runtime_session_id"),
                result.getString("turn_kind"), scope);
        return new RuntimeSessionRecord(session,
                ManagedSchemaRows.identity(result, "binding_id"),
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

    static void requireCandidate(RuntimeSessionRecord candidate) {
        if (candidate == null || candidate.getVersion() != 0
                || (candidate.getState() != RuntimeSessionRecord.State.ACQUIRING
                        && candidate.getState() != RuntimeSessionRecord.State.RELEASED)) {
            throw new IllegalArgumentException(
                    "candidate must be a new acquiring Session or release tombstone");
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
