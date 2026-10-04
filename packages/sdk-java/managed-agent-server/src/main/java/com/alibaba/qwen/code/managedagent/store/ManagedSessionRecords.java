package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The managed-session/1 journal-line contract
 * (packages/core/src/managed-runtime/managed-session-records.ts), mirrored
 * so the store refuses at commit time every record line the Session
 * authority's reopen reader would throw on: each event's per-kind payload
 * schema and payload rules, its subject shapes, the genesis header and the
 * commit marker. Every vocabulary here is pinned element by element against
 * the shared store fixture by ManagedSessionStoreContractFixtureTest, so a
 * kind or a rule added on the authority side cannot silently miss its
 * mirror — the same fixture is asserted against MANAGED_SESSION_EVENT_KINDS,
 * EVENT_SCHEMAS and ACTIVATION_SUBJECT_KINDS in
 * managed-session-store-contract.test.ts.
 */
public final class ManagedSessionRecords {
    public static final List<String> ACTIVATION_PHASES = List.of("installing",
            "active", "released", "revoked");
    public static final List<String> MODEL_ATTEMPT_STATES = List.of("started",
            "output_committed", "abandoned");
    public static final List<String> ACTION_SOURCES = List.of("tool_call",
            "automation_run", "team_plan", "user_operation");
    public static final List<String> ACTION_STATES = List.of("requested",
            "decided", "cancelled", "expired");
    public static final List<String> LIFECYCLE_STATES = List.of("idle",
            "active", "closing", "closed", "archived", "deleting", "deleted",
            "recovery_blocked");
    /** Mirrors ACTIVATION_SUBJECT_KINDS on the authority side. */
    public static final Map<String, Boolean> ACTIVATION_SUBJECT_KINDS;
    /**
     * The transitions the reader allows between lifecycle states. An absent
     * from allows only {@code idle}, and any non-final state may also block
     * into {@code recovery_blocked}.
     */
    public static final Map<String, List<String>> LIFECYCLE_TRANSITIONS;
    /** The per-kind payload contract of the authority's EVENT_SCHEMAS. */
    public static final Map<String, PayloadSchema> PAYLOAD_SCHEMAS;
    /** The free-text payload bound both `text` and `rawText` share. */
    public static final int MAX_TEXT_BYTES = 4096;
    private static final Pattern READER_VERSION = Pattern.compile(
            "^managed-session/(0|[1-9][0-9]*)$");

    /** A kind's payload: closed fields by name, and the optional ones. */
    public record PayloadSchema(Map<String, String> fields,
            List<String> optional) {
    }

