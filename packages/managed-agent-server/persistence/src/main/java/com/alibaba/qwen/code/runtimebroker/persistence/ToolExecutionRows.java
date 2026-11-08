package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.fastjson2.JSONWriter;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Map;

import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository.EXECUTION_COLUMNS;

/**
 * The row codec of the Tool execution ledger: column writes, row mapping,
 * JSON codecs and the candidate/replacement identity guards. Split out of
 * JdbcToolExecutionRepository verbatim; the SQL and verdicts are the ones the
 * repository ran inline.
 */
final class ToolExecutionRows {
    private ToolExecutionRows() {
    }

    static ToolExecutionRecord selectByExecutionId(
            Connection connection, String executionCallId, boolean forUpdate)
            throws SQLException {
        String sql = "SELECT " + EXECUTION_COLUMNS
                + " FROM ma_tool_execution WHERE execution_call_id_hash = ?"
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
        String sql = "INSERT INTO ma_tool_execution (" + EXECUTION_COLUMNS
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            setExecution(statement, record);
            statement.executeUpdate();
        }
    }

    static void updateExecution(Connection connection,
            ToolExecutionRecord record) throws SQLException {
        String sql = "UPDATE ma_tool_execution SET execution_state = ?, "
                + "execution_status = ?, result_json = ?, "
                + "last_sequence = ?, is_cancel_requested = ?, "
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
            JdbcRepositorySupport.setIdentity(statement, 6, record.getDispatchOwner());
            JdbcRepositorySupport.setInstant(statement, 7,
                    record.getDispatchLeaseUntil());
            statement.setLong(8, record.getDispatchGeneration());
            statement.setLong(9, record.getVersion());
            JdbcRepositorySupport.setInstant(statement, 10,
                    record.getSettledAt());
            JdbcRepositorySupport.setInstant(statement, 11, record.getAbandonedAt());
            JdbcRepositorySupport.setIdentity(statement, 12, record.getLossEvidenceId());
            statement.setObject(13, record.getAuthorizedDispatchGeneration(), java.sql.Types.BIGINT);
            statement.setObject(14, record.getAuthorizedBindingVersion(), java.sql.Types.BIGINT);
            statement.setString(15, JdbcRepositorySupport.valueKey(
                    record.getExecutionCallId()));
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Tool execution update failed");
            }
        }
    }

    static void setExecution(PreparedStatement statement,
            ToolExecutionRecord record) throws SQLException {
        statement.setString(1, JdbcRepositorySupport.valueKey(
                record.getExecutionCallId()));
        JdbcRepositorySupport.setIdentity(statement, 2, record.getExecutionCallId());
        statement.setString(3, JdbcRepositorySupport.valueKey(
                record.getIdempotencyKey()));
        JdbcRepositorySupport.setIdentity(statement, 4, record.getIdempotencyKey());
        JdbcRepositorySupport.setIdentity(statement, 5, record.getBindingId());
        statement.setLong(6, record.getRuntimeGeneration());
        JdbcRepositorySupport.setIdentity(statement, 7, record.getHarnessSessionId());
        JdbcRepositorySupport.setIdentity(statement, 8, record.getRuntimeSessionId());
        statement.setString(9, JdbcRepositorySupport.valueKey(
                record.getRuntimeSessionId()));
        JdbcRepositorySupport.setIdentity(statement, 10, record.getTurnId());
        JdbcRepositorySupport.setIdentity(statement, 11, record.getToolCallId());
        statement.setString(12, record.getRequestDigest());
        statement.setString(13, toJson(record.getReference()));
        statement.setString(14, record.getState().name());
        statement.setString(15, record.getExecutionStatus());
        statement.setString(16, toJson(record.getResult()));
        statement.setLong(17, record.getLastSequence());
        statement.setBoolean(18, record.isCancelRequested());
        JdbcRepositorySupport.setIdentity(statement, 19, record.getDispatchOwner());
        JdbcRepositorySupport.setInstant(statement, 20,
                record.getDispatchLeaseUntil());
        statement.setLong(21, record.getDispatchGeneration());
        statement.setLong(22, record.getVersion());
        JdbcRepositorySupport.setInstant(statement, 23,
                record.getSettledAt());
        JdbcRepositorySupport.setInstant(statement, 24, record.getAbandonedAt());
        JdbcRepositorySupport.setIdentity(statement, 25, record.getLossEvidenceId());
        statement.setObject(26, record.getAuthorizedDispatchGeneration(), java.sql.Types.BIGINT);
        statement.setObject(27, record.getAuthorizedBindingVersion(), java.sql.Types.BIGINT);
    }

    static ToolExecutionRecord mapExecution(ResultSet result)
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
                result.getBoolean("is_cancel_requested"),
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

    static String toJson(Map<String, Object> value) {
        return value == null ? null
                : JSON.toJSONString(value, JSONWriter.Feature.WriteNulls,
                        JSONWriter.Feature.WriteBigDecimalAsPlain);
    }

    static Map<String, Object> fromJson(String value) {
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

    static void requireReplacement(ToolExecutionRecord expected,
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
