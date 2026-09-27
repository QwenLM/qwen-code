package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.Body;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
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
    private static final Pattern TASK_ID = Pattern.compile(
            "^task_([0-9a-f]{64})$");
    private static final long MAX_TIME = 8_640_000_000_000_000L;
    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build();
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
     */
    void apply(String tenantId, String workspaceId, String sessionId,
            byte[] recordBytes, Function<String, StoredResource> resources) {
        for (String line : new String(recordBytes, StandardCharsets.UTF_8)
                .split("\n")) {
            JsonNode record = read(line, "journal record");
            if (!EVENT_SUBTYPE.equals(record.path("subtype").textValue())) {
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
                JsonNode key = event.path("sessionKey");
                require(tenantId.equals(key.path("tenantId").textValue())
                        && workspaceId.equals(key.path("workspaceId")
                                .textValue())
                        && sessionId.equals(key.path("sessionId").textValue()),
                        "The Stage H record names another Session.");
                applyRevision(tenantId, workspaceId, sessionId, domain, body,
                        payload.path("recordRef"),
                        time(event.path("occurredAt")), resources);
            }
        }
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

    private void applyRevision(String tenantId, String workspaceId,
            String sessionId, String domain, Body body, JsonNode recordRef,
            long occurredAt, Function<String, StoredResource> resources) {
        String resourceId = recordRef.path("resourceId").textValue();
        require(resourceId != null, "The Stage H record has no resource.");
        StoredResource resource = resources.apply(resourceId);
        require(resource.kind().equals(recordRef.path("kind").textValue())
                && resource.kind().equals("managed-" + domain)
                && resource.schemaVersion() == 1
                && recordRef.path("schemaVersion").asLong() == 1
                && resource.byteLength() == recordRef.path("byteLength")
                        .asLong(-1)
                && resource.digest().equals(recordRef.path("digest")
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
        if (previous == null) {
            require(body.isStart().test(record), "The first revision of "
                    + domain + " record " + recordId + " must open its run.");
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
                            + " revision, record_resource_id, task_kind,"
                            + " task_state, runtime_state,"
                            + " definition_revision, delivery_target,"
                            + " delivery_state, created_at, started_at,"
                            + " settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    scopeKey, recordKey, tenantId, workspaceId, sessionId,
                    domain, recordId, revision, resourceId, body.taskKind(),
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
        if (session.isEmpty() || !tenantId.equals(session.get().tenantId())) {
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