    static {
        Map<String, Boolean> subjects = new LinkedHashMap<>();
        for (String kind : ManagedExtensionRecords.EVENT_KINDS) {
            subjects.put(kind, false);
        }
        for (String kind : List.of("model.attempt", "tool.intent",
                "message.delta", "checkpoint.committed", "context.compacted",
                "message.retracted")) {
            subjects.put(kind, true);
        }
        ACTIVATION_SUBJECT_KINDS = Map.copyOf(subjects);

        Map<String, List<String>> transitions = new LinkedHashMap<>();
        transitions.put("idle", List.of("active", "closing"));
        transitions.put("active", List.of("idle", "closing"));
        transitions.put("closing", List.of("closed"));
        transitions.put("closed", List.of("archived", "deleting"));
        transitions.put("archived", List.of("closed", "deleting"));
        transitions.put("deleting", List.of("deleted"));
        transitions.put("deleted", List.of());
        transitions.put("recovery_blocked", List.of("idle", "active",
                "closing", "closed", "archived", "deleting"));
        LIFECYCLE_TRANSITIONS = Map.copyOf(transitions);

        Map<String, PayloadSchema> schemas = new LinkedHashMap<>();
        schemas.put("input.accepted", schema(
                fields("inputId", "id", "turnId", "id", "source", "text",
                        "contentRef", "ref", "deadline", "timeOrNull",
                        "admissionRef", "ref")));
        schemas.put("wake.requested", schema(
                fields("wakeId", "id", "reason", "text", "subject",
                        "subject", "sourceEventId", "id", "requiredSequence",
                        "sequence")));
        schemas.put("activation.changed", schema(
                fields("activationId", "id", "epoch", "sequence", "workerId",
                        "id", "subject", "subject", "phase", "text",
                        "leaseDurationMs", "sequenceOrNull", "expiresAt",
                        "timeOrNull", "installRef", "refOrNull", "boundaryRef",
                        "refOrNull", "renewalSeq", "sequence"),
                List.of("renewalSeq")));
        schemas.put("model.attempt", schema(
                fields("attemptId", "id", "routeRef", "ref",
                        "inputCheckpointRef", "refOrNull", "state", "text",
                        "usageRef", "refOrNull")));
        schemas.put("message.committed", schema(
                fields("messageId", "id", "role", "text", "contentRef",
                        "ref", "modelAttemptId", "idOrNull",
                        "parentMessageId", "idOrNull"),
                List.of("modelAttemptId")));
        schemas.put("tool.intent", schema(
                fields("executionCallId", "id", "batchId", "id", "ordinal",
                        "sequence", "toolDefinitionRef", "ref", "argsRef",
                        "ref", "outcomeSource", "text")));
        schemas.put("action.changed", schema(
                fields("requestId", "id", "kind", "text", "source", "text",
                        "inputRevision", "sequence", "optionsRef",
                        "refOrNull", "state", "text", "decisionRef",
                        "refOrNull")));
        schemas.put("tool.receipt", schema(
                fields("executionCallId", "id", "toolOutcomeRef", "ref",
                        "resultRef", "refOrNull", "resources", "refs",
                        "historyRevision", "sequence")));
        schemas.put("checkpoint.committed", schema(
                fields("checkpointId", "id", "coveredSequence", "sequence",
                        "previousCheckpointId", "idOrNull", "stateRef",
                        "ref", "boundary", "textOrNull")));
        schemas.put("context.compacted", schema(
                fields("compactionId", "id", "fromSequence", "sequence",
                        "toSequence", "sequence", "summaryRef", "ref",
                        "replacedMessageIds", "ids", "tokenCountsRef",
                        "refOrNull")));
        schemas.put("cancel.requested", schema(
                fields("requestId", "id", "target", "json", "reason",
                        "text", "requestedBy", "text")));
        schemas.put("turn.settled", schema(
                fields("turnId", "id", "outcome", "text", "stopReason",
                        "textOrNull", "resultRef", "refOrNull", "usageRef",
                        "refOrNull", "pendingOwnersRef", "refOrNull")));
        schemas.put("config.bound", schema(
                fields("revision", "sequence", "previousRevision",
                        "sequenceOrNull", "bundleRef", "ref",
                        "rootSnapshotRef", "ref")));
        schemas.put("lifecycle.changed", schema(
                fields("operationId", "id", "from", "textOrNull", "to",
                        "text", "reason", "text", "pendingOwnersRef",
                        "refOrNull")));
        schemas.put("domain.committed", schema(
                fields("domain", "text", "version", "sequence",
                        "operationId", "id", "recordRef", "ref")));
        schemas.put("message.delta", schema(
                fields("messageId", "id", "turnId", "id", "role", "text",
                        "text", "rawText")));
        schemas.put("message.retracted", schema(
                fields("messageId", "id", "turnId", "id", "fromSequence",
                        "sequence")));
        PAYLOAD_SCHEMAS = Map.copyOf(schemas);
    }

    private static Map<String, String> fields(String... nameAndKind) {
        Map<String, String> fields = new LinkedHashMap<>();
        for (int index = 0; index < nameAndKind.length; index += 2) {
            fields.put(nameAndKind[index], nameAndKind[index + 1]);
        }
        return fields;
    }

    private static PayloadSchema schema(Map<String, String> fields) {
        return new PayloadSchema(
                java.util.Collections.unmodifiableMap(fields), List.of());
    }

    private static PayloadSchema schema(Map<String, String> fields,
            List<String> optional) {
        return new PayloadSchema(
                java.util.Collections.unmodifiableMap(fields), optional);
    }

    private ManagedSessionRecords() {
    }

