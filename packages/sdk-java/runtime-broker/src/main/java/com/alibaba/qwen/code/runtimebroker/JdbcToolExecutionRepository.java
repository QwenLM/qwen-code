package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.TypeReference;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import javax.sql.DataSource;

/** JDBC ledger for idempotent Tool executions. */
public final class JdbcToolExecutionRepository
        implements ToolExecutionRepository {
    private static final String EXECUTION_COLUMNS = String.join(", ",
            "execution_call_id", "idempotency_key_hash", "idempotency_key",
            "binding_id", "runtime_generation", "harness_session_id",
            "runtime_session_id", "runtime_session_key", "turn_id",
            "tool_call_id", "request_digest", "reference_json",
            "execution_state", "execution_status", "result_json",
            "last_sequence", "cancel_requested", "dispatch_owner",
            "dispatch_lease_until", "dispatch_generation", "record_version",
            "settled_at");
    private static final TypeReference<Map<String, Object>> MAP_TYPE =
            new TypeReference<>() {
            };

    private final DataSource dataSource;

    public JdbcToolExecutionRepository(DataSource dataSource) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
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
        return JdbcRepositorySupport.read(dataSource, connection -> {
            ToolExecutionRecord record = selectByExecutionId(connection, id,
                    false);
            if (record != null && !id.equals(record.getExecutionCallId())) {
                throw new IllegalStateException(
                        "Tool execution identifier collision");
            }
            return record;
        });
    }

    @Override
    public ToolExecutionRecord findByIdempotencyKey(String idempotencyKey) {
        String key = BrokerValues.requireId(idempotencyKey,
                "idempotencyKey");
        return JdbcRepositorySupport.read(dataSource, connection -> {
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
        });
    }

    @Override
    public ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement) {
        requireReplacement(expected, replacement);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            ToolExecutionRecord current = selectByExecutionId(connection,
                    expected.getExecutionCallId(), true);
            if (current == null || !current.sameIdentity(expected)
                    || current.getVersion() != expected.getVersion()) {
                return null;
            }
            ToolExecutionRecord updated = replacement.withVersion(
                    expected.getVersion() + 1);
            updateExecution(connection, updated);
            return updated;
        });
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
            if (current == null || current.isSettled()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN) {
                return null;
            }
            Instant now = JdbcRepositorySupport.databaseNow(connection);
            if (ownerId.equals(current.getDispatchOwner())
                    && current.getDispatchLeaseUntil().isAfter(now)) {
                return current;
            }
            if (current.getDispatchOwner() != null
                    && current.getDispatchLeaseUntil().isAfter(now)) {
                return null;
            }
            ToolExecutionRecord.State nextState = current.isCancelRequested()
                    && (current.getState()
                                    == ToolExecutionRecord.State.EXECUTING
                            || current.getState()
                                    == ToolExecutionRecord.State
                                            .CANCEL_REQUESTED)
                    ? ToolExecutionRecord.State.CANCEL_REQUESTED
                    : ToolExecutionRecord.State.DISPATCHING;
            ToolExecutionRecord claimed = current.withDispatch(ownerId,
                    now.plus(duration),
                    current.getDispatchGeneration() + 1, nextState)
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
            if (current == null || current.isSettled()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN) {
                return null;
            }
            Instant now = JdbcRepositorySupport.databaseNow(connection);
            if (!ownerId.equals(current.getDispatchOwner())
                    || dispatchGeneration != current.getDispatchGeneration()
                    || !current.getDispatchLeaseUntil().isAfter(now)) {
                return null;
            }
            ToolExecutionRecord renewed = current.withDispatch(ownerId,
                    now.plus(duration), dispatchGeneration,
                    current.getState())
                    .withVersion(current.getVersion() + 1);
            updateExecution(connection, renewed);
            return renewed;
        });
    }

    @Override
    public boolean hasActiveByRuntimeSession(String runtimeSessionId) {
        String id = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            String sql = "SELECT runtime_session_id "
                    + "FROM qwen_tool_execution "
                    + "WHERE runtime_session_key = ? "
                    + "AND execution_state <> 'SETTLED'";
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
    public boolean hasActiveByBinding(String bindingId,
            long runtimeGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        return JdbcRepositorySupport.read(dataSource, connection -> {
            String sql = "SELECT execution_call_id "
                    + "FROM qwen_tool_execution WHERE binding_id = ? "
                    + "AND runtime_generation = ? "
                    + "AND execution_state <> 'SETTLED'";
            try (PreparedStatement statement = connection.prepareStatement(
                    sql)) {
                statement.setString(1, id);
                statement.setLong(2, runtimeGeneration);
                try (ResultSet result = statement.executeQuery()) {
                    return result.next();
                }
            }
        });
    }

    private static ToolExecutionRecord selectByExecutionId(
            Connection connection, String executionCallId, boolean forUpdate)
            throws SQLException {
        String sql = "SELECT " + EXECUTION_COLUMNS
                + " FROM qwen_tool_execution WHERE execution_call_id = ?"
                + (forUpdate ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, executionCallId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                ToolExecutionRecord record = mapExecution(result);
                if (!executionCallId.equals(record.getExecutionCallId())) {
                    throw new IllegalStateException(
                            "Tool execution identifier collision");
                }
                return record;
            }
        }
    }

    private static void insertExecution(Connection connection,
            ToolExecutionRecord record) throws SQLException {
        String sql = "INSERT INTO qwen_tool_execution (" + EXECUTION_COLUMNS
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                + "?, ?, ?, ?, ?, ?, ?)";
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
                + "settled_at = ? WHERE execution_call_id = ?";
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
            statement.setString(11, record.getExecutionCallId());
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Tool execution update failed");
            }
        }
    }

    private static void setExecution(PreparedStatement statement,
            ToolExecutionRecord record) throws SQLException {
        statement.setString(1, record.getExecutionCallId());
        statement.setString(2, JdbcRepositorySupport.valueKey(
                record.getIdempotencyKey()));
        statement.setString(3, record.getIdempotencyKey());
        statement.setString(4, record.getBindingId());
        statement.setLong(5, record.getRuntimeGeneration());
        statement.setString(6, record.getHarnessSessionId());
        statement.setString(7, record.getRuntimeSessionId());
        statement.setString(8, JdbcRepositorySupport.valueKey(
                record.getRuntimeSessionId()));
        statement.setString(9, record.getTurnId());
        statement.setString(10, record.getToolCallId());
        statement.setString(11, record.getRequestDigest());
        statement.setString(12, toJson(record.getReference()));
        statement.setString(13, record.getState().name());
        statement.setString(14, record.getExecutionStatus());
        statement.setString(15, toJson(record.getResult()));
        statement.setLong(16, record.getLastSequence());
        statement.setBoolean(17, record.isCancelRequested());
        statement.setString(18, record.getDispatchOwner());
        JdbcRepositorySupport.setInstant(statement, 19,
                record.getDispatchLeaseUntil());
        statement.setLong(20, record.getDispatchGeneration());
        statement.setLong(21, record.getVersion());
        JdbcRepositorySupport.setInstant(statement, 22,
                record.getSettledAt());
    }

    private static ToolExecutionRecord mapExecution(ResultSet result)
            throws SQLException {
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
                result.getString("execution_call_id"), idempotencyKey,
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
                JdbcRepositorySupport.getInstant(result, "settled_at"));
    }

    private static String toJson(Map<String, Object> value) {
        return value == null ? null : JSON.toJSONString(value);
    }

    private static Map<String, Object> fromJson(String value) {
        return value == null ? null : JSON.parseObject(value, MAP_TYPE);
    }

    private static void requireCandidate(ToolExecutionRecord candidate) {
        if (candidate == null || candidate.getVersion() != 0
                || candidate.getState()
                        != ToolExecutionRecord.State.PREPARED
                || candidate.getDispatchOwner() != null) {
            throw new IllegalArgumentException(
                    "candidate must be a new prepared execution");
        }
    }

    private static void requireReplacement(ToolExecutionRecord expected,
            ToolExecutionRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || replacement.getVersion() != expected.getVersion()) {
            throw new IllegalArgumentException(
                    "replacement must preserve execution identity and version");
        }
    }
}
