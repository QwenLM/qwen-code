package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.EventIdentity;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ItemPartRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class AgentMessageProjection {
    private final AgentEventJournal eventJournal;
    private final AgentStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final Clock clock;

    AgentMessageProjection(AgentEventJournal eventJournal,
            AgentStoreRows storeRows,
            JdbcTemplate jdbc,
            ObjectMapper objectMapper,
            Clock clock) {
        this.eventJournal = eventJournal;
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.clock = clock;
        this.itemMapper = (result, row) ->
                        new ItemRecord(
                                result.getString("tenant_id"),
                                result.getString("session_id"),
                                result.getString("item_id"),
                                result.getString("turn_id"),
                                result.getString("item_type"),
                                result.getString("item_role"),
                                result.getString("item_status"),
                                storeRows.readMap(result.getString("attributes_json")),
                                result.getLong("first_sequence"),
                                result.getLong("last_sequence"),
                                result.getLong("gmt_create"),
                                result.getLong("gmt_modified"),
                                result.getLong("revision"),
                                readParts(
                                        result.getString("parts_json"),
                                        result.getString("body_resource_key"),
                                        result.getString("tenant_id"),
                                        result.getString("session_id")));
    }

    static final TypeReference<List<ItemPartRecord>> PARTS_TYPE = new TypeReference<>() {};

    static final long MESSAGE_PAGE_BYTES = 8L * 1024 * 1024;

    final RowMapper<ItemRecord> itemMapper;

    StoreModels.MessagePage findMessagePage(String tenantId, String sessionId,
            String cursor, int limit, boolean backward, long afterSequence) {
        storeRows.requireSession(tenantId, sessionId);
        ManagedLegacySessionGuard.requireLegacyMutation(Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT csi_guard FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                Boolean.class, tenantId, sessionId)));
        if (limit < 1 || limit > 100) {
            throw new ManagedAgentException(400, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
        if (afterSequence < 0) {
            throw new ManagedAgentException(400, "invalid_event_cursor",
                    "Item sequence must be non-negative.");
        }
        var progress = jdbc.queryForMap("SELECT covered_sequence, projection_version, last_sequence, replay_floor_sequence FROM ma_event_stream"
                        + " WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                tenantId, sessionId);
        long covered = ((Number) progress.get("covered_sequence")).longValue();
        int projection = ((Number) progress.get("projection_version")).intValue();
        if (covered < ((Number) progress.get("replay_floor_sequence")).longValue()
                || (!backward && org.apache.commons.lang3.StringUtils.isBlank(cursor)
                && covered < ((Number) progress.get("last_sequence")).longValue())) {
            throw new ManagedAgentException(503, "message_projection_pending",
                    "Retry after pending messages have been projected.");
        }
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        MessagePosition position = new MessagePosition(1, scope, backward, projection, covered,
                backward ? covered + 1 : -1, "");
        if (org.apache.commons.lang3.StringUtils.isNotBlank(cursor)) {
            position = messagePosition(cursor, scope, backward, covered, projection);
        }
        String comparison = backward ? "<" : ">";
        String order = backward ? " DESC" : " ASC";
        boolean numericBoundary = afterSequence > 0 && org.apache.commons.lang3.StringUtils.isBlank(cursor);
        List<Object> pageArguments = new ArrayList<>(List.of(scope, tenantId, sessionId, position.through()));
        if (numericBoundary) {
            pageArguments.add(afterSequence);
        }
        pageArguments.addAll(List.of(position.sequence(), position.sequence(),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.identity(position.item()), limit + 1));
        List<MessageSize> candidates = jdbc.query(
                "SELECT m.item_id, m.first_sequence, OCTET_LENGTH(m.attributes_json) +"
                        + " OCTET_LENGTH(m.parts_json) + COALESCE(OCTET_LENGTH(r.inline_bytes), 0) AS byte_length"
                        + " FROM ma_message m LEFT JOIN ma_resource r ON r.resource_key = m.body_resource_key"
                        + " AND r.session_scope_key = ? AND r.tenant_id = m.tenant_id AND r.session_id = m.session_id"
                        + " WHERE m.tenant_id = ? AND m.session_id = ? AND m.first_sequence <= ?"
                        + (numericBoundary ? " AND m.first_sequence > ?" : "")
                        + " AND (m.first_sequence " + comparison + " ? OR (m.first_sequence = ? AND m.item_id "
                        + comparison + " ?)) ORDER BY m.first_sequence" + order + ", m.item_id" + order + " LIMIT ?",
                (row, index) -> new MessageSize(row.getString("item_id"), row.getLong("first_sequence"),
                        row.getLong("byte_length")),
                pageArguments.toArray());
        long bytes = 0;
        List<MessageSize> selected = new ArrayList<>();
        for (MessageSize candidate : candidates) {
            if (selected.size() == limit || bytes + candidate.bytes() > MESSAGE_PAGE_BYTES) {
                if (selected.isEmpty()) {
                    throw messagePageTooLarge();
                }
                break;
            }
            if (candidate.bytes() < 0) {
                throw new IllegalStateException("Message byte length is invalid.");
            }
            bytes += candidate.bytes();
            selected.add(candidate);
        }
        if (selected.isEmpty()) {
            return new StoreModels.MessagePage(List.of(), List.of(), false, null, covered, position.through());
        }
        List<Object> arguments = new ArrayList<>(List.of(tenantId, sessionId));
        selected.forEach(item -> arguments.add(
                ManagedSchemaKeys.identity(item.id())));
        // Bodies are fetched only after the metadata-only lookahead has selected a bounded page.
        List<ItemRecord> rows = List.copyOf(jdbc.query(
                "SELECT " + ManagedSchemaProjection.MESSAGE.columns() + " FROM ma_message WHERE tenant_id = ?"
                        + " AND session_id = ? AND item_id IN (" + AgentStoreRows.placeholders(selected.size())
                        + ") ORDER BY first_sequence ASC, item_id ASC", itemMapper, arguments.toArray()));
        if (rows.size() != selected.size() || rows.stream().anyMatch(item -> item.lastSequence() > covered)) {
            throw new IllegalStateException("Message projection differs from its progress.");
        }
        List<EventRecord> events = backward ? messageTurnEvents(tenantId, sessionId, rows, covered, bytes) : List.of();
        boolean more = selected.size() < candidates.size();
        MessageSize last = selected.getLast();
        String next = more ? messageCursor(new MessagePosition(1, scope, backward, projection,
                position.through(), last.sequence(), last.id())) : null;
        return new StoreModels.MessagePage(rows, events, more, next, covered, position.through());
    }

    List<EventRecord> messageTurnEvents(String tenantId, String sessionId,
            List<ItemRecord> items, long covered, long itemBytes) {
        List<String> turns = items.stream().map(ItemRecord::turnId).distinct().toList();
        List<Object> arguments = new ArrayList<>(List.of(tenantId, sessionId, covered));
        turns.forEach(turn -> arguments.add(
                ManagedSchemaKeys.identity(turn)));
        arguments.add(tenantId);
        arguments.add(sessionId);
        var sizes = jdbc.query("SELECT e.sequence_id, OCTET_LENGTH(e.data_json) AS byte_length FROM ma_public_event e"
                        + " JOIN (SELECT turn_id, event_type, MAX(sequence_id) AS seq FROM ma_public_event"
                        + " WHERE tenant_id = ? AND session_id = ? AND sequence_id <= ?"
                        + " AND stream_kind = 'SESSION' AND stream_id = X'' AND turn_id IN ("
                        + AgentStoreRows.placeholders(turns.size()) + ") AND event_type IN ('turn.started', 'turn.completed',"
                        + " 'turn.failed', 'turn.cancelled', 'turn.cancel.requested', 'environment.provisioning',"
                        + " 'environment.ready', 'environment.failed') GROUP BY turn_id, event_type) latest"
                        + " ON e.turn_id = latest.turn_id AND e.event_type = latest.event_type AND e.sequence_id = latest.seq"
                        + " WHERE e.tenant_id = ? AND e.session_id = ? AND e.stream_kind = 'SESSION' AND e.stream_id = X''",
                (row, index) -> new EventSize(row.getLong("sequence_id"), row.getLong("byte_length")), arguments.toArray());
        if (sizes.stream().mapToLong(EventSize::bytes).sum() + itemBytes > MESSAGE_PAGE_BYTES) {
            throw messagePageTooLarge();
        }
        if (sizes.isEmpty()) {
            return List.of();
        }
        List<Object> eventArguments = new ArrayList<>(List.of(tenantId, sessionId));
        sizes.forEach(event -> eventArguments.add(event.sequence()));
        return jdbc.query("SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event"
                        + " WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''"
                        + " AND sequence_id IN (" + AgentStoreRows.placeholders(sizes.size()) + ") ORDER BY sequence_id ASC",
                eventJournal.eventMapper, eventArguments.toArray());
    }

    MessagePosition messagePosition(String cursor, String scope, boolean backward,
            long covered, int projection) {
        try {
            if (cursor.length() > 4096) {
                throw new IllegalArgumentException();
            }
            MessagePosition position = objectMapper.readValue(
                    java.util.Base64.getUrlDecoder().decode(cursor), MessagePosition.class);
            if (position.version() != 1 || !scope.equals(position.scope()) || position.backward() != backward
                    || position.projection() < 1 || position.through() < 0 || position.sequence() < 0
                    || position.sequence() > position.through() || position.item() == null
                    || position.item().isEmpty() || position.item().length() > 512) {
                throw new IllegalArgumentException();
            }
            if (position.projection() != projection) {
                throw new ManagedAgentException(409, "message_projection_changed",
                        "Reload message history after its projection changed.");
            }
            if (position.through() > covered) {
                throw new IllegalArgumentException();
            }
            return position;
        } catch (java.io.IOException | IllegalArgumentException invalid) {
            throw new ManagedAgentException(400, "invalid_message_cursor",
                    "The message cursor is invalid for this Session and direction.");
        }
    }

    String messageCursor(MessagePosition position) {
        try {
            return java.util.Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(objectMapper.writeValueAsBytes(position));
        } catch (java.io.IOException failure) {
            throw new IllegalStateException("Message cursor serialization failed.", failure);
        }
    }

    static ManagedAgentException messagePageTooLarge() {
        return new ManagedAgentException(413, "message_page_too_large",
                "The message page exceeds its byte budget.");
    }

    record MessagePosition(int version, String scope, boolean backward, int projection,
            long through, long sequence, String item) {}

    record MessageSize(String id, long sequence, long bytes) {}

    record EventSize(long sequence, long bytes) {}

    /** The message projection coverage of each Session, in one read. */
    Map<String, Long> findMessageCoveredSequences(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 1);
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        Map<String, Long> result = new HashMap<>(sessionIds.size() * 2);
        RowCallbackHandler reader = row -> result.put(
                row.getString("session_id"), row.getLong("covered_sequence"));
        jdbc.query(
                "SELECT s.session_id, s.covered_sequence FROM ma_event_stream s"
                    + " WHERE s.stream_kind = 'SESSION' AND"
                    + " s.stream_id = X'' AND s.tenant_id = ? AND s.session_id IN ("
                        + AgentStoreRows.placeholders(sessionIds.size())
                        + ")",
                reader,
                arguments.toArray());
        return result;
    }

    ReplayWindow findReplayWindow(String tenantId, String sessionId) {
        List<ReplayWindow> rows =
                jdbc.query(
                        "SELECT s.replay_floor_sequence, s.covered_sequence FROM ma_event_stream s"
                            + " WHERE s.tenant_id = ? AND s.session_id = ?"
                            + " AND s.stream_kind = 'SESSION' AND s.stream_id = X''",
                        (result, row) ->
                                new ReplayWindow(
                                        result.getLong("replay_floor_sequence"),
                                        result.getLong("covered_sequence")),
                        tenantId,
                        sessionId);
        if (rows.isEmpty()) {
            throw new ManagedAgentException(404, "session_not_found",
                    "The Session was not found.");
        }
        return rows.getFirst();
    }

    List<ReplayFloorTarget> findReplayFloorTargets(int limit) {
        return jdbc.query(
                "SELECT s.tenant_id, s.session_id FROM ma_event_stream s"
                    + " WHERE s.stream_kind = 'SESSION' AND s.stream_id = X''"
                    + " AND s.covered_sequence > s.replay_floor_sequence"
                    + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE"
                    + " private_scope.tenant_id = s.tenant_id AND private_scope.session_id = s.session_id"
                    + " AND private_scope.csi_guard = FALSE)"
                    + " AND NOT EXISTS (SELECT 1 FROM ma_turn t JOIN ma_public_event e ON"
                    + " e.tenant_id = t.tenant_id AND e.session_id = t.session_id AND e.turn_id = t.turn_id"
                    + " WHERE t.tenant_id = s.tenant_id AND t.session_id = s.session_id"
                    + " AND t.status IN ('ACCEPTED', 'RUNNING', 'CANCELLING')"
                    + " AND e.stream_kind = 'SESSION' AND e.stream_id = X''"
                    + " AND e.event_type = 'turn.accepted' AND e.sequence_id <= s.replay_floor_sequence + 1)"
                    + " ORDER BY s.gmt_modified ASC LIMIT ?",
                (row, index) -> new ReplayFloorTarget(row.getString("tenant_id"), row.getString("session_id")),
                limit);
    }

    /** Advances only through readable message coverage, retaining active-Turn evidence. */
    ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence) {
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        ReplayWindow window = findReplayWindow(tenantId, sessionId);
        long floor = Math.min(floorSequence, window.snapshotThroughSequence());
        Long activeStart =
                jdbc.queryForObject(
                        "SELECT MIN(e.sequence_id) FROM ma_public_event e JOIN ma_turn t ON"
                            + " t.tenant_id = e.tenant_id AND t.session_id = e.session_id AND"
                            + " t.turn_id = e.turn_id WHERE e.tenant_id = ? AND e.session_id = ?"
                            + " AND e.stream_kind = 'SESSION' AND e.stream_id = X'' AND"
                            + " e.event_type = 'turn.accepted' AND t.status IN ('ACCEPTED',"
                            + " 'RUNNING', 'CANCELLING')",
                        Long.class,
                        tenantId,
                        sessionId);
        if (activeStart != null) {
            floor = Math.min(floor, Math.max(0, activeStart - 1));
        }
        if (floor <= window.floorSequence()) {
            return window;
        }
        jdbc.update(
                "UPDATE ma_event_stream SET replay_floor_sequence = ? WHERE tenant_id = ? AND"
                    + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                floor,
                tenantId,
                sessionId);
        return new ReplayWindow(floor, window.snapshotThroughSequence());
    }

    List<MaterializationTarget> findMaterializationTargets(int limit) {
        return jdbc.query(
                "SELECT s.tenant_id, s.session_id FROM ma_session s JOIN ma_event_stream p ON p.tenant_id = s.tenant_id AND p.session_id = s.session_id AND p.stream_kind = 'SESSION' AND p.stream_id = X'' WHERE s.session_kind = 'PUBLIC' AND s.csi_guard = FALSE AND s.retired_at IS NULL AND s.status <> 'DELETED' AND p.projection_pending = TRUE ORDER BY p.gmt_modified ASC LIMIT ?",
                (result, row) ->
                        new MaterializationTarget(
                                result.getString("tenant_id"), result.getString("session_id")),
                limit);
    }

    MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        Long covered = jdbc.queryForObject(
                        "SELECT covered_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                            + " UPDATE",
                Long.class, tenantId, sessionId);
        if (covered == null) {
            throw new IllegalStateException(
                    "Message projection progress is unavailable");
        }
        List<EventRecord> events =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id"
                            + " = X'' AND tenant_id = ? AND session_id = ? AND sequence_id > ?"
                            + " ORDER BY sequence_id ASC LIMIT ?",
                        eventJournal.eventMapper,
                        tenantId,
                        sessionId,
                        covered,
                        limit);
        if (events.isEmpty()) {
            return new MaterializationResult(false, covered);
        }
        long expected = covered + 1;
        Map<String, List<ItemPartRecord>> projectedParts = new LinkedHashMap<>();
        for (EventRecord event : events) {
            if (event.sequence() != expected) {
                // A gap is permanent: appendEvent allocates a sequence under
                // the session row lock this method already holds, so no
                // missing sequence can still appear. Skipping ahead once
                // beats throwing on every scan and wedging the projection.
                AgentStoreRows.LOG.error("Message projection skips a permanent event gap"
                                + " tenant={} session={} missingSequences={}-{}"
                                + " nextEvent={}",
                        tenantId, sessionId, expected, event.sequence() - 1,
                        event.sequence());
                // The skipped range may have carried a turn's terminal
                // event, whose settle is the only write that moves its
                // items off in_progress. Settle those turns' items here, or
                // they would be pinned forever — but only for a turn that is
                // provably over: its terminal event is in the journal (its
                // own materialization settled it already, making this a
                // no-op guard) or its row is not live. A turn whose row is
                // still live (recordHarnessEvents flips it in the same
                // transaction that appends the terminal event, so a live row
                // means the terminal event can still arrive) is settled by
                // its own event or by turn recovery's turn.failed — never
                // here. The remaining guards mirror settleTurnItems (never
                // re-settle a completed item, never push last_sequence
                // backwards).
                jdbc.update("UPDATE ma_message SET item_status ="
                                + " 'failed', last_sequence = CASE WHEN"
                                + " last_sequence < ? THEN ? ELSE"
                                + " last_sequence END, gmt_modified = ?,"
                                + " revision = revision + 1 WHERE tenant_id"
                                + " = ? AND session_id = ? AND item_status"
                                + " = 'in_progress' AND last_sequence < ?"
                                + " AND NOT EXISTS (SELECT 1 FROM"
                                + " ma_public_event terminal WHERE"
                                + " terminal.stream_kind = 'SESSION' AND"
                                + " terminal.stream_id = X'' AND"
                                + " terminal.tenant_id ="
                                + " ma_message.tenant_id AND"
                                + " terminal.session_id ="
                                + " ma_message.session_id AND"
                                + " terminal.turn_id ="
                                + " ma_message.turn_id AND"
                                + " terminal.event_type IN"
                                + " ('turn.completed', 'turn.failed',"
                                + " 'turn.cancelled'))"
                                + " AND NOT EXISTS (SELECT 1 FROM"
                                + " ma_turn live WHERE"
                                + " live.tenant_id ="
                                + " ma_message.tenant_id AND"
                                + " live.session_id ="
                                + " ma_message.session_id AND"
                                + " live.turn_id ="
                                + " ma_message.turn_id AND"
                                + " live.status IN ('ACCEPTED', 'RUNNING',"
                                + " 'CANCELLING'))",
                        event.sequence() - 1, event.sequence() - 1,
                        clock.millis(), tenantId, sessionId,
                        event.sequence());
            }
            materializeEvent(event, projectedParts);
            expected = event.sequence() + 1;
        }
        flushParts(tenantId, sessionId, projectedParts);
        long nextCovered = events.get(events.size() - 1).sequence();
        long now = clock.millis();
        jdbc.update(
                "UPDATE ma_event_stream SET covered_sequence = ?, gmt_modified = ?"
                    + " WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                nextCovered,
                now,
                tenantId,
                sessionId);
        return new MaterializationResult(true, nextCovered);
    }

    void deferMaterializationTarget(String tenantId,
            String sessionId) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        jdbc.update("UPDATE ma_event_stream SET gmt_modified = ? WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''",
                clock.millis(), tenantId, sessionId);
    }

    void rebuildTurnText(String tenantId, String sessionId, String turnId, long now) {
        Long covered =
                jdbc.queryForObject(
                        "SELECT covered_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                            + " UPDATE",
                        Long.class,
                        tenantId,
                        sessionId);
        Map<String, List<ItemPartRecord>> parts = new LinkedHashMap<>();
        jdbc.query(
                "SELECT item_id, parts_json, body_resource_key FROM ma_message WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ? AND item_role = 'assistant' AND"
                        + " item_type = 'message' FOR UPDATE",
                (org.springframework.jdbc.core.RowCallbackHandler)
                        row -> {
                            var retained =
                                    new ArrayList<>(
                                            readParts(
                                                    row.getString("parts_json"),
                                                    row.getString("body_resource_key"),
                                                    tenantId,
                                                    sessionId));
                            retained.removeIf(
                                    part ->
                                            "output_text".equals(part.type())
                                                    || "reasoning".equals(part.type()));
                            parts.put(row.getString("item_id"), retained);
                        },
                tenantId,
                sessionId,
                turnId);
        List<EventRecord> events =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE tenant_id = ? AND session_id = ? AND"
                                + " stream_kind = 'SESSION' AND stream_id = X'' AND turn_id = ? AND"
                                + " sequence_id <= ? AND event_type IN ('item.output_text.delta',"
                                + " 'item.reasoning.delta', 'turn.completed', 'turn.failed',"
                                + " 'turn.cancelled') ORDER BY sequence_id",
                        eventJournal.eventMapper,
                        tenantId,
                        sessionId,
                        turnId,
                        covered);
        EventRecord terminal = null;
        for (EventRecord event : events) {
            if (List.of("turn.completed", "turn.failed", "turn.cancelled").contains(event.type())) {
                terminal = event;
            } else {
                materializeText(
                        event,
                        "item.reasoning.delta".equals(event.type()) ? "reasoning" : "output_text",
                        parts);
            }
        }
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        var iterator = parts.entrySet().iterator();
        while (iterator.hasNext()) {
            var entry = iterator.next();
            List<ItemPartRecord> retained = entry.getValue();
            if (retained.isEmpty()) {
                ManagedProjectionResourceCollector.release(jdbc, scope, "MESSAGE",
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(scope, entry.getKey()));
                jdbc.update(
                        "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                                + " 'MESSAGE' AND owner_key = ?",
                        scope,
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                                scope, entry.getKey()));
                jdbc.update(
                        "DELETE FROM ma_message WHERE tenant_id = ? AND session_id = ? AND item_id"
                                + " = ?",
                        tenantId,
                        sessionId,
                        entry.getKey());
                iterator.remove();
                continue;
            }
            long first =
                    retained.stream().mapToLong(ItemPartRecord::firstSequence).min().orElseThrow();
            long last =
                    retained.stream().mapToLong(ItemPartRecord::lastSequence).max().orElseThrow();
            long created =
                    retained.stream().mapToLong(ItemPartRecord::createdAt).min().orElseThrow();
            long updated =
                    retained.stream().mapToLong(ItemPartRecord::updatedAt).max().orElseThrow();
            String status = "in_progress";
            if (terminal != null) {
                last = Math.max(last, terminal.sequence());
                updated = Math.max(updated, terminal.createdAt());
                status = switch (terminal.type()) {
                    case "turn.completed" -> "completed";
                    case "turn.cancelled" -> "cancelled";
                    default -> "failed";
                };
            }
            jdbc.update(
                    "UPDATE ma_message SET first_sequence = ?, last_sequence = ?, gmt_create = ?,"
                            + " gmt_modified = ?, item_status = ?, revision = revision + 1 WHERE"
                            + " tenant_id = ? AND session_id = ? AND item_id = ?",
                    first,
                    last,
                    created,
                    updated,
                    status,
                    tenantId,
                    sessionId,
                    entry.getKey());
        }
        flushParts(tenantId, sessionId, parts);
        jdbc.update(
                "UPDATE ma_event_stream SET projection_version = projection_version + 1,"
                    + " gmt_modified = ? WHERE tenant_id = ? AND session_id = ?"
                    + " AND stream_kind = 'SESSION' AND stream_id = X''",
                now,
                tenantId,
                sessionId);
    }

    void materializeEvent(EventRecord event, Map<String, List<ItemPartRecord>> projectedParts) {
        switch (event.type()) {
            case "turn.accepted", "item.input.added" -> materializeInput(event, projectedParts);
            case "item.output_text.delta" -> materializeText(event,
                    "output_text", projectedParts);
            case "item.reasoning.delta" -> materializeText(event,
                    "reasoning", projectedParts);
            case "item.tool_call.updated", "item.tool_result.updated" -> materializeTool(event);
            case "turn.completed", "turn.failed", "turn.cancelled" ->
                    settleTurnItems(event);
            default -> {
                return;
            }
        }
    }

    void materializeInput(EventRecord event, Map<String, List<ItemPartRecord>> projectedParts) {
        List<Map<String, Object>> input = inputData(event.data().get("input"));
        if (input.isEmpty()) {
            input = storeRows.requireTurn(event.tenantId(), event.sessionId(),
                    event.turnId()).input();
        }
        String itemId = string(event.data().get("itemId"));
        if (itemId == null) {
            itemId = StoreModels.inputItemId(event.turnId());
        }
        upsertItem(event, itemId, "message", "user", "completed",
                input.stream().anyMatch(block -> "image".equals(block.get("type")) || "resource".equals(block.get("type")))
                        ? Map.of("inputAttachments", input) : Map.of());
        for (int index = 0; index < input.size(); index++) {
            Map<String, Object> block = input.get(index);
            String text = string(block.get("text"));
            if (text == null) {
                text = workflowLaunchSummary(block);
            }
            if (text == null) {
                continue;
            }
            replacePart(event, itemId,
                    "part_" + ("item.input.added".equals(event.type()) ? itemId : event.turnId()) + "_input_" + index,
                    "input_text", text, projectedParts);
        }
    }

    /**
     * A workflow child's first turn carries one {@code workflow_launch} block and no text (#13803
     * K1): the message names the launch pin exactly as the daemon journal does ({@code
     * workflowLaunchSummaryText} in hosted-workflow-turn.ts), so both projections of the turn
     * agree. The block itself is never given a text key — the daemon parser requires its closed key
     * set.
     */
    static String workflowLaunchSummary(Map<String, Object> block) {
        if (!"workflow_launch".equals(block.get("type"))
                || !(block.get("definition") instanceof Map<?, ?> pin)) {
            return null;
        }
        String id = string(pin.get("definitionId"));
        String digest = string(pin.get("definitionDigest"));
        if (id == null || digest == null
                || !(pin.get("definitionRevision") instanceof Number revision)) {
            return null;
        }
        return "<workflow " + id + "@" + revision.longValue() + " sha256:"
                + digest.substring(0, Math.min(16, digest.length())) + ">";
    }

    void materializeText(EventRecord event, String partType, Map<String, List<ItemPartRecord>> projectedParts) {
        String text = string(event.data().get("text"));
        if (text == null || text.isEmpty()) {
            return;
        }
        String itemId = string(event.data().get("itemId"));
        if (itemId == null) {
            itemId = EventIdentity.assistantItemId(event.turnId());
        }
        // The previous part of the same series is the one with the greatest
        // last_sequence, whatever events sit between the two deltas — an
        // announcement row must not split an assistant message in two
        // (#13300 R3-3, symmetric with the write-side identity lookup).
        List<ItemPartRecord> parts = projectedParts.computeIfAbsent(itemId,
                key -> new ArrayList<>(partsForItem(event.tenantId(), event.sessionId(), key)));
        String partId = event.contentPartId() != null ? event.contentPartId() : parts.stream()
                .filter(part -> partType.equals(part.type()))
                .map(ItemPartRecord::partId).findFirst().orElseGet(() ->
                        EventIdentity.textPartId(event.turnId(), partType, event.sequence()));
        upsertItem(event, itemId, "message", "assistant", "in_progress",
                Map.of());
        appendPart(event, itemId, partId, partType, text, projectedParts);
    }

    void materializeTool(EventRecord event) {
        String itemId = EventIdentity.toolItemId(event.turnId(),
                event.sequence(), event.data());
        String sourceStatus = string(event.data().get("status"));
        // Protocol tokens must fold with Locale.ROOT: under a tr_TR default
        // locale "FAILED" becomes "faıled" and misses these arms.
        String status = switch (sourceStatus == null ? ""
                : sourceStatus.toLowerCase(Locale.ROOT)) {
            case "completed", "success" -> "completed";
            case "failed" -> "failed";
            case "cancelled" -> "cancelled";
            default -> "in_progress";
        };
        Map<String, Object> attributes = existingAttributes(event, itemId);
        if (attributes.get("result") instanceof Map<?, ?> previous) {
            if (!(event.data().get("result") instanceof Map<?, ?> next)
                    || number(next.get("projection_revision"))
                            <= number(previous.get("projection_revision"))) {
                return;
            }
        }
        attributes.putAll(event.data());
        attributes.remove("itemId");
        upsertItem(event, itemId, "tool_call", "assistant", status,
                Map.copyOf(attributes));
    }

    static long number(Object value) {
        return value instanceof Number numeric ? numeric.longValue() : 0;
    }

    Map<String, Object> existingAttributes(EventRecord event,
            String itemId) {
        List<String> rows = jdbc.query("SELECT attributes_json FROM"
                        + " ma_message WHERE tenant_id = ? AND"
                        + " session_id = ? AND item_id = ?",
                (result, row) -> result.getString("attributes_json"),
                event.tenantId(), event.sessionId(), itemId);
        return rows.isEmpty() ? new LinkedHashMap<>()
                : new LinkedHashMap<>(storeRows.readMap(rows.get(0)));
    }

    void settleTurnItems(EventRecord event) {
        String status = switch (event.type()) {
            case "turn.completed" -> "completed";
            case "turn.cancelled" -> "cancelled";
            default -> "failed";
        };
        jdbc.update("UPDATE ma_message SET item_status = ?,"
                        + " last_sequence = CASE WHEN last_sequence < ?"
                        + " THEN ? ELSE last_sequence END, gmt_modified = ?,"
                        + " revision = revision + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND item_status"
                        + " = 'in_progress'",
                status, event.sequence(), event.sequence(),
                event.createdAt(), event.tenantId(), event.sessionId(),
                event.turnId());
    }

    void upsertItem(EventRecord event, String itemId, String type,
            String role, String status, Map<String, Object> attributes) {
        int updated = jdbc.update("UPDATE ma_message SET"
                        + " item_status = ?, attributes_json = ?,"
                        + " last_sequence = ?, gmt_modified = ?, revision ="
                        + " revision + 1 WHERE tenant_id = ? AND session_id"
                        + " = ? AND item_id = ?",
                status, storeRows.writeJson(attributes), event.sequence(),
                event.createdAt(), event.tenantId(), event.sessionId(),
                itemId);
        if (updated == 0) {
            jdbc.update("INSERT INTO ma_message (tenant_id,"
                            + " session_id, item_id, turn_id, item_type,"
                            + " item_role, item_status, attributes_json, parts_json,"
                            + " first_sequence, last_sequence, gmt_create,"
                            + " gmt_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]',"
                            + " ?, ?, ?, ?)",
                    event.tenantId(), event.sessionId(), itemId,
                    event.turnId(), type, role, status,
                    storeRows.writeJson(attributes), event.sequence(), event.sequence(),
                    event.createdAt(), event.createdAt());
        }
    }

    void replacePart(EventRecord event, String itemId,
            String partId, String type, String text, Map<String, List<ItemPartRecord>> projectedParts) {
        changePart(event, itemId, partId, type, text, false, projectedParts);
    }

    void appendPart(EventRecord event, String itemId,
            String partId, String type, String text, Map<String, List<ItemPartRecord>> projectedParts) {
        changePart(event, itemId, partId, type, text, true, projectedParts);
    }

    void changePart(EventRecord event, String itemId, String partId,
            String type, String text, boolean append, Map<String, List<ItemPartRecord>> projectedParts) {
        List<ItemPartRecord> parts = projectedParts.computeIfAbsent(itemId,
                key -> new ArrayList<>(partsForItem(event.tenantId(), event.sessionId(), key)));
        int index = -1;
        for (int current = 0; current < parts.size(); current++) {
            if (partId.equals(parts.get(current).partId())) {
                index = current;
                break;
            }
        }
        ItemPartRecord old = index < 0 ? null : parts.get(index);
        ItemPartRecord next = new ItemPartRecord(partId, type,
                append && old != null ? old.text() + text : text,
                old == null ? event.sequence() : old.firstSequence(), event.sequence(),
                old == null ? event.createdAt() : old.createdAt(), event.createdAt(),
                old == null ? 1 : old.revision() + 1);
        if (index < 0) {
            parts.add(next);
        } else {
            parts.set(index, next);
        }
    }

    void flushParts(
            String tenantId, String sessionId, Map<String, List<ItemPartRecord>> projectedParts) {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        for (var entry : projectedParts.entrySet()) {
            String item = entry.getKey();
            byte[] bytes =
                    storeRows.writeJson(entry.getValue()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            String owner =
                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                            scope, item);
            Map<String, Object> previous =
                    jdbc.queryForMap(
                            "SELECT revision, body_resource_key FROM ma_message WHERE tenant_id = ?"
                                    + " AND session_id = ? AND item_id = ? FOR UPDATE",
                            tenantId,
                            sessionId,
                            item);
            long revision = ((Number) previous.get("revision")).longValue();
            if (previous.get("body_resource_key") != null) {
                ManagedProjectionResourceCollector.release(jdbc, scope, "MESSAGE", owner);
            }
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                            + " 'MESSAGE' AND owner_key = ?",
                    scope,
                    owner);
            String resource = null;
            if (bytes.length > 64 * 1024) {
                String digest = WorkspaceEvidenceResources.digest(bytes);
                String id = "message:" + owner + ":" + revision + ":" + digest;
                resource = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, id);
                try {
                    jdbc.update(
                            "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, ?, 'managed-message-parts', 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                            resource,
                            scope,
                            tenantId,
                            sessionId,
                            id,
                            bytes.length,
                            digest,
                            bytes);
                } catch (DuplicateKeyException duplicate) {
                    List<Boolean> matching =
                            jdbc.query(
                                    "SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE resource_key = ? FOR UPDATE",
                                    (row, index) ->
                                            scope.equals(row.getString("session_scope_key"))
                                                    && tenantId.equals(row.getString("tenant_id"))
                                                    && sessionId.equals(row.getString("session_id"))
                                                    && id.equals(row.getString("resource_id"))
                                                    && "managed-message-parts"
                                                            .equals(row.getString("kind"))
                                                    && row.getInt("schema_version") == 1
                                                    && row.getLong("byte_length") == bytes.length
                                                    && digest.equals(row.getString("sha256"))
                                                    && java.util.Arrays.equals(
                                                            bytes, row.getBytes("inline_bytes"))
                                                    && "MYSQL_INLINE"
                                                            .equals(row.getString("storage_kind"))
                                                    && "REFERENCED".equals(row.getString("state"))
                                                    && row.getString("deletion_operation_key")
                                                            == null
                                                    && row.getString("publication_id") == null
                                                    && row.getString("object_key") == null
                                                    && row.getString("object_version_id") == null
                                                    && row.getString("encryption_key_id") == null,
                                    resource);
                    if (matching.size() != 1 || !matching.getFirst()) {
                        throw new IllegalStateException(
                                "Immutable message body identity differs.", duplicate);
                    }
                }
                jdbc.update(
                        "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create) VALUES (?, 'MESSAGE', ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                        scope,
                        owner,
                        revision,
                        resource,
                        tenantId,
                        sessionId,
                        id);
            }
            int changed =
                    jdbc.update(
                            "UPDATE ma_message SET parts_json = ?, body_resource_key = ?"
                                    + " WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                            resource == null
                                    ? new String(bytes, java.nio.charset.StandardCharsets.UTF_8)
                                    : "[]",
                            resource,
                            tenantId,
                            sessionId,
                            item);
            if (changed != 1) {
                throw new IllegalStateException("Message disappeared during locked projection.");
            }
        }
    }

    List<ItemPartRecord> partsForItem(String tenantId, String sessionId, String itemId) {
        List<List<ItemPartRecord>> rows =
                jdbc.query(
                        "SELECT parts_json, body_resource_key FROM ma_message WHERE tenant_id = ?"
                                + " AND session_id = ? AND item_id = ? FOR UPDATE",
                        (row, index) -> readParts(row.getString(1), row.getString(2), tenantId, sessionId),
                        tenantId,
                        sessionId,
                        itemId);
        return rows.isEmpty() ? List.of() : rows.getFirst();
    }

    List<ItemPartRecord> readParts(String value, String resourceKey, String tenantId, String sessionId) {
        if (resourceKey == null) {
            return readParts(value);
        }
        List<byte[]> rows =
                jdbc.query(
                        "SELECT inline_bytes, byte_length, sha256 FROM ma_resource WHERE"
                            + " resource_key = ? AND session_scope_key = ? AND tenant_id = ? AND"
                            + " session_id = ? AND kind = ? AND schema_version = 1 AND state ="
                            + " 'REFERENCED' AND deletion_operation_key IS NULL",
                        (row, i) -> {
                            byte[] bytes = row.getBytes("inline_bytes");
                            if (bytes == null
                                    || bytes.length != row.getLong("byte_length")
                                    || !WorkspaceEvidenceResources.digest(bytes)
                                            .equals(row.getString("sha256"))) {
                                throw new IllegalStateException(
                                        "Message body resource digest differs.");
                            }
                            return bytes;
                        },
                        resourceKey,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        tenantId,
                        sessionId,
                        "managed-message-parts");
        if (rows.size() != 1) {
            throw new IllegalStateException("Message body resource is unavailable.");
        }
        return readParts(new String(rows.getFirst(), java.nio.charset.StandardCharsets.UTF_8));
    }

    List<ItemPartRecord> readParts(String value) {
        try {
            return value == null ? List.of() : objectMapper.readValue(value, PARTS_TYPE);
        } catch (java.io.IOException failure) {
            throw new IllegalStateException("Stored message parts are invalid.", failure);
        }
    }

    static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }

    static List<Map<String, Object>> inputData(Object value) {
        if (!(value instanceof List<?> values)) {
            return List.of();
        }
        List<Map<String, Object>> input = new ArrayList<>();
        for (Object item : values) {
            if (!(item instanceof Map<?, ?> raw)) {
                continue;
            }
            Map<String, Object> block = new LinkedHashMap<>();
            raw.forEach((key, entry) -> {
                if (key instanceof String name) {
                    block.put(name, entry);
                }
            });
            input.add(Map.copyOf(block));
        }
        return List.copyOf(input);
    }
}
