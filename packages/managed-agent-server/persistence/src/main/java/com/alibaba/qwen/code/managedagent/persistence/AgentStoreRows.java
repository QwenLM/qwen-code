package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

final class AgentStoreRows {
    private final HarnessRules harnessRules;
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    AgentStoreRows(HarnessRules harnessRules,
            JdbcTemplate jdbc,
            ObjectMapper objectMapper) {
        this.harnessRules = harnessRules;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.sessionMapper = (result, row) -> {
            if (result.getObject("list_last_sequence") == null || result.getObject("list_floor_sequence") == null) {
                throw new IllegalStateException("Session stream is unavailable.");
            }
            return readSession(result, new StreamCounters(result.getLong("list_last_sequence"),
                    result.getLong("list_floor_sequence")));
        };
        this.sessionListMapper = (result, row) ->
                        readSession(
                                result,
                                new StreamCounters(
                                        result.getLong("list_last_sequence"),
                                        result.getLong("list_floor_sequence")));
        this.turnSummaryMapper = (result, row) ->
                        new TurnSummary(
                                result.getString("session_id"),
                                result.getString("turn_id"),
                                result.getString("status"),
                                result.getLong("gmt_create"),
                                nullableLong(result, "completed_at"),
                                result.getString("error_code"));
        this.turnMapper = (result, row) ->
                new TurnRecord(result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("turn_id"),
                        result.getString("prompt_id"),
                        readInput(result.getString("input_json")),
                        result.getString("payload_digest"),
                        result.getString("status"),
                        result.getBoolean("is_submission_attempted"),
                        result.getString("harness_event_epoch"),
                        nullableLong(result, "harness_last_event_id"),
                        result.getString("dispatch_owner"),
                        nullableLong(result, "dispatch_lease_until"),
                        result.getInt("retry_count"),
                        additiveInt(result, "consecutive_failures"),
                        additiveInt(result, "budget_exempt_failures"),
                        nullableLong(result, "retry_after"),
                        result.getString("error_code"),
                        result.getString("error_message"),
                        result.getLong("gmt_create"),
                        result.getLong("gmt_modified"),
                        nullableLong(result, "completed_at"),
                        result.getLong("version"));
    }

    static final Logger LOG = LoggerFactory.getLogger(
            ManagedAgentStore.class);

    static final TypeReference<List<Map<String, Object>>> INPUT_TYPE =
            new TypeReference<>() {
            };

    static final TypeReference<Map<String, Object>> MAP_TYPE =
            new TypeReference<>() {
            };

    static final List<String> ACTIVE_TURN_STATES = List.of(
            "ACCEPTED", "RUNNING", "CANCELLING");

    static final String SESSION_WITH_STREAM =
            "SELECT " + ManagedSchemaProjection.SESSION.columns("ma_session") + ", es.last_sequence AS list_last_sequence, es.replay_floor_sequence AS list_floor_sequence, es.gmt_modified AS list_last_activity FROM ma_session LEFT JOIN ma_event_stream es ON es.tenant_id = ma_session.tenant_id AND es.session_id = ma_session.session_id AND es.stream_kind = 'SESSION' AND es.stream_id = X''";

    final RowMapper<SessionRecord> sessionMapper;

    final RowMapper<SessionRecord> sessionListMapper;

    SessionRecord readSession(java.sql.ResultSet result, StreamCounters counters) throws java.sql.SQLException {
        return new SessionRecord(
                result.getString("tenant_id"),
                result.getString("session_id"),
                result.getString("agent_id"),
                result.getString("agent_revision"),
                result.getString("title"),
                result.getString("status"),
                result.getString("harness_boot_id"),
                result.getString("harness_event_epoch"),
                result.getLong("harness_last_event_id"),
                counters.lastSequence(),
                counters.floorSequence(),
                result.getLong("gmt_create"),
                result.getLong("gmt_modified"),
                nullableLong(result, "deleted_at"),
                result.getLong("version"),
                readBinding(result),
                result.getString("approval_mode"),
                result.getString("tool_profile"),
                result.getString("agent_definition_digest"), result.getInt("public_child_agents_version"),
                result.getString("model_config_digest"), result.getString("memory_store_id"), result.getBoolean("owner_only"),
                result.getString("preview"), optionalLong(result, "list_last_activity"));
    }