    /**
     * The payload of one event of {@code kind}, as the reader's schema
     * requires it: closed over its fields, every required one present and
     * of its kind's shape, then the per-kind rules. The domain.committed
     * rules live in the store's domain path, which refuses unknown domains
     * and checks the record reference for registered and Stage H bodies
     * alike.
     */
    static void requireEventPayload(String kind, JsonNode payload) {
        PayloadSchema schema = PAYLOAD_SCHEMAS.get(kind);
        if (schema == null) {
            // The kind vocabulary is checked before its payload.
            return;
        }
        require(payload != null && payload.isObject(),
                "payload must be a JSON object");
        payload.fieldNames().forEachRemaining(name -> require(
                schema.fields().containsKey(name),
                "payload has the unexpected field " + name + " for "
                        + kind));
        for (Map.Entry<String, String> field : schema.fields().entrySet()) {
            String name = field.getKey();
            if (!payload.has(name)) {
                require(schema.optional().contains(name),
                        "payload." + name + " is required for " + kind);
                continue;
            }
            checkField(name, field.getValue(), payload.get(name));
        }
        payloadRules(kind, payload);
    }

    /** The subject one event carries, and the kinds that must carry one. */
    static void requireEventSubject(String kind, JsonNode subject) {
        Boolean activation = ACTIVATION_SUBJECT_KINDS.get(kind);
        if (subject == null) {
            require(activation == null || !activation,
                    kind + " requires an activation subject");
            return;
        }
        requireSubject(subject, "event.subject");
        require(activation == null || !activation
                || "activation".equals(subject.get("type").textValue()),
                kind + " requires an activation subject");
    }

    /**
     * A subject as the reader checks it: one of three closed shapes.
     */
    static void requireSubject(JsonNode node, String label) {
        require(node != null && node.isObject(),
                label + " must be a JSON object");
        String type = node.path("type").textValue();
        if ("activation".equals(type)) {
            ManagedExtensionRecords.closedSubset(node, Set.of("type",
                    "scopeId", "activationId", "epoch"), label);
            ManagedExtensionRecords.id(node.get("scopeId"),
                    label + ".scopeId");
            ManagedExtensionRecords.id(node.get("activationId"),
                    label + ".activationId");
            ManagedExtensionRecords.count(node.get("epoch"), 0,
                    Long.MAX_VALUE, label + ".epoch");
            return;
        }
        if ("turn".equals(type)) {
            ManagedExtensionRecords.closedSubset(node,
                    Set.of("type", "turnId"), label);
            ManagedExtensionRecords.id(node.get("turnId"), label + ".turnId");
            return;
        }
        if ("hook_operation".equals(type)) {
            ManagedExtensionRecords.closedSubset(node, Set.of("type",
                    "operationId", "occurrenceId"), label);
            ManagedExtensionRecords.id(node.get("operationId"),
                    label + ".operationId");
            ManagedExtensionRecords.id(node.get("occurrenceId"),
                    label + ".occurrenceId");
            return;
        }
        throw new InvalidRecordException(label + ".type must be activation,"
                + " turn or hook_operation.");
    }

    /**
     * The genesis header as the reader parses it, and the Session it must
     * name.
     */
    static void requireHeader(JsonNode node, String tenantId,
            String workspaceId, String sessionId) {
        ManagedExtensionRecords.closedSubset(node, Set.of("formatVersion",
                "minimumReader", "sessionKey", "engine", "definitionRef",
                "rootSnapshotRef", "createdBy", "baseTranscriptProof"),
                "header");
        JsonNode formatVersion = node.get("formatVersion");
        require(formatVersion != null && formatVersion.isNumber()
                && formatVersion.decimalValue().compareTo(BigDecimal.ONE)
                        == 0,
                "header.formatVersion is not supported by this reader");
        JsonNode minimumReader = node.get("minimumReader");
        require(minimumReader != null && minimumReader.isTextual()
                && READER_VERSION.matcher(minimumReader.textValue())
                        .matches()
                && ("managed-session/0".equals(minimumReader.textValue())
                        || "managed-session/1".equals(
                                minimumReader.textValue())),
                "header.minimumReader is not supported by this reader");
        JsonNode engine = node.get("engine");
        require(engine != null && "managed".equals(engine.textValue()),
                "header.engine must be managed");
        JsonNode key = node.get("sessionKey");
        ManagedExtensionRecords.closedSubset(key,
                Set.of("tenantId", "workspaceId", "sessionId"),
                "header.sessionKey");
        for (String field : List.of("tenantId", "workspaceId", "sessionId")) {
            ManagedExtensionRecords.id(key.get(field),
                    "header.sessionKey." + field);
        }
        require(tenantId.equals(key.get("tenantId").textValue())
                && workspaceId.equals(key.get("workspaceId").textValue())
                && sessionId.equals(key.get("sessionId").textValue()),
                "the genesis transaction belongs to a different session");
        ManagedExtensionRecords.durableRef(node.get("definitionRef"),
                "header.definitionRef");
        ManagedExtensionRecords.durableRef(node.get("rootSnapshotRef"),
                "header.rootSnapshotRef");
        ManagedExtensionRecords.id(node.get("createdBy"), "header.createdBy");
        if (node.has("baseTranscriptProof")) {
            ManagedExtensionRecords.durableRef(
                    node.get("baseTranscriptProof"),
                    "header.baseTranscriptProof");
        }
    }

