package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * Java mirror of the frozen managed-event-envelope/1 contract (TypeScript:
 * packages/core/src/managed-runtime/managed-event-envelope.ts). Every rule
 * here mirrors the TypeScript side byte-for-byte — canonical JSON, the
 * SHA-256 digest, the validation bounds — and the fixture consumer test
 * proves it against the frozen fixtures. Declared, not enabled (phase MQ2a):
 * no runtime path calls this yet.
 */
public final class ManagedEventEnvelopes {
    static final int FORMAT_VERSION = 1;
    static final String STREAM_AUTHORITATIVE_JOURNAL = "authoritative_journal";
    static final int MAX_ID_BYTES = 512;
    static final long MAX_TIME_MS = 8640000000000000L;
    // Number.MAX_SAFE_INTEGER - 1: the schema's sequence ceiling (the TypeScript
    // assert rejects exactly MAX_SAFE_INTEGER as "cannot advance").
    static final long MAX_SEQUENCE = 9007199254740990L;

    static final Set<String> KINDS = Set.of(
            "input.accepted", "wake.requested", "activation.changed",
            "model.attempt", "message.committed", "tool.intent",
            "action.changed", "tool.receipt", "checkpoint.committed",
            "context.compacted", "cancel.requested", "turn.settled",
            "config.bound", "lifecycle.changed", "domain.committed",
            "message.delta", "message.retracted", "operation.replayed");

    static final Set<String> FORBIDDEN_FIELDS = Set.of(
            "absolutePath", "localPath", "pid", "pod", "runtimeBindingId",
            "runtimeEndpoint", "secretHandle", "sidecar");

    private static final List<String> ENVELOPE_KEYS = List.of(
            "v", "sessionId", "tenantId", "workspaceId", "stream", "sequence",
            "eventId", "kind", "occurredAt", "payloadRef");

    private ManagedEventEnvelopes() {
    }

    /** The envelope of one committed event, derived from its row. */
    public static ManagedEventEnvelope from(JsonNode event) {
        JsonNode key = event.required("sessionKey");
        return new ManagedEventEnvelope(
                FORMAT_VERSION,
                key.required("sessionId").asText(),
                key.required("tenantId").asText(),
                key.required("workspaceId").asText(),
                STREAM_AUTHORITATIVE_JOURNAL,
                event.required("sequence").asLong(),
                event.required("eventId").asText(),
                event.required("kind").asText(),
                event.required("occurredAt").asLong(),
                new ManagedEventEnvelope.PayloadRef(digest(event)));
    }

    /**
     * The digest of the full committed event: SHA-256 over the canonical JSON
     * of the one-element list `[event]` — the same canonical form the commit
     * marker's transaction-wide eventsDigest uses.
     */
    public static String digest(JsonNode event) {
        String encoded = canonicalJson(
                com.fasterxml.jackson.databind.node.JsonNodeFactory.instance
                        .arrayNode().add(event));
        return sha256Hex(encoded);
    }

    /**
     * The receiver-side idempotence key: `(tenantId, sessionId, stream,
     * sequence)`.
     */
    public static String key(ManagedEventEnvelope envelope) {
        return envelope.tenantId() + "\n" + envelope.sessionId() + "\n"
                + envelope.stream() + "\n" + envelope.sequence();
    }

    /**
     * Redelivery-safe comparison: two parses announce the same committed event
     * when their keys are exactly equal; anything unparseable announces
     * nothing (returns false).
     */
    public static boolean isRedelivered(JsonNode delivered, JsonNode seen) {
        try {
            ManagedEventEnvelope left = parse(delivered);
            ManagedEventEnvelope right = parse(seen);
            return key(left).equals(key(right));
        } catch (IllegalArgumentException notParseable) {
            return false;
        }
    }

    /** Parse and validate an envelope, mirroring parseManagedEventEnvelope. */
    public static ManagedEventEnvelope parse(JsonNode value) {
        if (value == null || !value.isObject()) {
            fail("envelope must be a plain JSON object.");
        }
        if (value.size() != ENVELOPE_KEYS.size()) {
            fail("envelope must have exactly the keys "
                    + String.join(", ", ENVELOPE_KEYS) + ".");
        }
        for (String name : ENVELOPE_KEYS) {
            if (!value.has(name)) {
                fail("envelope must have exactly the keys "
                        + String.join(", ", ENVELOPE_KEYS) + ".");
            }
        }
        value.fieldNames().forEachRemaining(name -> {
            if (FORBIDDEN_FIELDS.contains(name)) {
                fail("envelope must not carry the forbidden field \"" + name
                        + "\".");
            }
            if (!ENVELOPE_KEYS.contains(name)) {
                fail("envelope must have exactly the keys "
                        + String.join(", ", ENVELOPE_KEYS) + ".");
            }
        });
        JsonNode v = value.get("v");
        if (v == null || !v.isIntegralNumber()
                || v.longValue() != FORMAT_VERSION) {
            fail("envelope.v must be " + FORMAT_VERSION + ".");
        }
        long sequence = sequence(value.get("sequence"));
        if (sequence < 1) {
            fail("envelope.sequence must start at 1.");
        }
        JsonNode payloadRef = value.get("payloadRef");
        if (payloadRef == null || !payloadRef.isObject()
                || payloadRef.size() != 1 || !payloadRef.has("digest")) {
            fail("envelope.payloadRef must have exactly the keys digest.");
        }
        return new ManagedEventEnvelope(
                FORMAT_VERSION,
                stableId(value.get("sessionId"), "envelope.sessionId"),
                stableId(value.get("tenantId"), "envelope.tenantId"),
                stableId(value.get("workspaceId"), "envelope.workspaceId"),
                stream(value.get("stream")),
                sequence,
                stableId(value.get("eventId"), "envelope.eventId"),
                kind(value.get("kind")),
                timeMs(value.get("occurredAt")),
                new ManagedEventEnvelope.PayloadRef(
                        digestValue(payloadRef.get("digest"))));
    }

