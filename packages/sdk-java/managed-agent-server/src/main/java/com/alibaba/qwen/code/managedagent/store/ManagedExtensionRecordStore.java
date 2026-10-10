package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.Body;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
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
    private static final Logger LOG = LoggerFactory.getLogger(
            ManagedExtensionRecordStore.class);
    /** A session message its Session's lineage refuses (H4d): only this
     * store holds a child's lineage, so it is a rollbackable non-commit. */
    public static final String ERROR_MESSAGE_LINEAGE =
            "session_message_lineage_refused";
    public static final String ERROR_REJECTED =
            "managed_session_extension_record_rejected";
    public static final String OPENING_COMMAND_QUERY = "SELECT COUNT(*) FROM"
            + " qwen_managed_session_extension_record WHERE"
            + " session_scope_key = ? AND operation_hash = ?";
    private static final String EVENT_SUBTYPE = "managed_session_event_v1";
    private static final String HEADER_SUBTYPE = "managed_session_header_v1";
    private static final String COMMIT_SUBTYPE = "managed_session_commit_v1";
    private static final Set<String> EVENT_FIELDS = Set.of("v", "sequence",
            "eventId", "sessionKey", "kind", "occurredAt", "payload");
    private static final Set<String> EVENT_FIELDS_WITH_SUBJECT = Set.of("v",
            "sequence", "eventId", "sessionKey", "kind", "occurredAt",
            "subject", "payload");
    /** The event ids commitExtensionRecord assigns, {@code <domain>:<n>}. */
    private static final Pattern RESERVED_EVENT_ID = Pattern.compile("^(?:"
            + String.join("|", ManagedExtensionProjection.RECORD_BODIES
                    .keySet().stream().sorted().toList())
            + "):[0-9]+$");
    private static final Pattern TASK_ID = Pattern.compile(
            "^task_([0-9a-f]{64})$");
    private static final Set<String> SESSION_KEY_FIELDS = Set.of("tenantId",
            "workspaceId", "sessionId");
    private static final Set<String> PAYLOAD_FIELDS = Set.of("domain",
            "version", "operationId", "recordRef");
    // Parses as strictly as the Session authority's reader: no duplicate
    // keys, no trailing content, no deeper nesting, and, checked after
    // parsing, only finite numbers. The store never accepts a line or a body
    // that the authority could not read back.
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory
                    .builder().streamReadConstraints(StreamReadConstraints
                            .builder().maxNestingDepth(ManagedSessionStoreModels
                                    .MAX_JSON_DEPTH).build()).build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private final JdbcTemplate jdbc;
    private final AgentStateStore sessions;
    private final ManagedTaskEventStore taskEvents;

    @Autowired
    public ManagedExtensionRecordStore(JdbcTemplate jdbc,
            AgentStateStore sessions, ManagedTaskEventStore taskEvents) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.taskEvents = taskEvents;
    }

    /** A store beside no public Session table, which announces nothing. */
    public ManagedExtensionRecordStore(JdbcTemplate jdbc) {
        this(jdbc, (AgentStateStore) null);
    }

    /** A store that journals its own task events beside the table. */
    public ManagedExtensionRecordStore(JdbcTemplate jdbc,
            AgentStateStore sessions) {
        this(jdbc, sessions, new ManagedTaskEventStore(jdbc));
    }

    public record TaskRow(String taskId, String kind,
            TaskProjection projection) {
    }

    public record TaskPage(List<TaskRow> tasks, boolean hasMore) {
    }

    public List<JsonNode> listRecords(String tenantId, String sessionId,
            String domain) {
        Body body = ManagedExtensionProjection.RECORD_BODIES.get(domain);
        require(body != null, "Unknown extension record domain.");
        List<String> ids = jdbc.query("SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND domain = ?"
                        + " ORDER BY created_at, record_key",
                (result, row) -> result.getString("record_resource_id"),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, domain);
        return ids.stream().map(id -> {
            JsonNode record = readBody(readResource(tenantId, sessionId, id));
            body.require().accept(record);
            return record;
        }).toList();
    }

    public Optional<JsonNode> latestHookRegistration(String tenantId, String sessionId) {
        return jdbc.query("SELECT record_resource_id FROM qwen_managed_session_extension_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'hook_registration' AND settled_at IS NOT NULL"
                        + " ORDER BY first_sequence DESC",
                (result, row) -> result.getString("record_resource_id"),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId)
                .stream().map(id -> {
                    JsonNode record = readBody(readResource(tenantId, sessionId, id));
                    ManagedHookRecords.requireRegistration(record);
                    return record;
                }).filter(record -> "settled".equals(record.path("run").path("state").textValue()))
                .findFirst();
    }

    /** Reads only a committed resource in this Session's scope. */
    public JsonNode readRecordResource(String tenantId, String sessionId,
            JsonNode ref) {
        return readBody(readCommittedResource(tenantId, sessionId, ref));
    }

    public StoredResource readCommittedResource(String tenantId, String sessionId,
            JsonNode ref) {
        ManagedExtensionRecords.durableRef(ref, "recordResource");
        StoredResource resource = readResource(tenantId, sessionId,
                ref.get("resourceId").textValue());
        requireReference(resource, ref);
        return resource;
    }

    private StoredResource readResource(String tenantId, String sessionId,
            String resourceId) {
        StoredResource resource = jdbc.query("SELECT * FROM"
                        + " qwen_managed_session_resource WHERE"
                        + " session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND resource_id = ?"
                        + " AND state = 'REFERENCED' AND storage_kind = 'MYSQL_INLINE'"
                        + " AND object_key IS NULL AND object_version_id IS NULL"
                        + " AND encryption_key_id IS NULL",
                (result, row) -> new StoredResource(
                        result.getString("resource_id"),
                        result.getString("kind"), result.getInt("schema_version"),
                        result.getLong("byte_length"), result.getString("sha256"),
                        result.getBytes("inline_bytes")),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, resourceId).stream().findFirst()
                .orElseThrow(() -> rejected("Missing committed MCP resource."));
        require(resource.bytes() != null
                && resource.bytes().length == resource.byteLength()
                && sha256(resource.bytes()).equals(resource.digest()),
                "The committed MCP resource is corrupt.");
        return resource;
    }

    /**
     * What one journal transaction carries: the tool receipts, and the
     * payload of its last activation.changed event (null when it has none),
     * collected during the same pass so the commit does not parse twice.
     */
    record ApplyResult(List<JsonNode> receipts, JsonNode lastActivation) {
    }

    /**
     * Applies the Stage H revisions that one journal transaction carries.
     * It runs inside the Session store's commit, after the transaction's
     * resources are stored, so {@code resources} reads each body verified.
     * Every record line must be one the authority's reader can parse, and
     * every event line one its reader can read back: a line the authority
     * would refuse at the next open is refused here, so no commit can
     * brick the Session it writes. A Stage H event must hold its declared
     * place among the transaction's {@code eventCount} events, and its
     * transaction must hold only those events and then its commit marker,
     * as the authority writes it.
     */
    ApplyResult apply(String tenantId, String workspaceId, String sessionId,
            long firstSequence, int eventCount, byte[] recordBytes,
            Function<String, StoredResource> resources) {
        String[] lines = new String(recordBytes, StandardCharsets.UTF_8)
                .split("\n");
        List<JsonNode> receipts = new ArrayList<>();
        int applied = 0;
        JsonNode lastActivation = null;
        boolean shaped = true;
        boolean managed = false;
        String lastSubtype = null;
        for (int index = 0; index < lines.length; index++) {
            JsonNode record = parse(lines[index]);
            if (record == null) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        ManagedSessionStoreModels.ERROR_INVALID_REQUEST,
                        "Record line " + (index + 1) + " is not a JSON object"
                                + " the Session authority can read.");
            }
            String subtype = record.path("subtype").textValue();
            lastSubtype = subtype;
            if (!EVENT_SUBTYPE.equals(subtype)) {
                if (HEADER_SUBTYPE.equals(subtype)
                        || COMMIT_SUBTYPE.equals(subtype)) {
                    managed = true;
                } else {
                    // The authority's reader tolerates a line of a subtype
                    // it does not know only before the Managed header.
                    require(!managed, "Record line " + (index + 1)
                            + " has the unknown subtype " + subtype
                            + " after the Managed header.");
                }
                // Every line inside the transaction's event range is an
                // event line: the reader refuses any other record there.
                require(index >= eventCount, "Record line " + (index + 1)
                        + " is not an event line, yet it sits among the"
                        + " transaction's events.");
                shaped &= index >= eventCount;
                requireLineBytes(lines[index], index,
                        COMMIT_SUBTYPE.equals(subtype)
                                ? ManagedSessionStoreModels
                                        .MAX_COMMIT_MARKER_BYTES
                                : ManagedSessionStoreModels.MAX_EVENT_BYTES);
                continue;
            }
            managed = true;
            requireLineBytes(lines[index], index,
                    ManagedSessionStoreModels.MAX_EVENT_BYTES);
            require(index < eventCount, "The event of record line "
                    + (index + 1) + " is not one of the transaction's"
                    + " events.");
            JsonNode event = record.path("managedSession");
            JsonNode payload = event.path("payload");
            String kind = event.path("kind").textValue();
            String domain = "domain.committed".equals(kind)
                    ? payload.path("domain").textValue() : null;
            Body body = domain == null ? null
                    : ManagedExtensionProjection.RECORD_BODIES.get(domain);
            long occurredAt = requireEvent(event, tenantId, workspaceId,
                    sessionId, firstSequence + index, body == null);
            String eventId = event.path("eventId").textValue();
            if (body == null) {
                require(!RESERVED_EVENT_ID.matcher(eventId).matches(),
                        "event id " + eventId
                                + " is reserved for Stage H records.");
            } else {
                // A Stage H line carries its own domain's reserved id;
                // holding another domain's would collide with that domain's
                // next record, which could then never commit.
                require(ownReservedId(eventId, domain),
                        "The Stage H record's event id " + eventId
                                + " is not its domain's reserved " + domain
                                + ":<n> id.");
            }
            if ("activation.changed".equals(kind)) {
                lastActivation = payload;
            }
            if ("tool.receipt".equals(kind)) {
                receipts.add(event);
            }
            if (!"domain.committed".equals(kind)) {
                continue;
            }
            // Run the payload checks for every domain.committed event, not
            // only ones with a parseable domain — a line without a textual
            // domain must not skip into the journal the reader refuses.
            requireDomainCommitted(payload, domain, body != null);
            if (body != null) {
                require(applied == 0, "A transaction carries at most one"
                        + " Stage H record.");
                applyRevision(tenantId, workspaceId, sessionId, domain, body,
                        payload.get("operationId").textValue(),
                        payload.get("recordRef"),
                        firstSequence + index, occurredAt, resources,
                        () -> transactionInputIds(lines, eventCount));
                applied++;
            }
        }
        require(applied == 0 || shaped && COMMIT_SUBTYPE.equals(lastSubtype),
                "A transaction with a Stage H record holds only its events,"
                        + " then its commit marker.");
        return new ApplyResult(receipts, lastActivation);
    }

    /** A never-started verdict and the creation mint share one seam:
     * this lock is the same row the creation fence reads FOR UPDATE, so
     * the mint's lineage write and the verdict's name serialize against
     * each other. The verdict must name exactly the Session the lineage
     * proves minted — unnamed orphans the mint, mismatched forges one —
     * and null exactly when no lineage exists. Package-visible for its
     * H2 decision-table pin; the row lock it rides only binds inside
     * the commit transaction that calls it. */
    void reconcileNeverStartedVerdict(String tenantId, String sessionId,
            String domain, String recordId, JsonNode record) {
        jdbc.query("SELECT record_key FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE session_scope_key = ?"
                        + " AND record_key = ? FOR UPDATE",
                (result, rowNum) -> result.getString(1),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                ManagedExtensionProjection.recordKey(sessionId, domain,
                        recordId));
        // The lineage read must be a locking read on purpose: under
        // REPEATABLE READ the transaction's snapshot was established by
        // the ordinary reads ahead of this gate, so a plain SELECT would
        // miss a mint committed after that snapshot even while the row
        // lock above serializes against the mint's own fence. A locking
        // read always sees the latest committed data on both InnoDB
        // isolation defaults — and takes the same extension-then-session
        // lock order the mint uses, so the seam never cycles.
        List<String> lineage = jdbc.query(
                "SELECT session_id FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND parent_child_run_id = ? FOR UPDATE",
                (result, rowNum) -> result.getString(1), tenantId,
                sessionId, recordId);
        JsonNode named = record.get("childSessionId");
        String namedId = named == null || named.isNull() ? null
                : named.textValue();
        boolean lawfullyNamed = lineage.isEmpty() ? namedId == null
                : lineage.size() == 1 && lineage.getFirst().equals(namedId);
        if (!lawfullyNamed) {
            // Its own refusal code, not the generic record rejection:
            // the Hosted writer must classify this as a rollbackable
            // non-commit (an authority kept alive for the corrected
            // retry), never as a write failure that latches the parent's
            // Session log shut behind it.
            throw new ApiException(HttpStatus.CONFLICT,
                    "child_run_lineage_minted",
                    "Child run " + recordId + "'s never-started verdict does"
                            + " not name the Session its creation minted.");
        }
    }

    boolean hasNewLifecycleDispatch(String tenantId, String sessionId, byte[] bytes,
            Function<String, StoredResource> resources) {
        boolean dispatch = false;
        var revisions = new java.util.HashMap<String, JsonNode>();
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            JsonNode parsed = parse(line);
            if (parsed == null) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        ManagedSessionStoreModels.ERROR_INVALID_REQUEST,
                        "Record line is not a JSON object the Session authority can read.");
            }
            JsonNode event = parsed.path("managedSession");
            JsonNode payload = event.path("payload");
            if ("input.accepted".equals(event.path("kind").asText())
                    || "tool.intent".equals(event.path("kind").asText())) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_admission_closed");
            }
            if ("model.attempt".equals(event.path("kind").asText())
                    && "started".equals(payload.path("state").asText())) {
                dispatch = true;
            }
            if (!"domain.committed".equals(event.path("kind").asText())) {
                continue;
            }
            String domain = payload.path("domain").asText();
            // A lifecycle-claimed owner also owes its own child-cleanup
            // records (dispatch, attach, cancel, close_scope): they are
            // lifecycle work, never new ordinary work — but they never
            // enter the hook dispatch analysis or its network re-verify.
            boolean hookDomain = "hook_execution".equals(domain)
                    || "hook_registration".equals(domain);
            if (!hookDomain
                    && !"child_run".equals(domain)
                    && !"child_acceptance".equals(domain)) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_admission_closed");
            }
            if (hookDomain) {
                JsonNode next = readBody(resources.apply(
                        payload.path("recordRef").path("resourceId").asText()));
                JsonNode previous = previousLifecycleRecord(tenantId,
                        sessionId, domain, next, revisions);
                if (requiresLifecycleDispatch(previous, next)) {
                    dispatch = true;
                }
            }
        }
        return dispatch;
    }

    void requireLifecycleSettlement(String tenantId, String sessionId, byte[] bytes,
            Function<String, StoredResource> resources) {
        var revisions = new java.util.HashMap<String, JsonNode>();
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            JsonNode parsed = parse(line);
            if (parsed == null) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        ManagedSessionStoreModels.ERROR_INVALID_REQUEST,
                        "Record line is not a JSON object the Session authority can read.");
            }
            JsonNode event = parsed.path("managedSession");
            String kind = event.path("kind").asText();
            JsonNode payload = event.path("payload");
            if ("input.accepted".equals(kind) || "tool.intent".equals(kind)
                    || "model.attempt".equals(kind) && "started".equals(payload.path("state").asText())) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_admission_closed");
            }
            if (!"domain.committed".equals(kind)) {
                continue;
            }
            String domain = payload.path("domain").asText();
            if (!List.of("hook_execution", "hook_registration").contains(domain)) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_admission_closed");
            }
            JsonNode next = readBody(resources.apply(payload.path("recordRef").path("resourceId").asText()));
            JsonNode previous = previousLifecycleRecord(tenantId, sessionId, domain, next, revisions);
            if (previous == null || requiresLifecycleDispatch(previous, next)) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_admission_closed");
            }
        }
    }

    private JsonNode previousLifecycleRecord(String tenantId, String sessionId, String domain, JsonNode next,
            java.util.Map<String, JsonNode> revisions) {
        String id = next.path("hook_execution".equals(domain) ? "hookExecutionId" : "registrationId").asText();
        String key = domain + ":" + id;
        JsonNode previous = revisions.get(key);
        if (previous == null) {
            previous = jdbc.queryForList("SELECT record_resource_id FROM qwen_managed_session_extension_record"
                + " WHERE session_scope_key = ? AND record_key = ? AND tenant_id = ? AND session_id = ? AND domain = ? AND record_id = ?",
                String.class, ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                ManagedExtensionProjection.recordKey(sessionId, domain, id), tenantId, sessionId, domain, id).stream().map(resource -> {
                    JsonNode record = readBody(readResource(tenantId, sessionId, resource));
                    ManagedExtensionProjection.RECORD_BODIES.get(domain).require().accept(record);
                    return record;
                }).findFirst().orElse(null);
        }
        revisions.put(key, next);
        return previous;
    }

    private boolean requiresLifecycleDispatch(JsonNode previous, JsonNode next) {
        if (previous == null) {
            return "dispatch_started".equals(next.path("run").path("execution").asText());
        }
        JsonNode before = previous.path("run");
        JsonNode after = next.path("run");
        String execution = before.path("execution").asText();
        if (!List.of("", "intent").contains(execution) && !before.path("runtime").equals(after.path("runtime"))) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_admission_closed");
        }
        return "intent".equals(execution) && !List.of("intent", "not_started_proven").contains(after.path("execution").asText());
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
                        + " session_scope_key = ? AND task_kind IS NOT NULL" + cursor + " ORDER BY created_at DESC,"
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
                        + " session_scope_key = ? AND record_key = ? AND task_kind IS NOT NULL",
                (result, row) -> taskRow(result, tenantId, sessionId),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                recordKey).stream().findFirst();
    }

    /**
     * The event-level checks the Session authority's reader runs on every
     * event line: a closed envelope with an optional subject, version 1,
     * the sequence of the line's place among the transaction's events, a
     * well-formed id, this Session's closed key, and a valid time and
     * kind. The authority never gives a Stage H record event a subject, so
     * only the other event lines may carry one. Returns the event's time.
     */
    private static long requireEvent(JsonNode event, String tenantId,
            String workspaceId, String sessionId, long sequence,
            boolean allowSubject) {
        Set<String> allowed = allowSubject
                ? EVENT_FIELDS_WITH_SUBJECT : EVENT_FIELDS;
        boolean closed = event != null && event.isObject()
                && EVENT_FIELDS.stream().allMatch(event::has)
                && event.size() <= allowed.size()
                && (!event.has("subject") || event.get("subject").isObject());
        if (closed) {
            for (Iterator<String> names = event.fieldNames();
                    names.hasNext();) {
                if (!allowed.contains(names.next())) {
                    closed = false;
                    break;
                }
            }
        }
        require(event == null || !event.isObject() || !event.has("subject")
                || event.get("subject").isObject(),
                "event.subject must be a JSON object");
        require(closed, "event must be an object with exactly "
                + EVENT_FIELDS
                + (allowSubject ? " and an optional subject" : ""));
        // The reader checks the payload's value shape for every kind,
        // before any per-kind schema.
        require(event.get("payload").isObject(),
                "event.payload must be a JSON object");
        long occurredAt;
        try {
            ManagedExtensionRecords.count(event.get("v"), 1, 1, "event.v");
            ManagedExtensionRecords.count(event.get("sequence"), sequence,
                    sequence, "event.sequence");
            ManagedExtensionRecords.id(event.get("eventId"), "event.eventId");
            occurredAt = ManagedExtensionRecords.count(event.get(
                    "occurredAt"), 0, ManagedExtensionRecords.MAX_TIME,
                    "event.occurredAt");
            ManagedExtensionRecords.closed(event.get("sessionKey"),
                    SESSION_KEY_FIELDS, "event.sessionKey");
            ManagedExtensionRecords.oneOf(event.get("kind"),
                    ManagedExtensionRecords.EVENT_KINDS, "event.kind");
        } catch (InvalidRecordException error) {
            throw rejected(error.getMessage());
        }
        JsonNode key = event.get("sessionKey");
        require(tenantId.equals(key.get("tenantId").textValue())
                && workspaceId.equals(key.get("workspaceId").textValue())
                && sessionId.equals(key.get("sessionId").textValue()),
                "The event names another Session.");
        return occurredAt;
    }

    /**
     * The payload checks the Session authority's reader runs on every
     * domain.committed event: a closed payload whose domain is in the v1
     * index, of version 1, whose operation is an id and whose reference
     * names a version 1 record of the domain, whether or not the domain
     * has a record body here.
     */
    private static void requireDomainCommitted(JsonNode payload,
            String domain, boolean stageH) {
        try {
            ManagedExtensionRecords.closed(payload, PAYLOAD_FIELDS,
                    "event.payload");
            ManagedExtensionRecords.oneOf(payload.get("domain"),
                    ManagedExtensionRecords.DOMAINS, "event.payload.domain");
            ManagedExtensionRecords.count(payload.get("version"), 1, 1,
                    "event.payload.version");
            ManagedExtensionRecords.id(payload.get("operationId"),
                    "event.payload.operationId");
            ManagedExtensionRecords.durableRef(payload.get("recordRef"),
                    "event.payload.recordRef");
        } catch (InvalidRecordException error) {
            throw rejected(error.getMessage());
        }
        JsonNode recordRef = payload.get("recordRef");
        require(("managed-" + domain).equals(recordRef.get("kind")
                .textValue()) && recordRef.get("schemaVersion")
                        .longValue() == 1,
                (stageH ? "The Stage H record" : "The record event")
                        + " must reference managed-" + domain + " version"
                        + " 1.");
    }

    private static void requireLineBytes(String line, int index,
            int maximum) {
        require(line.getBytes(StandardCharsets.UTF_8).length <= maximum,
                "Record line " + (index + 1) + " exceeds " + maximum
                        + " UTF-8 bytes, which the Session authority cannot"
                        + " read back.");
    }

    /**
     * The resource of one committed record that an indexed Hook projection
     * matches, if any. Admission keeps the records under one key in
     * agreement, so comparing with one of them decides as all would.
     */
    private Optional<String> hookRecordResource(String where,
            Object... arguments) {
        return jdbc.query("SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record WHERE "
                        + where + " LIMIT 1",
                (result, row) -> result.getString("record_resource_id"),
                arguments).stream().findFirst();
    }

    /** The ids of the inputs a transaction accepts, one per input event
     * (a repeated id stays repeated), read only when a record must bind to
     * them. */
    private static List<String> transactionInputIds(String[] lines,
            int eventCount) {
        List<String> inputs = new ArrayList<>();
        for (int index = 0; index < Math.min(eventCount, lines.length);
                index++) {
            JsonNode event = parse(lines[index]);
            if (event != null && EVENT_SUBTYPE.equals(event.path("subtype")
                    .textValue()) && "input.accepted".equals(event
                            .path("managedSession").path("kind").textValue())) {
                inputs.add(event.path("managedSession").path("payload")
                        .path("inputId").textValue());
            }
        }
        return inputs;
    }

    private void applyRevision(String tenantId, String workspaceId,
            String sessionId, String domain, Body body, String operationId,
            JsonNode recordRef, long sequence, long occurredAt,
            Function<String, StoredResource> resources,
            Supplier<List<String>> inputIds) {
        String resourceId = recordRef.get("resourceId").textValue();
        StoredResource resource = resources.apply(resourceId);
        require(resource.kind().equals(recordRef.get("kind").textValue())
                && resource.schemaVersion() == 1
                && resource.byteLength() == recordRef.get("byteLength")
                        .longValue()
                && resource.digest().equals(recordRef.get("digest")
                        .textValue()),
                "The Stage H record does not match its resource.");
        JsonNode record = readBody(resource);
        try {
            body.require().accept(record);
        } catch (InvalidRecordException error) {
            throw rejected(error.getMessage());
        }
        if (List.of("mcp_configuration", "mcp_operation", "hook_registration", "hook_execution").contains(domain)) {
            for (String field : List.of("catalogRef", "argsRef", "resultRef", "planRef", "inputRef")) {
                JsonNode ref = record.get(field);
                if (ref != null && !ref.isNull()) {
                    requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
                }
            }
        }
        if (domain.equals("child_run")) {
            for (String field : List.of("commandRef", "startReceiptRef", "outputRef",
                    "inputRef", "resultRef", "terminalReceiptRef")) {
                JsonNode ref = record.get(field);
                if (ref != null && !ref.isNull()) {
                    requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
                }
            }
            require(!ManagedExtensionRecords.isChildSessionRun(record)
                    || record.get("depth").longValue() != 1
                    || record.get("rootSessionId").textValue()
                            .equals(sessionId),
                    "Child run rootSessionId must be this Session for a"
                            + " first-level child.");
            JsonNode stopReasonNode = record.get("stopReason");
            JsonNode executionNode = record.get("run").get("execution");
            if (stopReasonNode != null && !stopReasonNode.isNull()
                    && executionNode != null && "not_started_proven"
                            .equals(executionNode.textValue())) {
                reconcileNeverStartedVerdict(tenantId, sessionId, domain,
                        body.recordId().apply(record), record);
            }
        }
        if (domain.equals("child_acceptance")) {
            for (String field : List.of("contentRef", "terminalReceiptRef")) {
                JsonNode ref = record.get(field);
                if (ref != null && !ref.isNull()) {
                    requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
                }
            }
        }
        if (domain.equals("session_message")) {
            JsonNode ref = record.get("contentRef");
            requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
        }
        if (List.of("team_task", "team_message", "team_plan").contains(domain)) {
            for (String field : List.of("descriptionRef", "metadataRef", "contentRef",
                    "planRef", "feedbackRef")) {
                JsonNode ref = record.get(field);
                if (ref != null && !ref.isNull()) {
                    requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
                }
            }
        }
        if (domain.equals("schedule")) {
            JsonNode ref = record.get("promptRef");
            requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
            // H6b: a persistent definition lives in its target Session.
            require(!"persistent".equals(record.get("sessionMode").textValue())
                    || sessionId.equals(record.get("targetSessionId").textValue()),
                    "Schedule targetSessionId must be this Session for a"
                            + " persistent definition.");
        }
        if (domain.equals("monitor_run")) {
            for (String field : List.of("commandRef", "startReceiptRef", "outputRef",
                    "lastObservationRef")) {
                JsonNode ref = record.get(field);
                if (ref != null && !ref.isNull()) {
                    requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
                }
            }
        }
        if (domain.equals("channel_route")) {
            JsonNode ref = record.get("policyRef");
            requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
        }
        if (domain.equals("channel_delivery")) {
            JsonNode ref = record.get("contentRef");
            requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
            for (JsonNode segment : record.get("segments")) {
                JsonNode segmentRef = segment.get("contentRef");
                requireReference(resources.apply(segmentRef.get("resourceId").textValue()),
                        segmentRef);
                JsonNode proofRef = segment.get("receipt").get("proofRef");
                if (proofRef != null && !proofRef.isNull()) {
                    requireReference(resources.apply(proofRef.get("resourceId").textValue()),
                            proofRef);
                }
            }
        }
        if (domain.equals("hook_execution")) {
            StoredResource plan = resources.apply(record.get("planRef").get("resourceId").textValue());
            if (plan.kind().equals("managed-hook-plan")) {
                JsonNode messagesRef = readBody(plan).get("messagesRef");
                if (messagesRef != null && !messagesRef.isNull()) {
                    try {
                        ManagedExtensionRecords.durableRef(messagesRef, "plan.messagesRef");
                        StoredResource messages = resources.apply(messagesRef.get("resourceId").textValue());
                        requireReference(messages, messagesRef);
                        require(List.of("managed-hook-messages", "managed-hook-message-chunks").contains(messages.kind()),
                                "The Hook plan must reference a messages snapshot or chunk manifest.");
                        if (messages.kind().equals("managed-hook-message-chunks")) {
                            JsonNode parts = readBody(messages).get("parts");
                            require(parts != null && parts.isArray(), "The Hook messages manifest must contain parts.");
                            for (JsonNode part : parts) {
                                ManagedExtensionRecords.durableRef(part, "messages.parts");
                                require("managed-hook-message-part".equals(part.get("kind").textValue()),
                                        "The Hook messages manifest must reference message parts.");
                                requireReference(resources.apply(part.get("resourceId").textValue()), part);
                            }
                        }
                    } catch (InvalidRecordException error) {
                        throw rejected(error.getMessage());
                    }
                }
            }
        }
        String recordId = body.recordId().apply(record);
        String recordKey = ManagedExtensionProjection.recordKey(sessionId,
                domain, recordId);
        String scopeKey = ManagedSessionStore.sessionScopeKey(tenantId,
                sessionId);
        ManagedHookRecords.AdmissionKeys keys =
                ManagedHookRecords.admissionKeys(domain, record);
        if (domain.equals("hook_registration")) {
            hookRecordResource("session_scope_key = ? AND hook_definition_hash = ?",
                    scopeKey, keys.definitionHash()).ifPresent(registration ->
                    require(ManagedExtensionRecords.isDefinitionPinConsistent(
                            readBody(resources.apply(registration)).get("run").get("definition"),
                            record.get("run").get("definition")),
                            "A Hook catalog revision cannot name two definition digests."));
        }
        if (domain.equals("mcp_configuration")) {
            List<String> configurations = jdbc.query("SELECT record_resource_id FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_scope_key = ? AND domain = 'mcp_configuration'",
                    (result, row) -> result.getString("record_resource_id"), scopeKey);
            for (String configuration : configurations) {
                require(ManagedExtensionRecords.isDefinitionPinConsistent(
                        readBody(resources.apply(configuration)).get("run").get("definition"),
                        record.get("run").get("definition")),
                        "An MCP server revision cannot name two definition digests.");
            }
        }
        if (domain.equals("child_acceptance")) {
            String childRunKey = ManagedExtensionProjection.recordKey(sessionId,
                    "child_run", record.get("childRunId").textValue());
            String childRunResource = jdbc.query("SELECT record_resource_id FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_scope_key = ? AND record_key = ?",
                    (result, row) -> result.getString("record_resource_id"),
                    scopeKey, childRunKey).stream().findFirst().orElse(null);
            require(childRunResource != null,
                    "Child acceptance must name a child Session run of this Session.");
            JsonNode child = readBody(resources.apply(childRunResource));
            require(ManagedExtensionRecords.isChildSessionRun(child),
                    "Child acceptance must name a child Session run of this Session.");
            require("settled".equals(child.get("run").get("state").textValue())
                    && "completed".equals(child.get("stopReason").textValue()),
                    "Child acceptance must name a run that ended with its"
                            + " result committed.");
            require(child.get("ownerScopeId").textValue().equals(
                    record.get("parentScopeId").textValue())
                    && child.get("resultVersion").decimalValue().compareTo(
                            record.get("resultVersion").decimalValue()) == 0,
                    "Child acceptance must match its child run scope and"
                            + " result version.");
            String expectedCall = "tool".equals(child.get("completion")
                    .textValue())
                    ? child.get("run").get("executionCallId").textValue() : null;
            String actualCall = record.get("parentExecutionCallId").isNull()
                    ? null : record.get("parentExecutionCallId").textValue();
            require(Objects.equals(expectedCall, actualCall),
                    "Child acceptance must attach the completion call its"
                            + " child run names.");
            require(!child.get("resultRef").isNull()
                    && record.get("contentDigest").textValue().equals(
                            child.get("resultRef").get("digest").textValue())
                    && !child.get("terminalReceiptRef").isNull()
                    && record.get("terminalReceiptRef").get("digest")
                            .textValue().equals(child.get("terminalReceiptRef")
                                    .get("digest").textValue()),
                    "Child acceptance must bind the result and receipt its"
                            + " child run committed.");
        }
        if (domain.equals("child_run")
                && ManagedExtensionRecords.isChildSessionRun(record)) {
            // H4b decision 7 (the reverse of the acceptance's check): the
            // acceptance record is authoritative — the run's delivery may
            // reach accepted/consumed only after its acceptance chain
            // exists, and may never retract to unknown/rejected once it
            // does.
            String delivery = record.get("run").get("delivery").get("state")
                    .textValue();
            String acceptanceKey = ManagedExtensionProjection.recordKey(
                    sessionId, "child_acceptance",
                    record.get("childRunId").textValue());
            boolean acceptanceExists = !jdbc
                    .query("SELECT record_resource_id FROM"
                                    + " qwen_managed_session_extension_record"
                                    + " WHERE session_scope_key = ? AND record_key = ?",
                            (result, row) -> result.getString(
                                    "record_resource_id"),
                            scopeKey, acceptanceKey)
                    .isEmpty();
            require(
                    !(delivery.equals("accepted") || delivery.equals("consumed"))
                            || acceptanceExists,
                    "Child run delivery reaches accepted or consumed only with"
                            + " its acceptance record.");
            require(
                    !(delivery.equals("unknown") || delivery.equals("rejected"))
                            || !acceptanceExists,
                    "Child run delivery cannot go unknown or rejected after its"
                            + " acceptance record.");
        }
        StoredRow previous = jdbc.query("SELECT * FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND record_key = ?",
                ManagedExtensionRecordStore::storedRow, scopeKey, recordKey)
                .stream().findFirst().orElse(null);
        String operationHash = sha256(operationId);
        if (domain.equals("session_message")) {
            requireSessionMessage(tenantId, sessionId, scopeKey, record,
                    previous == null, resources);
        }
        if (domain.startsWith("team_")) {
            requireTeamRecord(sessionId, scopeKey, domain, record,
                    previous == null ? null
                            : readBody(resources.apply(previous.resourceId())),
                    resources);
        }
        if (previous == null) {
            if (domain.equals("child_run")) {
                requireContinuation(sessionId, scopeKey, record, resources);
            }
            if (domain.equals("hook_execution")) {
                String registrationKey = ManagedExtensionProjection.recordKey(sessionId,
                        "hook_registration", record.get("registrationId").textValue());
                String registrationResource = jdbc.query("SELECT record_resource_id FROM"
                                + " qwen_managed_session_extension_record WHERE"
                                + " session_scope_key = ? AND record_key = ?",
                        (result, row) -> result.getString("record_resource_id"),
                        scopeKey, registrationKey).stream().findFirst().orElse(null);
                require(registrationResource != null,
                        "Hook execution must bind to its settled committed registration.");
                JsonNode registration = readBody(resources.apply(registrationResource));
                require("settled".equals(registration.get("run").get("state").textValue())
                        && ManagedMcpRecords.same(registration.get("run").get("definition"), record.get("run").get("definition")),
                        "Hook execution must bind to its settled committed registration.");
                // Indexed lookups, not a read of every earlier execution: the
                // unique indexes also refuse a concurrent duplicate.
                require(keys.onceKeyHash() == null || hookRecordResource(
                                "session_scope_key = ? AND hook_once_key_hash = ?",
                                scopeKey, keys.onceKeyHash()).isEmpty(),
                        "Hook onceKey is already consumed in this Session.");
                String occurrence = "Hook occurrence must keep its registration,"
                        + " event and plan, with unique ordinals.";
                require(hookRecordResource("session_scope_key = ?"
                                + " AND hook_occurrence_hash = ? AND hook_ordinal = ?",
                                scopeKey, keys.occurrenceHash(), keys.ordinal()).isEmpty(),
                        occurrence);
                hookRecordResource("session_scope_key = ? AND hook_occurrence_hash = ?",
                        scopeKey, keys.occurrenceHash()).ifPresent(sibling -> {
                            JsonNode other = readBody(resources.apply(sibling));
                            require(List.of("registrationId", "eventName", "planRef").stream()
                                    .allMatch(key -> ManagedMcpRecords.same(record.get(key), other.get(key))),
                                    occurrence);
                        });
            }
            if (domain.equals("mcp_operation")) {
                String configKey = ManagedExtensionProjection.recordKey(sessionId,
                        "mcp_configuration", record.get("configurationId").textValue());
                String configResource = jdbc.query("SELECT record_resource_id FROM"
                                + " qwen_managed_session_extension_record WHERE"
                                + " session_scope_key = ? AND record_key = ?",
                        (result, row) -> result.getString("record_resource_id"),
                        scopeKey, configKey).stream().findFirst().orElse(null);
                require(configResource != null,
                        "MCP operation must bind to its active committed configuration.");
                JsonNode config = readBody(resources.apply(configResource));
                require("active".equals(config.get("releaseState").textValue())
                        && "settled".equals(config.get("run").get("state").textValue())
                        && List.of("serverId", "serverRevision", "configRevision",
                                "catalogRevision", "connectionGeneration").stream()
                                .allMatch(key -> ManagedMcpRecords.same(config.get(key), record.get(key)))
                        && ManagedMcpRecords.same(config.get("run").get("definition"), record.get("run").get("definition")),
                        "MCP operation must bind to its active committed configuration.");
            }
            if (domain.equals("automation_run")) {
                // H6b: a run binds to its live definition at the current
                // revision, and its id is the derivation of its occurrence
                // (design decisions 2 and 3).
                String scheduleKey = ManagedExtensionProjection.recordKey(sessionId,
                        "schedule", record.get("scheduleId").textValue());
                String scheduleResource = jdbc.query("SELECT record_resource_id FROM"
                                + " qwen_managed_session_extension_record WHERE"
                                + " session_scope_key = ? AND record_key = ?",
                        (result, row) -> result.getString("record_resource_id"),
                        scopeKey, scheduleKey).stream().findFirst().orElse(null);
                String binding = "Automation run must bind to its live definition"
                        + " at the current revision.";
                require(scheduleResource != null, binding);
                JsonNode schedule = readBody(resources.apply(scheduleResource));
                require(!ManagedExtensionRecords
                                .isTerminalRunState(
                                schedule.get("run").get("state").textValue())
                        && schedule.get("definitionRevision").decimalValue().compareTo(
                                record.get("definitionRevision").decimalValue()) == 0
                        && ManagedMcpRecords.same(schedule.get("sessionMode"),
                                record.get("sessionMode"))
                        && ManagedMcpRecords.same(schedule.get("targetSessionId"),
                                record.get("targetSessionId")),
                        binding);
                require(record.get("automationRunId").textValue().equals(
                                AutomationLedgerStore.automationRunId(
                                        record.get("scheduleId").textValue(),
                                        record.get("occurrenceKey").textValue())),
                        "Automation run id must be derived from its definition"
                                + " and occurrence.");
            }
            if (domain.equals("channel_delivery")) {
                // H5c: a delivery goes out through a committed, live route
                // at the revision it was planned against.
                String routeKey = ManagedExtensionProjection.recordKey(sessionId,
                        "channel_route", record.get("routeId").textValue());
                String routeResource = jdbc.query("SELECT record_resource_id FROM"
                                + " qwen_managed_session_extension_record WHERE"
                                + " session_scope_key = ? AND record_key = ?",
                        (result, row) -> result.getString("record_resource_id"),
                        scopeKey, routeKey).stream().findFirst().orElse(null);
                require(routeResource != null,
                        "Channel delivery must bind to its committed route at the"
                                + " pinned revision.");
                JsonNode route = readBody(resources.apply(routeResource));
                String routeState = route.get("run").get("state").textValue();
                require(ManagedMcpRecords.same(route.get("routeRevision"),
                        record.get("routeRevision"))
                        && !List.of("settled", "failed", "cancelled")
                                .contains(routeState),
                        "Channel delivery must bind to its committed route at the"
                                + " pinned revision.");
            }
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
                    && body.isSuccessor().test(readBody(resources.apply(
                            previous.resourceId())), record),
                    domain + " record " + recordId
                            + " cannot follow its revision "
                            + previous.revision() + ".");
        }
        if (domain.equals("session_message")) {
            // After the chain rules, so a different message under a taken
            // id answers as the conflict it is, as the authority does. A
            // transaction carries at most one Stage H record (apply), so
            // every input it accepts is this record's: an opening receipt
            // carries exactly one, under its own id, and no other revision
            // carries any.
            boolean opening = previous == null && "inbound".equals(
                    record.get("direction").textValue());
            List<String> inputs = inputIds.get();
            require(opening
                    ? inputs.equals(List.of(record.get("inputId").textValue()))
                    : inputs.isEmpty(),
                    "An inbound session message opens together with its"
                            + " input, and no other revision carries one.");
        }
        JsonNode run = record.get("run");
        TaskProjection projection = ManagedExtensionProjection.project(
                previous == null ? null : previous.projection(), run,
                occurredAt,
                record.path("stopRequested").asBoolean(false));
        JsonNode delivery = run.get("delivery");
        String deliveryTarget = delivery.isNull() ? null
                : delivery.get("target").textValue();
        String deliveryState = delivery.isNull() ? null
                : delivery.get("state").textValue();
        long revision = previous == null ? 1 : previous.revision() + 1;
        if (previous == null) {
            try {
                jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                                + " (session_scope_key, record_key, tenant_id,"
                                + " workspace_id, session_id, domain, record_id,"
                                + " operation_hash, revision, record_resource_id,"
                                + " task_kind, task_state, runtime_state,"
                                + " definition_revision, delivery_target,"
                                + " delivery_state, created_at, started_at,"
                                + " settled_at, first_sequence, hook_once_key_hash,"
                                + " hook_occurrence_hash, hook_ordinal,"
                                + " hook_definition_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                                + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        scopeKey, recordKey, tenantId, workspaceId, sessionId,
                        domain, recordId, operationHash, revision, resourceId,
                        body.taskKindOf().apply(record),
                        body.taskKindOf().apply(record) == null ? null : projection.state(), projection.runtimeState(),
                        projection.definitionRevision(), deliveryTarget,
                        deliveryState, projection.createdAt(),
                        projection.startedAt(), projection.settledAt(), sequence,
                        keys.onceKeyHash(), keys.occurrenceHash(), keys.ordinal(),
                        keys.definitionHash());
            } catch (DuplicateKeyException error) {
                // The checks above run under the Session's head lock, so
                // only a writer that bypassed them reaches here; the unique
                // indexes refuse it, and the log names which one.
                LOG.warn("Managed Stage H record was refused by a unique index"
                                + " tenant={} session={} domain={} record={}",
                        tenantId, sessionId, domain, recordId, error);
                throw rejected(domain + " record " + recordId + " repeats a"
                        + " record or a Hook once key or occurrence ordinal"
                        + " already committed in this Session.");
            }
        } else {
            jdbc.update("UPDATE qwen_managed_session_extension_record SET"
                            + " revision = ?, record_resource_id = ?,"
                            + " task_state = ?, runtime_state = ?,"
                            + " definition_revision = ?, delivery_target = ?,"
                            + " delivery_state = ?, started_at = ?,"
                            + " settled_at = ? WHERE session_scope_key = ?"
                            + " AND record_key = ?",
                    revision, resourceId, body.taskKindOf().apply(record) == null ? null : projection.state(),
                    projection.runtimeState(),
                    projection.definitionRevision(), deliveryTarget,
                    deliveryState, projection.startedAt(),
                    projection.settledAt(), scopeKey, recordKey);
        }
        if (body.taskKindOf().apply(record) != null && (previous == null
                || !Objects.equals(previous.projection(), projection))) {
            String taskId = ManagedExtensionProjection.taskId(recordKey);
            if (isBeingDeleted(tenantId, sessionId)) {
                return;
            }
            try {
                taskEvents.appendStateChange(tenantId, sessionId, taskId,
                        projection.state(), projection.runtimeState(),
                        occurredAt);
            } catch (ApiException refused) {
                // The record row above is the authoritative state and it is
                // already written; the event journal is a derived, bounded
                // feed. A journal that refuses past its backlog bound — or
                // whose retention floor is pinned behind unarchived output —
                // degrades the feed, never the record commit, or one task's
                // output backlog would wedge every later revision of it.
                LOG.warn("Managed Stage H task event was refused by the journal"
                                + " tenant={} session={} task={} revision={}"
                                + " code={}",
                        tenantId, sessionId, taskId, revision,
                        refused.getCode());
            }
        }
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

    private static JsonNode readBody(StoredResource resource) {
        JsonNode record = parse(new String(resource.bytes(),
                StandardCharsets.UTF_8));
        require(record != null, "The Stage H record is not a JSON object the"
                + " Session authority can read.");
        return record;
    }

    /** A JSON object as the authority's reader parses it, or null. */
    public static JsonNode parse(String text) {
        try {
            JsonNode node = JSON.readTree(text);
            return node != null && node.isObject() && finite(node) ? node
                    : null;
        } catch (JsonProcessingException error) {
            return null;
        }
    }

    /** JavaScript reads a number past the double range as an infinity. */
    private static boolean finite(JsonNode node) {
        if (node.isNumber()) {
            return Double.isFinite(node.doubleValue());
        }
        for (JsonNode child : node) {
            if (!finite(child)) {
                return false;
            }
        }
        return true;
    }

    private static String sha256(String value) {
        return sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(
                    "SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    /**
     * H4d: each Session proves what it holds. A record in the parent's
     * journal binds to its child run; a record in a child's journal binds
     * to the lineage creation stamped on its Session row, which only this
     * store holds, so that refusal carries its own code: the authority
     * could not refuse it first, and the writer keeps its log writable.
     */
    private void requireSessionMessage(String tenantId, String sessionId,
            String scopeKey, JsonNode message, boolean opening,
            Function<String, StoredResource> resources) {
        boolean outbound = "outbound".equals(message.get("direction")
                .textValue());
        String target = message.get("targetSessionId").isNull() ? null
                : message.get("targetSessionId").textValue();
        String sender = message.get("senderSessionId").textValue();
        String childRunId = message.get("childRunId").textValue();
        require(!outbound || sender.equals(sessionId),
                "Outbound session message must be sent by this Session.");
        require(outbound || sessionId.equals(target),
                "Inbound session message must be addressed to this Session.");
        if (outbound == "to_child".equals(message.get("route").textValue())) {
            JsonNode child = recordBody(scopeKey, sessionId, "child_run",
                    childRunId, resources);
            require(child != null
                    && ManagedExtensionRecords.isChildSessionRun(child),
                    "Session message must name a child Session run of this"
                            + " Session.");
            String attached = child.get("childSessionId").isNull() ? null
                    : child.get("childSessionId").textValue();
            if (outbound) {
                require(!opening || !ManagedExtensionRecords.TERMINAL.contains(
                        child.get("run").get("state").textValue()),
                        "Session message to a child must name a run that has"
                                + " not ended.");
                require(target == null || target.equals(attached),
                        "Session message to a child must target the Session"
                                + " its run attached.");
            } else {
                // Before the attach the parent cannot tell its child's
                // Session yet: the delivery waits, it is not a forgery.
                require(attached != null,
                        "Session message from a child arrives only once its"
                                + " run attached.");
                require(sender.equals(attached),
                        "Session message from a child must come from the"
                                + " Session its run attached.");
            }
            return;
        }
        // The lineage is stamped at creation and never changes, so a plain
        // read decides; read directly, since a store built beside no
        // public Session table holds no AgentStateStore.
        List<String[]> lineage = jdbc.query("SELECT parent_session_id,"
                        + " parent_child_run_id FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> new String[] {
                        result.getString("parent_session_id"),
                        result.getString("parent_child_run_id") },
                tenantId, sessionId);
        String parent = lineage.isEmpty() ? null : lineage.get(0)[0];
        String edge = lineage.isEmpty() ? null : lineage.get(0)[1];
        boolean follows = parent != null && childRunId.equals(edge)
                && (outbound ? target == null || target.equals(parent)
                        : sender.equals(parent));
        if (!follows) {
            throw new ApiException(HttpStatus.CONFLICT, ERROR_MESSAGE_LINEAGE,
                    outbound
                            ? "Session message to a parent must follow this"
                                    + " Session's lineage."
                            : "Session message from a parent must follow this"
                                    + " Session's lineage.");
        }
    }

    /**
     * H4d's continueChildRun: a continuation opens a new run after a
     * completed one of this Session, in its scope, tree, workspace and
     * definition, and a predecessor is continued at most once, so the
     * chain stays linear.
     */
    private void requireContinuation(String sessionId, String scopeKey,
            JsonNode child, Function<String, StoredResource> resources) {
        JsonNode named = child.get("predecessorChildRunId");
        if (!ManagedExtensionRecords.isChildSessionRun(child)
                || named.isNull()) {
            return;
        }
        String predecessorId = named.textValue();
        JsonNode predecessor = recordBody(scopeKey, sessionId, "child_run",
                predecessorId, resources);
        require(predecessor != null && predecessor.get("kind").textValue()
                .equals(child.get("kind").textValue()),
                "Child continuation must name a child run of this Session of"
                        + " its own kind.");
        require("completed".equals(predecessor.get("stopReason")
                .textValue()),
                "Child continuation must follow a run that completed with its"
                        + " result.");
        require(!predecessor.get("stopRequested").booleanValue(),
                "Child continuation cannot revive a run whose stop was"
                        + " requested.");
        require(List.of("ownerScopeId", "rootSessionId", "depth",
                "workspaceMode", "workingDirectory").stream()
                .allMatch(key -> ManagedExtensionRecords.same(
                        predecessor.get(key), child.get(key)))
                && ManagedExtensionRecords.same(predecessor.get("run")
                        .get("definition"), child.get("run").get("definition")),
                "Child continuation must keep its predecessor's scope, tree,"
                        + " workspace and definition.");
        // Continuations are rare and checked only when one opens, so the runs
        // are read rather than indexed: a sibling proven never to have
        // started releases the predecessor, which no unique index could
        // express. Only a run of the predecessor's kind can continue it, so
        // only those are read. Each opened once every earlier one proved it
        // never started, so at most one still holds the predecessor; the
        // authority keeps just that latest one, relying on the same
        // invariant, so a second release condition must change both.
        List<String> siblings = jdbc.query("SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND domain = 'child_run'"
                        + " AND task_kind = ?",
                (result, row) -> result.getString("record_resource_id"),
                scopeKey, ManagedExtensionRecords.childRunTaskKind(child));
        for (String sibling : siblings) {
            JsonNode body = readBody(resources.apply(sibling));
            require(!predecessorId.equals(body.get("predecessorChildRunId")
                    .textValue()) || "not_started_proven".equals(
                            body.at("/run/execution").textValue()),
                    "Child continuation must name a predecessor no other run"
                            + " continues.");
        }
    }

    /**
     * H4e: a team lives in its lead's journal. Each member joins as a live
     * child Session run of the lead that no other team lists; every other
     * team record opens only in an active team of this Session, so a
     * closing team drains, and its parties, owner, dependencies and plan
     * member come from that team. The authority checks the same rules.
     */
    private void requireTeamRecord(String sessionId, String scopeKey,
            String domain, JsonNode record, JsonNode previous,
            Function<String, StoredResource> resources) {
        if (domain.equals("team_state")) {
            require(sessionId.equals(record.get("leadSessionId").textValue()),
                    "Team must be led by this Session.");
            Set<String> joined = new HashSet<>();
            if (previous != null) {
                previous.get("members").forEach(member -> joined.add(
                        member.get("childRunId").textValue()));
            }
            String teamId = record.get("teamId").textValue();
            for (JsonNode member : record.get("members")) {
                String run = member.get("childRunId").textValue();
                if (joined.contains(run)) {
                    continue;
                }
                JsonNode child = recordBody(scopeKey, sessionId, "child_run",
                        run, resources);
                require(child != null
                        && ManagedExtensionRecords.isChildSessionRun(child)
                        && !ManagedExtensionRecords.isTerminalRunState(
                                child.at("/run/state").textValue()),
                        "Team member must join as a child Session run of this"
                                + " Session that has not ended.");
                // Joins are rare, so the teams are read rather than indexed.
                for (JsonNode other : domainBodies(scopeKey, "team_state",
                        resources)) {
                    require(other.get("teamId").textValue().equals(teamId)
                            || memberWith(other, "childRunId", run) == null,
                            "Team member's child run must belong to no other"
                                    + " team.");
                }
            }
            return;
        }
        String teamId = record.get("teamId").textValue();
        JsonNode team = recordBody(scopeKey, sessionId, "team_state", teamId,
                resources);
        require(team != null && (previous != null
                || "active".equals(team.get("lifecycle").textValue())),
                "Team record must open in an active team of this Session.");
        if (domain.equals("team_task")) {
            String taskId = record.get("taskId").textValue();
            if (previous == null) {
                // Read only when a task opens; its number never changes.
                for (JsonNode other : domainBodies(scopeKey, "team_task",
                        resources)) {
                    require(!teamId.equals(other.get("teamId").textValue())
                            || other.get("number").longValue()
                                    != record.get("number").longValue(),
                            "Team task number must be unique in its team.");
                }
            }
            JsonNode owner = record.get("owner");
            require(owner.isNull() || (previous != null
                    && ManagedExtensionRecords.same(owner, previous.get("owner")))
                    || takesPart(team, owner.textValue()),
                    "Team task owner must be the leader or a member of its"
                            + " team.");
            Set<String> earlier = new HashSet<>();
            if (previous != null) {
                previous.get("blockedBy").forEach(each -> earlier.add(
                        each.textValue()));
            }
            Deque<String> pending = new ArrayDeque<>();
            for (JsonNode each : record.get("blockedBy")) {
                String blocker = each.textValue();
                if (earlier.contains(blocker)) {
                    continue;
                }
                JsonNode other = recordBody(scopeKey, sessionId, "team_task",
                        blocker, resources);
                require(other != null
                        && teamId.equals(other.get("teamId").textValue()),
                        "Team task must be blocked only by tasks of its team.");
                pending.push(blocker);
            }
            // Only the new edges can close a cycle: one does exactly when
            // this task is reachable from a new blocker.
            Set<String> seen = new HashSet<>();
            while (!pending.isEmpty()) {
                String next = pending.pop();
                require(!next.equals(taskId),
                        "Team task dependencies must not form a cycle.");
                if (seen.add(next)) {
                    recordBody(scopeKey, sessionId, "team_task", next,
                            resources).get("blockedBy").forEach(each ->
                                    pending.push(each.textValue()));
                }
            }
        }
        if (domain.equals("team_message")) {
            String to = record.get("to").textValue();
            // Every revision, not only the opening: the roster only grows,
            // so a lawful successor always passes, while one that
            // readdresses the message is refused before its recipient is
            // looked up below.
            require(takesPart(team, record.get("from").textValue())
                    && takesPart(team, to),
                    "Team message must travel between the leader and members"
                            + " of its team.");
            JsonNode target = record.get("targetSessionId");
            if (!target.isNull()) {
                // The leader is this Session; a member is the Session its
                // run attached, so a message to one not attached yet stays
                // planned.
                String expected = sessionId;
                if (!ManagedTeamRecords.LEADER.equals(to)) {
                    JsonNode child = recordBody(scopeKey, sessionId,
                            "child_run", memberWith(team, "name", to)
                                    .get("childRunId").textValue(),
                            resources);
                    expected = ManagedExtensionRecords.isChildSessionRun(child)
                            && !child.get("childSessionId").isNull()
                                    ? child.get("childSessionId").textValue()
                                    : null;
                }
                require(target.textValue().equals(expected),
                        "Team message must target the Session of its"
                                + " recipient.");
            }
        }
        if (domain.equals("team_plan") && previous == null) {
            JsonNode member = memberWith(team, "name",
                    record.get("member").textValue());
            require(member != null
                    && member.get("planModeRequired").booleanValue(),
                    "Team plan must come from a member of its team that"
                            + " requires plan mode.");
        }
    }

    private static boolean takesPart(JsonNode team, String name) {
        return ManagedTeamRecords.LEADER.equals(name)
                || memberWith(team, "name", name) != null;
    }

    private static JsonNode memberWith(JsonNode team, String key,
            String value) {
        for (JsonNode member : team.get("members")) {
            if (value.equals(member.get(key).textValue())) {
                return member;
            }
        }
        return null;
    }

    /** The latest committed body of every record of one domain of this
     * Session. */
    private List<JsonNode> domainBodies(String scopeKey, String domain,
            Function<String, StoredResource> resources) {
        return jdbc.query("SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND domain = ?",
                (result, row) -> result.getString("record_resource_id"),
                scopeKey, domain)
                .stream().map(resource -> readBody(resources.apply(resource)))
                .toList();
    }

    /** The latest committed body of one record of this Session, or null. */
    private JsonNode recordBody(String scopeKey, String sessionId,
            String domain, String recordId,
            Function<String, StoredResource> resources) {
        return jdbc.query("SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND record_key = ?",
                (result, row) -> result.getString("record_resource_id"),
                scopeKey, ManagedExtensionProjection.recordKey(sessionId,
                        domain, recordId))
                .stream().findFirst()
                .map(resource -> readBody(resources.apply(resource)))
                .orElse(null);
    }

    private static void requireReference(StoredResource resource, JsonNode ref) {
        require(resource.kind().equals(ref.get("kind").textValue())
                && resource.schemaVersion() == ref.get("schemaVersion").longValue()
                && resource.byteLength() == ref.get("byteLength").longValue()
                && resource.digest().equals(ref.get("digest").textValue()),
                "The MCP reference does not match its committed resource.");
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

    /** Whether the event id sits in the domain's own reserved
     * {@code <domain>:<n>} namespace. */
    private static boolean ownReservedId(String eventId, String domain) {
        if (eventId == null || !eventId.startsWith(domain + ":")) {
            return false;
        }
        for (int index = domain.length() + 1; index < eventId.length();
                index++) {
            if (!Character.isDigit(eventId.charAt(index))) {
                return false;
            }
        }
        return eventId.length() > domain.length() + 1;
    }
    /** Whether the Session is being deleted or deleted. The read runs
     * inside the record commit's own transaction, so a plain SELECT would
     * read that transaction's own snapshot and silently miss a deletion that
     * committed later (REPEATABLE READ) — the journal must stay empty once a
     * deletion began. Up to this point the commit holds the tenant row and
     * the journal head, not the Session row, so FOR UPDATE takes the Session
     * row's lock here for the first time and may wait across connections —
     * the same shape main's announce() already has. */
    private boolean isBeingDeleted(String tenantId, String sessionId) {
        String status = jdbc.query("SELECT status FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                (result, row) -> result.getString("status"),
                tenantId, sessionId).stream().findFirst().orElse(null);
        return "DELETING".equals(status) || "DELETED".equals(status);
    }
}
