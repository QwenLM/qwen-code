package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/** Narrow original native activation, input/wake and initial checkpoint proof for CSI. */
public final class CsiNativeActivationProof {
    private static final long MAX_SAFE = 9_007_199_254_740_990L;
    private static final Set<String> ENVELOPE = Set.of("uuid", "parentUuid", "sessionId", "timestamp",
            "type", "subtype", "cwd", "version", "managedSession");
    private static final Set<String> MARKER = Set.of("transactionId", "commandId", "operation", "contentDigest",
            "firstSequence", "lastSequence", "eventCount", "eventsDigest", "previousCommitDigest");
    private static final Set<String> PAYLOAD = Set.of("activationId", "epoch", "workerId", "subject",
            "phase", "leaseDurationMs", "expiresAt", "installRef", "boundaryRef");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64).build()).build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    private CsiNativeActivationProof() {
    }

    public record Genesis(String definitionDigest, String definitionResourceId,
            String rootResourceId, String lastRecordUuid) {
    }

    public record Transaction(List<JsonNode> events, String lastRecordUuid) {
    }

    public record Activation(String activationId, String workerId, JsonNode installRef,
            long leaseDurationMs, long expiresAt, long renewalSequence) {
    }

    public record Prefix(String inputId, String checkpointResourceId) {
    }

    public static List<JsonNode> records(byte[] bytes) {
        require(bytes != null && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            require(text.endsWith("\n"));
            List<JsonNode> result = new ArrayList<>();
            for (String line : text.substring(0, text.length() - 1).split("\n", -1)) {
                JsonNode record = object(JSON.readTree(line));
                require(line.getBytes(StandardCharsets.UTF_8).length <=
                        ("managed_session_commit_v1".equals(record.path("subtype").textValue()) ? 64 * 1024 : 1024 * 1024));
                result.add(record);
            }
            require(result.size() <= 257);
            return List.copyOf(result);
        } catch (IOException error) {
            throw invalid();
        }
    }

    public static Genesis genesis(List<JsonNode> records, RuntimeProvisionRequest original,
            Function<JsonNode, byte[]> resources) {
        require(records.size() == 2);
        JsonNode engine = records.getFirst();
        Set<String> engineFields = new java.util.HashSet<>(ENVELOPE);
        engineFields.remove("managedSession");
        engineFields.add("systemPayload");
        closed(engine, engineFields);
        envelope(engine, original, "session_execution_engine", null);
        closed(engine.path("systemPayload"), Set.of("version", "engine"));
        require(number(engine.path("systemPayload").get("version")) == 1
                && "managed".equals(text(engine.path("systemPayload"), "engine")));
        JsonNode headerRecord = records.getLast();
        closed(headerRecord, ENVELOPE);
        envelope(headerRecord, original, "managed_session_header_v1", text(engine, "uuid"));
        JsonNode header = headerRecord.path("managedSession");
        closed(header, Set.of("formatVersion", "minimumReader", "sessionKey", "engine",
                "definitionRef", "rootSnapshotRef", "createdBy"));
        require(number(header.get("formatVersion")) == 1
                && "managed-session/1".equals(text(header, "minimumReader"))
                && "managed".equals(text(header, "engine")));
        key(header.path("sessionKey"), original);
        require("hosted-harness".equals(text(header, "createdBy")));
        JsonNode definition = readObject(reference(header.path("definitionRef"), "managed-definition", resources));
        closed(definition, Set.of("engine", "sessionId", "toolProfile"));
        require("managed".equals(text(definition, "engine"))
                && original.getIsolationKey().equals(text(definition, "sessionId"))
                && CsiFilesRetirementProfile.PROFILE.equals(text(definition, "toolProfile")));
        JsonNode root = readObject(reference(header.path("rootSnapshotRef"), "managed-root", resources));
        closed(root, Set.of("cwd"));
        require(original.getScope().getCanonicalCwd().equals(text(root, "cwd")));
        return new Genesis(text(header.path("definitionRef"), "digest"),
                id(header.path("definitionRef"), "resourceId"), id(header.path("rootSnapshotRef"), "resourceId"),
                text(headerRecord, "uuid"));
    }

    public static Transaction transaction(List<JsonNode> records, JsonNode metadata,
            RuntimeProvisionRequest original, String parentUuid) {
        long count = number(metadata.get("eventCount"));
        require(count > 0 && count <= 256 && records.size() == count + 1);
        long first = number(metadata.get("firstSequence"));
        require(first > 0 && number(metadata.get("lastSequence")) == first + count - 1);
        List<JsonNode> events = new ArrayList<>();
        for (int index = 0; index < records.size(); index++) {
            JsonNode record = records.get(index);
            closed(record, ENVELOPE);
            envelope(record, original, index < count ? "managed_session_event_v1"
                    : "managed_session_commit_v1", parentUuid);
            parentUuid = text(record, "uuid");
            if (index < count) {
                JsonNode event = object(record.path("managedSession"));
                require(number(event.get("v")) == 1 && number(event.get("sequence")) == first + index);
                key(event.path("sessionKey"), original);
                events.add(event);
            }
        }
        JsonNode marker = records.getLast().path("managedSession");
        closed(marker, MARKER);
        id(marker, "transactionId");
        id(marker, "commandId");
        require(number(marker.get("firstSequence")) == first
                && number(marker.get("lastSequence")) == first + count - 1
                && number(marker.get("eventCount")) == count);
        text(marker, "operation");
        text(marker, "contentDigest");
        text(marker, "eventsDigest");
        if (!marker.path("previousCommitDigest").isNull()) {
            text(marker, "previousCommitDigest");
        }
        for (String field : MARKER) {
            require(metadata.has(field) && canonical(marker.get(field)).equals(canonical(metadata.get(field))));
        }
        require(sha256(canonical(marker).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "commitDigest")));
        var array = JSON.createArrayNode();
        events.forEach(array::add);
        require(sha256(canonical(array).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "eventsDigest")));
        return new Transaction(List.copyOf(events), parentUuid);
    }

    public static Prefix advance(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, String writerId, Genesis genesis, Activation activation,
            long previousSequence, Prefix previous, Function<JsonNode, byte[]> resources) {
        require(activation != null && writerId.equals(activation.workerId())
                && writerId.equals(text(metadata, "writerId"))
                && number(metadata.get("writerGeneration")) == 1 && number(metadata.get("activationEpoch")) == 1);
        if ("submitInput".equals(text(metadata, "operation"))) {
            require(previous.inputId() == null);
            return new Prefix(input(transaction, metadata, original, activation, previousSequence, resources),
                    previous.checkpointResourceId());
        }
        require(previous.checkpointResourceId() == null);
        return new Prefix(previous.inputId(), initialCheckpoint(transaction, metadata, original, writerId,
                genesis, activation, previousSequence, resources));
    }

    private static String input(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousSequence, Function<JsonNode, byte[]> resources) {
        require(transaction.events().size() == 2 && metadata.path("latestCheckpointResourceId").isNull());
        JsonNode accepted = transaction.events().getFirst();
        JsonNode wake = transaction.events().getLast();
        for (JsonNode event : transaction.events()) {
            closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "payload"));
            key(event.path("sessionKey"), original);
            require(number(event.get("v")) == 1);
        }
        require("input.accepted".equals(text(accepted, "kind")) && "wake.requested".equals(text(wake, "kind"))
                && number(accepted.get("sequence")) == previousSequence + 1
                && number(wake.get("sequence")) == previousSequence + 2
                && time(accepted.get("occurredAt")) < activation.expiresAt()
                && time(wake.get("occurredAt")) == time(accepted.get("occurredAt")));
        JsonNode payload = accepted.path("payload");
        closed(payload, Set.of("inputId", "turnId", "source", "contentRef", "deadline", "admissionRef"));
        String inputId = id(payload, "inputId");
        require(inputId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                && inputId.equals(id(payload, "turnId")) && inputId.equals(id(metadata, "commandId"))
                && "hosted-harness".equals(text(payload, "source"))
                && (inputId + ":accepted").equals(id(accepted, "eventId")));
        if (!payload.path("deadline").isNull()) {
            time(payload.get("deadline"));
        }
        byte[] inputBytes = reference(payload.path("contentRef"), "managed-input", resources);
        require(inputBytes.length <= 64 * 1024 && sha256(inputBytes).equals(text(metadata, "contentDigest")));
        JsonNode blocks = readJson(inputBytes);
        require(blocks != null && blocks.isArray() && !blocks.isEmpty());
        for (JsonNode block : blocks) {
            closed(block, Set.of("type", "text"));
            require("text".equals(text(block, "type")) && block.path("text").isTextual()
                    && !block.path("text").textValue().isEmpty());
        }
        byte[] admissionBytes = reference(payload.path("admissionRef"), "managed-admission", resources);
        require(admissionBytes.length <= 64 * 1024);
        JsonNode admission = readObject(admissionBytes);
        closed(admission, Set.of("promptId", "digest"));
        require(inputId.equals(id(admission, "promptId"))
                && ("sha256:" + sha256(inputBytes)).equals(text(admission, "digest")));
        JsonNode wakePayload = wake.path("payload");
        closed(wakePayload, Set.of("wakeId", "reason", "subject", "sourceEventId", "requiredSequence"));
        require((inputId + ":wake").equals(id(wake, "eventId"))
                && (inputId + ":wake").equals(id(wakePayload, "wakeId"))
                && "input".equals(text(wakePayload, "reason"))
                && (inputId + ":accepted").equals(id(wakePayload, "sourceEventId"))
                && number(wakePayload.get("requiredSequence")) == previousSequence + 1);
        JsonNode subject = wakePayload.path("subject");
        closed(subject, Set.of("type", "turnId"));
        require("turn".equals(text(subject, "type")) && inputId.equals(id(subject, "turnId")));
        return inputId;
    }

    public static String initialCheckpoint(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, String writerId, Genesis genesis, Activation activation,
            long previousSequence, Function<JsonNode, byte[]> resources) {
        require(activation != null && transaction.events().size() == 1
                && writerId.equals(activation.workerId()) && writerId.equals(text(metadata, "writerId"))
                && number(metadata.get("writerGeneration")) == 1 && number(metadata.get("activationEpoch")) == 1
                && "commitCheckpoint".equals(text(metadata, "operation")));
        JsonNode event = transaction.events().getFirst();
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "subject", "payload"));
        key(event.path("sessionKey"), original);
        require("checkpoint.committed".equals(text(event, "kind")) && number(event.get("v")) == 1
                && number(event.get("sequence")) == previousSequence + 1
                && time(event.get("occurredAt")) < activation.expiresAt());
        JsonNode subject = event.path("subject");
        closed(subject, Set.of("type", "scopeId", "activationId", "epoch"));
        require("activation".equals(text(subject, "type"))
                && activation.activationId().equals(id(subject, "scopeId"))
                && activation.activationId().equals(id(subject, "activationId")) && number(subject.get("epoch")) == 1);
        JsonNode payload = event.path("payload");
        closed(payload, Set.of("checkpointId", "coveredSequence", "previousCheckpointId", "stateRef", "boundary"));
        String checkpointId = "ckpt-" + (previousSequence + 1);
        require(checkpointId.equals(id(event, "eventId")) && checkpointId.equals(id(payload, "checkpointId"))
                && number(payload.get("coveredSequence")) == previousSequence
                && payload.path("previousCheckpointId").isNull() && payload.path("boundary").isNull()
                && ("harness:before_model:" + activation.activationId() + ":" + previousSequence)
                        .equals(id(metadata, "commandId")));
        JsonNode ref = payload.path("stateRef");
        JsonNode state = readObject(reference(ref, "managed-checkpoint", resources));
        require(id(ref, "resourceId").equals(id(metadata, "latestCheckpointResourceId"))
                && text(ref, "digest").equals(text(metadata, "contentDigest")));
        closed(state, Set.of("identity", "resume", "continuation", "attempt", "tools", "runtime", "approval",
                "output", "followUp"));
        JsonNode identity = state.path("identity");
        closed(identity, Set.of("schemaVersion", "sessionKey", "engine", "checkpointId", "coveredSequence",
                "activationId", "turnId", "promptId", "definitionRevision", "configRevision", "inputDigest",
                "previousCheckpointId"));
        key(identity.path("sessionKey"), original);
        require(number(identity.get("schemaVersion")) == 1 && "managed".equals(text(identity, "engine"))
                && checkpointId.equals(id(identity, "checkpointId"))
                && number(identity.get("coveredSequence")) == previousSequence
                && activation.activationId().equals(id(identity, "activationId"))
                && genesis.definitionResourceId().equals(id(identity, "definitionRevision"))
                && genesis.rootResourceId().equals(id(identity, "configRevision"))
                && genesis.definitionDigest().equals(text(identity, "inputDigest")));
        nullFields(identity, "turnId", "promptId", "previousCheckpointId");
        JsonNode resume = state.path("resume");
        closed(resume, Set.of("source", "throughSequence", "recording", "initialTurn", "consumedNotificationIds",
                "apiHistoryRef", "fileHistoryRef", "artifactRef", "goalRecordsRef", "goalCheckpointWindowRef",
                "tokenCountsRef", "uiTelemetryRef", "attributionRef", "goalRecoverySourceUuid"));
        require("session_log".equals(text(resume, "source"))
                && number(resume.get("throughSequence")) == previousSequence && number(resume.get("initialTurn")) == 0);
        emptyArrays(resume, "consumedNotificationIds");
        nullFields(resume, "apiHistoryRef", "fileHistoryRef", "artifactRef", "goalRecordsRef", "goalCheckpointWindowRef",
                "tokenCountsRef", "uiTelemetryRef", "attributionRef", "goalRecoverySourceUuid");
        JsonNode recording = resume.path("recording");
        closed(recording, Set.of("lastCompletedUuid", "turnParentUuids", "parentSessionId", "sourceType", "sourceId",
                "lastAssistantModel", "executionEngine"));
        require("managed".equals(text(recording, "executionEngine")));
        nullFields(recording, "lastCompletedUuid", "parentSessionId", "sourceType", "sourceId", "lastAssistantModel");
        emptyArrays(recording, "turnParentUuids");
        JsonNode continuation = state.path("continuation");
        closed(continuation, Set.of("phase", "pendingEventIds"));
        require("before_model".equals(text(continuation, "phase")));
        emptyArrays(continuation, "pendingEventIds");
        nullFields(state, "attempt", "tools", "runtime", "approval");
        JsonNode output = state.path("output");
        closed(output, Set.of("llmContentRef", "physicalStatus", "hookResultRef", "mediaRefs", "parentHistory"));
        nullFields(output, "llmContentRef", "physicalStatus", "hookResultRef", "parentHistory");
        emptyArrays(output, "mediaRefs");
        JsonNode followUp = state.path("followUp");
        closed(followUp, Set.of("pendingInputIds", "cancelRequestIds", "goalPermitIds", "cronIds", "notificationIds",
                "childRunIds", "stopBudgetRemaining", "scopeLineage"));
        nullFields(followUp, "stopBudgetRemaining");
        emptyArrays(followUp, "pendingInputIds", "cancelRequestIds", "goalPermitIds", "cronIds", "notificationIds",
                "childRunIds", "scopeLineage");
        var array = JSON.createArrayNode().add(event);
        require(sha256(canonical(array).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "eventsDigest")));
        return id(ref, "resourceId");
    }

    private static void nullFields(JsonNode node, String... fields) {
        for (String field : fields) {
            require(node.path(field).isNull());
        }
    }

    private static void emptyArrays(JsonNode node, String... fields) {
        for (String field : fields) {
            require(node.path(field).isArray() && node.path(field).isEmpty());
        }
    }

    public static Activation activation(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, String writerId, String definitionDigest,
            Activation previous, Function<JsonNode, byte[]> resources) {
        require(transaction.events().size() == 1 && number(metadata.get("writerGeneration")) == 1
                && number(metadata.get("activationEpoch")) == 1
                && definitionDigest.equals(text(metadata, "contentDigest"))
                && metadata.path("latestCheckpointResourceId").isNull());
        JsonNode event = transaction.events().getFirst();
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "payload"));
        require("activation.changed".equals(text(event, "kind")));
        key(event.path("sessionKey"), original);
        time(event.get("occurredAt"));
        JsonNode payload = event.path("payload");
        Set<String> payloadFields = new java.util.HashSet<>(PAYLOAD);
        if (previous != null) {
            payloadFields.add("renewalSeq");
        }
        closed(payload, payloadFields);
        String id = id(payload, "activationId");
        require(number(payload.get("epoch")) == 1 && "active".equals(text(payload, "phase"))
                && writerId.equals(text(payload, "workerId")) && writerId.equals(text(metadata, "writerId"))
                && payload.path("boundaryRef").isNull());
        uuid(writerId);
        JsonNode subject = payload.path("subject");
        closed(subject, Set.of("type", "scopeId", "activationId", "epoch"));
        require("activation".equals(text(subject, "type")) && id.equals(text(subject, "scopeId"))
                && id.equals(text(subject, "activationId")) && number(subject.get("epoch")) == 1);
        long lease = number(payload.get("leaseDurationMs"));
        long expires = time(payload.get("expiresAt"));
        require(lease > 0 && expires > time(event.get("occurredAt")));
        JsonNode ref = payload.path("installRef");
        byte[] bytes = reference(ref, "managed-activation-install", resources);
        JsonNode body = readObject(bytes);
        closed(body, Set.of("version", "activationId", "epoch", "workerId", "leaseDurationMs"));
        require(number(body.get("version")) == 1 && id.equals(text(body, "activationId"))
                && number(body.get("epoch")) == 1 && writerId.equals(text(body, "workerId"))
                && number(body.get("leaseDurationMs")) > 0);
        long renewal = previous == null ? 0 : number(payload.get("renewalSeq"));
        String suffix = previous == null ? "" : ":renewal:" + renewal;
        require((previous == null ? "installActivation" : "renewActivation").equals(text(metadata, "operation"))
                && (id + ":active" + suffix).equals(id(metadata, "commandId"))
                && ("activation:" + id + ":active" + suffix).equals(id(event, "eventId")));
        if (previous == null) {
            require(number(metadata.get("firstSequence")) == 1 && number(body.get("leaseDurationMs")) == lease);
        } else {
            require(id.equals(previous.activationId()) && writerId.equals(previous.workerId())
                    && canonical(ref).equals(canonical(previous.installRef()))
                    && renewal == previous.renewalSequence() + 1);
        }
        var array = JSON.createArrayNode().add(event);
        require(sha256(canonical(array).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "eventsDigest")));
        return new Activation(id, writerId, ref.deepCopy(), lease, expires, renewal);
    }

    public static boolean hasActivation(Transaction transaction) {
        return transaction.events().stream().anyMatch(event -> "activation.changed".equals(event.path("kind").textValue()));
    }

    public static JsonNode readObject(byte[] bytes) {
        return object(readJson(bytes));
    }

    private static JsonNode readJson(byte[] bytes) {
        require(bytes != null && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return JSON.readTree(text);
        } catch (IOException error) {
            throw invalid();
        }
    }

    private static byte[] reference(JsonNode ref, String kind, Function<JsonNode, byte[]> resources) {
        closed(ref, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        id(ref, "resourceId");
        require(kind.equals(text(ref, "kind")) && number(ref.get("schemaVersion")) == 1);
        byte[] bytes = resources.apply(ref);
        require(bytes != null && bytes.length == number(ref.get("byteLength"))
                && sha256(bytes).equals(text(ref, "digest")));
        return bytes;
    }

    private static void key(JsonNode key, RuntimeProvisionRequest original) {
        closed(key, Set.of("tenantId", "workspaceId", "sessionId"));
        require(original.getScope().getTenantId().equals(text(key, "tenantId"))
                && original.getScope().getWorkspaceId().equals(text(key, "workspaceId"))
                && original.getIsolationKey().equals(text(key, "sessionId")));
    }

    private static void envelope(JsonNode record, RuntimeProvisionRequest original, String subtype, String parentUuid) {
        require("system".equals(text(record, "type")) && subtype.equals(text(record, "subtype"))
                && original.getIsolationKey().equals(text(record, "sessionId"))
                && original.getScope().getCanonicalCwd().equals(text(record, "cwd"))
                && (parentUuid == null ? record.path("parentUuid").isNull()
                        : parentUuid.equals(text(record, "parentUuid"))));
        uuid(text(record, "uuid"));
        try {
            Instant.parse(text(record, "timestamp"));
        } catch (java.time.DateTimeException error) {
            throw invalid();
        }
        text(record, "version");
    }

    private static JsonNode object(JsonNode node) {
        require(node != null && node.isObject());
        return node;
    }

    private static void uuid(String value) {
        try {
            require(UUID.fromString(value).toString().equals(value));
        } catch (IllegalArgumentException error) {
            throw invalid();
        }
    }

    private static void closed(JsonNode node, Set<String> fields) {
        object(node);
        require(node.size() == fields.size());
        node.fieldNames().forEachRemaining(field -> require(fields.contains(field)));
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        require(value != null && value.isTextual() && !value.textValue().isEmpty()
                && value.textValue().length() <= 4096);
        return value.textValue();
    }

    private static long number(JsonNode value) {
        require(value != null && value.isIntegralNumber() && value.canConvertToLong()
                && value.longValue() >= 0 && value.longValue() <= MAX_SAFE);
        return value.longValue();
    }

    private static String id(JsonNode node, String field) {
        String value = text(node, field);
        byte[] utf8 = value.getBytes(StandardCharsets.UTF_8);
        require(utf8.length <= 512 && new String(utf8, StandardCharsets.UTF_8).equals(value)
                && java.text.Normalizer.isNormalized(value, java.text.Normalizer.Form.NFC)
                && value.codePoints().noneMatch(character -> character < 0x20 || character >= 0x7f && character <= 0x9f));
        return value;
    }

    private static long time(JsonNode node) {
        long value = number(node);
        require(value <= 8_640_000_000_000_000L);
        return value;
    }

    private static String canonical(JsonNode node) {
        require(node != null);
        if (node.isObject()) {
            List<String> fields = new ArrayList<>();
            node.fieldNames().forEachRemaining(fields::add);
            fields.sort(String::compareTo);
            List<String> entries = new ArrayList<>();
            for (String field : fields) {
                entries.add(quote(field) + ":" + canonical(node.get(field)));
            }
            return "{" + String.join(",", entries) + "}";
        }
        if (node.isArray()) {
            List<String> entries = new ArrayList<>();
            node.forEach(child -> entries.add(canonical(child)));
            return "[" + String.join(",", entries) + "]";
        }
        if (node.isTextual()) {
            return quote(node.textValue());
        }
        if (node.isNumber()) {
            return canonicalNumber(node.doubleValue());
        }
        require(node.isNull() || node.isBoolean());
        return node.toString();
    }

    private static String canonicalNumber(double value) {
        require(Double.isFinite(value));
        if (value == 0) {
            return "0";
        }
        double magnitude = Math.abs(value);
        BigDecimal decimal = BigDecimal.valueOf(magnitude).stripTrailingZeros();
        // Java 21 may prefer two digits when one suffices; native JSON uses one.
        if (decimal.precision() == 2) {
            BigDecimal exact = new BigDecimal(magnitude);
            BigDecimal lower = exact.round(new MathContext(1, RoundingMode.FLOOR)).stripTrailingZeros();
            BigDecimal upper = exact.round(new MathContext(1, RoundingMode.CEILING)).stripTrailingZeros();
            boolean lowerMatches = lower.doubleValue() == magnitude;
            if (lowerMatches) {
                decimal = lower;
            }
            if (upper.doubleValue() == magnitude) {
                int distance = upper.subtract(exact).abs().compareTo(lower.subtract(exact).abs());
                if (!lowerMatches || distance < 0 || distance == 0 && !upper.unscaledValue().testBit(0)) {
                    decimal = upper;
                }
            }
        }
        int exponent = decimal.precision() - decimal.scale() - 1;
        String encoded;
        if (exponent >= -6 && exponent < 21) {
            encoded = decimal.toPlainString();
        } else {
            String digits = decimal.unscaledValue().toString();
            encoded = digits.substring(0, 1) + (digits.length() == 1 ? "" : "." + digits.substring(1))
                    + "e" + (exponent < 0 ? "" : "+") + exponent;
        }
        return value < 0 ? "-" + encoded : encoded;
    }

    private static String quote(String text) {
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < text.length(); index++) {
            char value = text.charAt(index);
            switch (value) {
                case '"', '\\' -> result.append('\\').append(value);
                case '\b' -> result.append("\\b");
                case '\f' -> result.append("\\f");
                case '\n' -> result.append("\\n");
                case '\r' -> result.append("\\r");
                case '\t' -> result.append("\\t");
                default -> {
                    if (value < 0x20 || Character.isSurrogate(value)
                            && !(Character.isHighSurrogate(value) && index + 1 < text.length()
                                    && Character.isLowSurrogate(text.charAt(index + 1)))
                            && !(Character.isLowSurrogate(value) && index > 0
                                    && Character.isHighSurrogate(text.charAt(index - 1)))) {
                        result.append("\\u");
                        for (int shift = 12; shift >= 0; shift -= 4) {
                            result.append(Character.forDigit((value >> shift) & 15, 16));
                        }
                    } else {
                        result.append(value);
                    }
                }
            }
        }
        return result.append('"').toString();
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw invalid();
        }
    }

    private static RuntimeBrokerException invalid() {
        return new RuntimeBrokerException(409, "csi_original_activation_unavailable",
                "The original CSI native activation proof is unavailable.", false);
    }
}
