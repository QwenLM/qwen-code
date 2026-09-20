package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Repository
public class ManagedAgentStore implements AgentStateStore {
    private static final TypeReference<List<Map<String, Object>>> INPUT_TYPE =
            new TypeReference<>() {
            };
    private static final TypeReference<Map<String, Object>> MAP_TYPE =
            new TypeReference<>() {
            };
    private static final List<String> ACTIVE_TURN_STATES = List.of(
            "ACCEPTED", "RUNNING", "CANCELLING");
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final CommittedEventPublisher eventPublisher;
    private final RowMapper<SessionRecord> sessionMapper = (result, row) ->
            new SessionRecord(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getString("agent_id"), result.getString("title"),
                    result.getString("status"),
                    result.getString("harness_boot_id"),
                    result.getString("harness_event_epoch"),
                    result.getLong("harness_last_event_id"),
                    result.getLong("last_sequence"),
                    result.getLong("created_at"),
                    result.getLong("updated_at"),
                    result.getLong("version"));
    private final RowMapper<TurnRecord> turnMapper = (result, row) ->
            new TurnRecord(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getString("turn_id"),
                    result.getString("prompt_id"),
                    readInput(result.getString("input_json")),
                    result.getString("payload_digest"),
                    result.getString("status"),
                    result.getBoolean("submission_attempted"),
                    result.getString("harness_event_epoch"),
                    nullableLong(result, "harness_last_event_id"),
                    result.getString("dispatch_owner"),
                    nullableLong(result, "dispatch_lease_until"),
                    result.getString("error_code"),
                    result.getString("error_message"),
                    result.getLong("created_at"),
                    result.getLong("updated_at"),
                    nullableLong(result, "completed_at"),
                    result.getLong("version"));
    private final RowMapper<EventRecord> eventMapper = (result, row) ->
            new EventRecord(result.getString("tenant_id"),
                    result.getString("session_id"),
                    result.getLong("sequence_id"),
                    result.getString("event_id"),
                    result.getString("turn_id"),
                    result.getString("event_type"),
                    readMap(result.getString("data_json")),
                    result.getBoolean("terminal"),
                    result.getString("source_key"),
                    result.getLong("created_at"));

