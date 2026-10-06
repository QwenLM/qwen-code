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
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
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
                        firstSequence + index, occurredAt, resources);
                applied++;
            }
        }
        require(applied == 0 || shaped && COMMIT_SUBTYPE.equals(lastSubtype),
                "A transaction with a Stage H record holds only its events,"
                        + " then its commit marker.");
        return new ApplyResult(receipts, lastActivation);
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

    private void applyRevision(String tenantId, String workspaceId,
            String sessionId, String domain, Body body, String operationId,
            JsonNode recordRef, long sequence, long occurredAt,
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
            for (String field : List.of("commandRef", "startReceiptRef", "outputRef")) {
                JsonNode ref = record.get(field);
                if (ref != null && !ref.isNull()) {
                    requireReference(resources.apply(ref.get("resourceId").textValue()), ref);
                }
            }
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
        StoredRow previous = jdbc.query("SELECT * FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND record_key = ?",
                ManagedExtensionRecordStore::storedRow, scopeKey, recordKey)
                .stream().findFirst().orElse(null);
        String operationHash = sha256(operationId);
        if (previous == null) {
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
                        body.taskKind(),
                        body.taskKind() == null ? null : projection.state(), projection.runtimeState(),
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
                    revision, resourceId, body.taskKind() == null ? null : projection.state(),
                    projection.runtimeState(),
                    projection.definitionRevision(), deliveryTarget,
                    deliveryState, projection.startedAt(),
                    projection.settledAt(), scopeKey, recordKey);
        }
        if (body.taskKind() != null && (previous == null
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