    // --- canonical JSON (mirrors canonicalManagedSessionJson) ---

    static String canonicalJson(JsonNode node) {
        if (node == null || node.isNull()) {
            return "null";
        }
        if (node.isArray()) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < node.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(canonicalJson(node.get(i)));
            }
            return sb.append(']').toString();
        }
        if (node.isObject()) {
            StringBuilder sb = new StringBuilder("{");
            List<String> names = new ArrayList<>();
            node.fieldNames().forEachRemaining(names::add);
            // JavaScript's default Array.sort compares UTF-16 code units,
            // which is exactly Java's String.compareTo on char values.
            names.sort(Comparator.naturalOrder());
            boolean first = true;
            for (String name : names) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append(jsonString(name)).append(':')
                        .append(canonicalJson(node.get(name)));
            }
            return sb.append('}').toString();
        }
        return primitiveJson(node);
    }

    private static String primitiveJson(JsonNode node) {
        if (node.isTextual()) {
            return jsonString(node.textValue());
        }
        if (node.isBoolean()) {
            return node.booleanValue() ? "true" : "false";
        }
        if (node.isNumber()) {
            return numberJson(node);
        }
        throw new IllegalArgumentException(
                "unsupported JSON node type: " + node.getNodeType());
    }

    private static String numberJson(JsonNode node) {
        if (node.isIntegralNumber()) {
            return node.bigIntegerValue().toString();
        }
        // JSON.stringify renders an integral double with no fraction; a
        // fractional double in shortest round-trip form.
        BigDecimal decimal = node.decimalValue().stripTrailingZeros();
        return decimal.toPlainString();
    }

    /** String escaping exactly as JSON.stringify (non-ASCII kept raw). */
    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.append('"').toString();
    }

    private static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : hash) {
                sb.append(Character.forDigit((b >> 4) & 0xf, 16));
                sb.append(Character.forDigit(b & 0xf, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // --- per-field validation (mirrors the TypeScript asserts) ---

    private static long sequence(JsonNode node) {
        if (node == null || !node.isIntegralNumber()
                || !node.canConvertToLong()) {
            fail("envelope.sequence must be a non-negative safe integer.");
        }
        long value = node.longValue();
        if (value < 0 || value > MAX_SEQUENCE) {
            fail("envelope.sequence must be a non-negative safe integer.");
        }
        return value;
    }

    private static long timeMs(JsonNode node) {
        if (node == null || !node.isIntegralNumber()
                || !node.canConvertToLong()) {
            fail("envelope.occurredAt must be UTC Unix milliseconds as a safe"
                    + " integer.");
        }
        long value = node.longValue();
        if (value < 0) {
            fail("envelope.occurredAt must be UTC Unix milliseconds as a safe"
                    + " integer.");
        }
        if (value > MAX_TIME_MS) {
            fail("envelope.occurredAt exceeds the maximum UTC Unix millisecond"
                    + " value.");
        }
        return value;
    }

    private static String stableId(JsonNode node, String label) {
        if (node == null || !node.isTextual() || node.textValue().isEmpty()) {
            fail(label + " must be a non-empty string.");
        }
        String id = node.textValue();
        if (id.getBytes(StandardCharsets.UTF_8).length > MAX_ID_BYTES) {
            fail(label + " exceeds " + MAX_ID_BYTES + " UTF-8 bytes.");
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
                fail(label + " must not contain control characters.");
            }
            // The TypeScript valid-UTF-8 round-trip check rejects unpaired
            // surrogates; mirror it by the pairing rule.
            if (Character.isHighSurrogate(c) && (i + 1 >= id.length()
                    || !Character.isLowSurrogate(id.charAt(i + 1)))) {
                fail(label + " must be valid UTF-8 text.");
            }
            if (Character.isLowSurrogate(c) && (i == 0
                    || !Character.isHighSurrogate(id.charAt(i - 1)))) {
                fail(label + " must be valid UTF-8 text.");
            }
        }
        if (!Normalizer.isNormalized(id, Normalizer.Form.NFC)) {
            fail(label + " must use NFC normalization.");
        }
        return id;
    }

    private static String stream(JsonNode node) {
        if (node == null || !node.isTextual()
                || !STREAM_AUTHORITATIVE_JOURNAL.equals(node.textValue())) {
            fail("envelope.stream must be one of: "
                    + STREAM_AUTHORITATIVE_JOURNAL + ".");
        }
        return node.textValue();
    }

    private static String kind(JsonNode node) {
        if (node == null || !node.isTextual()
                || !KINDS.contains(node.textValue())) {
            fail("envelope.kind must be one of: " + String.join(", ", KINDS)
                    + ".");
        }
        return node.textValue();
    }

    private static String digestValue(JsonNode node) {
        if (node == null || !node.isTextual()
                || !node.textValue().matches("[0-9a-f]{64}")) {
            fail("envelope.payloadRef.digest must be a lowercase SHA-256 hex"
                    + " digest.");
        }
        return node.textValue();
    }

    private static void fail(String message) {
        throw new IllegalArgumentException(message);
    }
}
