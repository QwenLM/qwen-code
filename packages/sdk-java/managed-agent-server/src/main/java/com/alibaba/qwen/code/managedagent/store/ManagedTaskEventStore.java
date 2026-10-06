package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The bounded per-task event journal behind
 * {@code listSessionTaskEvents} and {@code queryWebShellTaskEvents} (H3 of
 * #12827). Producers write an event in the transaction that commits what
 * produces it, so a read never passes a concurrently committing event; the
 * per-task sequence is allocated under the Session's journal head lock, in
 * commit order. One event is one logical cursor position, and a cursor names
 * only durable state, so identity survives restarts, projection rebuilds and
 * archival.
 *
 * <p>The durable retention floor lives in the per-task cursor row, so it
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

    public ManagedTaskEventStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
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

    /**
     * The opaque cursor naming the position after {@code sequence}. It
     * encodes only the task and the position, so any rebuild derives the
     * identical string.
     */
    public static String encodeCursor(String taskId, long sequence) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("tev1:" + taskId + ":" + sequence).getBytes(
                        StandardCharsets.UTF_8));
    }

    /**
     * The position a cursor names for this task.
     *
     * @throws ApiException {@code 400 invalid_event_cursor} when the cursor
     *         is malformed or belongs to another task
     */
    public static long decodeCursor(String expectedTaskId, String cursor) {
        String decoded;
        try {
            decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            throw invalidCursor();
        }
        String[] parts = decoded.split(":");
        if (parts.length != 3 || !"tev1".equals(parts[0])
                || !expectedTaskId.equals(parts[1])) {
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

    /** Reads the durable positions of a task that has no cursor row. */
    public CursorPositions positions(String tenantId, String sessionId,
            String taskId) {
        return jdbc.query("SELECT last_sequence, expired_through,"
                        + " artifact_refs FROM qwen_managed_session_task_journal_cursor"
                        + " WHERE session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?",
                (result, row) -> new CursorPositions(
                        result.getLong("last_sequence"),
                        result.getLong("expired_through"),
                        refs(result.getString("artifact_refs"))),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId).stream().findFirst()
                .orElse(CursorPositions.EMPTY);
    }

    /**
     * Reads the retained events strictly after {@code after}, oldest first.
     * The caller resolves the floor itself, so an omitted {@code after} and
     * an explicit cursor share this one path.
     */
    public EventPage read(String tenantId, String sessionId, String taskId,
            long after, int limit) {
        List<TaskEvent> events = jdbc.query("SELECT * FROM"
                        + " qwen_managed_session_task_journal WHERE"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?"
                        + " AND event_sequence > ?"
                        + " ORDER BY event_sequence LIMIT ?",
                ManagedTaskEventStore::eventRow,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId, after, limit + 1);
        boolean hasMore = events.size() > limit;
        return new EventPage(hasMore ? events.subList(0, limit) : events,
                hasMore);
    }

    /**
     * Journals a task view change, from the record revision that commits it.
     * A revision that changes nothing observable produces no event.
     */
    public void appendStateChange(String tenantId, String sessionId,
            String taskId, String state, String runtimeState,
            long occurredAt) {
        long sequence = advance(tenantId, sessionId, taskId);
        jdbc.update("INSERT INTO qwen_managed_session_task_journal"
                        + " (session_scope_key, tenant_id, session_id,"
                        + " task_id, event_sequence, event_type,"
                        + " occurred_at, schema_version, projection_version,"
                        + " state, runtime_state) VALUES"
                        + " (?, ?, ?, ?, ?, 'state_changed', ?, ?, ?, ?, ?)",
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId, sequence, occurredAt,
                SCHEMA_VERSION, PROJECTION_VERSION, state, runtimeState);
        expireBeyondRetain(tenantId, sessionId, taskId);
    }

    /**
     * Journals a chunk of durable task output. Output requires the Session
     * to serve artifacts (the durable half of {@code
     * capabilities.artifacts}: workspace-bound and not being deleted),
     * because its own expiry and every later event's waits on archival. The
     * segment identity, when given, must continue the stream's published
     * ranges exactly: an overlapping or duplicated range is a refusal, so a
     * recovered reader never joins the same output twice. The event is
     * accepted unarchived; {@link #markOutputArchived} lifts its barrier
     * once the full text is durably readable and discoverable.
     */
    public long appendOutput(String tenantId, String sessionId, String taskId,
            String text, boolean truncated, String captureId, String streamId,
            Long firstOrdinal, Long endOrdinal, long occurredAt) {
        requireOutputAdmission(tenantId, sessionId);
        int length = text == null ? 0 : text.codePointCount(0, text.length());
        if (length < 1 || length > MAX_OUTPUT_CHARS) {
            throw new ApiException(HttpStatus.CONFLICT, CODE_SEGMENT_CONFLICT,
                    "An output event chunk holds 1 to " + MAX_OUTPUT_CHARS
                            + " characters.");
        }
        boolean segmented = captureId != null;
        if (segmented != (streamId != null)
                || segmented != (firstOrdinal != null)
                || segmented != (endOrdinal != null)
                || segmented && endOrdinal <= firstOrdinal) {
            throw new ApiException(HttpStatus.CONFLICT, CODE_SEGMENT_CONFLICT,
                    "An output event's segment identity is all or nothing,"
                            + " and its range is half-open.");
        }
        if (segmented) {
            Long published = jdbc.queryForObject("SELECT MAX(end_ordinal)"
                            + " FROM qwen_managed_session_task_journal WHERE"
                            + " session_scope_key = ? AND tenant_id = ?"
                            + " AND session_id = ? AND task_id = ?"
                            + " AND capture_id = ? AND stream_id = ?",
                    Long.class,
                    ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                    tenantId, sessionId, taskId, captureId, streamId);
            if (published != null && published.longValue() != firstOrdinal) {
                throw new ApiException(HttpStatus.CONFLICT,
                        CODE_SEGMENT_CONFLICT,
                        "The segment range overlaps or leaves a gap against"
                                + " the published ordinal space.");
            }
        }
        long sequence = advance(tenantId, sessionId, taskId);
        jdbc.update("INSERT INTO qwen_managed_session_task_journal"
                        + " (session_scope_key, tenant_id, session_id,"
                        + " task_id, event_sequence, event_type,"
                        + " occurred_at, schema_version, projection_version,"
                        + " text, truncated, capture_id, stream_id,"
                        + " first_ordinal, end_ordinal) VALUES"
                        + " (?, ?, ?, ?, ?, 'output', ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, ?)",
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId, sequence, occurredAt,
                SCHEMA_VERSION, PROJECTION_VERSION, text, truncated,
                captureId, streamId, firstOrdinal, endOrdinal);
        expireBeyondRetain(tenantId, sessionId, taskId);
        return sequence;
    }

    /**
     * Journals the first visibility of an output Artifact on the task. The
     * reference joins the view's newest unique hundred; a duplicate or a
     * 101st is a refusal, so no reference ever ages out silently.
     */
    public long appendArtifact(String tenantId, String sessionId,
            String taskId, String artifactId, long occurredAt) {
        requireOutputAdmission(tenantId, sessionId);
        // The ref list moves by compare-and-set on its snapshot: two
        // writers that read the same list see only one's row count change,
        // the other retries against what actually stands — a lost-write
        // can never age an Artifact out while its event lives below.
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            RefsView view = artifactRefsOf(tenantId, sessionId, taskId);
            if (view.refs().contains(artifactId)) {
                throw new ApiException(HttpStatus.CONFLICT,
                        CODE_ADMISSION_REFUSED,
                        "The task already references Artifact " + artifactId
                                + ".");
            }
            if (view.refs().size() >= ARTIFACT_REF_BOUND) {
                throw new ApiException(HttpStatus.CONFLICT,
                        CODE_ADMISSION_REFUSED,
                        "The task already references " + ARTIFACT_REF_BOUND
                                + " Artifacts; rotating past the bound is a"
                                + " refusal, never a silent eviction.");
            }
            ArrayNode refs = JSON.createArrayNode();
            view.refs().forEach(refs::add);
            refs.add(artifactId);
            String next = refs.toString();
            if (view.text() == null) {
                try {
                    jdbc.update("INSERT INTO"
                                    + " qwen_managed_session_task_journal_cursor"
                                    + " (session_scope_key, tenant_id, session_id,"
                                    + " task_id, last_sequence, artifact_refs)"
                                    + " VALUES (?, ?, ?, ?, 0, ?)",
                            ManagedSessionStore.sessionScopeKey(tenantId,
                                    sessionId),
                            tenantId, sessionId, taskId, next);
                } catch (DuplicateKeyException raced) {
                    continue;
                }
                break;
            }
            int updated = jdbc.update("UPDATE"
                            + " qwen_managed_session_task_journal_cursor"
                            + " SET artifact_refs = ? WHERE session_scope_key = ?"
                            + " AND tenant_id = ? AND session_id = ?"
                            + " AND task_id = ? AND artifact_refs = ?",
                    next, ManagedSessionStore.sessionScopeKey(tenantId,
                            sessionId),
                    tenantId, sessionId, taskId, view.text());
            if (updated == 1) {
                break;
            }
            if (attempt + 1 == MAX_CAS_ATTEMPTS) {
                throw new ApiException(HttpStatus.CONFLICT,
                        CODE_ADMISSION_REFUSED,
                        "The task's artifact references changed concurrently;"
                                + " retry the whole append.");
            }
        }
        long sequence = advance(tenantId, sessionId, taskId);
        jdbc.update("INSERT INTO qwen_managed_session_task_journal"
                        + " (session_scope_key, tenant_id, session_id,"
                        + " task_id, event_sequence, event_type,"
                        + " occurred_at, schema_version, projection_version,"
                        + " artifact_id) VALUES (?, ?, ?, ?, ?, 'artifact',"
                        + " ?, ?, ?, ?)",
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId, sequence, occurredAt,
                SCHEMA_VERSION, PROJECTION_VERSION, artifactId);
        expireBeyondRetain(tenantId, sessionId, taskId);
        return sequence;
    }

    /**
     * Marks every output event through {@code throughSequence} archived: its
     * full text is durably readable in an Artifact and discoverable through
     * the task view's references. Only this call lets the floor cross them.
     */
    public int markOutputArchived(String tenantId, String sessionId,
            String taskId, long throughSequence) {
        return jdbc.update("UPDATE qwen_managed_session_task_journal SET"
                        + " archived = 1 WHERE session_scope_key = ?"
                        + " AND tenant_id = ? AND session_id = ?"
                        + " AND task_id = ? AND event_type = 'output'"
                        + " AND archived = 0 AND event_sequence <= ?",
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId, throughSequence);
    }

    /**
     * Expires the retained prefix through {@code throughSequence} and raises
     * the durable floor to it. An expiry at or below the floor is a no-op.
     * The request may not cross an output event whose full text is not
     * archived, because that event and every later one hold their expiry
     * until archival; crossing is a refusal, so an archival failure pins the
     * floor and loses nothing. The floor survives the retained set emptying.
     */
    public long expireThrough(String tenantId, String sessionId, String taskId,
            long throughSequence) {
        CursorPositions positions = positions(tenantId, sessionId, taskId);
        if (throughSequence <= positions.expiredThrough()) {
            return positions.expiredThrough();
        }
        if (throughSequence > positions.lastSequence()) {
            throughSequence = positions.lastSequence();
        }
        Long pinned = jdbc.queryForObject("SELECT MIN(event_sequence) FROM"
                        + " qwen_managed_session_task_journal WHERE"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?"
                        + " AND event_type = 'output' AND archived = 0",
                Long.class,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId);
        if (pinned != null && throughSequence >= pinned) {
            throw new ApiException(HttpStatus.CONFLICT, CODE_FLOOR_PINNED,
                    "An unarchived output event at sequence " + pinned
                            + " holds back its own and every later event's"
                            + " expiry.");
        }
        String scopeKey = ManagedSessionStore.sessionScopeKey(tenantId,
                sessionId);
        jdbc.update("DELETE FROM qwen_managed_session_task_journal WHERE"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?"
                        + " AND event_sequence <= ?",
                scopeKey, tenantId, sessionId, taskId, throughSequence);
        jdbc.update("UPDATE qwen_managed_session_task_journal_cursor SET"
                        + " expired_through = ? WHERE session_scope_key = ?"
                        + " AND tenant_id = ? AND session_id = ?"
                        + " AND task_id = ?",
                throughSequence, scopeKey, tenantId, sessionId, taskId);
        return throughSequence;
    }

    /** Allocates the task's next committed sequence, in commit order. */
    private long advance(String tenantId, String sessionId, String taskId) {
        String scopeKey = ManagedSessionStore.sessionScopeKey(tenantId,
                sessionId);
        CursorPositions positions = positions(tenantId, sessionId, taskId);
        if (positions.lastSequence() >= positions.expiredThrough()
                + BACKLOG_BOUND) {
            throw new ApiException(HttpStatus.CONFLICT, CODE_BACKLOG_FULL,
                    "The task's event journal holds " + BACKLOG_BOUND
                            + " retained events; the next event is refused"
                            + " rather than accepted and lost.");
        }
        int updated = jdbc.update(
                "UPDATE qwen_managed_session_task_journal_cursor SET"
                        + " last_sequence = last_sequence + 1 WHERE"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?",
                scopeKey, tenantId, sessionId, taskId);
        if (updated == 0) {
            try {
                jdbc.update("INSERT INTO"
                                + " qwen_managed_session_task_journal_cursor"
                                + " (session_scope_key, tenant_id, session_id,"
                                + " task_id, last_sequence, artifact_refs)"
                                + " VALUES (?, ?, ?, ?, 1, '[]')",
                        scopeKey, tenantId, sessionId, taskId);
            } catch (DuplicateKeyException raced) {
                jdbc.update("UPDATE qwen_managed_session_task_journal_cursor"
                                + " SET last_sequence = last_sequence + 1"
                                + " WHERE session_scope_key = ?"
                                + " AND tenant_id = ? AND session_id = ?"
                                + " AND task_id = ?",
                        scopeKey, tenantId, sessionId, taskId);
            }
        }
        Long sequence = jdbc.queryForObject("SELECT last_sequence FROM"
                        + " qwen_managed_session_task_journal_cursor"
                        + " WHERE session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?",
                Long.class, scopeKey, tenantId, sessionId, taskId);
        if (sequence == null) {
            throw new IllegalStateException(
                    "The task's journal cursor row vanished mid-commit.");
        }
        return sequence;
    }

    /**
     * The automatic retention pass behind every append: only the rows over
     * the retain target expire, and only as far as the barrier allows, so a
     * non-output journal stays bounded on its own and a pinned floor simply
     * stops the pass until archival catches up.
     */
    private void expireBeyondRetain(String tenantId, String sessionId,
            String taskId) {
        CursorPositions positions = positions(tenantId, sessionId, taskId);
        long retained = positions.lastSequence() - positions.expiredThrough();
        if (retained <= RETAIN_TARGET) {
            return;
        }
        long through = positions.lastSequence() - RETAIN_TARGET;
        Long pinned = jdbc.queryForObject("SELECT MIN(event_sequence) FROM"
                        + " qwen_managed_session_task_journal WHERE"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?"
                        + " AND event_type = 'output' AND archived = 0",
                Long.class,
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId);
        if (pinned != null && through >= pinned) {
            through = pinned - 1;
        }
        if (through > positions.expiredThrough()) {
            expireThrough(tenantId, sessionId, taskId, through);
        }
    }

    /**
     * The durable half of the task output admission gate: output-producing
     * flows require the Session to serve artifacts, which its durable row
     * narrows to workspace-bound and not being deleted.
     */
    private void requireOutputAdmission(String tenantId, String sessionId) {
        record SessionShape(String workspaceId, String status) {
        }
        SessionShape session = jdbc.query("SELECT workspace_id, status FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
                        + " AND session_id = ?",
                (result, row) -> new SessionShape(
                        result.getString("workspace_id"),
                        result.getString("status")),
                tenantId, sessionId).stream().findFirst()
                .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT,
                        CODE_ADMISSION_REFUSED,
                        "The Session does not serve task output."));
        if (session.workspaceId() == null
                || "DELETING".equals(session.status())
                || "DELETED".equals(session.status())) {
            throw new ApiException(HttpStatus.CONFLICT, CODE_ADMISSION_REFUSED,
                    "A Session without capabilities.artifacts admits no"
                            + " output-producing task flow.");
        }
    }

    private static final int MAX_CAS_ATTEMPTS = 5;

    /** The raw artifact reference list and its exact stored text, which is
     * what a compare-and-set must match byte for byte. */
    private record RefsView(List<String> refs, String text) {
    }

    private RefsView artifactRefsOf(String tenantId, String sessionId,
            String taskId) {
        return jdbc.query("SELECT artifact_refs FROM"
                        + " qwen_managed_session_task_journal_cursor"
                        + " WHERE session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?",
                (result, row) -> new RefsView(
                        refs(result.getString("artifact_refs")),
                        result.getString("artifact_refs")),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, taskId).stream().findFirst()
                .orElse(new RefsView(List.of(), null));
    }

    private static List<String> refs(String json) {
        try {
            JsonNode node = JSON.readTree(json);
            List<String> refs = new ArrayList<>();
            if (node.isArray()) {
                node.forEach(ref -> refs.add(ref.asText()));
            }
            return List.copyOf(refs);
        } catch (Exception error) {
            throw new IllegalStateException(
                    "The task's journal cursor references are corrupt.",
                    error);
        }
    }

    private static TaskEvent eventRow(ResultSet result, int row)
            throws SQLException {
        return new TaskEvent(result.getLong("event_sequence"),
                result.getString("event_type"), result.getLong("occurred_at"),
                result.getInt("schema_version"),
                result.getInt("projection_version"),
                result.getString("state"), result.getString("runtime_state"),
                result.getString("text"),
                result.getObject("truncated", Boolean.class),
                result.getString("artifact_id"),
                result.getString("capture_id"), result.getString("stream_id"),
                result.getObject("first_ordinal", Long.class),
                result.getObject("end_ordinal", Long.class),
                result.getBoolean("archived"));
    }

    private static ApiException invalidCursor() {
        return new ApiException(HttpStatus.BAD_REQUEST,
                "invalid_event_cursor",
                "The task event cursor is invalid.");
    }
}
