package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Java mirror of the frozen managed-event-envelope/1 contract (TypeScript:
 * packages/core/src/managed-runtime/managed-event-envelope.ts). Every rule
 * here mirrors the TypeScript side byte-for-byte — canonical JSON, the
 * SHA-256 digest, the validation bounds — and the fixture consumer test
 * proves it against the frozen fixtures. The journal transport (MQ2b) derives
 * {@code authoritative_journal} envelopes through it, the public-event
 * transport (MQ2c) {@code public_event} envelopes, and the transport
 * consumers parse both.
 */
public final class ManagedEventEnvelopes {
    static final int FORMAT_VERSION = 1;
    public static final String STREAM_AUTHORITATIVE_JOURNAL =
            "authoritative_journal";
    public static final String STREAM_PUBLIC_EVENT = "public_event";
    // Ordered (the failure message joins it), as the TypeScript constant.
    static final List<String> STREAMS = List.of(
            STREAM_AUTHORITATIVE_JOURNAL, STREAM_PUBLIC_EVENT);
    static final int MAX_ID_BYTES = 512;
    // A public kind is the public event type: managed_agent_event.event_type
    // and the public API both cap it at 128, and the grammar is ASCII.
    static final int MAX_PUBLIC_KIND_BYTES = 128;
    static final Pattern PUBLIC_KIND = Pattern.compile(
            "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$");
    static final long MAX_TIME_MS = 8640000000000000L;
    // MANAGED_SESSION_LIMITS.maxJsonDepth: the digest refuses a value nested
    // deeper, counting from the top-level list at depth 0.
    static final int MAX_JSON_DEPTH = 64;
    // Number.MAX_SAFE_INTEGER - 1: the schema's sequence ceiling (the TypeScript
    // assert rejects exactly MAX_SAFE_INTEGER as "cannot advance").
    static final long MAX_SEQUENCE = 9007199254740990L;

    // Ordered (the failure message joins it) — the frozen contract's 20-kind
    // vocabulary in fixture order.
    static final List<String> KINDS = List.of(
            "input.accepted", "wake.requested", "activation.changed",
            "model.attempt", "message.committed", "tool.intent",
            "action.changed", "tool.receipt", "checkpoint.committed",
            "context.compacted", "cancel.requested", "turn.settled",
            "config.bound", "lifecycle.changed", "domain.committed",
            "message.delta", "message.retracted", "operation.replayed",
            "hosted.batch.planned", "hosted.cleanup");

    static final Set<String> FORBIDDEN_FIELDS = Set.of(
            "absolutePath", "localPath", "pid", "pod", "runtimeBindingId",
            "runtimeEndpoint", "secretHandle", "sidecar");

    private static final List<String> ENVELOPE_KEYS = List.of(
            "v", "sessionId", "tenantId", "workspaceId", "stream", "sequence",
            "eventId", "kind", "occurredAt", "payloadRef");

    // The nine fields of a public event row a public_event envelope binds.
    private static final List<String> PUBLIC_EVENT_ROW_KEYS = List.of(
            "tenantId", "sessionId", "sequence", "eventId", "turnId", "type",
            "data", "terminal", "createdAt");

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
     * The public event row a {@code public_event} envelope binds, as the
     * committed {@link EventRecord} carries it. {@code data} goes through the
     * store's own mapper, so the tree is the one the store wrote as
     * data_json and a receiver reading the row back recomputes the same
     * digest.
     */
    public static ObjectNode publicEventRow(EventRecord event,
            ObjectMapper mapper) {
        ObjectNode row = JsonNodeFactory.instance.objectNode();
        row.put("tenantId", event.tenantId());
        row.put("sessionId", event.sessionId());
        row.put("sequence", event.sequence());
        row.put("eventId", event.eventId());
        if (event.turnId() == null) {
            row.putNull("turnId");
        } else {
            row.put("turnId", event.turnId());
        }
        row.put("type", event.type());
        row.set("data", mapper.valueToTree(event.data()));
        row.put("terminal", event.terminal());
        row.put("createdAt", event.createdAt());
        return row;
    }

