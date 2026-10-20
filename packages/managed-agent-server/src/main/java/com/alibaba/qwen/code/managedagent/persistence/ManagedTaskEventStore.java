package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Supplier;

/**
 * The bounded per-task event journal behind
 * {@code listSessionTaskEvents} and {@code queryWebShellTaskEvents} (H3 of
 * #12827). Producers write an event in the transaction that commits what
 * produces it, so a read never passes a concurrently committing event; the
 * per-task sequence is allocated under its event-stream row lock, in
 * commit order. One event is one logical cursor position, and a cursor names
 * only durable state, so identity survives restarts, projection rebuilds and
 * archival.
 *
 * <p>The durable retention floor lives in the per-task event-stream row, so it
 * survives an empty retained set. Only an oldest prefix expires, and the
 * visibility barrier pins the floor behind every output event whose full
 * text is not yet archived and discoverable; an archival failure therefore
 * loses nothing and the backlog bound refuses the next accepted event
 * instead of silently discarding one. Output events carry their segment
 * identity in the per-stream ordinal space, and appends keep the ranges
 * continuous and non-overlapping, so a {@code cursor_expired} recovery joins
 * Artifacts and events without duplication.
 */
@Repository
public class ManagedTaskEventStore {
    public static final int SCHEMA_VERSION = 1;
    public static final int PROJECTION_VERSION = 1;
    public static final int MAX_OUTPUT_CHARS = 16384;
    /** The newest unique references a task view lists; the 101st refuses. */
    public static final int ARTIFACT_REF_BOUND = 100;
    /** The expiry pass keeps this many retained rows behind every append. */
    public static final int RETAIN_TARGET = 256;
    /**
     * Retained rows a task's journal may hold; an append past the bound is a
     * refusal, which is the producer backpressure the contract requires
     * while the barrier pins the floor.
     */
    public static final int BACKLOG_BOUND = 512;
    public static final String CODE_ADMISSION_REFUSED =
            "managed_task_output_admission_refused";
    public static final String CODE_FLOOR_PINNED =
            "managed_task_event_floor_pinned";
    public static final String CODE_BACKLOG_FULL =
            "managed_task_event_backlog_full";
    public static final String CODE_SEGMENT_CONFLICT =
            "managed_task_event_segment_conflict";
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public ManagedTaskEventStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(
                java.util.Objects.requireNonNull(jdbc.getDataSource(), "dataSource")));
    }

    /** One committed task event, as the journal row holds it. */
    public record TaskEvent(long sequence, String type, long occurredAt,
            int schemaVersion, int projectionVersion, String state,
            String runtimeState, String text, Boolean truncated,
            String artifactId, String captureId, String streamId,
            Long firstOrdinal, Long endOrdinal, boolean archived) {
    }

    public record EventPage(List<TaskEvent> events, boolean hasMore) {
    }

    /**
     * The durable per-task positions: the committed tail, the retention
     * floor and the newest unique artifact references, oldest first.
     */
    public record CursorPositions(long lastSequence, long expiredThrough,
            List<String> artifactRefs) {
        static final CursorPositions EMPTY = new CursorPositions(0, 0,
                List.of());
    }

    /** Scoped durable task positions; raw identity delimiters never enter the encoding. */
    public static String encodeCursor(String tenantId, String sessionId, String taskId, long sequence) {
        if (sequence < 0) {
            throw new IllegalArgumentException("A task cursor requires a nonnegative sequence");
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("tev2:" + ManagedSchemaKeys.key(tenantId, sessionId, taskId) + ":" + sequence)
                        .getBytes(StandardCharsets.US_ASCII));
    }

    public static long decodeCursor(String tenantId, String sessionId, String taskId, String cursor) {
        if (cursor == null || cursor.length() > 128) {
            throw invalidCursor();
        }
        String decoded;
        try {
            decoded = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.US_ASCII);
        } catch (IllegalArgumentException error) {
            throw invalidCursor();
        }
        String[] parts = decoded.split(":", -1);
        if (parts.length != 3 || !"tev2".equals(parts[0])
                || !ManagedSchemaKeys.key(tenantId, sessionId, taskId).equals(parts[1])) {
            throw invalidCursor();
        }
        try {
            long position = Long.parseLong(parts[2]);
            if (position < 0) {
                throw new NumberFormatException();
            }
            return position;
        } catch (NumberFormatException error) {
            throw invalidCursor();
        }
    }

    /** Operational positions survive an empty event set and projection rebuilds. */
    public CursorPositions positions(String tenantId, String sessionId, String taskId) {
        return jdbc.query("SELECT last_sequence, replay_floor_sequence, artifact_refs_resource_key"
                        + " FROM ma_event_stream WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'TASK' AND stream_id = ?",
                (row, index) -> new CursorPositions(row.getLong("last_sequence"),
                        row.getLong("replay_floor_sequence"),
                        cursorState(tenantId, sessionId, row.getString("artifact_refs_resource_key")).artifactRefs()),
                tenantId, sessionId, taskId).stream().findFirst().orElse(CursorPositions.EMPTY);
    }

    public EventPage read(String tenantId, String sessionId, String taskId, long after, int limit) {
        List<TaskEvent> events = jdbc.query("SELECT sequence_id AS event_sequence, event_type,"
                        + " gmt_create AS occurred_at, schema_version, projection_version, state, runtime_state,"
                        + " text, truncated, artifact_id, capture_id, output_stream_id AS stream_id,"
                        + " first_ordinal, end_ordinal, archived FROM ma_public_event WHERE tenant_id = ?"
                        + " AND session_id = ? AND stream_kind = 'TASK' AND stream_id = ?"
                        + " AND sequence_id > ? ORDER BY sequence_id LIMIT ?",
                ManagedTaskEventStore::eventRow, tenantId, sessionId, taskId, after, limit + 1);
        return new EventPage(events.size() > limit ? events.subList(0, limit) : events, events.size() > limit);
    }

    public void appendStateChange(String tenantId, String sessionId, String taskId, String state,
            String runtimeState, long occurredAt) {
        transaction(() -> {
            lockStream(tenantId, sessionId, taskId, occurredAt);
            long sequence = advance(tenantId, sessionId, taskId);
            jdbc.update("INSERT INTO ma_public_event (tenant_id,session_id,stream_kind,stream_id,sequence_id,"
                            + "event_id,event_type,gmt_create,schema_version,projection_version,state,runtime_state)"
                            + " VALUES (?,?,'TASK',?,?,?,'state_changed',?,?,?,?,?)",
                    tenantId, sessionId, taskId, sequence, eventId(tenantId, sessionId, taskId, sequence),
                    occurredAt, SCHEMA_VERSION, PROJECTION_VERSION, state, runtimeState);
            expireBeyondRetain(tenantId, sessionId, taskId);
            return null;
        });
    }

    /** Segment ends are cursor facts, so expiry cannot make a duplicate segment admissible. */
    public long appendOutput(String tenantId, String sessionId, String taskId, String text, boolean truncated,
            String captureId, String streamId, Long firstOrdinal, Long endOrdinal, long occurredAt) {
        return transaction(() -> {
            requireOutputAdmission(tenantId, sessionId);
            int length = text == null ? 0 : text.codePointCount(0, text.length());
            if (length < 1 || length > MAX_OUTPUT_CHARS) {
                throw conflict(CODE_SEGMENT_CONFLICT, "An output chunk must fit the task event bound.");
            }
            boolean segmented = captureId != null;
            if (segmented != (streamId != null) || segmented != (firstOrdinal != null)
                    || segmented != (endOrdinal != null) || segmented && (firstOrdinal < 0 || endOrdinal <= firstOrdinal)) {
                throw conflict(CODE_SEGMENT_CONFLICT, "The segment identity must name one nonnegative half-open range.");
            }
            lockStream(tenantId, sessionId, taskId, occurredAt);
            CursorState cursor = state(tenantId, sessionId, taskId);
            String streamKey = segmented ? ManagedSchemaKeys.key(captureId, streamId) : null;
            Long published = streamKey == null ? null : cursor.outputEnds().get(streamKey);
            if (published != null && published.longValue() != firstOrdinal) {
                throw conflict(CODE_SEGMENT_CONFLICT, "The output range overlaps or leaves a gap.");
            }
            long sequence = advance(tenantId, sessionId, taskId);
            if (segmented) {
                Map<String, Long> ends = new TreeMap<>(cursor.outputEnds());
                ends.put(streamKey, endOrdinal);
                ObjectNode ranges = JSON.createObjectNode();
                ends.forEach(ranges::put);
                jdbc.update("UPDATE ma_event_stream SET output_ranges_json = ?, gmt_modified = ? WHERE tenant_id = ?"
                                + " AND session_id = ? AND stream_kind = 'TASK' AND stream_id = ?",
                        ranges.toString(), occurredAt, tenantId, sessionId, taskId);
            }
            jdbc.update("INSERT INTO ma_public_event (tenant_id,session_id,stream_kind,stream_id,sequence_id,"
                            + "event_id,event_type,gmt_create,schema_version,projection_version,text,truncated,capture_id,"
                            + "output_stream_id,first_ordinal,end_ordinal) VALUES (?,?,'TASK',?,?,?,'output',?,?,?,?,?,?,?,?,?)",
                    tenantId, sessionId, taskId, sequence, eventId(tenantId, sessionId, taskId, sequence),
                    occurredAt, SCHEMA_VERSION, PROJECTION_VERSION, text, truncated,
                    captureId, streamId, firstOrdinal, endOrdinal);
            expireBeyondRetain(tenantId, sessionId, taskId);
            return sequence;
        });
    }

    public long appendArtifact(String tenantId, String sessionId, String taskId, String artifactId, long occurredAt) {
        return transaction(() -> {
            requireOutputAdmission(tenantId, sessionId);
            lockStream(tenantId, sessionId, taskId, occurredAt);
            CursorState cursor = state(tenantId, sessionId, taskId);
            if (cursor.artifactRefs().contains(artifactId)) {
                throw conflict(CODE_ADMISSION_REFUSED, "The task already references the Artifact.");
            }
            if (cursor.artifactRefs().size() >= ARTIFACT_REF_BOUND) {
                throw conflict(CODE_ADMISSION_REFUSED, "The task's Artifact references reached their bound.");
            }
            List<String> refs = new ArrayList<>(cursor.artifactRefs());
            refs.add(artifactId);
            long sequence = advance(tenantId, sessionId, taskId);
            publishCursorState(tenantId, sessionId, taskId, sequence,
                    new CursorState(refs, cursor.outputEnds()), occurredAt);
            jdbc.update("INSERT INTO ma_public_event (tenant_id,session_id,stream_kind,stream_id,sequence_id,"
                            + "event_id,event_type,gmt_create,schema_version,projection_version,artifact_id)"
                            + " VALUES (?,?,'TASK',?,?,?,'artifact',?,?,?,?)",
                    tenantId, sessionId, taskId, sequence, eventId(tenantId, sessionId, taskId, sequence),
                    occurredAt, SCHEMA_VERSION, PROJECTION_VERSION, artifactId);
            expireBeyondRetain(tenantId, sessionId, taskId);
            return sequence;
        });
    }

    public int markOutputArchived(String tenantId, String sessionId, String taskId, long throughSequence) {
        return transaction(() -> {
            lockStream(tenantId, sessionId, taskId, 0);
            return jdbc.update("UPDATE ma_public_event SET archived = TRUE WHERE tenant_id = ? AND session_id = ?"
                            + " AND stream_kind = 'TASK' AND stream_id = ? AND event_type = 'output'"
                            + " AND archived = FALSE AND sequence_id <= ?",
                    tenantId, sessionId, taskId, throughSequence);
        });
    }

    /** Floor movement and prefix deletion share the stream lock and the producer transaction. */
    public long expireThrough(String tenantId, String sessionId, String taskId, long throughSequence) {
        return transaction(() -> {
            lockStream(tenantId, sessionId, taskId, 0);
            CursorPositions positions = positions(tenantId, sessionId, taskId);
            long through = Math.min(throughSequence, positions.lastSequence());
            if (through <= positions.expiredThrough()) {
                return positions.expiredThrough();
            }
            Long pinned = oldestUnarchived(tenantId, sessionId, taskId);
            if (pinned != null && through >= pinned) {
                throw conflict(CODE_FLOOR_PINNED, "An unarchived output event pins the retention floor.");
            }
            jdbc.update("DELETE FROM ma_public_event WHERE tenant_id = ? AND session_id = ?"
                            + " AND stream_kind = 'TASK' AND stream_id = ? AND sequence_id <= ?",
                    tenantId, sessionId, taskId, through);
            jdbc.update("UPDATE ma_event_stream SET replay_floor_sequence = ? WHERE tenant_id = ? AND session_id = ?"
                            + " AND stream_kind = 'TASK' AND stream_id = ?",
                    through, tenantId, sessionId, taskId);
            return through;
        });
    }

    private void lockStream(String tenantId, String sessionId, String taskId, long occurredAt) {
        jdbc.update("INSERT INTO ma_event_stream (tenant_id,session_id,stream_kind,stream_id,gmt_modified)"
                        + " VALUES (?,?,'TASK',?,?) ON DUPLICATE KEY UPDATE stream_id = stream_id",
                tenantId, sessionId, taskId, occurredAt);
        jdbc.queryForObject("SELECT last_sequence FROM ma_event_stream WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'TASK' AND stream_id = ? FOR UPDATE",
                Long.class, tenantId, sessionId, taskId);
    }

    private long advance(String tenantId, String sessionId, String taskId) {
        CursorPositions positions = positions(tenantId, sessionId, taskId);
        if (positions.lastSequence() - positions.expiredThrough() >= BACKLOG_BOUND) {
            throw conflict(CODE_BACKLOG_FULL, "The retained task event backlog reached its bound.");
        }
        long sequence = positions.lastSequence() + 1;
        jdbc.update("UPDATE ma_event_stream SET last_sequence = ? WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'TASK' AND stream_id = ?",
                sequence, tenantId, sessionId, taskId);
        return sequence;
    }

    private void expireBeyondRetain(String tenantId, String sessionId, String taskId) {
        CursorPositions positions = positions(tenantId, sessionId, taskId);
        long through = positions.lastSequence() - RETAIN_TARGET;
        Long pinned = oldestUnarchived(tenantId, sessionId, taskId);
        if (pinned != null) {
            through = Math.min(through, pinned - 1);
        }
        if (through > positions.expiredThrough()) {
            expireThrough(tenantId, sessionId, taskId, through);
        }
    }

    private Long oldestUnarchived(String tenantId, String sessionId, String taskId) {
        return jdbc.queryForObject("SELECT MIN(sequence_id) FROM ma_public_event WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'TASK' AND stream_id = ? AND event_type = 'output' AND archived = FALSE",
                Long.class, tenantId, sessionId, taskId);
    }

    private record CursorState(List<String> artifactRefs, Map<String, Long> outputEnds) {
        private CursorState {
            artifactRefs = List.copyOf(artifactRefs);
            outputEnds = Map.copyOf(outputEnds);
        }
    }

    private CursorState state(String tenantId, String sessionId, String taskId) {
        return jdbc.query("SELECT artifact_refs_resource_key,output_ranges_json FROM ma_event_stream"
                        + " WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'TASK' AND stream_id = ?",
                (row, index) -> {
                    Map<String, Long> ends = new TreeMap<>();
                    String encoded = row.getString("output_ranges_json");
                    if (encoded != null) {
                        try {
                            JsonNode ranges = JSON.readTree(encoded);
                            if (!ranges.isObject()) {
                                throw new IllegalStateException("The task's output range cursor is corrupt");
                            }
                            ranges.fields().forEachRemaining(entry -> {
                                if (!entry.getValue().isIntegralNumber() || !entry.getValue().canConvertToLong()
                                        || entry.getValue().longValue() < 0) {
                                    throw new IllegalStateException("The task's output range cursor is corrupt");
                                }
                                ends.put(entry.getKey(), entry.getValue().longValue());
                            });
                        } catch (java.io.IOException exception) {
                            throw new IllegalStateException("The task's output range cursor is corrupt", exception);
                        }
                    }
                    return new CursorState(cursorState(tenantId, sessionId,
                            row.getString("artifact_refs_resource_key")).artifactRefs(), ends);
                }, tenantId, sessionId, taskId).getFirst();
    }

    private CursorState cursorState(String tenantId, String sessionId, String resourceKey) {
        if (resourceKey == null) {
            return new CursorState(List.of(), Map.of());
        }
        return jdbc.query("SELECT inline_bytes,sha256,byte_length FROM ma_resource WHERE resource_key = ?"
                        + " AND session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE' AND state = 'REFERENCED' AND kind = ? AND schema_version = 1",
                (row, index) -> {
                    byte[] bytes = row.getBytes("inline_bytes");
                    if (bytes == null || bytes.length != row.getLong("byte_length")
                            || !ToolPublicationContract.sha256(bytes).equals(row.getString("sha256"))) {
                        throw new IllegalStateException("The task cursor resource failed integrity validation");
                    }
                    try {
                        JsonNode node = JSON.readTree(bytes);
                        if (node.path("schemaVersion").asInt() != 1 || !node.path("artifactRefs").isArray()) {
                            throw new IllegalStateException("The task cursor resource has an unsupported shape");
                        }
                        List<String> refs = new ArrayList<>();
                        node.path("artifactRefs").forEach(ref -> refs.add(ref.textValue()));
                        return new CursorState(refs, Map.of());
                    } catch (java.io.IOException exception) {
                        throw new IllegalStateException("The task cursor resource is corrupt", exception);
                    }
                }, resourceKey, ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId, "task-artifact-refs/1")
                .stream().findFirst().orElseThrow(() -> new IllegalStateException("The task cursor resource is missing"));
    }

    private void publishCursorState(String tenantId, String sessionId, String taskId, long revision,
            CursorState state, long occurredAt) {
        ObjectNode body = JSON.createObjectNode().put("schemaVersion", 1);
        state.artifactRefs().forEach(body.putArray("artifactRefs")::add);
        if (!body.has("artifactRefs")) {
            body.putArray("artifactRefs");
        }
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String digest = ToolPublicationContract.sha256(bytes);
        String resourceId = "task-cursor:" + ManagedSchemaKeys.key(taskId, digest);
        String resourceKey = ManagedSchemaKeys.key(scope, resourceId);
        String ownerKey = ManagedSchemaKeys.key(scope, "TASK", taskId);
        String workspace = jdbc.queryForObject("SELECT workspace_id FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenantId, sessionId);
        jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,session_id,resource_id,kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create) VALUES (?,?,?,?,?,?,'task-artifact-refs/1',1,?,?,'MYSQL_INLINE',?,'REFERENCED'," + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE resource_key = resource_key",
                resourceKey, scope, tenantId, workspace, sessionId, resourceId, bytes.length, digest, bytes);
        Boolean same = jdbc.queryForObject("SELECT inline_bytes,sha256,byte_length,kind,schema_version,state FROM ma_resource"
                        + " WHERE resource_key = ? AND session_scope_key = ? AND tenant_id = ? AND session_id = ?",
                (row, index) -> java.util.Arrays.equals(bytes, row.getBytes("inline_bytes"))
                        && digest.equals(row.getString("sha256")) && bytes.length == row.getLong("byte_length")
                        && "task-artifact-refs/1".equals(row.getString("kind")) && row.getInt("schema_version") == 1
                        && "REFERENCED".equals(row.getString("state")),
                resourceKey, scope, tenantId, sessionId);
        if (!Boolean.TRUE.equals(same)) {
            throw new IllegalStateException("The task Artifact reference resource identity conflicts");
        }
        jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = 'EVENT_STREAM' AND owner_key = ?",
                scope, ownerKey);
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key,owner_kind,owner_key,owner_revision,resource_key,tenant_id,workspace_id,session_id,gmt_create) VALUES (?,'EVENT_STREAM',?,?,?,?,?,?," + ManagedSchemaTime.SQL_NOW + ")",
                scope, ownerKey, revision, resourceKey, tenantId, workspace, sessionId);
        jdbc.update("UPDATE ma_event_stream SET artifact_refs_resource_key = ?, gmt_modified = ? WHERE tenant_id = ?"
                        + " AND session_id = ? AND stream_kind = 'TASK' AND stream_id = ?",
                resourceKey, occurredAt, tenantId, sessionId, taskId);
    }

    private void requireOutputAdmission(String tenantId, String sessionId) {
        record Shape(String workspaceId, String status, Long retiredAt) {
        }
        Shape session = jdbc.query("SELECT workspace_id,status,retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                (row, index) -> new Shape(row.getString("workspace_id"), row.getString("status"),
                        row.getObject("retired_at", Long.class)), tenantId, sessionId).stream().findFirst()
                .orElseThrow(() -> conflict(CODE_ADMISSION_REFUSED, "The Session does not serve task output."));
        if (session.workspaceId() == null || session.retiredAt() != null
                || "DELETING".equals(session.status()) || "DELETED".equals(session.status())) {
            throw conflict(CODE_ADMISSION_REFUSED, "The Session does not serve task output.");
        }
    }

    private <T> T transaction(Supplier<T> action) {
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            return action.get();
        }
        return transactions.execute(status -> action.get());
    }

    private static String eventId(String tenantId, String sessionId, String taskId, long sequence) {
        return ManagedSchemaKeys.key("task-event", tenantId, sessionId, taskId, Long.toString(sequence));
    }

    private static ManagedAgentException conflict(String code, String message) {
        return new ManagedAgentException(HttpStatus.CONFLICT, code, message);
    }

    private static TaskEvent eventRow(ResultSet result, int row) throws SQLException {
        return new TaskEvent(result.getLong("event_sequence"), result.getString("event_type"),
                result.getLong("occurred_at"), result.getInt("schema_version"), result.getInt("projection_version"),
                result.getString("state"), result.getString("runtime_state"), result.getString("text"),
                result.getObject("truncated", Boolean.class), result.getString("artifact_id"),
                result.getString("capture_id"), result.getString("stream_id"), result.getObject("first_ordinal", Long.class),
                result.getObject("end_ordinal", Long.class), result.getBoolean("archived"));
    }

    private static ManagedAgentException invalidCursor() {
        return new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_event_cursor", "The task event cursor is invalid.");
    }
}
