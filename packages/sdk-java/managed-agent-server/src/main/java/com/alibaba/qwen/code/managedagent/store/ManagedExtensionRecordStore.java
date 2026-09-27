package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.Body;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The Stage H records of each Managed Session, kept by the Session store in
 * the transaction that commits them: the latest revision of every record,
 * its SessionTaskView projection and its delivery line, which is the outbox.
 * A revision the shared contract refuses fails the whole commit, so the
 * control plane never holds a record that the Session authority could not
 * have committed.
 */
@Repository
public class ManagedExtensionRecordStore {
    public static final String ERROR_REJECTED =
            "managed_session_extension_record_rejected";
    private static final String EVENT_SUBTYPE = "managed_session_event_v1";
    private static final String COMMIT_SUBTYPE = "managed_session_commit_v1";
    private static final Set<String> EVENT_FIELDS = Set.of("v", "sequence",
            "eventId", "sessionKey", "kind", "occurredAt", "payload");
    private static final Pattern TASK_ID = Pattern.compile(
            "^task_([0-9a-f]{64})$");
    private static final long MAX_TIME = 8_640_000_000_000_000L;
    private static final Set<String> SESSION_KEY_FIELDS = Set.of("tenantId",
            "workspaceId", "sessionId");
    private static final Set<String> PAYLOAD_FIELDS = Set.of("domain",
            "version", "operationId", "recordRef");
    // Parses as strictly as the Session authority does, so the store never
    // accepts a line or a body the authority could not read back.
    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private final JdbcTemplate jdbc;
    private final AgentStateStore sessions;

    @Autowired
    public ManagedExtensionRecordStore(JdbcTemplate jdbc,
            AgentStateStore sessions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
    }

    /** A store beside no public Session table, which announces nothing. */
    ManagedExtensionRecordStore(JdbcTemplate jdbc) {
        this(jdbc, null);
    }

    public record TaskRow(String taskId, String kind,
            TaskProjection projection) {
    }

    public record TaskPage(List<TaskRow> tasks, boolean hasMore) {
    }

    /**
     * Applies the Stage H revisions that one journal transaction carries.
     * It runs inside the Session store's commit, after the transaction's
     * resources are stored, so {@code resources} reads each body verified.
     * A Stage H event must hold its declared place among the transaction's
     * {@code eventCount} events, and the transaction must end with its
     * commit marker, as the authority's reader requires.
     */
    void apply(String tenantId, String workspaceId, String sessionId,
            long firstSequence, int eventCount, byte[] recordBytes,
            Function<String, StoredResource> resources) {
        String[] lines = new String(recordBytes, StandardCharsets.UTF_8)
                .split("\n");
        boolean applied = false;
        String lastSubtype = null;
        for (int index = 0; index < lines.length; index++) {
            JsonNode record = read(lines[index], "journal record");
            lastSubtype = record.path("subtype").textValue();
            if (!EVENT_SUBTYPE.equals(lastSubtype)) {
                continue;
            }
            JsonNode event = record.path("managedSession");
            JsonNode payload = event.path("payload");
            if (!"domain.committed".equals(event.path("kind").textValue())) {
                continue;
            }
            String domain = payload.path("domain").textValue();
            Body body = domain == null ? null
                    : ManagedExtensionProjection.RECORD_BODIES.get(domain);
            if (body != null) {
                require(index < eventCount, "The Stage H record event is not"
                        + " one of the transaction's events.");
                requireEnvelope(event, domain, tenantId, workspaceId,
                        sessionId, firstSequence + index);
                applyRevision(tenantId, workspaceId, sessionId, domain, body,
                        payload.get("operationId").textValue(),
                        payload.get("recordRef"),
                        time(event.path("occurredAt")), resources);
                applied = true;
            }
        }
        require(!applied || COMMIT_SUBTYPE.equals(lastSubtype),
                "A transaction with a Stage H record ends with its commit"
                        + " marker.");
    }

    public TaskPage listTasks(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTaskId, int limit) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(ManagedSessionStore.sessionScopeKey(tenantId,
                sessionId));
        String cursor = "";
        if (beforeCreatedAt != null) {
            cursor = " AND (created_at < ? OR created_at = ?"
                    + " AND record_key < ?)";
            arguments.add(beforeCreatedAt);
            arguments.add(beforeCreatedAt);
            arguments.add(recordKey(beforeTaskId));
        }
        arguments.add(limit + 1);
        List<TaskRow> rows = jdbc.query("SELECT * FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND task_kind IS NOT NULL"
                        + cursor + " ORDER BY created_at DESC,"
                        + " record_key DESC LIMIT ?",
                (result, row) -> taskRow(result, tenantId, sessionId),
                arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new TaskPage(hasMore ? rows.subList(0, limit) : rows, hasMore);
    }

