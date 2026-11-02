package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.contracts.persistence.EventIdentity;
import com.alibaba.qwen.code.managedagent.contracts.persistence.EventIdentity.Identity;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

final class AgentEventJournal {
    private final AgentStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final CommittedEventPublisher eventPublisher;

    AgentEventJournal(AgentStoreRows storeRows,
            JdbcTemplate jdbc,
            Clock clock,
            CommittedEventPublisher eventPublisher) {
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.clock = clock;
        this.eventPublisher = eventPublisher;
        this.eventMapper = (result, row) ->
                new EventRecord(result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getLong("sequence_id"),
                        result.getString("event_id"),
                        result.getString("turn_id"),
                        result.getString("event_type"),
                        storeRows.readMap(result.getString("data_json")),
                        result.getBoolean("terminal"),
                        result.getString("source_key"),
                        result.getLong("gmt_create"),
                        result.getInt("schema_version"),
                        result.getInt("projection_version"),
                        result.getString("item_id"),
                        result.getString("content_part_id"));
    }

    static final String INSERT_EVENT = "INSERT INTO ma_public_event"
            + " (tenant_id, session_id, sequence_id, event_id, turn_id,"
            + " event_type, data_json, terminal, source_key, gmt_create,"
            + " schema_version, projection_version, item_id, content_part_id)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    final RowMapper<EventRecord> eventMapper;