    /**
     * The envelope of one committed public event row, mirroring
     * managedEventEnvelopeFromPublicEvent: the row carries no workspace, so
     * the Session's binding is passed alongside it, and the digest is SHA-256
     * over the canonical JSON of the one-element list {@code [row]}.
     */
    public static ManagedEventEnvelope fromPublicEventRow(JsonNode row,
            String workspaceId) {
        if (row == null || !row.isObject()) {
            fail("publicEvent must be a plain JSON object.");
        }
        if (row.size() != PUBLIC_EVENT_ROW_KEYS.size()) {
            fail("publicEvent must have exactly the keys "
                    + String.join(", ", PUBLIC_EVENT_ROW_KEYS) + ".");
        }
        for (String name : PUBLIC_EVENT_ROW_KEYS) {
            if (!row.has(name)) {
                fail("publicEvent must have exactly the keys "
                        + String.join(", ", PUBLIC_EVENT_ROW_KEYS) + ".");
            }
        }
        long sequence = finiteInteger(row.get("sequence"),
                "publicEvent.sequence");
        if (sequence < 1) {
            fail("publicEvent.sequence must start at 1.");
        }
        if (!row.get("terminal").isBoolean()) {
            fail("publicEvent.terminal must be a boolean.");
        }
        JsonNode turnId = row.get("turnId");
        if (!turnId.isNull()) {
            stableId(turnId, "publicEvent.turnId");
        }
        String type = publicKind(row.get("type"), "publicEvent.type");
        ObjectNode bound = JsonNodeFactory.instance.objectNode();
        for (String name : PUBLIC_EVENT_ROW_KEYS) {
            bound.set(name, row.get(name));
        }
        var listed = JsonNodeFactory.instance.arrayNode().add(bound);
        requireDepth(listed, 0);
        ManagedEventEnvelope candidate = new ManagedEventEnvelope(
                FORMAT_VERSION,
                stableId(row.get("sessionId"), "publicEvent.sessionId"),
                stableId(row.get("tenantId"), "publicEvent.tenantId"),
                workspaceId,
                STREAM_PUBLIC_EVENT,
                sequence,
                stableId(row.get("eventId"), "publicEvent.eventId"),
                type,
                timeMs(row.get("createdAt"), "publicEvent.createdAt"),
                new ManagedEventEnvelope.PayloadRef(sha256Hex(canonicalJson(
                        listed))));
        // The envelope's own rules (the workspace id among them) decide last,
        // exactly as the TypeScript derivation re-parses what it built.
        return parse(toTree(candidate));
    }