    /**
     * The commit marker as the reader parses it, agreeing with the
     * transaction its request declares on all nine fields, since the store
     * keys its durable row and the replay idempotency by the request while
     * the authority's reopen keys by the marker.
     */
    static void requireCommitMarker(JsonNode node,
            ManagedSessionStoreModels.CommitTransactionRequest request) {
        ManagedExtensionRecords.closedSubset(node, Set.of("transactionId",
                "commandId", "operation", "contentDigest", "firstSequence",
                "lastSequence", "eventCount", "eventsDigest",
                "previousCommitDigest"), "commit");
        ManagedExtensionRecords.id(node.get("transactionId"),
                "commit.transactionId");
        ManagedExtensionRecords.id(node.get("commandId"), "commit.commandId");
        text(node.get("operation"), "commit.operation");
        ManagedExtensionRecords.digest(node.get("contentDigest"),
                "commit.contentDigest");
        ManagedExtensionRecords.digest(node.get("eventsDigest"),
                "commit.eventsDigest");
        JsonNode previous = node.get("previousCommitDigest");
        // Absent is not null: the reader refuses the missing member while
        // an explicit JSON null is legal for a first commit after genesis.
        require(previous != null,
                "commit.previousCommitDigest is required");
        if (!previous.isNull()) {
            ManagedExtensionRecords.digest(previous,
                    "commit.previousCommitDigest");
        }
        long markerFirst = ManagedExtensionRecords.count(
                node.get("firstSequence"), 1, Long.MAX_VALUE,
                "commit.firstSequence");
        long markerLast = ManagedExtensionRecords.count(
                node.get("lastSequence"), 1, Long.MAX_VALUE,
                "commit.lastSequence");
        long markerCount = ManagedExtensionRecords.count(
                node.get("eventCount"), 1,
                ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS,
                "commit.eventCount");
        require(markerLast - markerFirst + 1 == markerCount,
                "commit sequence range must match commit.eventCount");
        require(request.transactionId().equals(
                        node.get("transactionId").textValue())
                && request.commandId().equals(
                        node.get("commandId").textValue())
                && request.operation().equals(
                        node.get("operation").textValue())
                && request.contentDigest().equals(
                        node.get("contentDigest").textValue())
                && markerFirst == request.firstSequence()
                && markerLast == request.lastSequence()
                && markerCount == request.eventCount()
                && request.eventsDigest().equals(
                        node.get("eventsDigest").textValue())
                && Objects.equals(request.previousCommitDigest(),
                        previous.isNull() ? null : previous.textValue()),
                "commit marker does not agree with the transaction its"
                        + " request declares");
    }

    private static void checkField(String name, String fieldKind,
            JsonNode value) {
        String label = "payload." + name;
        switch (fieldKind) {
            case "id" -> ManagedExtensionRecords.id(value, label);
            case "idOrNull" -> {
                if (!value.isNull()) {
                    ManagedExtensionRecords.id(value, label);
                }
            }
            case "ids" -> {
                require(value.isArray(), label + " must be an array");
                for (int index = 0; index < value.size(); index++) {
                    ManagedExtensionRecords.id(value.get(index),
                            label + "[" + index + "]");
                }
            }
            case "sequence" -> ManagedExtensionRecords.count(value, 0,
                    Long.MAX_VALUE, label);
            case "sequenceOrNull" -> {
                if (!value.isNull()) {
                    ManagedExtensionRecords.count(value, 0, Long.MAX_VALUE,
                            label);
                }
            }
            case "timeOrNull" -> {
                if (!value.isNull()) {
                    ManagedExtensionRecords.count(value, 0,
                            ManagedExtensionRecords.MAX_TIME, label);
                }
            }
            case "ref" -> ManagedExtensionRecords.durableRef(value, label);
            case "refOrNull" -> {
                if (!value.isNull()) {
                    ManagedExtensionRecords.durableRef(value, label);
                }
            }
            case "refs" -> {
                require(value.isArray(), label + " must be an array");
                for (int index = 0; index < value.size(); index++) {
                    ManagedExtensionRecords.durableRef(value.get(index),
                            label + "[" + index + "]");
                }
            }
            case "text" -> text(value, label);
            case "textOrNull" -> {
                if (!value.isNull()) {
                    text(value, label);
                }
            }
            case "rawText" -> rawText(value, label);
            case "subject" -> requireSubject(value, label);
            case "json" -> {
                // Any finite JSON value; the line's parse already enforces.
            }
            default -> throw new IllegalStateException(
                    "unknown field kind " + fieldKind);
        }
    }