    public ManagedAgentStore(JdbcTemplate jdbc, ObjectMapper objectMapper,
            Clock clock, CommittedEventPublisher eventPublisher) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.eventPublisher = eventPublisher;
    }

    @Transactional
    public Admission insertSessionCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String title, List<Map<String, Object>> input,
            String payloadDigest) {
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
        String turnId = input.isEmpty() ? null : publicId("turn");
        String promptId = input.isEmpty() ? null
                : UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, title, status, created_at,"
                        + " updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)",
                tenantId, sessionId, agentId, title, now, now);
        if (turnId != null) {
            insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
        }
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, now);
        appendEvent(tenantId, sessionId, null, "session.created",
                Map.of("sessionId", sessionId), false, null, now);
        if (turnId != null) {
            appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                    Map.of("turnId", turnId), false, null, now);
        }
        return new Admission(sessionId, turnId, false, true);
    }

    @Transactional
    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        Optional<CommandRecord> existing = findCommand(tenantId, operation,
                idempotencyKey, true);
        if (existing.isPresent()) {
            return replayCommand(tenantId, operation, idempotencyKey,
                    requestDigest);
        }
        if (!"ACTIVE".equals(session.status())) {
            throw new ApiException(HttpStatus.CONFLICT, "session_not_active",
                    "The Session does not accept new Turns.");
        }
        if (hasActiveTurn(tenantId, sessionId)) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_active",
                    "The Session already has an active Turn.");
        }
        long now = clock.millis();
        String turnId = publicId("turn");
        insertTurn(tenantId, sessionId, turnId,
                UUID.randomUUID().toString(), input, payloadDigest, now);
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, now);
        appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                Map.of("turnId", turnId), false, null, now);
        return new Admission(sessionId, turnId, false, true);
    }

    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId) {
        requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        long now = clock.millis();
        insertCommand(tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, now);
        boolean commandEffect = ACTIVE_TURN_STATES.contains(turn.status())
                && !"CANCELLING".equals(turn.status());
        if (commandEffect) {
            int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                            + " 'CANCELLING', updated_at = ?, version ="
                            + " version + 1 WHERE tenant_id = ? AND"
                            + " session_id = ? AND turn_id = ? AND status IN"
                            + " ('ACCEPTED', 'RUNNING')",
                    now, tenantId, sessionId, turnId);
            commandEffect = updated == 1;
            if (commandEffect) {
                appendEvent(tenantId, sessionId, turnId,
                        "turn.cancel.requested", Map.of("turnId", turnId),
                        false, null, now);
            }
        }
        return new Admission(sessionId, turnId, false, commandEffect);
    }

    public Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        CommandRecord command = findCommand(tenantId, operation,
                idempotencyKey).orElseThrow(() -> new ApiException(
                        HttpStatus.CONFLICT, "idempotency_conflict",
                        "The idempotency key is already in use."));
        if (!command.requestDigest().equals(requestDigest)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        return new Admission(command.sessionId(), command.turnId(), true,
                false);
    }

    public Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey) {
        return findCommand(tenantId, operation, idempotencyKey, false);
    }

    private Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey, boolean forUpdate) {
        List<CommandRecord> rows = jdbc.query(
                "SELECT tenant_id, operation, idempotency_key,"
                        + " request_digest, session_id, turn_id, created_at"
                        + " FROM managed_agent_command WHERE tenant_id = ?"
                        + " AND operation = ? AND idempotency_key = ?"
                        + (forUpdate ? " FOR UPDATE" : ""),
                (result, row) -> new CommandRecord(
                        result.getString("tenant_id"),
                        result.getString("operation"),
                        result.getString("idempotency_key"),
                        result.getString("request_digest"),
                        result.getString("session_id"),
                        result.getString("turn_id"),
                        result.getLong("created_at")),
                tenantId, operation, idempotencyKey);
        return rows.stream().findFirst();
    }

    public Optional<SessionRecord> findSession(String tenantId,
            String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_session WHERE tenant_id = ?"
                        + " AND session_id = ?",
                sessionMapper, tenantId, sessionId);
        return rows.stream().findFirst();
    }

    public Optional<SessionRecord> findSessionById(String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_session WHERE"
                        + " session_id = ?",
                sessionMapper, sessionId);
        return rows.stream().findFirst();
    }

    public SessionPage listSessions(String tenantId, Long beforeUpdatedAt,
            String beforeSessionId, int limit) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        String cursorClause = "";
        if (beforeUpdatedAt != null && beforeSessionId != null) {
            cursorClause = " AND (updated_at < ? OR (updated_at = ?"
                    + " AND session_id < ?))";
            arguments.add(beforeUpdatedAt);
            arguments.add(beforeUpdatedAt);
            arguments.add(beforeSessionId);
        }
        arguments.add(limit + 1);
        List<SessionRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_session WHERE tenant_id = ?"
                        + cursorClause
                        + " ORDER BY updated_at DESC, session_id DESC LIMIT ?",
                sessionMapper, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        if (hasMore) {
            rows = new ArrayList<>(rows.subList(0, limit));
        }
        return new SessionPage(List.copyOf(rows), hasMore);
    }

    public Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ?",
                turnMapper, tenantId, sessionId, turnId);
        return rows.stream().findFirst();
    }

    public Optional<TurnRecord> findActiveTurn(String tenantId,
            String sessionId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')"
                        + " ORDER BY created_at DESC LIMIT 1",
                turnMapper, tenantId, sessionId);
        return rows.stream().findFirst();
    }

    public Optional<TurnRecord> findLatestTurn(String tenantId,
            String sessionId) {
        List<TurnRecord> rows = jdbc.query(
                "SELECT * FROM managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? ORDER BY created_at DESC,"
                        + " turn_id DESC LIMIT 1",
                turnMapper, tenantId, sessionId);
        return rows.stream().findFirst();
    }

    public List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit) {
        requireSession(tenantId, sessionId);
        return jdbc.query("SELECT * FROM managed_agent_event WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " sequence_id > ? ORDER BY sequence_id ASC LIMIT ?",
                eventMapper,
                tenantId, sessionId, afterSequence, limit);
    }

    public EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit) {
        requireSession(tenantId, sessionId);
        List<EventRecord> rows = beforeSequence == null
                ? jdbc.query("SELECT * FROM managed_agent_event WHERE"
                                + " tenant_id = ? AND session_id = ?"
                                + " ORDER BY sequence_id DESC LIMIT ?",
                        eventMapper, tenantId, sessionId, limit + 1)
                : jdbc.query("SELECT * FROM managed_agent_event WHERE"
                                + " tenant_id = ? AND session_id = ? AND"
                                + " sequence_id < ? ORDER BY sequence_id"
                                + " DESC LIMIT ?",
                        eventMapper, tenantId, sessionId, beforeSequence,
                        limit + 1);
        boolean hasMore = rows.size() > limit;
        if (hasMore) {
            rows = new ArrayList<>(rows.subList(0, limit));
        } else {
            rows = new ArrayList<>(rows);
        }
        java.util.Collections.reverse(rows);
        return new EventPage(List.copyOf(rows), hasMore);
    }

    public List<DispatchTarget> findDispatchable(long now, int limit) {
        return jdbc.query("SELECT tenant_id, session_id, turn_id FROM"
                        + " managed_agent_turn WHERE status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                        + " (dispatch_lease_until IS NULL OR"
                        + " dispatch_lease_until < ?)"
                        + " ORDER BY updated_at ASC LIMIT ?",
                (result, row) -> new DispatchTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("turn_id")), now, limit);
    }

    @Transactional
    public Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET"
                        + " dispatch_owner = ?, dispatch_lease_until = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ? AND turn_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING',"
                        + " 'CANCELLING') AND (dispatch_lease_until IS NULL"
                        + " OR dispatch_lease_until < ?)",
                owner, now + leaseDuration.toMillis(), now, tenantId,
                sessionId, turnId, now);
        return updated == 0 ? Optional.empty()
                : findTurn(tenantId, sessionId, turnId);
    }

    public boolean renewTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        long now = clock.millis();
        return jdbc.update("UPDATE managed_agent_turn SET"
                        + " dispatch_lease_until = ?, version = version + 1"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                        + " dispatch_lease_until >= ?",
                now + leaseDuration.toMillis(), tenantId, sessionId, turnId,
                owner, now) == 1;
    }

    public void releaseTurnLease(String tenantId, String sessionId,
            String turnId, String owner) {
        jdbc.update("UPDATE managed_agent_turn SET dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                tenantId, sessionId, turnId, owner);
    }

    @Transactional
    public boolean bindHarness(String tenantId, String sessionId,
            String harnessBootId) {
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        if (session.harnessBootId() != null) {
            return session.harnessBootId().equals(harnessBootId);
        }
        long now = clock.millis();
        jdbc.update("UPDATE managed_agent_session SET harness_boot_id = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                harnessBootId, now, tenantId, sessionId);
        return true;
    }

    @Transactional
    public void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner) {
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET"
                        + " submission_attempted = TRUE, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND harness_event_epoch IS NULL",
                now, tenantId, sessionId, turnId, owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    @Transactional
    public void recordAdmission(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastEventId) {
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " CASE WHEN status = 'CANCELLING' THEN status ELSE"
                        + " 'RUNNING' END, harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastEventId, now, tenantId, sessionId, turnId,
                owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        jdbc.update("UPDATE managed_agent_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ?",
                eventEpoch, lastEventId, now, tenantId, sessionId);
        if (!hasEventType(tenantId, sessionId, turnId, "turn.started")) {
            appendEvent(tenantId, sessionId, turnId, "turn.started",
                    Map.of("turnId", turnId), false, null, now);
        }
    }

    @Transactional
    public void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events) {
        if (events.isEmpty()) {
            return;
        }
        SessionRecord session = requireSessionForUpdate(tenantId, sessionId);
        TurnRecord turn = requireTurnForUpdate(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < clock.millis()) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (!eventEpoch.equals(turn.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness event epoch changed");
        }
        long lastSourceId = turn.harnessLastEventId() == null ? 0
                : turn.harnessLastEventId();
        List<HarnessEvent> accepted = new ArrayList<>();
        for (HarnessEvent event : events) {
            if (event.sourceId() > lastSourceId) {
                accepted.add(event);
                lastSourceId = event.sourceId();
            }
        }
        if (accepted.isEmpty()) {
            return;
        }
        long now = clock.millis();
        HarnessEvent terminal = null;
        for (int index = 0; index < accepted.size(); index++) {
            HarnessEvent event = accepted.get(index);
            if (event.projection() != null
                    && event.projection().terminal()) {
                if (terminal != null || index != accepted.size() - 1) {
                    throw new IllegalArgumentException(
                            "Terminal Harness event must end the batch");
                }
                terminal = event;
            }
        }
        int updated = terminal == null
                ? updateHarnessCursor(tenantId, sessionId, turnId, owner,
                        eventEpoch, lastSourceId, now)
                : completeHarnessTurn(tenantId, sessionId, turnId, owner,
                        eventEpoch, lastSourceId, terminal.projection(), now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        List<HarnessEvent> projected = accepted.stream()
                .filter(event -> event.projection() != null).toList();
        List<EventRecord> committed = appendEvents(tenantId, sessionId,
                turnId, eventEpoch, lastSourceId, session.lastSequence(),
                projected, now);
        publishAfterCommit(committed);
    }

    private int updateHarnessCursor(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastSourceId, long now) {
        return jdbc.update("UPDATE managed_agent_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, updated_at = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastSourceId, now, tenantId, sessionId, turnId,
                owner, now);
    }

    private int completeHarnessTurn(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastSourceId, ProjectedEvent terminal, long now) {
        return jdbc.update("UPDATE managed_agent_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, status = ?,"
                        + " error_code = ?, error_message = ?,"
                        + " completed_at = ?, updated_at = ?,"
                        + " dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastSourceId, terminal.terminalStatus(),
                terminal.errorCode(), terminal.errorMessage(), now, now,
                tenantId, sessionId, turnId, owner, now);
    }

    private List<EventRecord> appendEvents(String tenantId,
            String sessionId, String turnId, String eventEpoch,
            long lastSourceId, long sequence, List<HarnessEvent> events,
            long now) {
        List<EventRecord> records = new ArrayList<>();
        long next = sequence;
        for (HarnessEvent event : events) {
            ProjectedEvent projection = event.projection();
            records.add(new EventRecord(tenantId, sessionId, ++next,
                    publicId("evt"), turnId, projection.type(),
                    projection.data(), projection.terminal(),
                    event.sourceKey(), now));
        }
        jdbc.update("UPDATE managed_agent_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, last_sequence = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                eventEpoch, lastSourceId, next, now, tenantId, sessionId);
        if (!records.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO managed_agent_event (tenant_id,"
                            + " session_id, sequence_id, event_id, turn_id,"
                            + " event_type, data_json, terminal, source_key,"
                            + " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?)",
                    records, records.size(), (statement, event) -> {
                        statement.setString(1, event.tenantId());
                        statement.setString(2, event.sessionId());
                        statement.setLong(3, event.sequence());
                        statement.setString(4, event.eventId());
                        statement.setString(5, event.turnId());
                        statement.setString(6, event.type());
                        statement.setString(7, writeJson(event.data()));
                        statement.setBoolean(8, event.terminal());
                        statement.setString(9, event.sourceKey());
                        statement.setLong(10, event.createdAt());
                    });
        }
        return List.copyOf(records);
    }

    @Transactional
    public void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner) {
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || turn.harnessEventEpoch() != null
                || turn.submissionAttempted()) {
            return;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " 'CANCELLED',"
                        + " completed_at = ?, updated_at = ?,"
                        + " dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until >= ?"
                        + " AND submission_attempted = FALSE",
                now, now, tenantId, sessionId, turnId, owner, now);
        if (updated != 1) {
            return;
        }
        appendEvent(tenantId, sessionId, turnId, "turn.cancelled",
                Map.of("turnId", turnId), true, null, now);
    }

    @Transactional
    public void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message) {
        TurnRecord turn = requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || !ACTIVE_TURN_STATES.contains(turn.status())) {
            return;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " 'FAILED',"
                        + " error_code = ?, error_message = ?, completed_at ="
                        + " ?, updated_at = ?, dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                        + " dispatch_lease_until >= ?",
                code, message, now, now, tenantId, sessionId, turnId, owner,
                now);
        if (updated != 1) {
            return;
        }
        appendEvent(tenantId, sessionId, turnId, "turn.failed",
                Map.of("code", code, "message", message), true, null, now);
    }

    @Transactional
    public void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey) {
        requireSessionForUpdate(tenantId, sessionId);
        if (!hasSourceEvent(tenantId, sessionId, sourceKey)) {
            appendEvent(tenantId, sessionId, turnId, type, data, terminal,
                    sourceKey, clock.millis());
        }
    }

    public SessionRecord requireSession(String tenantId, String sessionId) {
        return findSession(tenantId, sessionId).orElseThrow(() ->
                new ApiException(HttpStatus.NOT_FOUND, "session_not_found",
                        "The Session was not found."));
    }

    private SessionRecord requireSessionForUpdate(String tenantId,
            String sessionId) {
        try {
            return jdbc.queryForObject("SELECT * FROM managed_agent_session"
                            + " WHERE tenant_id = ? AND session_id = ?"
                            + " FOR UPDATE",
                    sessionMapper, tenantId, sessionId);
        } catch (EmptyResultDataAccessException error) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "session_not_found", "The Session was not found.");
        }
    }

    private TurnRecord requireTurn(String tenantId, String sessionId,
            String turnId) {
        return findTurn(tenantId, sessionId, turnId).orElseThrow(() ->
                new ApiException(HttpStatus.NOT_FOUND, "turn_not_found",
                        "The Turn was not found."));
    }

    private TurnRecord requireTurnForUpdate(String tenantId,
            String sessionId, String turnId) {
        try {
            return jdbc.queryForObject("SELECT * FROM managed_agent_turn"
                            + " WHERE tenant_id = ? AND session_id = ? AND"
                            + " turn_id = ? FOR UPDATE",
                    turnMapper, tenantId, sessionId, turnId);
        } catch (EmptyResultDataAccessException error) {
            throw new ApiException(HttpStatus.NOT_FOUND, "turn_not_found",
                    "The Turn was not found.");
        }
    }

    private void insertTurn(String tenantId, String sessionId,
            String turnId, String promptId, List<Map<String, Object>> input,
            String payloadDigest, long now) {
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, created_at, updated_at) VALUES"
                        + " (?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, ?)",
                tenantId, sessionId, turnId, promptId, writeJson(input),
                payloadDigest, now, now);
    }

    private void insertCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, long now) {
        jdbc.update("INSERT INTO managed_agent_command (tenant_id,"
                        + " operation, idempotency_key, request_digest,"
                        + " session_id, turn_id, created_at) VALUES"
                        + " (?, ?, ?, ?, ?, ?, ?)",
                tenantId, operation, idempotencyKey, requestDigest,
                sessionId, turnId, now);
    }

    private EventRecord appendEvent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey, long now) {
        Long sequence = jdbc.queryForObject("SELECT last_sequence FROM"
                        + " managed_agent_session WHERE tenant_id = ? AND"
                        + " session_id = ? FOR UPDATE",
                Long.class, tenantId, sessionId);
        if (sequence == null) {
            throw new IllegalStateException("Session sequence is unavailable");
        }
        long next = sequence + 1;
        EventRecord event = new EventRecord(tenantId, sessionId, next,
                publicId("evt"), turnId, type, data, terminal, sourceKey,
                now);
        jdbc.update("UPDATE managed_agent_session SET last_sequence = ?,"
                        + " updated_at = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                next, now, tenantId, sessionId);
        jdbc.update("INSERT INTO managed_agent_event (tenant_id,"
                        + " session_id, sequence_id, event_id, turn_id,"
                        + " event_type, data_json, terminal, source_key,"
                        + " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                event.tenantId(), event.sessionId(), event.sequence(),
                event.eventId(), event.turnId(), event.type(),
                writeJson(event.data()), event.terminal(), event.sourceKey(),
                event.createdAt());
        publishAfterCommit(List.of(event));
        return event;
    }

    private void publishAfterCommit(List<EventRecord> events) {
        if (events.isEmpty()) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            eventPublisher.publish(events);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(
                new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        eventPublisher.publish(events);
                    }
                });
    }

    private boolean hasActiveTurn(String tenantId, String sessionId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                Integer.class, tenantId, sessionId);
        return count != null && count > 0;
    }

    private boolean hasEventType(String tenantId, String sessionId,
            String turnId, String type) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " event_type = ?",
                Integer.class, tenantId, sessionId, turnId, type);
        return count != null && count > 0;
    }

    private boolean hasSourceEvent(String tenantId, String sessionId,
            String sourceKey) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND source_key = ?",
                Integer.class, tenantId, sessionId, sourceKey);
        return count != null && count > 0;
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException("Value is not valid JSON",
                    error);
        }
    }

    private List<Map<String, Object>> readInput(String value) {
        try {
            return objectMapper.readValue(value, INPUT_TYPE);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored input is invalid", error);
        }
    }

    private Map<String, Object> readMap(String value) {
        try {
            return objectMapper.readValue(value, MAP_TYPE);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored event is invalid", error);
        }
    }

    private static Long nullableLong(java.sql.ResultSet result, String name)
            throws java.sql.SQLException {
        long value = result.getLong(name);
        return result.wasNull() ? null : value;
    }

    private static String publicId(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString()
                .replace("-", "");
    }
}
