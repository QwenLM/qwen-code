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
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
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
    private static final String EVENT_SUBTYPE = "managed_session_event_v1";
    private static final String COMMIT_SUBTYPE = "managed_session_commit_v1";
    private static final String HEADER_SUBTYPE = "managed_session_header_v1";
    private static final Set<String> EVENT_FIELDS = Set.of("v", "sequence",
            "eventId", "sessionKey", "kind", "occurredAt", "payload");
    private static final Set<String> EVENT_SUBJECT_FIELDS = Set.of("v",
            "sequence", "eventId", "sessionKey", "kind", "occurredAt",
            "subject", "payload");
    /** The event IDs a Stage H chain assigns, {@code <domain>:<count>}. */
    private static final Pattern RESERVED_EVENT_ID = Pattern.compile("^(?:"
            + String.join("|", ManagedExtensionProjection.RECORD_BODIES
                    .keySet()) + "):[0-9]+$");
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
        ManagedExtensionRecords.durableRef(ref, "recordResource");
        StoredResource resource = readResource(tenantId, sessionId,
                ref.get("resourceId").textValue());
        requireReference(resource, ref);
        return readBody(resource);
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
     * Applies the Stage H revisions that one journal transaction carries.
     * It runs inside the Session store's commit, after the transaction's
     * resources are stored, so {@code resources} reads each body verified.
     * Every record line must be one the authority's reader accepts, whether
     * or not the transaction carries a Stage H record: every line names this
     * Session at the top level and stays within its kind's byte cap, every
     * event line holds the shared envelope at its declared place among the
     * transaction's events with the payload and the subject its kind
     * requires (all mirrored in {@link ManagedSessionRecords}), every
     * {@code domain.committed} line names a registered domain and a version
     * 1 record reference of it, an unknown record subtype is tolerated only
     * before the Managed header, and the header and the commit marker parse
     * as the reader parses them, the marker agreeing with the transaction
     * the request declares on all nine of its fields. The request's two
     * content digests are then recomputed from the lines, in the canonical
     * JSON the reader recomputes them in — the events digest over the
     * parsed events and the commit digest over the marker body — so a line
     * the reader could not verify is never stored. The
     * {@code <domain>:<count>} event IDs come from the authority's commit
     * gate, not its reader, so they are checked exactly: only the ID the
     * chain assigns next, or a planted one would make the authority refuse
     * its own legitimate later revision. A Stage H event must hold its
     * declared place among the transaction's {@code eventCount} events,
     * and its transaction must hold only those events and then its commit
     * marker, as the authority writes it.
     */
    List<JsonNode> apply(String tenantId, String workspaceId, String sessionId,
            ManagedSessionStoreModels.CommitTransactionRequest request,
            byte[] recordBytes, Function<String, StoredResource> resources) {
        long firstSequence = request.firstSequence();
        long lastSequence = request.lastSequence();
        int eventCount = request.eventCount();
        String eventsDigest = request.eventsDigest();
        String previousCommitDigest = request.previousCommitDigest();
        String[] lines = new String(recordBytes, StandardCharsets.UTF_8)
                .split("\n");
        JsonNode[] records = new JsonNode[lines.length];
        int header = -1;
        for (int index = 0; index < lines.length; index++) {
            JsonNode record = parse(lines[index]);
            if (record == null) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        ManagedSessionStoreModels.ERROR_INVALID_REQUEST,
                        "Record line " + (index + 1) + " is not a JSON object"
                                + " the Session authority can read.");
            }
            records[index] = record;
            if (HEADER_SUBTYPE.equals(record.path("subtype").textValue())) {
                require(header < 0, "Record line " + (index + 1)
                        + " repeats the Managed header.");
                require(eventCount == 0, "Record line " + (index + 1)
                        + " holds the Managed header outside the genesis"
                        + " transaction.");
                requireLineBytes(lines[index], index,
                        ManagedSessionStoreModels.MAX_HEADER_BYTES);
                try {
                    ManagedSessionRecords.requireHeader(
                            record.get("managedSession"), tenantId,
                            workspaceId, sessionId);
                } catch (InvalidRecordException error) {
                    throw rejected(error.getMessage());
                }
                header = index;
            }
        }
        List<JsonNode> receipts = new ArrayList<>();
        List<JsonNode> events = new ArrayList<>();
        Set<String> transactionEventIds = new HashSet<>();
        int stageH = 0;
        boolean shaped = true;
        JsonNode markerBody = null;
        String lastSubtype = null;
        for (int index = 0; index < records.length; index++) {
            JsonNode record = records[index];
            require(sessionId.equals(record.path("sessionId").textValue()),
                    "Record line " + (index + 1)
                            + " does not name this Session at the top"
                            + " level.");
            String subtype = record.path("subtype").textValue();
            lastSubtype = subtype;
            if (HEADER_SUBTYPE.equals(subtype)) {
                continue;
            }
            if (!EVENT_SUBTYPE.equals(subtype)) {
                if (COMMIT_SUBTYPE.equals(subtype)) {
                    require(index > header, "Record line " + (index + 1)
                            + " precedes the Managed header.");
                    requireLineBytes(lines[index], index,
                            ManagedSessionStoreModels.MAX_COMMIT_MARKER_BYTES);
                    try {
                        ManagedSessionRecords.requireCommitMarker(
                                record.get("managedSession"), request);
                    } catch (InvalidRecordException error) {
                        throw rejected(error.getMessage());
                    }
                    markerBody = record.get("managedSession");
                } else {
                    // The scanner tolerates a foreign engine's records only
                    // before the genesis transaction's Managed header.
                    require(header >= 0 && index < header,
                            "Record line " + (index + 1) + " has the unknown"
                                    + " subtype " + subtype
                                    + " after the Managed header.");
                }
                shaped &= index >= eventCount;
                continue;
            }
            require(index < eventCount, "Record line " + (index + 1)
                    + " is not one of the transaction's events.");
            JsonNode event = record.path("managedSession");
            long occurredAt = requireEvent(event,
                    firstSequence + index);
            requireOwnSession(event, tenantId, workspaceId, sessionId,
                    "The event names another Session.");
            events.add(event);
            String kind = event.get("kind").textValue();
            try {
                ManagedSessionRecords.requireEventPayload(kind,
                        event.get("payload"));
                ManagedSessionRecords.requireEventSubject(kind,
                        event.get("subject"));
            } catch (InvalidRecordException error) {
                throw rejected(error.getMessage());
            }
            if ("checkpoint.committed".equals(kind)) {
                require(event.get("payload").get("coveredSequence")
                        .longValue() <= firstSequence - 1,
                        "Record line " + (index + 1) + " covers events not"
                                + " committed before its transaction.");
            }
            String eventId = event.get("eventId").textValue();
            require(transactionEventIds.add(eventId), "Record line "
                    + (index + 1)
                    + " repeats the event ID of another event in the"
                    + " transaction.");
            if ("tool.receipt".equals(kind)) {
                receipts.add(event);
            }
            String domain = null;
            if ("domain.committed".equals(kind)) {
                domain = event.path("payload").path("domain").textValue();
                require(domain != null && ManagedExtensionRecords.DOMAINS
                        .contains(domain), "Record line " + (index + 1)
                        + " commits a record of an unknown domain.");
                requireDomainPayload(event.get("payload"), domain,
                        ManagedExtensionProjection.RECORD_BODIES
                                .containsKey(domain));
            }
            Body body = domain == null ? null
                    : ManagedExtensionProjection.RECORD_BODIES.get(domain);
            if (body == null) {
                require(!RESERVED_EVENT_ID.matcher(eventId).matches(),
                        "Record line " + (index + 1) + " takes an event ID"
                                + " reserved for Stage H records.");
                continue;
            }
            // A Stage H revision event, which the authority never gives a
            // subject, is the last line to check before its revision lands.
            try {
                ManagedExtensionRecords.closed(event, EVENT_FIELDS, "event");
            } catch (InvalidRecordException error) {
                throw rejected(error.getMessage());
            }
            // The ID is the one the domain's chain assigns next, exactly:
            // any other <domain>:<count> ID the authority would refuse, and
            // a planted one wedges the chain once the authority loads it on
            // reopen and refuses its own legitimate revision as a repeat.
            long assigned = jdbc.queryForObject(
                    "SELECT COALESCE(SUM(revision), 0) FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_scope_key = ? AND domain = ?",
                    Long.class,
                    ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                    domain) + 1;
            require(eventId.equals(domain + ":" + assigned),
                    "Record line " + (index + 1) + " takes the event ID "
                            + eventId + "; the " + domain
                            + " chain assigns " + domain + ":" + assigned
                            + " to its next revision.");
            require(stageH == 0, "Record line " + (index + 1)
                    + " commits a second Stage H record revision, which the"
                    + " authority never writes in one transaction.");
            applyRevision(tenantId, workspaceId, sessionId, domain, body,
                    event.get("payload").get("operationId").textValue(),
                    event.get("payload").get("recordRef"),
                    firstSequence + index, occurredAt, resources);
            stageH++;
        }
        // Defense in depth: ManagedSessionStore.validateCommit pins
        // recordCount == eventCount + 1 outside the genesis, which is the
        // only transaction a header may appear in, so a transaction with a
        // header never reaches this rule with an unrouted line.
        require(header >= 0 || shaped && COMMIT_SUBTYPE.equals(lastSubtype),
                "A transaction with a Stage H record holds only its events,"
                        + " then its commit marker.");
        if (markerBody != null) {
            // The reader recomputes both content digests from the
            // transaction itself: the request must carry their true values,
            // not merely ones the marker repeats.
            ArrayNode eventsArray = JsonNodeFactory.instance.arrayNode();
            events.forEach(eventsArray::add);
            require(eventsDigest.equals(
                    ManagedSessionRecords.canonicalDigest(eventsArray)),
                    "The transaction's eventsDigest does not match its"
                            + " event content.");
            require(request.commitDigest() != null
                    && request.commitDigest().equals(
                            ManagedSessionRecords.canonicalDigest(markerBody)),
                    "The transaction's commitDigest does not match its"
                            + " commit marker.");
        }
        return receipts;
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
     * The envelope every journal event line must hold, checked as the
     * authority's reopen reader checks it: a closed event with an optional
     * subject, its format version, its sequence at its declared place, its
     * event ID, a time in the shared range and its kind against the shared
     * vocabulary. The per-kind payload, the subject and the top-level
     * Session are checked beside it. Returns the time the event occurred.
     */
    private static long requireEvent(JsonNode event, long sequence) {
        try {
            ManagedExtensionRecords.closedSubset(event, EVENT_SUBJECT_FIELDS,
                    "event");
            ManagedExtensionRecords.count(event.get("v"), 1, 1, "event.v");
            ManagedExtensionRecords.count(event.get("sequence"), sequence,
                    sequence, "event.sequence");
            ManagedExtensionRecords.id(event.get("eventId"), "event.eventId");
            long occurredAt = ManagedExtensionRecords.count(event.get(
                    "occurredAt"), 0, ManagedExtensionRecords.MAX_TIME,
                    "event.occurredAt");
            ManagedExtensionRecords.closed(event.get("sessionKey"),
                    SESSION_KEY_FIELDS, "event.sessionKey");
            ManagedExtensionRecords.oneOf(event.get("kind"),
                    ManagedExtensionRecords.EVENT_KINDS, "event.kind");
            return occurredAt;
        } catch (InvalidRecordException error) {
            throw rejected(error.getMessage());
        }
    }

    /** The event names the Session the transaction commits to. */
    private static void requireOwnSession(JsonNode event, String tenantId,
            String workspaceId, String sessionId, String names) {
        JsonNode key = event.get("sessionKey");
        require(tenantId.equals(key.get("tenantId").textValue())
                && workspaceId.equals(key.get("workspaceId").textValue())
                && sessionId.equals(key.get("sessionId").textValue()),
                names);
    }

    /**
     * The payload of a domain.committed event as the authority's reader
     * accepts it, whether or not a record body is registered for the
     * domain: closed over the four fields, version 1, a well-formed
     * operation ID and a durable reference that names a version 1 record of
     * the domain.
     */
    private static void requireDomainPayload(JsonNode payload, String domain,
            boolean stageH) {
        try {
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
        JsonNode recordRef = payload.get("recordRef");
        require(("managed-" + domain).equals(recordRef.get("kind")
                .textValue()) && recordRef.get("schemaVersion")
                        .longValue() == 1,
                (stageH ? "The Stage H record" : "The committed record")
                        + " must reference managed-" + domain
                        + " version 1.");
    }

    /** A record line no longer, in UTF-8 bytes, than its kind's cap. */
    private static void requireLineBytes(String line, int index,
            int maxBytes) {
        // Texts of at most maxBytes/3 characters fit any cap; texts longer
        // than maxBytes characters miss any cap — UTF-8 costs one to three
        // bytes per BMP char. Only the band between needs the encoding.
        long chars = line.length();
        require(3L * chars <= maxBytes || (chars > maxBytes ? false
                : line.getBytes(StandardCharsets.UTF_8).length <= maxBytes),
                "Record line " + (index + 1) + " exceeds " + maxBytes
                        + " UTF-8 bytes.");
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
                occurredAt);
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
            announce(tenantId, scopeKey, sessionId,
                    ManagedExtensionProjection.taskId(recordKey),
                    projection.state(), revision, sequence);
        }
    }

    /**
     * Announces a changed task view on the Session's task-event outbox, in
     * the same transaction, when the tenant's Session exists and is neither
     * deleted nor being deleted, so a deleted Session accumulates no rows
     * the task-events feed can never deliver. The announcement stays out of
     * the Session event stream, whose message projection reads it as a
     * content boundary: an announcement between two streamed text deltas
     * would split the stored message part. The task-events feed drains this
     * table in journal order.
     */
    private void announce(String tenantId, String scopeKey, String sessionId,
            String taskId, String state, long revision, long sequence) {
        if (sessions == null
                || !sessions.isLivePublicSession(tenantId, sessionId)) {
            return;
        }
        jdbc.update("INSERT INTO qwen_managed_session_task_event"
                        + " (session_scope_key, tenant_id, session_id,"
                        + " task_id, task_state, revision, journal_sequence)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?)",
                scopeKey, tenantId, sessionId, taskId, state, revision,
                sequence);
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
}
