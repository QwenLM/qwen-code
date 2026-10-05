package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.fastjson2.JSONWriter;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.ArrayList;
import java.util.List;
import javax.sql.DataSource;

/** JDBC ledger for idempotent Tool executions. */
public final class JdbcToolExecutionRepository
        implements ToolExecutionRepository {
    private static final String EXECUTION_COLUMNS = String.join(", ",
            "execution_call_id_hash", "execution_call_id",
            "idempotency_key_hash", "idempotency_key",
            "binding_id", "runtime_generation", "harness_session_id",
            "runtime_session_id", "runtime_session_key", "turn_id",
            "tool_call_id", "request_digest", "reference_json",
            "execution_state", "execution_status", "result_json",
            "last_sequence", "cancel_requested", "dispatch_owner",
            "dispatch_lease_until", "dispatch_generation", "record_version",
            "settled_at", "abandoned_at", "loss_evidence_id",
            "authorized_dispatch_generation", "authorized_binding_version");
    private final DataSource dataSource;

    public JdbcToolExecutionRepository(DataSource dataSource) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
    }

    static void abandonByBinding(Connection connection, RuntimeBindingRecord binding)
            throws SQLException {
        List<ToolExecutionRecord> batch = new ArrayList<>();
        String sql = "SELECT " + EXECUTION_COLUMNS + " FROM qwen_tool_execution "
                + "WHERE binding_id = ? AND runtime_generation = ? "
                + "AND execution_state NOT IN ('SETTLED', 'ABANDONED') "
                + "ORDER BY execution_call_id_hash LIMIT 100 FOR UPDATE";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    ToolExecutionRecord record = mapExecution(result);
                    if (record.getBindingId().equals(binding.getBindingId())) {
                        batch.add(record);
                    }
                }
            }
        }
        Instant now = JdbcRepositorySupport.databaseNow(connection);
        for (ToolExecutionRecord record : batch) {
            updateExecution(connection, record.abandon(binding, now)
                    .withVersion(record.getVersion() + 1));
        }
    }

    static boolean hasActiveByBinding(Connection connection, String bindingId,
            long generation) throws SQLException {
        String sql = "SELECT binding_id FROM qwen_tool_execution "
                + "WHERE binding_id = ? AND runtime_generation = ? "
                + "AND execution_state NOT IN ('SETTLED', 'ABANDONED')";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, bindingId);
            statement.setLong(2, generation);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    if (bindingId.equals(result.getString("binding_id"))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    @Override
    public ToolExecutionRecord findOrCreate(ToolExecutionRecord candidate) {
        requireCandidate(candidate);
        ToolExecutionRecord existing = findByIdempotencyKey(
                candidate.getIdempotencyKey());
        if (existing != null) {
            return existing;
        }
        try {
            return JdbcRepositorySupport.transaction(dataSource,
                    connection -> {
                        insertExecution(connection, candidate);
                        return candidate;
                    });
        } catch (IllegalStateException failure) {
            if (!JdbcRepositorySupport.isConstraintViolation(failure)) {
                throw failure;
            }
            ToolExecutionRecord winner = findByIdempotencyKey(
                    candidate.getIdempotencyKey());
            if (winner != null) {
                return winner;
            }
            ToolExecutionRecord duplicateId = findByExecutionCallId(
                    candidate.getExecutionCallId());
            if (duplicateId != null) {
                throw new IllegalArgumentException(
                        "executionCallId already belongs to another request",
                        failure);
            }
            throw failure;
        }
    }

    @Override
    public ToolExecutionRecord findByExecutionCallId(String executionCallId) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return JdbcRepositorySupport.read(dataSource, connection ->
                selectByExecutionId(connection, id, false));
    }

    @Override
    public ToolExecutionRecord findByIdempotencyKey(String idempotencyKey) {
        String key = BrokerValues.requireId(idempotencyKey,
                "idempotencyKey");
        return JdbcRepositorySupport.read(dataSource,
                connection -> selectByIdempotencyKey(connection, key));
    }

    static ToolExecutionRecord selectByIdempotencyKey(Connection connection,
            String key) throws SQLException {
        String sql = "SELECT " + EXECUTION_COLUMNS
                + " FROM qwen_tool_execution "
                + "WHERE idempotency_key_hash = ?";
        try (PreparedStatement statement = connection.prepareStatement(
                sql)) {
            statement.setString(1, JdbcRepositorySupport.valueKey(key));
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                ToolExecutionRecord record = mapExecution(result);
                if (!key.equals(record.getIdempotencyKey())) {
                    throw new IllegalStateException(
                            "Tool idempotency hash collision");
                }
                return record;
            }
        }
    }

    public boolean usesDataSource(DataSource source) {
        return dataSource == source;
    }

    public ToolExecutionRecord findByExecutionCallIdForUpdate(Connection connection,
            String executionCallId) throws SQLException {
        if (connection == null || connection.getAutoCommit()) {
            throw new IllegalArgumentException("An active transaction is required");
        }
        return selectByExecutionId(connection,
                BrokerValues.requireId(executionCallId, "executionCallId"), true);
    }

    @Override
    public ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner,
            long dispatchGeneration) {
        requireReplacement(expected, replacement);
        return JdbcRepositorySupport.transaction(dataSource, connection ->
                compareAndSet(connection, expected, replacement, owner, dispatchGeneration));
    }

    static ToolExecutionRecord compareAndSet(Connection connection, ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner, long dispatchGeneration) throws SQLException {
        return compareAndSet(connection, expected, replacement, owner, dispatchGeneration, false);
    }

    static ToolExecutionRecord authorizeDispatch(Connection connection, ToolExecutionRecord expected,
            String owner, long dispatchGeneration, long bindingVersion) throws SQLException {
        return compareAndSet(connection, expected, expected.authorizeDispatch(bindingVersion),
                owner, dispatchGeneration, true);
    }

    private static ToolExecutionRecord compareAndSet(Connection connection, ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner, long dispatchGeneration,
            boolean authorizing) throws SQLException {
        requireReplacement(expected, replacement);
        if (!authorizing && !expected.sameAuthorization(replacement)) {
            throw new IllegalArgumentException("replacement must preserve dispatch authorization");
        }
        ToolExecutionRecord current = selectByExecutionId(connection,
                expected.getExecutionCallId(), true);
        if (current == null || !current.sameIdentity(expected)
                || !current.sameAuthorization(expected)
                || authorizing && (current.getState() != ToolExecutionRecord.State.DISPATCHING
                        || current.isCancelRequested()
                        || current.getAuthorizedDispatchGeneration() != null)
                || current.getVersion() != expected.getVersion()
                || current.isTerminal()
                || current.getState()
                        == ToolExecutionRecord.State.UNKNOWN
                || !current.sameDispatch(expected)
                || !current.hasLiveDispatchAt(
                        JdbcRepositorySupport.databaseNowPrecise(
                                connection))
                || !current.getDispatchOwner().equals(owner)
                || current.getDispatchGeneration()
                        != dispatchGeneration) {
            return null;
        }
        ToolExecutionRecord.State nextState = replacement.getState();
        if (nextState == ToolExecutionRecord.State.ABANDONED
                || nextState == ToolExecutionRecord.State.PREPARED
                || nextState == ToolExecutionRecord.State.DISPATCHING
                        && current.getState()
                                != ToolExecutionRecord.State.DISPATCHING) {
            throw new IllegalArgumentException(
                    "execution state must not move backwards");
        }
        if (current.isCancelRequested()
                && !replacement.isCancelRequested()) {
            throw new IllegalArgumentException(
                    "replacement must not drop a cancellation request");
        }
        ToolExecutionRecord updated = replacement.withVersion(
                expected.getVersion() + 1);
        updateExecution(connection, updated);
        return updated;
    }

    @Override
    public ToolExecutionRecord claimDispatch(String executionCallId,
            String owner, Duration leaseDuration) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = JdbcRepositorySupport.requireDuration(
                leaseDuration);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            ToolExecutionRecord current = selectByExecutionId(connection, id,
                    true);
            if (current == null || current.isTerminal()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN) {
                return null;
            }
            Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
            if (ownerId.equals(current.getDispatchOwner())
                    && current.getDispatchLeaseUntil().isAfter(now)) {
                return current;
            }
            if (current.getDispatchOwner() != null
                    && current.getDispatchLeaseUntil().isAfter(now)) {
                return null;
            }
            if (current.getState() == ToolExecutionRecord.State.EXECUTING
                    || current.getState()
                            == ToolExecutionRecord.State.CANCEL_REQUESTED) {
                ToolExecutionRecord unknown = current.withUnknown()
                        .withVersion(current.getVersion() + 1);
                updateExecution(connection, unknown);
                return null;
            }
            ToolExecutionRecord claimed = current.withDispatch(ownerId,
                    JdbcRepositorySupport.leaseUntil(now, duration),
                    current.getDispatchGeneration() + 1,
                    ToolExecutionRecord.State.DISPATCHING)
                    .withVersion(current.getVersion() + 1);
            updateExecution(connection, claimed);
            return claimed;
        });
    }

    @Override
    public ToolExecutionRecord renewDispatch(String executionCallId,
            String owner, long dispatchGeneration, Duration leaseDuration) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = JdbcRepositorySupport.requireDuration(
                leaseDuration);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            ToolExecutionRecord current = selectByExecutionId(connection, id,
                    true);
            if (current == null || current.isTerminal()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN) {
                return null;
            }
            Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
            if (!ownerId.equals(current.getDispatchOwner())
                    || dispatchGeneration != current.getDispatchGeneration()
                    || !current.getDispatchLeaseUntil().isAfter(now)) {
                return null;
            }
            ToolExecutionRecord renewed = current.withDispatch(ownerId,
                    JdbcRepositorySupport.leaseUntil(now, duration),
                    dispatchGeneration,
                    current.getState())
                    .withVersion(current.getVersion() + 1);
            updateExecution(connection, renewed);
            return renewed;
        });
    }

    @Override
    public ToolExecutionRecord requestCancel(String executionCallId,
            long expectedVersion) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            ToolExecutionRecord current = selectByExecutionId(connection, id,
                    true);
            if (current == null || current.isTerminal()
                    || current.getVersion() != expectedVersion) {
                return null;
            }
            if (current.isCancelRequested()) {
                return current;
            }
            ToolExecutionRecord requested = current.withState(
                    current.getState() == ToolExecutionRecord.State.EXECUTING
                            ? ToolExecutionRecord.State.CANCEL_REQUESTED
                            : current.getState(),
                    true);
            if (current.getState() == ToolExecutionRecord.State.PREPARED) {
                requested = requested.withResult(
                        current.cancellationBeforeDispatch(),
                        current.getLastSequence(),
                        JdbcRepositorySupport.databaseNow(connection));
            }
            ToolExecutionRecord updated = requested.withVersion(
                    current.getVersion() + 1);
            updateExecution(connection, updated);
            return updated;
        });
    }

    @Override
    public ToolExecutionRecord settlePrepared(ToolExecutionRecord expected,
            Map<String, Object> result, Instant settlementTime) {
        if (expected == null || result == null || settlementTime == null) {
            throw new IllegalArgumentException(
                    "expected, result and time are required");
        }
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            ToolExecutionRecord current = selectByExecutionId(connection,
                    expected.getExecutionCallId(), true);
            if (current == null || !current.sameIdentity(expected)
                    || current.getVersion() != expected.getVersion()
                    || current.isTerminal()
                    || current.getState() != ToolExecutionRecord.State.PREPARED) {
                return null;
            }
            ToolExecutionRecord settled = current.withResult(result,
                    current.getLastSequence(), settlementTime)
                    .withVersion(current.getVersion() + 1);
            updateExecution(connection, settled);
            return settled;
        });
    }

    @Override
    public ToolExecutionRecord resolveUnknown(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return resolve(expected, resolutionResult, resolutionTime, true);
    }

    @Override
    public ToolExecutionRecord resolveUnsettled(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return resolve(expected, resolutionResult, resolutionTime, false);
    }

    private ToolExecutionRecord resolve(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime,
            boolean unknownOnly) {
        if (expected == null) {
            throw new IllegalArgumentException("expected is required");
        }
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            ToolExecutionRecord current = selectByExecutionId(connection,
                    expected.getExecutionCallId(), true);
            if (current == null || !current.sameIdentity(expected)
                    || current.getVersion() != expected.getVersion()
                    || !current.needsReconciliation()
                    || unknownOnly && current.getState() != ToolExecutionRecord.State.UNKNOWN) {
                return null;
            }
            ToolExecutionRecord resolved = current.resolveUnsettled(
                    resolutionResult, resolutionTime)
                    .withVersion(current.getVersion() + 1);
            updateExecution(connection, resolved);
            return resolved;
        });
    }

    @Override
    public List<ToolExecutionRecord> findUnsettled(RuntimeSessionRecord session,
            String afterExecutionCallId, int limit) {
        if (session == null || limit < 1 || limit > 100) {
            throw new IllegalArgumentException("session and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireId(afterExecutionCallId, "cursor"));
        return JdbcRepositorySupport.read(dataSource, connection -> {
            String sql = "SELECT " + EXECUTION_COLUMNS + " FROM qwen_tool_execution "
                    + "WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_key = ? "
                    + "AND harness_session_id = ? AND execution_call_id_hash > ? "
                    + "AND execution_state IN ('EXECUTING', 'CANCEL_REQUESTED', 'UNKNOWN') "
                    + "ORDER BY execution_call_id_hash LIMIT ?";
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                statement.setString(1, session.getBindingId());
                statement.setLong(2, session.getRuntimeGeneration());
                statement.setString(3, JdbcRepositorySupport.valueKey(session.getRuntimeSessionId()));
                statement.setString(4, session.getSession().getHarnessSessionId());
                statement.setString(5, after);
                statement.setInt(6, limit);
                List<ToolExecutionRecord> records = new ArrayList<>();
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        ToolExecutionRecord record = mapExecution(result);
                        if (!record.belongsTo(session)) {
                            throw new IllegalStateException("Execution scan ownership differs");
                        }
                        records.add(record);
                    }
                }
                return List.copyOf(records);
            }
        });
    }

    @Override
    public List<ToolExecutionRecord> findBackgroundProcesses(
            RuntimeSessionRecord session, String afterExecutionCallId, int limit) {
        if (session == null || limit < 1 || limit > 100) {
            throw new IllegalArgumentException("session and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireId(afterExecutionCallId, "cursor"));
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<ToolExecutionRecord> matches = new ArrayList<>();
            String cursor = after;
            // The dispatch mode lives in the reference payload, so SQL
            // pages the ownership-and-state window and the filter runs row
            // by row; the scan stops as soon as a page of matches is full
            // or the window is exhausted, keeping "short page means done".
            for (;;) {
                String sql = "SELECT " + EXECUTION_COLUMNS + " FROM qwen_tool_execution "
                        + "WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_key = ? "
                        + "AND harness_session_id = ? AND execution_call_id_hash > ? "
                        + "AND execution_state NOT IN ('SETTLED', 'ABANDONED') "
                        + "ORDER BY execution_call_id_hash LIMIT ?";
                List<ToolExecutionRecord> batch = new ArrayList<>();
                try (PreparedStatement statement = connection.prepareStatement(sql)) {
                    statement.setString(1, session.getBindingId());
                    statement.setLong(2, session.getRuntimeGeneration());
                    statement.setString(3, JdbcRepositorySupport.valueKey(session.getRuntimeSessionId()));
                    statement.setString(4, session.getSession().getHarnessSessionId());
                    statement.setString(5, cursor);
                    statement.setInt(6, limit);
                    try (ResultSet result = statement.executeQuery()) {
                        while (result.next()) {
                            ToolExecutionRecord record = mapExecution(result);
                            if (!record.belongsTo(session)) {
                                throw new IllegalStateException("Execution scan ownership differs");
                            }
                            batch.add(record);
                        }
                    }
                }
                if (batch.isEmpty()) {
                    return List.copyOf(matches);
                }
                for (ToolExecutionRecord record : batch) {
                    if ("background_v3_process".equals(
                            record.getReference().get("dispatchMode"))) {
                        matches.add(record);
                        if (matches.size() == limit) {
                            return List.copyOf(matches);
                        }
                    }
                }
                if (batch.size() < limit) {
                    return List.copyOf(matches);
                }
                cursor = JdbcRepositorySupport.valueKey(
                        batch.get(batch.size() - 1).getExecutionCallId());
            }
        });
    }

    @Override
    public List<ToolExecutionRecord> findByBinding(String bindingId,
            long runtimeGeneration, String afterExecutionCallId, int limit) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0 || limit < 1 || limit > 100) {
            throw new IllegalArgumentException(
                    "positive runtimeGeneration and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireWellFormed(
                        BrokerValues.requireId(afterExecutionCallId, "cursor"), "cursor"));
        return JdbcRepositorySupport.read(dataSource, connection -> {
            String sql = "SELECT " + EXECUTION_COLUMNS + " FROM qwen_tool_execution "
                    + "WHERE binding_id = ? AND runtime_generation = ? "
                    + "AND execution_call_id_hash > ? "
                    + "ORDER BY execution_call_id_hash LIMIT ?";
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                statement.setString(1, id);
                statement.setLong(2, runtimeGeneration);
                statement.setString(3, after);
                statement.setInt(4, limit);
                List<ToolExecutionRecord> records = new ArrayList<>();
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        ToolExecutionRecord record = mapExecution(result);
                        BrokerValues.requireWellFormed(record.getExecutionCallId(), "executionCallId");
                        if (!id.equals(record.getBindingId())
                                || runtimeGeneration != record.getRuntimeGeneration()) {
                            throw new IllegalStateException("Execution inventory ownership differs");
                        }
                        records.add(record);
                    }
                }
                return List.copyOf(records);
            }
        });
    }

    @Override
    public boolean hasActiveByBinding(String bindingId,
            long runtimeGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        return JdbcRepositorySupport.read(dataSource, connection ->
                hasActiveByBinding(connection, id, runtimeGeneration));
    }

    @Override
    public boolean hasActiveByRuntimeSession(String runtimeSessionId) {
        String id = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            String sql = "SELECT runtime_session_id "
                    + "FROM qwen_tool_execution "
                    + "WHERE runtime_session_key = ? "
                    + "AND execution_state NOT IN ('SETTLED', 'ABANDONED')";
            try (PreparedStatement statement = connection.prepareStatement(
                    sql)) {
                statement.setString(1, JdbcRepositorySupport.valueKey(id));
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        if (id.equals(result.getString(
                                "runtime_session_id"))) {
                            return true;
                        }
                    }
                    return false;
                }
            }
        });
    }

    @Override
    public boolean hasActiveByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId) {
        return JdbcRepositorySupport.read(dataSource, connection ->
                hasActiveByRuntimeSession(connection, bindingId,
                        runtimeGeneration, runtimeSessionId,
                        java.util.Set.of()));
    }

    @Override
    public boolean hasActiveByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId,
            java.util.Set<String> excludingExecutionCallIds) {
        return JdbcRepositorySupport.read(dataSource, connection ->
                hasActiveByRuntimeSession(connection, bindingId,
                        runtimeGeneration, runtimeSessionId,
                        excludingExecutionCallIds));
    }

    static boolean hasActiveByRuntimeSession(Connection connection,
            String bindingId, long runtimeGeneration, String runtimeSessionId)
            throws SQLException {
        return hasActiveByRuntimeSession(connection, bindingId,
                runtimeGeneration, runtimeSessionId, java.util.Set.of());
    }

    static boolean hasActiveByRuntimeSession(Connection connection,
            String bindingId, long runtimeGeneration, String runtimeSessionId,
            java.util.Set<String> excludingExecutionCallIds)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT binding_id, runtime_session_id, execution_call_id FROM qwen_tool_execution "
                        + "WHERE binding_id = ? AND runtime_generation = ? "
                        + "AND runtime_session_key = ? "
                        + "AND execution_state NOT IN ('SETTLED', 'ABANDONED')")) {
            statement.setString(1, bindingId);
            statement.setLong(2, runtimeGeneration);
            statement.setString(3, JdbcRepositorySupport.valueKey(runtimeSessionId));
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    if (bindingId.equals(result.getString("binding_id"))
                            && runtimeSessionId.equals(result.getString("runtime_session_id"))
                            && !excludingExecutionCallIds.contains(result.getString("execution_call_id"))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static ToolExecutionRecord selectByExecutionId(
            Connection connection, String executionCallId, boolean forUpdate)
            throws SQLException {
        String sql = "SELECT " + EXECUTION_COLUMNS
                + " FROM qwen_tool_execution WHERE execution_call_id_hash = ?"
                + (forUpdate ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            if (forUpdate) {
                statement.setQueryTimeout(10);
            }
            statement.setString(1, JdbcRepositorySupport.valueKey(
                    executionCallId));
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                ToolExecutionRecord record = mapExecution(result);
                if (!executionCallId.equals(record.getExecutionCallId())) {
                    throw new IllegalStateException(
                            "Tool execution-call hash collision");
                }
                return record;
            }
        }
    }

    static void insertExecution(Connection connection,
            ToolExecutionRecord record) throws SQLException {
        String sql = "INSERT INTO qwen_tool_execution (" + EXECUTION_COLUMNS
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            setExecution(statement, record);
            statement.executeUpdate();
        }
    }

    private static void updateExecution(Connection connection,
            ToolExecutionRecord record) throws SQLException {
        String sql = "UPDATE qwen_tool_execution SET execution_state = ?, "
                + "execution_status = ?, result_json = ?, "
                + "last_sequence = ?, cancel_requested = ?, "
                + "dispatch_owner = ?, dispatch_lease_until = ?, "
                + "dispatch_generation = ?, record_version = ?, "
                + "settled_at = ?, abandoned_at = ?, loss_evidence_id = ?, "
                + "authorized_dispatch_generation = ?, authorized_binding_version = ? "
                + "WHERE execution_call_id_hash = ?";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, record.getState().name());
            statement.setString(2, record.getExecutionStatus());
            statement.setString(3, toJson(record.getResult()));
            statement.setLong(4, record.getLastSequence());
            statement.setBoolean(5, record.isCancelRequested());
            statement.setString(6, record.getDispatchOwner());
            JdbcRepositorySupport.setInstant(statement, 7,
                    record.getDispatchLeaseUntil());
            statement.setLong(8, record.getDispatchGeneration());
            statement.setLong(9, record.getVersion());
            JdbcRepositorySupport.setInstant(statement, 10,
                    record.getSettledAt());
            JdbcRepositorySupport.setInstant(statement, 11, record.getAbandonedAt());
            statement.setString(12, record.getLossEvidenceId());
            statement.setObject(13, record.getAuthorizedDispatchGeneration(), java.sql.Types.BIGINT);
            statement.setObject(14, record.getAuthorizedBindingVersion(), java.sql.Types.BIGINT);
            statement.setString(15, JdbcRepositorySupport.valueKey(
                    record.getExecutionCallId()));
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Tool execution update failed");
            }
        }
    }

    private static void setExecution(PreparedStatement statement,
            ToolExecutionRecord record) throws SQLException {
        statement.setString(1, JdbcRepositorySupport.valueKey(
                record.getExecutionCallId()));
        statement.setString(2, record.getExecutionCallId());
        statement.setString(3, JdbcRepositorySupport.valueKey(
                record.getIdempotencyKey()));
        statement.setString(4, record.getIdempotencyKey());
        statement.setString(5, record.getBindingId());
        statement.setLong(6, record.getRuntimeGeneration());
        statement.setString(7, record.getHarnessSessionId());
        statement.setString(8, record.getRuntimeSessionId());
        statement.setString(9, JdbcRepositorySupport.valueKey(
                record.getRuntimeSessionId()));
        statement.setString(10, record.getTurnId());
        statement.setString(11, record.getToolCallId());
        statement.setString(12, record.getRequestDigest());
        statement.setString(13, toJson(record.getReference()));
        statement.setString(14, record.getState().name());
        statement.setString(15, record.getExecutionStatus());
        statement.setString(16, toJson(record.getResult()));
        statement.setLong(17, record.getLastSequence());
        statement.setBoolean(18, record.isCancelRequested());
        statement.setString(19, record.getDispatchOwner());
        JdbcRepositorySupport.setInstant(statement, 20,
                record.getDispatchLeaseUntil());
        statement.setLong(21, record.getDispatchGeneration());
        statement.setLong(22, record.getVersion());
        JdbcRepositorySupport.setInstant(statement, 23,
                record.getSettledAt());
        JdbcRepositorySupport.setInstant(statement, 24, record.getAbandonedAt());
        statement.setString(25, record.getLossEvidenceId());
        statement.setObject(26, record.getAuthorizedDispatchGeneration(), java.sql.Types.BIGINT);
        statement.setObject(27, record.getAuthorizedBindingVersion(), java.sql.Types.BIGINT);
    }

    private static ToolExecutionRecord mapExecution(ResultSet result)
            throws SQLException {
        String executionCallId = result.getString("execution_call_id");
        if (!JdbcRepositorySupport.valueKey(executionCallId).equals(
                result.getString("execution_call_id_hash"))) {
            throw new IllegalStateException(
                    "Tool execution-call hash is invalid");
        }
        String idempotencyKey = result.getString("idempotency_key");
        if (!JdbcRepositorySupport.valueKey(idempotencyKey).equals(
                result.getString("idempotency_key_hash"))) {
            throw new IllegalStateException(
                    "Tool idempotency hash is invalid");
        }
        String runtimeSessionId = result.getString("runtime_session_id");
        if (!JdbcRepositorySupport.valueKey(runtimeSessionId).equals(
                result.getString("runtime_session_key"))) {
            throw new IllegalStateException(
                    "Tool Runtime Session hash is invalid");
        }
        return new ToolExecutionRecord(
                executionCallId, idempotencyKey,
                result.getString("binding_id"),
                result.getLong("runtime_generation"),
                result.getString("harness_session_id"), runtimeSessionId,
                result.getString("turn_id"),
                result.getString("tool_call_id"),
                result.getString("request_digest"),
                fromJson(result.getString("reference_json")),
                ToolExecutionRecord.State.valueOf(
                        result.getString("execution_state")),
                result.getString("execution_status"),
                fromJson(result.getString("result_json")),
                result.getLong("last_sequence"),
                result.getBoolean("cancel_requested"),
                result.getString("dispatch_owner"),
                JdbcRepositorySupport.getInstant(result,
                        "dispatch_lease_until"),
                result.getLong("dispatch_generation"),
                result.getLong("record_version"),
                JdbcRepositorySupport.getInstant(result, "settled_at"),
                JdbcRepositorySupport.getInstant(result, "abandoned_at"),
                result.getString("loss_evidence_id"),
                result.getObject("authorized_dispatch_generation", Long.class),
                result.getObject("authorized_binding_version", Long.class));
    }

    private static String toJson(Map<String, Object> value) {
        return value == null ? null
                : JSON.toJSONString(value, JSONWriter.Feature.WriteNulls,
                        JSONWriter.Feature.WriteBigDecimalAsPlain);
    }

    private static Map<String, Object> fromJson(String value) {
        return value == null ? null : JSON.parseObject(value,
                JSONReader.Feature.DisableReferenceDetect);
    }

    static void requireCandidate(ToolExecutionRecord candidate) {
        if (candidate == null || candidate.getVersion() != 0
                || candidate.getLastSequence() != 0
                || candidate.getState()
                        != ToolExecutionRecord.State.PREPARED
                || candidate.getDispatchOwner() != null
                || candidate.getAuthorizedDispatchGeneration() != null) {
            throw new IllegalArgumentException(
                    "candidate must be a new prepared execution");
        }
    }

    private static void requireReplacement(ToolExecutionRecord expected,
            ToolExecutionRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || !expected.sameDispatch(replacement)
                || replacement.getVersion() != expected.getVersion()
                || replacement.getLastSequence()
                        < expected.getLastSequence()) {
            throw new IllegalArgumentException(
                    "replacement must preserve execution identity, dispatch"
                            + " claim, version, and result sequence");
        }
    }
}