    private static void payloadRules(String kind, JsonNode payload) {
        switch (kind) {
            case "wake.requested" -> require(
                    payload.get("requiredSequence").longValue() >= 1,
                    "payload.requiredSequence must start at 1");
            case "activation.changed" -> {
                String phase = ManagedExtensionRecords.oneOf(
                        payload.get("phase"), ACTIVATION_PHASES,
                        "payload.phase");
                boolean open = "installing".equals(phase)
                        || "active".equals(phase);
                require(!payload.get("expiresAt").isNull(),
                        "payload.expiresAt must be present when phase is "
                                + phase);
                if (open) {
                    require(!payload.get("leaseDurationMs").isNull(),
                            "payload.leaseDurationMs must be present when"
                                    + " phase is " + phase);
                    require(!payload.get("installRef").isNull(),
                            "payload.installRef must be present when phase"
                                    + " is " + phase);
                    require(payload.get("boundaryRef").isNull(),
                            "payload.boundaryRef must be null when phase is "
                                    + phase);
                } else {
                    require(!payload.get("boundaryRef").isNull(),
                            "payload.boundaryRef must be present when phase"
                                    + " is " + phase);
                }
            }
            case "model.attempt" -> {
                String state = ManagedExtensionRecords.oneOf(
                        payload.get("state"), MODEL_ATTEMPT_STATES,
                        "payload.state");
                require(!"started".equals(state)
                        || payload.get("usageRef").isNull(),
                        "payload.usageRef must be null while the attempt is"
                                + " started");
            }
            case "action.changed" -> {
                ManagedExtensionRecords.oneOf(payload.get("source"),
                        ACTION_SOURCES, "payload.source");
                String state = ManagedExtensionRecords.oneOf(
                        payload.get("state"), ACTION_STATES, "payload.state");
                boolean decided = "decided".equals(state);
                require(decided != payload.get("decisionRef").isNull(),
                        "payload.decisionRef must be "
                                + (decided ? "present" : "null")
                                + " when state is " + state);
            }
            case "lifecycle.changed" -> {
                String to = ManagedExtensionRecords.oneOf(payload.get("to"),
                        LIFECYCLE_STATES, "payload.to");
                String from = payload.get("from").isNull() ? null
                        : ManagedExtensionRecords.oneOf(payload.get("from"),
                                LIFECYCLE_STATES, "payload.from");
                require(isLifecycleTransitionAllowed(from, to),
                        "payload cannot transition from "
                                + (from == null ? "null" : from) + " to "
                                + to);
            }
            case "context.compacted" -> {
                long from = payload.get("fromSequence").longValue();
                long to = payload.get("toSequence").longValue();
                require(from >= 1 && to >= 1,
                        "payload sequence references must start at 1");
                require(to >= from,
                        "payload.toSequence must not precede"
                                + " payload.fromSequence");
            }
            case "checkpoint.committed" -> require(
                    payload.get("coveredSequence").longValue() >= 1,
                    "payload.coveredSequence must start at 1");
            default -> {
                // The domain.committed rules live in the store's domain
                // path; the other kinds carry shapes only.
            }
        }
    }

    /** The lifecycle steps the reader allows, with its two special cases. */
    private static boolean isLifecycleTransitionAllowed(String from,
            String to) {
        if (from == null) {
            return "idle".equals(to);
        }
        if ("recovery_blocked".equals(to)) {
            return !"deleted".equals(from) && !"recovery_blocked".equals(from);
        }
        List<String> next = LIFECYCLE_TRANSITIONS.get(from);
        return next != null && next.contains(to);
    }