    public Optional<TaskRow> findTask(String tenantId, String sessionId,
            String taskId) {
        String recordKey = recordKey(taskId);
        if (recordKey == null) {
            return Optional.empty();
        }
        return jdbc.query("SELECT * FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND record_key = ?"
                        + " AND task_kind IS NOT NULL",
                (result, row) -> taskRow(result, tenantId, sessionId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                recordKey).stream().findFirst();
    }

    /**
     * Checks the domain.committed event of a Stage H record as the Session
     * authority's reader does: a closed event at its sequence, its version,
     * its Session, and a closed payload whose reference names a version 1
     * record of the domain. The authority never gives such an event a
     * subject.
     */
    private static void requireEnvelope(JsonNode event, String domain,
            String tenantId, String workspaceId, String sessionId,
            long sequence) {
        try {
            ManagedExtensionRecords.closed(event, EVENT_FIELDS, "event");
            ManagedExtensionRecords.count(event.get("v"), 1, 1, "event.v");
            ManagedExtensionRecords.count(event.get("sequence"), sequence,
                    sequence, "event.sequence");
            ManagedExtensionRecords.id(event.get("eventId"), "event.eventId");
            ManagedExtensionRecords.closed(event.get("sessionKey"),
                    SESSION_KEY_FIELDS, "event.sessionKey");
            JsonNode payload = event.get("payload");
            ManagedExtensionRecords.closed(payload, PAYLOAD_FIELDS,
                    "event.payload");
            ManagedExtensionRecords.count(payload.get("version"), 1, 1,
                    "event.payload.version");
            ManagedExtensionRecords.id(payload.get("operationId"),
                    "event.payload.operationId");
            ManagedExtensionRecords.durableRef(payload.get("recordRef"),
                    "event.payload.recordRef");
        } catch (InvalidRecordException error) {
            throw rejected(error.getMessage());
        }
        JsonNode key = event.get("sessionKey");
        JsonNode recordRef = event.get("payload").get("recordRef");
        require(tenantId.equals(key.get("tenantId").textValue())
                && workspaceId.equals(key.get("workspaceId").textValue())
                && sessionId.equals(key.get("sessionId").textValue()),
                "The Stage H record names another Session.");
        require(("managed-" + domain).equals(recordRef.get("kind")
                .textValue()) && recordRef.get("schemaVersion")
                        .longValue() == 1,
                "The Stage H record must reference managed-" + domain
                        + " version 1.");
    }

    private void applyRevision(String tenantId, String workspaceId,
            String sessionId, String domain, Body body, String operationId,
            JsonNode recordRef, long occurredAt,
            Function<String, StoredResource> resources) {
        String resourceId = recordRef.get("resourceId").textValue();
        StoredResource resource = resources.apply(resourceId);
        require(resource.kind().equals(recordRef.get("kind").textValue())
                && resource.schemaVersion() == 1
                && resource.byteLength() == recordRef.get("byteLength")
                        .longValue()
                && resource.digest().equals(recordRef.get("digest")
                        .textValue()),
                "The Stage H record does not match its resource.");
        JsonNode record = read(new String(resource.bytes(),
                StandardCharsets.UTF_8), "Stage H record");
        try {
            body.require().accept(record);
        } catch (InvalidRecordException error) {
            throw rejected(error.getMessage());
        }
        String recordId = body.recordId().apply(record);
        String recordKey = ManagedExtensionProjection.recordKey(sessionId,
                domain, recordId);
        String scopeKey = ManagedSessionStore.sessionScopeKey(tenantId,
                sessionId);
        StoredRow previous = jdbc.query("SELECT * FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND record_key = ?",
                ManagedExtensionRecordStore::storedRow, scopeKey, recordKey)
                .stream().findFirst().orElse(null);
        String operationHash = sha256(operationId);
        if (previous == null) {
            require(body.isStart().test(record), "The first revision of "
                    + domain + " record " + recordId + " must open its run.");
            // The command that opens a record becomes the operation of its
            // grants, so it opens no other record.
            Integer opened = jdbc.queryForObject("SELECT COUNT(*) FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_scope_key = ? AND operation_hash = ?",
                    Integer.class, scopeKey, operationHash);
            require(opened != null && opened == 0, "Command " + operationId
                    + " already opened another Stage H record.");
        } else {
            require(previous.domain().equals(domain)
                    && previous.recordId().equals(recordId)
                    && body.isSuccessor().test(read(new String(resources
                            .apply(previous.resourceId()).bytes(),
                            StandardCharsets.UTF_8), "Stage H record"),
                            record),
                    domain + " record " + recordId
                            + " cannot follow its revision "
                            + previous.revision() + ".");
        }
        JsonNode run = record.get("run");
        TaskProjection projection = ManagedExtensionProjection.project(
                previous == null ? null : previous.projection(), run,
                occurredAt);
        JsonNode delivery = run.get("delivery");
        String deliveryTarget = delivery.isNull() ? null
                : delivery.get("target").textValue();
        String deliveryState = delivery.isNull() ? null
                : delivery.get("state").textValue();
        long revision = previous == null ? 1 : previous.revision() + 1;
        if (previous == null) {
            jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                            + " (session_scope_key, record_key, tenant_id,"
                            + " workspace_id, session_id, domain, record_id,"
                            + " operation_hash, revision, record_resource_id,"
                            + " task_kind, task_state, runtime_state,"
                            + " definition_revision, delivery_target,"
                            + " delivery_state, created_at, started_at,"
                            + " settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    scopeKey, recordKey, tenantId, workspaceId, sessionId,
                    domain, recordId, operationHash, revision, resourceId,
                    body.taskKind(),
                    projection.state(), projection.runtimeState(),
                    projection.definitionRevision(), deliveryTarget,
                    deliveryState, projection.createdAt(),
                    projection.startedAt(), projection.settledAt());
        } else {
            jdbc.update("UPDATE qwen_managed_session_extension_record SET"
                            + " revision = ?, record_resource_id = ?,"
                            + " task_state = ?, runtime_state = ?,"
                            + " definition_revision = ?, delivery_target = ?,"
                            + " delivery_state = ?, started_at = ?,"
                            + " settled_at = ? WHERE session_scope_key = ?"
                            + " AND record_key = ?",
                    revision, resourceId, projection.state(),
                    projection.runtimeState(),
                    projection.definitionRevision(), deliveryTarget,
                    deliveryState, projection.startedAt(),
                    projection.settledAt(), scopeKey, recordKey);
        }
        if (previous == null
                || !Objects.equals(previous.projection(), projection)) {
            announce(tenantId, sessionId,
                    ManagedExtensionProjection.taskId(recordKey),
                    projection.state(), revision);
        }
    }