    List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit) {
        storeRows.requireSession(tenantId, sessionId);
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id = X''"
                    + " AND tenant_id = ? AND session_id = ? AND sequence_id > ? ORDER BY"
                    + " sequence_id ASC LIMIT ?",
                eventMapper,
                tenantId,
                sessionId,
                afterSequence,
                limit);
    }

    /**
     * The latest environment event of each Session's latest Turn, in one round trip; the Turns are
     * already loaded, so the turn-row join of the single-session read is implied.
     */
    Map<String, EventRecord> findLatestEnvironmentEvents(
            String tenantId, Map<String, TurnSummary> latestTurns) {
        if (latestTurns.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(latestTurns.size() * 2 + 2);
        arguments.add(tenantId);
        StringBuilder pairs = new StringBuilder();
        for (TurnSummary turn : latestTurns.values()) {
            if (pairs.length() > 0) {
                pairs.append(",");
            }
            pairs.append(" (?, ?)");
            // Bound as identity bytes: H2 types row-comparison parameters
            // as VARCHAR, and a command it recompiles after binding (any
            // new session or SET in between) refuses VARBINARY rows against
            // VARCHAR ones. Bytes compare the same on MySQL and MariaDB.
            arguments.add(ManagedSchemaKeys.identity(turn.sessionId()));
            arguments.add(ManagedSchemaKeys.identity(turn.turnId()));
        }
        arguments.add(tenantId);
        // One row per session: the latest environment event of its latest
        // Turn, selected in SQL instead of shipping every match per pair.
        List<EventRecord> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns("event") + " FROM ma_public_event event JOIN (SELECT environment.session_id,"
                            + " MAX(environment.sequence_id) AS max_sequence FROM ma_public_event environment WHERE"
                            + " environment.stream_kind = 'SESSION' AND environment.stream_id = X'' AND environment.tenant_id = ? AND"
                            + " environment.event_type IN ('environment.provisioning', 'environment.ready',"
                            + " 'environment.failed') AND (environment.session_id, environment.turn_id) IN ("
                                + pairs
                                + ") GROUP BY environment.session_id) latest ON latest.session_id ="
                                + " event.session_id AND latest.max_sequence = event.sequence_id"
                                + " WHERE event.stream_kind = 'SESSION' AND event.stream_id = X''"
                                + " AND event.tenant_id = ?",
                        eventMapper,
                        arguments.toArray());
        Map<String, EventRecord> result = new HashMap<>(latestTurns.size() * 2);
        for (EventRecord row : rows) {
            result.put(row.sessionId(), row);
        }
        return result;
    }

    List<EventRecord> findControlEvents(String tenantId,
            String sessionId, long throughSequence) {
        storeRows.requireSession(tenantId, sessionId);
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id = X''"
                    + " AND tenant_id = ? AND session_id = ? AND sequence_id <= ? AND event_type"
                    + " NOT IN ('turn.accepted', 'item.output_text.delta', 'item.reasoning.delta',"
                    + " 'item.tool_call.updated', 'item.tool_result.updated') ORDER BY sequence_id"
                    + " ASC",
                eventMapper,
                tenantId,
                sessionId,
                throughSequence);
    }

    EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit) {
        storeRows.requireSession(tenantId, sessionId);
        List<EventRecord> rows =
                beforeSequence == null
                        ? jdbc.query(
                                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                                    + " stream_id = X'' AND tenant_id = ? AND session_id = ? ORDER"
                                    + " BY sequence_id DESC LIMIT ?",
                                eventMapper,
                                tenantId,
                                sessionId,
                                limit + 1)
                        : jdbc.query(
                                "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                                    + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND"
                                    + " sequence_id < ? ORDER BY sequence_id DESC LIMIT ?",
                                eventMapper,
                                tenantId,
                                sessionId,
                                beforeSequence,
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

    List<EventRecord> appendEvents(String tenantId,
            String sessionId, String turnId, String eventEpoch,
            long lastSourceId, long sequence, List<HarnessEvent> events,
            long now) {
        List<EventRecord> records = new ArrayList<>();
        long next = sequence;
        Identity previous = events.isEmpty() ? null
                : findIdentity(tenantId, sessionId, next,
                        events.getFirst().projection().type());
        for (HarnessEvent event : events) {
            ProjectedEvent projection = event.projection();
            previous = EventIdentity.of(projection.type(), turnId, ++next,
                    projection.data(), previous);
            records.add(new EventRecord(tenantId, sessionId, next,
                    AgentStoreRows.publicId("evt"), turnId, projection.type(),
                    projection.data(), projection.terminal(),
                    event.sourceKey(), now, EventIdentity.SCHEMA_VERSION,
                    EventIdentity.PROJECTION_VERSION, previous.itemId(),
                    previous.contentPartId()));
        }
        jdbc.update("UPDATE ma_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                eventEpoch, lastSourceId, now, tenantId, sessionId);
        jdbc.update(
                "UPDATE ma_event_stream SET last_sequence = ?, gmt_modified = ? WHERE tenant_id = ?"
                    + " AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                next,
                now,
                tenantId,
                sessionId);
        if (!records.isEmpty()) {
            jdbc.batchUpdate(INSERT_EVENT, records, records.size(),
                    (statement, event) -> {
                        statement.setString(1, event.tenantId());
                        statement.setString(2, event.sessionId());
                        statement.setLong(3, event.sequence());
                        statement.setString(4, event.eventId());
                        statement.setString(5, event.turnId());
                        statement.setString(6, event.type());
                        statement.setString(7, storeRows.writeJson(event.data()));
                        statement.setBoolean(8, event.terminal());
                        statement.setString(9, event.sourceKey());
                        statement.setLong(10, event.createdAt());
                        statement.setInt(11, event.schemaVersion());
                        statement.setInt(12, event.projectionVersion());
                        statement.setString(13, event.itemId());
                        statement.setString(14, event.contentPartId());
                    });
        }
        return List.copyOf(records);
    }

    void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey) {
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (!hasSourceEvent(tenantId, sessionId, sourceKey)) {
            appendEvent(tenantId, sessionId, turnId, type, data, terminal,
                    sourceKey, clock.millis());
        }
    }

    void appendLiveSessionEventIfAbsent(String tenantId,
            String sessionId, String type, Map<String, Object> data,
            String sourceKey) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        // A locking read sees the latest committed status, where a plain one
        // could still see the snapshot taken before a deletion committed.
        Optional<SessionRecord> session = jdbc.query(AgentStoreRows.SESSION_WITH_STREAM + " WHERE ma_session.tenant_id = ? AND"
                                        + " ma_session.session_kind = 'PUBLIC' AND"
                                        + " ma_session.session_id = ? FOR UPDATE",
                storeRows.sessionMapper, tenantId, sessionId).stream()
                .findFirst();
        if (session.isEmpty() || "DELETING".equals(session.get().status())
                || "DELETED".equals(session.get().status())) {
            return;
        }
        if (!hasSourceEvent(tenantId, sessionId, sourceKey)) {
            appendEvent(tenantId, sessionId, null, type, data, false,
                    sourceKey, clock.millis());
        }
    }

    static Map<String, Object> acceptedData(String turnId,
            List<Map<String, Object>> input) {
        return Map.of("turnId", turnId,
                "itemId", StoreModels.inputItemId(turnId), "input", input);
    }

    static String operationSource(String operationId,
            String phase) {
        return "operation:" + operationId + ":" + phase;
    }

    EventRecord appendEvent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey, long now) {
        Long sequence =
                jdbc.queryForObject(
                        "SELECT last_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                            + " UPDATE",
                        Long.class,
                        tenantId,
                        sessionId);
        if (sequence == null) {
            throw new IllegalStateException("Session sequence is unavailable");
        }
        long next = sequence + 1;
        Identity identity = EventIdentity.of(type, turnId, next, data,
                findIdentity(tenantId, sessionId, sequence, type));
        EventRecord event = new EventRecord(tenantId, sessionId, next,
                AgentStoreRows.publicId("evt"), turnId, type, data, terminal, sourceKey,
                now, EventIdentity.SCHEMA_VERSION,
                EventIdentity.PROJECTION_VERSION, identity.itemId(),
                identity.contentPartId());
        jdbc.update("UPDATE ma_event_stream SET last_sequence = ?,"
                        + " gmt_modified = ? WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'SESSION' AND stream_id = X''",
                next, now, tenantId, sessionId);
        jdbc.update(INSERT_EVENT, event.tenantId(), event.sessionId(),
                event.sequence(), event.eventId(), event.turnId(),
                event.type(), storeRows.writeJson(event.data()), event.terminal(),
                event.sourceKey(), event.createdAt(), event.schemaVersion(),
                event.projectionVersion(), event.itemId(),
                event.contentPartId());
        publishAfterCommit(List.of(event));
        return event;
    }

    // Emptied deltas name nothing, and a delta that continued one now starts
    // a Part of its own, so identities from the first emptied event on are
    // derived again as the rebuilt Items will name them.
    void reassignIdentity(String tenantId, String sessionId,
            long fromSequence) {
        List<EventRecord> events =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id"
                            + " = X'' AND tenant_id = ? AND session_id = ? AND sequence_id >= ?"
                            + " ORDER BY sequence_id ASC",
                        eventMapper,
                        tenantId,
                        sessionId,
                        fromSequence - 1);
        Identity previous = null;
        for (EventRecord event : events) {
            if (event.sequence() < fromSequence) {
                previous = new Identity(event.type(), event.itemId(),
                        event.contentPartId());
                continue;
            }
            Identity identity = EventIdentity.of(event.type(),
                    event.turnId(), event.sequence(), event.data(), previous);
            if (!Objects.equals(identity.itemId(), event.itemId())
                    || !Objects.equals(identity.contentPartId(),
                            event.contentPartId())) {
                jdbc.update(
                        "UPDATE ma_public_event SET item_id = ?, content_part_id = ? WHERE"
                            + " tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION' AND"
                            + " stream_id = X'' AND sequence_id = ?",
                        identity.itemId(),
                        identity.contentPartId(),
                        tenantId,
                        sessionId,
                        event.sequence());
            }
            previous = identity;
        }
    }

    // Only a text delta continues the event before it, so other events skip
    // the lookup.
    Identity findIdentity(String tenantId, String sessionId,
            long sequence, String nextType) {
        if (!EventIdentity.continuesPrevious(nextType)) {
            return null;
        }
        List<Identity> rows =
                jdbc.query(
                        "SELECT event_type, item_id, content_part_id FROM ma_public_event WHERE"
                            + " stream_kind = 'SESSION' AND stream_id = X'' AND tenant_id = ? AND"
                            + " session_id = ? AND sequence_id = ?",
                        (result, row) ->
                                new Identity(
                                        result.getString("event_type"),
                                        result.getString("item_id"),
                                        result.getString("content_part_id")),
                        tenantId,
                        sessionId,
                        sequence);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    void publishAfterCommit(List<EventRecord> events) {
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

    boolean hasEventType(String tenantId, String sessionId,
            String turnId, String type) {
        Integer count =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                            + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND turn_id ="
                            + " ? AND event_type = ?",
                        Integer.class,
                        tenantId,
                        sessionId,
                        turnId,
                        type);
        return count != null && count > 0;
    }

    boolean hasSourceEvent(String tenantId, String sessionId,
            String sourceKey) {
        Integer count =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                            + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND source_key"
                            + " = ?",
                        Integer.class,
                        tenantId,
                        sessionId,
                        sourceKey);
        return count != null && count > 0;
    }
}
