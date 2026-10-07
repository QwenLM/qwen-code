package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.io.IOException;
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

/** Narrow native genesis/install/renew proof shared by CSI producers and consumers. */
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

    public record Genesis(String definitionDigest, String lastRecordUuid) {
    }

    public record Transaction(List<JsonNode> events, String lastRecordUuid) {
    }

    public record Activation(String activationId, String workerId, JsonNode installRef,
            long leaseDurationMs, long expiresAt, long renewalSequence) {
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
        return new Genesis(text(header.path("definitionRef"), "digest"), text(headerRecord, "uuid"));
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
        for (String field : MARKER) {
            require(metadata.has(field) && canonical(marker.get(field)).equals(canonical(metadata.get(field))));
        }
        require(sha256(canonical(marker).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "commitDigest")));
        return new Transaction(List.copyOf(events), parentUuid);
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
        require(bytes != null && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return object(JSON.readTree(text));
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
            return Long.toString(number(node));
        }
        require(node.isNull() || node.isBoolean());
        return node.toString();
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