    private static Long optionalLong(java.sql.ResultSet result, String column)
            throws java.sql.SQLException {
        java.sql.ResultSetMetaData meta = result.getMetaData();
        for (int index = 1; index <= meta.getColumnCount(); index++) {
            if (meta.getColumnLabel(index).equalsIgnoreCase(column)) {
                return nullableLong(result, column);
            }
        }
        return null;
    }

    final RowMapper<TurnSummary> turnSummaryMapper;

    final RowMapper<TurnRecord> turnMapper;

    static String renameTarget(String tenant, String session) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                "SESSION", tenant, session);
    }

    static final String SESSION_OPERATION_KINDS =
            "('CLOSE', 'ARCHIVE', 'DELETE', 'ACTION_RESPONSE', 'CWD_CHANGE', 'TASK_CANCEL', 'CONTEXT_COMPRESSION')";

    static String sessionOperationTarget(String sessionId) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(sessionId);
    }

    static String sessionOperationKey(String tenantId, String sessionId, OperationKind kind, String operationId) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind.valueOf(kind.name()),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId), sessionOperationTarget(sessionId), operationId);
    }

    long lifecycleDatabaseTime() {
        return jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) ->
                        Math.addExact(
                                Math.multiplyExact(row.getLong(1), 1000), row.getLong(2) / 1000));
    }

    Optional<SessionRecord> findSession(String tenantId,
            String sessionId) {
        List<SessionRecord> rows =
                jdbc.query(
                        SESSION_WITH_STREAM + " WHERE ma_session.session_kind = 'PUBLIC' AND"
                                + " ma_session.tenant_id = ? AND ma_session.session_id = ?",
                        sessionMapper,
                        tenantId,
                        sessionId);
        return rows.stream().findFirst();
    }

    Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT " + ManagedSchemaProjection.TURN.columns() + " FROM ma_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ?",
                turnMapper, tenantId, sessionId, turnId);
        return rows.stream().findFirst();
    }

    Map<String, List<String>> readPermissionRules(String json) {
        return json == null ? null : harnessRules.nonEmptyPermissionRules(harnessRules.permissionRules(readMap(json)));
    }

    SessionRecord requireSession(String tenantId, String sessionId) {
        return findSession(tenantId, sessionId).orElseThrow(() ->
                new ManagedAgentException(404, "session_not_found",
                        "The Session was not found."));
    }

    void requireLegacyMutation(String tenantId, String sessionId) {
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
    }

    SessionRecord requireLegacySessionForUpdate(String tenantId, String sessionId) {
        return requireSessionForUpdate(tenantId, sessionId, true);
    }

    SessionRecord requireSessionForUpdate(String tenantId,
            String sessionId) {
        return requireSessionForUpdate(tenantId, sessionId, false);
    }

    SessionRecord requireSessionForUpdate(
            String tenantId, String sessionId, boolean legacyMutation) {
        try {
            return jdbc.queryForObject(
                    "SELECT " + ManagedSchemaProjection.SESSION.columns("ma_session")
                            + " FROM ma_session WHERE ma_session.session_kind = 'PUBLIC' AND ma_session.tenant_id ="
                            + " ? AND ma_session.session_id = ? FOR UPDATE",
                    (rows, rowNumber) -> {
                        if (legacyMutation) {
                            ManagedLegacySessionGuard.requireLegacyMutation(rows.getBoolean("is_csi_guard"));
                        }
                        // H2 can retain pre-wait outer-join values after locking the Session.
                        // Read its stream only after acquiring that lock.
                        List<StreamCounters> streams = jdbc.query(
                                "SELECT last_sequence, replay_floor_sequence FROM ma_event_stream"
                                        + " WHERE tenant_id = ? AND session_id = ? AND stream_kind ="
                                        + " 'SESSION' AND stream_id = X'' FOR UPDATE",
                                (stream, index) -> new StreamCounters(stream.getLong("last_sequence"),
                                        stream.getLong("replay_floor_sequence")),
                                tenantId, sessionId);
                        if (streams.isEmpty()) {
                            throw new IllegalStateException("Session stream is unavailable.");
                        }
                        return readSession(rows, streams.getFirst());
                    },
                    tenantId,
                    sessionId);
        } catch (EmptyResultDataAccessException error) {
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
    }

    record LockedSessionTurn(SessionRecord session, TurnRecord turn) {
    }

    LockedSessionTurn requireSessionTurnForUpdate(String tenantId, String sessionId, String turnId) {
        return new LockedSessionTurn(requireSessionForUpdate(tenantId, sessionId),
                requireTurnForUpdate(tenantId, sessionId, turnId));
    }

    LockedSessionTurn requireLegacySessionTurnForUpdate(String tenantId, String sessionId, String turnId) {
        return new LockedSessionTurn(requireLegacySessionForUpdate(tenantId, sessionId),
                requireTurnForUpdate(tenantId, sessionId, turnId));
    }

    TurnRecord requireTurn(String tenantId, String sessionId,
            String turnId) {
        return findTurn(tenantId, sessionId, turnId).orElseThrow(() ->
                new ManagedAgentException(404, "turn_not_found",
                        "The Turn was not found."));
    }

    TurnRecord requireTurnForUpdate(String tenantId,
            String sessionId, String turnId) {
        try {
            return jdbc.queryForObject("SELECT " + ManagedSchemaProjection.TURN.columns() + " FROM ma_turn"
                            + " WHERE tenant_id = ? AND session_id = ? AND"
                            + " turn_id = ? FOR UPDATE",
                    turnMapper, tenantId, sessionId, turnId);
        } catch (EmptyResultDataAccessException error) {
            throw new ManagedAgentException(404, "turn_not_found",
                    "The Turn was not found.");
        }
    }

    String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException("Value is not valid JSON",
                    error);
        }
    }

    List<Map<String, Object>> readInput(String value) {
        try {
            return objectMapper.readValue(value, INPUT_TYPE);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored input is invalid", error);
        }
    }

    Map<String, Object> readMap(String value) {
        try {
            return objectMapper.readValue(value, MAP_TYPE);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored event is invalid", error);
        }
    }

    static ContextBinding readBinding(java.sql.ResultSet result)
            throws java.sql.SQLException {
        String workspaceId = result.getString("workspace_id");
        if (workspaceId == null) {
            return null;
        }
        String configRef = result.getString("workspace_config_ref");
        String policyRef = result.getString("workspace_policy_ref");
        String contextConfigRef = result.getString("context_config_ref");
        if (!JdbcManagedWorkspaceRegistry.descriptorRef(configRef, policyRef)
                .equals(contextConfigRef)) {
            throw new IllegalStateException(
                    "Persisted Workspace configuration descriptor changed for session "
                            + result.getString("session_id") + " of tenant "
                            + result.getString("tenant_id"));
        }
        return new ContextBinding(result.getString("tenant_id"), workspaceId,
                result.getLong("workspace_generation"),
                result.getString("workspace_storage_id"),
                result.getString("cwd_relative"), contextConfigRef,
                result.getLong("context_revision"));
    }

    static Long nullableLong(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        long value = result.getLong(name);
        return result.wasNull() ? null : value;
    }

    // The cwd columns arrive with V46; an operation read against an
    // additive-upgrade schema that predates them must treat the columns as
    // absent instead of erroring the whole query.
    static String additiveString(java.sql.ResultSet result,
            String name) throws java.sql.SQLException {
        return hasColumn(result, name) ? result.getString(name) : null;
    }

    static Long additiveLong(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        return hasColumn(result, name) ? nullableLong(result, name) : null;
    }

    static int additiveInt(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        return hasColumn(result, name) ? result.getInt(name) : 0;
    }

    static boolean hasColumn(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        var meta = result.getMetaData();
        for (int column = 1; column <= meta.getColumnCount(); column++) {
            if (name.equalsIgnoreCase(meta.getColumnLabel(column))) {
                return true;
            }
        }
        return false;
    }

    static String publicId(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString()
                .replace("-", "");
    }

    record StreamCounters(long lastSequence, long floorSequence) {}

    static String placeholders(int count) {
        return String.join(", ", Collections.nCopies(count, "?"));
    }
}