    /** A bounded free-text field as the reader bounds one: no controls. */
    private static void text(JsonNode node, String label) {
        require(node != null && node.isTextual()
                && !node.textValue().isEmpty(),
                label + " must be a non-empty string");
        String value = node.textValue();
        boolean controlled = false;
        for (int index = 0; !controlled && index < value.length(); index++) {
            char character = value.charAt(index);
            controlled = character <= 0x1f || character >= 0x7f
                    && character <= 0x9f;
        }
        require(!controlled, () -> label + " must not contain control"
                + " characters");
        require(value.getBytes(StandardCharsets.UTF_8).length
                <= MAX_TEXT_BYTES,
                label + " exceeds " + MAX_TEXT_BYTES + " UTF-8 bytes");
    }

    /** Free-form output text: bounded in size only. */
    private static void rawText(JsonNode node, String label) {
        require(node != null && node.isTextual()
                && !node.textValue().isEmpty(),
                label + " must be a non-empty string");
        require(node.textValue().getBytes(StandardCharsets.UTF_8).length
                <= MAX_TEXT_BYTES,
                label + " exceeds " + MAX_TEXT_BYTES + " UTF-8 bytes");
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new InvalidRecordException(message + ".");
        }
    }

    /** Builds the refusal message only on the line that produces one. */
    private static void require(boolean condition,
            java.util.function.Supplier<String> message) {
        if (!condition) {
            throw new InvalidRecordException(message.get() + ".");
        }
    }

    /**
     * The lowercase SHA-256 hex digest of the value in canonical JSON, byte
     * identical to the authority's canonicalJson /
     * canonicalManagedSessionJson: objects with keys sorted as UTF-16 text,
     * arrays in order, strings as JSON.stringify writes them, numbers as
     * ECMA-262 writes them. Used by the store to recompute the two content
     * digests the reader recomputes rather than trusting the request.
     * Pinned case by case in the shared store fixture (canonicalJsonCases).
     */
    public static String canonicalDigest(JsonNode value) {
        StringBuilder out = new StringBuilder();
        canonicalJson(value, out);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(
                    "SHA-256").digest(out.toString().getBytes(
                            StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static void canonicalJson(JsonNode value, StringBuilder out) {
        if (value == null || value.isNull()) {
            out.append("null");
        } else if (value.isTextual()) {
            out.append(jsonString(value.textValue()));
        } else if (value.isBoolean()) {
            out.append(value.booleanValue() ? "true" : "false");
        } else if (value.isNumber()) {
            out.append(numberString(value.decimalValue()));
        } else if (value.isArray()) {
            out.append('[');
            for (int index = 0; index < value.size(); index++) {
                if (index > 0) {
                    out.append(',');
                }
                canonicalJson(value.get(index), out);
            }
            out.append(']');
        } else {
            out.append('{');
            List<String> keys = new ArrayList<>();
            value.fieldNames().forEachRemaining(keys::add);
            keys.sort(null);
            for (int index = 0; index < keys.size(); index++) {
                if (index > 0) {
                    out.append(',');
                }
                out.append(jsonString(keys.get(index))).append(':');
                canonicalJson(value.get(keys.get(index)), out);
            }
            out.append('}');
        }
    }

    /** A string as JSON.stringify writes it: only the escapes JSON requires. */
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private static String jsonString(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2);
        out.append('"');
        for (int index = 0; index < value.length(); index++) {
            char c = value.charAt(index);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c <= 0x1f) {
                        out.append("\\u00").append(HEX[c >> 4])
                                .append(HEX[c & 0xf]);
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        return out.append('"').toString();
    }

    /**
     * A number as ECMA-262 writes it: plain digits while the exponent of
     * the first significant digit is between -6 and 20, the one-e form
     * outside it. The digit sequence comes from the double's shortest
     * round-trip form, which Java and V8 agree on.
     */
    private static String numberString(BigDecimal value) {
        BigDecimal stripped = value.stripTrailingZeros();
        if (stripped.signum() == 0) {
            return "0";
        }
        // exponent of the first significant digit: plain -1's magnitude
        int exponent = stripped.precision() - stripped.scale() - 1;
        if (exponent >= -6 && exponent < 21) {
            return stripped.toPlainString();
        }
        String digits = stripped.unscaledValue().abs().toString();
        String mantissa = digits.length() == 1 ? digits
                : digits.charAt(0) + "." + digits.substring(1);
        return (stripped.signum() < 0 ? "-" : "") + mantissa + "e"
                + (exponent >= 0 ? "+" : "") + exponent;
    }
}