    /**
     * Announces a changed task view on the Session event stream, in the same
     * transaction, when the Session has a public resource.
     */
    private void announce(String tenantId, String sessionId, String taskId,
            String state, long revision) {
        if (sessions == null) {
            return;
        }
        Optional<SessionRecord> session = sessions.findSessionById(sessionId);
        // A deleted Session's terminal event stays its last one.
        if (session.isEmpty() || !tenantId.equals(session.get().tenantId())
                || "DELETING".equals(session.get().status())
                || "DELETED".equals(session.get().status())) {
            return;
        }
        sessions.appendPublicEventIfAbsent(tenantId, sessionId, null,
                "task.updated", Map.of("taskId", taskId, "state", state),
                false, "task:" + taskId + ":" + revision);
    }

    private static TaskRow taskRow(ResultSet result, String tenantId,
            String sessionId) throws SQLException {
        if (!tenantId.equals(result.getString("tenant_id"))
                || !sessionId.equals(result.getString("session_id"))) {
            throw new IllegalStateException(
                    "A Stage H record row is outside its Session scope");
        }
        return new TaskRow(ManagedExtensionProjection.taskId(
                result.getString("record_key")),
                result.getString("task_kind"), projection(result));
    }

    private static StoredRow storedRow(ResultSet result, int row)
            throws SQLException {
        return new StoredRow(result.getString("domain"),
                result.getString("record_id"), result.getLong("revision"),
                result.getString("record_resource_id"), projection(result));
    }

    private static TaskProjection projection(ResultSet result)
            throws SQLException {
        return new TaskProjection(result.getString("task_state"),
                result.getString("runtime_state"),
                result.getObject("definition_revision", Long.class),
                result.getLong("created_at"),
                result.getObject("started_at", Long.class),
                result.getObject("settled_at", Long.class));
    }

    private static String recordKey(String taskId) {
        var matcher = taskId == null ? null : TASK_ID.matcher(taskId);
        return matcher != null && matcher.matches() ? matcher.group(1) : null;
    }

    private static JsonNode read(String text, String label) {
        try {
            JsonNode node = JSON.readTree(text);
            require(node != null && node.isObject(),
                    label + " must be a JSON object.");
            return node;
        } catch (JsonProcessingException error) {
            throw rejected(label + " is not valid JSON.");
        }
    }

    private static long time(JsonNode node) {
        BigDecimal value = node.isNumber() && Double.isFinite(
                node.doubleValue()) ? node.decimalValue() : null;
        require(value != null && value.stripTrailingZeros().scale() <= 0
                && value.signum() >= 0
                && value.compareTo(BigDecimal.valueOf(MAX_TIME)) <= 0,
                "The Stage H record event has no valid time.");
        return value.longValueExact();
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(
                    "SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw rejected(message);
        }
    }

    private static ApiException rejected(String message) {
        return new ApiException(HttpStatus.CONFLICT, ERROR_REJECTED, message);
    }

    private record StoredRow(String domain, String recordId, long revision,
            String resourceId, TaskProjection projection) {
    }
}
