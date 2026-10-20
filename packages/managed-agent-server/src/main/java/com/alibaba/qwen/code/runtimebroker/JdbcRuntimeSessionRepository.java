package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiFilesProtocol;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import javax.sql.DataSource;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** JDBC logical Runtime Session repository. */
public final class JdbcRuntimeSessionRepository
        implements RuntimeSessionRepository {
    static final String SESSION_COLUMNS = String.join(", ",
            "scope_key", "runtime_session_id", "tenant_id", "workspace_id",
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
                BrokerValues.requireId(runtimeSessionId, "runtimeSessionId"), true, 10);
    }

    public void completeCsiApplication(Connection connection, JdbcCsiApplicationRetirement.Authority authority,
            JdbcRuntimeBindingRepository bindings, byte[] receipt) throws SQLException {
        authority.requireConnection(connection);
        if (authority.stage() != JdbcCsiApplicationRetirement.Stage.CUT || bindings == null
                || !bindings.usesDataSource(dataSource) || receipt == null || receipt.length > 64 * 1024) {
            throw new IllegalArgumentException("Original CUT authority and persisted receipt are required");
        }
        var original = authority.original();
        var frozen = ManagedCsiFilesProtocol.parse(authority.frozenBytes(), 32 * 1024 * 1024);
        var binding = bindings.findByIdForUpdate(connection, original.bindingId());
        if (binding == null || !binding.getRequest().equals(original.request()) || binding.getGeneration() != 1
                || binding.getVersion() != original.version()) {
            throw new IllegalArgumentException("Original binding is required");
        }
        com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding context;
        try (var statement = connection.prepareStatement("SELECT * FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE")) {
            statement.setQueryTimeout(10);
            JdbcRepositorySupport.setIdentity(statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            try (var row = statement.executeQuery()) {
                if (!row.next() || !row.getBoolean("csi_guard")) {
                    throw new IllegalArgumentException("Original managed Session is required");
                }
                context = new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "tenant_id"),
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_id"), row.getLong("workspace_generation"), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_storage_id"),
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "cwd_relative"), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "context_config_ref"), row.getLong("context_revision"));
                if (row.next()) {
                    throw new IllegalArgumentException("Ambiguous original managed Session");
                }
            }
        }
        var operation = new java.util.LinkedHashMap<String, Object>();
        operation.put("operation", "finalize");
        operation.put("retirementId", authority.retirementId());
        operation.put("preparedCommitSha256", frozen.get("preparedCommitSha256"));
        operation.put("frozenRequestSha256", CsiNativeActivationProof.sha256(authority.frozenBytes()));
        operation.put("cutSha256", CsiNativeActivationProof.sha256(authority.cutBytes()));
        var expected = CsiFileFinalizeProtocol.request(binding, context, operation);
        var response = CsiFileFinalizeProtocol.response(receipt, expected);
        if (!java.util.Objects.equals(frozen.get("preCutObservationSha256"), response.get("preCutObservationSha256"))) {
            throw new IllegalArgumentException("Original observation is required");
        }
        try (var statement = connection.prepareStatement("SELECT finalize_receipt_bytes, finalize_receipt_sha256"
                + " FROM ma_operation WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT'"
                + " AND tenant_id = ? AND operation_id = ? AND target_kind = 'RUNTIME_BINDING'"
                + " AND target_key = ? AND target_id = ? AND target_revision = ?"
                + " AND progress_stage = 'CUT' AND progress_version = 3 FOR UPDATE")) {
            statement.setQueryTimeout(10);
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("CSI_RETIREMENT", original.request().getScope().getTenantId(), authority.retirementId()));
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 3, authority.retirementId());
            statement.setString(4, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.bindingId()));
            JdbcRepositorySupport.setIdentity(statement, 5, original.bindingId());
            statement.setLong(6, original.generation());
            try (var row = statement.executeQuery()) {
                if (!row.next() || !java.util.Arrays.equals(receipt, row.getBytes(1))
                        || !CsiNativeActivationProof.sha256(receipt).equals(row.getString(2)) || row.next()) {
                    throw new IllegalArgumentException("Exact persisted original receipt is required");
                }
            }
        }
        var saved = findByIdForUpdate(connection, original.request().getScope(), original.request().getIsolationKey());
        original.requireSession(saved);
        if (saved.getState() != RuntimeSessionRecord.State.READY || saved.getVersion() == Long.MAX_VALUE) {
            throw new IllegalArgumentException("Original READY logical Session is required");
        }
        try (var statement = connection.prepareStatement("UPDATE ma_runtime_session SET session_state = 'RELEASED',"
                + " record_version = record_version + 1 WHERE scope_key = ? AND runtime_session_id = ?"
                + " AND binding_id = ? AND runtime_generation = 1 AND session_state = 'READY' AND record_version = ?")) {
            statement.setQueryTimeout(10);
            statement.setString(1, JdbcRepositorySupport.scopeKey(original.request().getScope()));
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            JdbcRepositorySupport.setIdentity(statement, 3, original.bindingId());
            statement.setLong(4, saved.getVersion());
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Original logical Session completion failed");
            }
        }
    }

    static List<RuntimeSessionRecord> lockActiveSessions(Connection connection,
            RuntimeBindingRecord binding) throws SQLException {
        List<RuntimeSessionRecord> batch = new ArrayList<>();
        String sql = "SELECT " + SESSION_COLUMNS + " FROM ma_runtime_session "
                + "WHERE binding_id = ? AND runtime_generation = ? "
                + "AND session_state NOT IN ('RELEASED', 'FAILED') "
                + "ORDER BY scope_key, runtime_session_id LIMIT 100 FOR UPDATE";
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
                            + "WHERE scope_key = ? AND runtime_session_id = ?")) {
                JdbcRepositorySupport.setInstant(statement, 1, now);
                statement.setString(2, JdbcRepositorySupport.scopeKey(session.getSession().getScope()));
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
                    if (binding.getBindingId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "binding_id"))) {
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
        if (JdbcCsiFilesRetirementGuard.isProfile(scope)) {
            return JdbcRepositorySupport.transaction(dataSource, connection -> {
                var original = JdbcCsiFilesRetirementGuard.lockRuntimeSession(connection, candidate);
                original.requireAdmission();
                JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
                RuntimeSessionRecord existing = selectSession(connection, scope,
                        candidate.getRuntimeSessionId(), true);
                if (existing != null) {
                    return requireSameIdentity(existing, candidate);
                }
                insertSession(connection, candidate);
                return candidate;
            });
        }
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
    public RuntimeSessionRecord findHistorical(String tenantId, String harnessSessionId, String runtimeSessionId) {
        BrokerValues.requireId(tenantId, "tenantId");
        BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        BrokerValues.requireId(runtimeSessionId, "runtimeSessionId");
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
            String harnessSessionId, java.util.Collection<String> runtimeSessionIds) {
        String tenant = BrokerValues.requireId(tenantId, "tenantId");
        String harness = BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        java.util.LinkedHashSet<String> ids = new java.util.LinkedHashSet<>();
        for (String runtimeSessionId : runtimeSessionIds) {
            ids.add(BrokerValues.requireId(runtimeSessionId, "runtimeSessionId"));
        }
        if (ids.isEmpty()) {
            return List.of();
        }
        List<String> ordered = List.copyOf(ids);
        return JdbcRepositorySupport.read(dataSource, connection -> {
            java.util.Map<String, RuntimeSessionRecord> found = new java.util.HashMap<>();
            for (int from = 0; from < ordered.size(); from += 100) {
                List<String> chunk = ordered.subList(from,
                        Math.min(from + 100, ordered.size()));
                String placeholders = String.join(", ",
                        java.util.Collections.nCopies(chunk.size(), "?"));
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
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            JdbcCsiFilesRetirementGuard.Original original =
                    JdbcCsiFilesRetirementGuard.lockRuntimeSession(connection, expected);
            if (original != null) {
                JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
                if (replacement.getState() == RuntimeSessionRecord.State.RELEASING
                        || replacement.getState() == RuntimeSessionRecord.State.RELEASED) {
                    throw JdbcCsiFilesRetirementGuard.releaseUnavailable();
                }
                if (expected.getState() == RuntimeSessionRecord.State.ACQUIRING
                        && replacement.getState() == RuntimeSessionRecord.State.READY) {
                    original.requireAdmission();
                }
            }
            return compareAndSet(connection, expected, replacement);
        });
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
                        + "WHERE scope_key = ? "
                        + "AND runtime_session_id = ?")) {
            statement.setString(1, updated.getState().name());
            statement.setLong(2, updated.getVersion());
            JdbcRepositorySupport.setInstant(statement, 3,
                    updated.getLastActiveAt());
            statement.setString(4, JdbcRepositorySupport.scopeKey(
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
        BrokerValues.requireId(tenantId, "tenantId");
        BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Release batch must contain 1-100 Sessions");
        }
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<RuntimeSessionRecord> result = new ArrayList<>();
            try (PreparedStatement statement = connection.prepareStatement("SELECT " + SESSION_COLUMNS
                    + " FROM ma_runtime_session WHERE harness_session_id = ? AND tenant_id = ?"
                    + " AND session_state NOT IN ('RELEASED', 'FAILED')"
                    + " AND (scope_key > ? OR scope_key = ? AND runtime_session_id > ?)"
                    + " ORDER BY scope_key, runtime_session_id LIMIT ?")) {
                String afterScope = after == null ? "" : JdbcRepositorySupport.scopeKey(after.getSession().getScope());
                JdbcRepositorySupport.setIdentity(statement, 1, harnessSessionId);
                JdbcRepositorySupport.setIdentity(statement, 2, tenantId);
                statement.setString(3, afterScope);
                statement.setString(4, afterScope);
                JdbcRepositorySupport.setIdentity(statement, 5, after == null ? "" : after.getRuntimeSessionId());
                statement.setInt(6, limit);
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
        String id = BrokerValues.requireId(bindingId, "bindingId");
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
                        if (id.equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "binding_id"))) {
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
                + " FROM ma_runtime_session WHERE scope_key = ? "
                + "AND runtime_session_id = ?"
                + (forUpdate ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            if (queryTimeout > 0) {
                statement.setQueryTimeout(queryTimeout);
            }
            statement.setString(1, JdbcRepositorySupport.scopeKey(scope));
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
            statement.setString(1, JdbcRepositorySupport.scopeKey(scope));
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
        RuntimeScope scope = new RuntimeScope(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "tenant_id"),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "workspace_id"),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "workspace_generation"),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "canonical_cwd"),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "capability_digest"),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "isolation_class"));
        if (!JdbcRepositorySupport.scopeKey(scope).equals(
                result.getString("scope_key"))) {
            throw new IllegalStateException(
                    "Runtime Session scope hash is invalid");
        }
        RuntimeSession session = new RuntimeSession(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "harness_session_id"),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "runtime_session_id"),
                result.getString("turn_kind"), scope);
        return new RuntimeSessionRecord(session,
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(result, "binding_id"),
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