    /**
     * The digest of the full committed event: SHA-256 over the canonical JSON
     * of the one-element list `[event]` — the same canonical form the commit
     * marker's transaction-wide eventsDigest uses.
     */
    public static String digest(JsonNode event) {
        String encoded = canonicalJson(
                JsonNodeFactory.instance.arrayNode().add(event));
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
        // The forbidden fields are refused by name before the shape checks,
        // exactly as the TypeScript closed() helper orders it.
        value.fieldNames().forEachRemaining(name -> {
            if (FORBIDDEN_FIELDS.contains(name)) {
                fail("envelope must not carry the forbidden field \"" + name
                        + "\".");
            }
        });
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
            if (!ENVELOPE_KEYS.contains(name)) {
                fail("envelope must have exactly the keys "
                        + String.join(", ", ENVELOPE_KEYS) + ".");
            }
        });
        JsonNode v = value.get("v");
        if (v == null || !v.isNumber() || v.doubleValue() != FORMAT_VERSION) {
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
        String sessionId = stableId(value.get("sessionId"),
                "envelope.sessionId");
        String tenantId = stableId(value.get("tenantId"), "envelope.tenantId");
        String workspaceId = stableId(value.get("workspaceId"),
                "envelope.workspaceId");
        String stream = stream(value.get("stream"));
        String eventId = stableId(value.get("eventId"), "envelope.eventId");
        // The kind vocabulary is the stream's: the closed record vocabulary
        // on the journal, the open public type grammar on the public stream.
        String kind = STREAM_AUTHORITATIVE_JOURNAL.equals(stream)
                ? kind(value.get("kind"))
                : publicKind(value.get("kind"), "envelope.kind");
        return new ManagedEventEnvelope(
                FORMAT_VERSION,
                sessionId,
                tenantId,
                workspaceId,
                stream,
                sequence,
                eventId,
                kind,
                timeMs(value.get("occurredAt"), "envelope.occurredAt"),
                new ManagedEventEnvelope.PayloadRef(
                        digestValue(payloadRef.get("digest"))));
    }

    /**
     * The canonical wire form of an envelope — the same canonical JSON the
     * TypeScript producer emits — so a receiver recomputes the same bytes.
     */
    public static String toJson(ManagedEventEnvelope envelope) {
        return canonicalJson(toTree(envelope));
    }

    private static ObjectNode toTree(ManagedEventEnvelope envelope) {
        ObjectNode node = JsonNodeFactory.instance.objectNode();
        node.put("v", envelope.v());
        node.put("sessionId", envelope.sessionId());
        node.put("tenantId", envelope.tenantId());
        node.put("workspaceId", envelope.workspaceId());
        node.put("stream", envelope.stream());
        node.put("sequence", envelope.sequence());
        node.put("eventId", envelope.eventId());
        node.put("kind", envelope.kind());
        node.put("occurredAt", envelope.occurredAt());
        node.putObject("payloadRef").put("digest", envelope.payloadRef().digest());
        return node;
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
            // JSON.stringify has only doubles: an integer above 2^53 renders
            // from its nearest double (rounding), never as exact digits, so
            // the canonical bytes match the TypeScript side.
            return jsNumberToString(node.doubleValue());
        }
        throw new IllegalArgumentException(
                "unsupported JSON node type: " + node.getNodeType());
    }

    /**
     * ECMAScript Number::toString (radix 10) faithfully, so the digest matches
     * the TypeScript side byte-for-byte. The thresholds are the spec's:
     * decimal form while 1e-6 ≤ |x| < 1e21, exponential outside it.
     */
    static String jsNumberToString(double d) {
        if (d == 0) {
            return "0";
        }
        if (!Double.isFinite(d)) {
            throw new IllegalArgumentException(
                    "non-finite number in digest input");
        }
        String sign = d < 0 ? "-" : "";
        double a = Math.abs(d);
        // ECMAScript Number::toString digits: the shortest decimal that still
        // parses back to this exact double; among the shortest, the closest to
        // the exact value, then even on a tie. Double.toString is not faithful
        // on subnormals (2^-1074 → Java "4.9e-324" but ECMAScript "5e-324"), so
        // the digits are generated from the exact value, not re-read from it.
        BigDecimal exact = new BigDecimal(a);
        String digits = null;
        int n = 0;
        for (int p = 1; p <= 17 && digits == null; p++) {
            // lo/hi are the consecutive p-digit decimals bracketing the exact
            // value; any round-tripping p-digit decimal is one of them.
            BigDecimal lo = exact.round(new MathContext(p, RoundingMode.FLOOR));
            BigDecimal hi = exact.round(new MathContext(p, RoundingMode.CEILING));
            BigDecimal best = null;
            for (BigDecimal candidate : new BigDecimal[] {lo, hi}) {
                if (candidate.signum() <= 0 || candidate.doubleValue() != a) {
                    continue;
                }
                if (best != null) {
                    int cmp = candidate.subtract(exact).abs()
                            .compareTo(best.subtract(exact).abs());
                    boolean closer = cmp < 0;
                    boolean tieToEven = cmp == 0
                            && !candidate.unscaledValue().testBit(0)
                            && best.unscaledValue().testBit(0);
                    if (!closer && !tieToEven) {
                        continue;
                    }
                }
                best = candidate;
            }
            if (best != null) {
                BigDecimal s = best.stripTrailingZeros();
                digits = s.unscaledValue().toString();
                // n: the value is 0.d1…dk × 10^n (so 10^(n-1) ≤ |x| < 10^n).
                n = digits.length() - s.scale();
            }
        }
        if (digits == null) {
            throw new AssertionError("no shortest decimal for " + d);
        }
        int k = digits.length();
        StringBuilder sb = new StringBuilder(sign);
        if (k <= n && n <= 21) {
            // integral value in the plain range: digits then (n-k) zeros.
            sb.append(digits);
            sb.append("0".repeat(n - k));
        } else if (n > 0 && n <= 21) {
            // decimal point inside the digits.
            sb.append(digits, 0, n).append('.').append(digits.substring(n));
        } else if (n > -6 && n <= 0) {
            // small decimal: 0.00…digits.
            sb.append("0.").append("0".repeat(-n)).append(digits);
        } else {
            // exponential: d[.ddd]e±X where X = n - 1, with a sign like JS.
            sb.append(digits.charAt(0));
            if (k > 1) {
                sb.append('.').append(digits.substring(1));
            }
            sb.append('e').append(n - 1 > 0 ? '+' : '-')
                    .append(Math.abs(n - 1));
        }
        return sb.toString();
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
                    } else if (Character.isHighSurrogate(c)
                            && (i + 1 >= s.length()
                                    || !Character.isLowSurrogate(
                                            s.charAt(i + 1)))) {
                        // JSON.stringify escapes an unpaired surrogate as a
                        // lowercase backslash-u escape; emitting it raw would
                        // become a replacement char in UTF-8 and change the digest.
                        sb.append(String.format("\\u%04x", (int) c));
                    } else if (Character.isLowSurrogate(c)
                            && (i == 0 || !Character.isHighSurrogate(
                                    s.charAt(i - 1)))) {
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
            return DigestUtils.sha256Hex(s.getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException(error);
        }
    }

    // --- per-field validation (mirrors the TypeScript asserts) ---

    /**
     * The shared safe-integer rule, on the number's VALUE, not the Jackson
     * node category: a finite, integral-valued number within the safe-integer
     * range. `1e0` and `42.0` are valid integers exactly as
     * `Number.isSafeInteger` accepts them on the TypeScript side.
     */
    private static long finiteInteger(JsonNode node, String label) {
        if (node == null || !node.isNumber()) {
            fail(label + " must be a non-negative safe integer.");
        }
        double value = node.doubleValue();
        if (!Double.isFinite(value) || value != Math.rint(value)) {
            fail(label + " must be a non-negative safe integer.");
        }
        if (value < 0 || value > MAX_SEQUENCE) {
            fail(label + " must be a non-negative safe integer.");
        }
        return (long) value;
    }

    private static long sequence(JsonNode node) {
        return finiteInteger(node, "envelope.sequence");
    }

    private static long timeMs(JsonNode node, String label) {
        long value = finiteInteger(node, label);
        if (value > MAX_TIME_MS) {
            fail(label + " exceeds the maximum UTC Unix millisecond value.");
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
                || !STREAMS.contains(node.textValue())) {
            fail("envelope.stream must be one of: " + String.join(", ", STREAMS)
                    + ".");
        }
        return node.textValue();
    }

    private static String publicKind(JsonNode node, String label) {
        if (node == null || !node.isTextual()
                || node.textValue().length() > MAX_PUBLIC_KIND_BYTES
                || !PUBLIC_KIND.matcher(node.textValue()).matches()) {
            fail(label + " must be a public event type: lowercase"
                    + " dot-separated segments of at most "
                    + MAX_PUBLIC_KIND_BYTES + " characters.");
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

    /**
     * The TypeScript digest's depth bound: a container deeper than
     * MAX_JSON_DEPTH is refused, counting the digested list as depth 0 — so
     * a row's {@code data} sits at depth 2. Stops at the bound, so a deep
     * value never recurses far.
     */
    private static void requireDepth(JsonNode node, int depth) {
        if (!node.isContainerNode()) {
            return;
        }
        if (depth > MAX_JSON_DEPTH) {
            fail("publicEvent.data exceeds the maximum JSON depth of "
                    + MAX_JSON_DEPTH + ".");
        }
        for (JsonNode child : node) {
            requireDepth(child, depth + 1);
        }
    }

    private static void fail(String message) {
        throw new IllegalArgumentException(message);
    }
}
