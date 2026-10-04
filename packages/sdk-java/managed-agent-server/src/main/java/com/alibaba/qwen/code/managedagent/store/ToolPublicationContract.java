package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion.VersionFlag;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;

public final class ToolPublicationContract {
    public static final String PROTOCOL = "managed-tool-publication/1";
    public static final int MAX_BODY_BYTES = 64 * 1024;
    public static final long MAX_CAPTURE_BYTES = 1L << 41;
    public static final long PRODUCER_BYTES = 2_686_976;
    public static final long ADMISSION_BYTES = 2_097_152;
    public static final long MAX_COUNT = 9_007_199_254_740_990L;
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());
    private static final Set<String> BINDING_KEYS = Set.of("publication",
            "publicationId", "sessionKey", "turnId", "executionCallId",
            "modelCallId", "runtimeBindingId", "reference", "bindingGeneration",
            "captureId", "revision", "captureScope", "capturePolicy", "argsRef",
            "requestDigest", "writerId", "writerGeneration", "activationId",
            "activationEpoch", "intentSequence", "checkpointRef");
    private static final JsonNode RESULT_SCHEMA = resultSchema();

    private ToolPublicationContract() {
    }

    public static JsonNode parseBytes(String kind, byte[] bytes) {
        require(bytes.length <= MAX_BODY_BYTES, "Publication body is too large");
        return parse(kind, readJson(bytes));
    }

    public static JsonNode parse(String kind, JsonNode value) {
        require(value != null && value.toString().getBytes(StandardCharsets.UTF_8)
                .length <= MAX_BODY_BYTES, "Publication body is too large");
        switch (kind) {
            case "binding" -> binding(value);
            case "request" -> request(value);
            case "grant" -> grant(value);
            default -> throw new IllegalArgumentException("Unknown publication record");
        }
        return value.deepCopy();
    }

    private static void binding(JsonNode b) {
        closed(b, BINDING_KEYS);
        protocol(b);
        token(b.get("publicationId"));
        scope(b.get("sessionKey"));
        for (String key : List.of("turnId", "executionCallId", "modelCallId",
                "runtimeBindingId", "writerId", "activationId")) {
            id(b.get(key));
        }
        JsonNode reference = b.get("reference");
        closed(reference, Set.of("sessionId", "promptId", "callId", "argsDigest"));
        for (String key : List.of("sessionId", "promptId", "callId")) {
            id(reference.get(key));
        }
        wireDigest(reference.get("argsDigest"));
        wireDigest(b.get("requestDigest"));
        String generation = id(b.get("bindingGeneration"));
        require(generation.matches("[1-9][0-9]{0,18}")
                && new BigInteger(generation).compareTo(BigInteger.valueOf(Long.MAX_VALUE))
                <= 0, "Invalid binding generation");
        token(b.get("captureId"));
        require(count(b.get("revision"), 1) == 1, "Invalid revision");
        require("process_pipes".equals(text(b, "captureScope"))
                && "complete_required".equals(text(b, "capturePolicy")),
                "Unsupported capture policy");
        ref(b.get("argsRef"), "managed-tool-input");
        ref(b.get("checkpointRef"), "managed-checkpoint");
        for (String key : List.of("writerGeneration", "activationEpoch", "intentSequence")) {
            count(b.get(key), MAX_COUNT);
        }
    }

    private static void request(JsonNode r) {
        String op = text(r, "operation");
        if ("reserve".equals(op)) {
            closed(r, Set.of("publication", "operation", "sessionKey", "owner",
                    "binding", "captureBytes"));
            binding(r.get("binding"));
            count(r.get("captureBytes"), MAX_CAPTURE_BYTES);
        } else {
            require(Set.of("renew", "fence", "close_not_started").contains(op),
                    "Invalid publication operation");
            closed(r, Set.of("publication", "operation", "sessionKey", "owner",
                    "publicationId"));
            token(r.get("publicationId"));
        }
        protocol(r);
        scope(r.get("sessionKey"));
        JsonNode owner = r.get("owner");
        closed(owner, Set.of("writerId", "writerGeneration"));
        id(owner.get("writerId"));
        count(owner.get("writerGeneration"), MAX_COUNT);
        if ("reserve".equals(op)) {
            JsonNode b = r.get("binding");
            require(b.get("sessionKey").equals(r.get("sessionKey"))
                    && b.get("writerId").equals(owner.get("writerId"))
                    && b.get("writerGeneration").decimalValue()
                    .compareTo(owner.get("writerGeneration").decimalValue()) == 0,
                    "Reservation owner conflicts");
        }
    }

    private static void grant(JsonNode g) {
        closed(g, Set.of("publication", "publicationId", "bindingDigest", "state",
                "expiresAt", "captureBytes", "producerBytes", "admissionBytes"));
        protocol(g);
        token(g.get("publicationId"));
        digest(g.get("bindingDigest"));
        String state = text(g, "state");
        require(Set.of("OPEN", "FENCED", "NOT_STARTED").contains(state),
                "Invalid publication state");
        if ("OPEN".equals(state)) {
            count(g.get("expiresAt"), 8_640_000_000_000_000L);
        } else {
            require(g.get("expiresAt").isNull(), "Closed grant has an expiry");
        }
        count(g.get("captureBytes"), MAX_CAPTURE_BYTES);
        require(count(g.get("producerBytes"), MAX_COUNT) == PRODUCER_BYTES
                && count(g.get("admissionBytes"), MAX_COUNT) == ADMISSION_BYTES,
                "Metadata allocation conflicts");
    }

    public static void requirePayload(JsonNode binding, String payload) {
        binding(binding);
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        require(bytes.length <= 256 * 1024 && payload.equals(new String(bytes,
                StandardCharsets.UTF_8)), "Invalid payload encoding");
        JsonNode body = readJson(bytes);
        closed(body, Set.of("toolName", "input"));
        require("run_shell_command".equals(text(body, "toolName"))
                && body.get("input").isObject()
                && !body.get("input").path("is_background").equals(JSON.getNodeFactory().booleanNode(true)),
                "Only foreground Shell can publish");
        JsonNode input = body.get("input");
        require(input.has("command") && input.get("command").isTextual()
                && !input.get("command").textValue().isEmpty(), "Shell command is invalid");
        input.fieldNames().forEachRemaining(name -> require(
                Set.of("command", "timeout", "description").contains(name), "Shell input field is invalid"));
        require(!input.has("timeout") || input.get("timeout").isIntegralNumber()
                && input.get("timeout").canConvertToInt()
                && input.get("timeout").intValue() >= 1 && input.get("timeout").intValue() <= 600_000,
                "Shell timeout is invalid");
        require(!input.has("description") || input.get("description").isTextual(),
                "Shell description is invalid");
        require(("sha256:" + sha256(bytes)).equals(text(binding, "requestDigest")),
                "Original payload digest conflicts");
        require(("sha256:" + sha256(canonicalText(canonical(input)).getBytes(StandardCharsets.UTF_8)))
                .equals(text(binding.path("reference"), "argsDigest")),
                "Canonical Shell input digest conflicts");
    }

    public static String bindingDigest(JsonNode binding) {
        return sha256(canonicalText(canonical(parse("binding", binding)))
                .getBytes(StandardCharsets.UTF_8));
    }

    public static String tokenHash(String token) {
        require(token != null && token.matches("[A-Za-z0-9_-]{43}"),
                "Invalid publication token");
        byte[] bytes = java.util.Base64.getUrlDecoder().decode(token);
        require(bytes.length == 32 && java.util.Base64.getUrlEncoder()
                .withoutPadding().encodeToString(bytes).equals(token),
                "Publication token must encode 256 bits");
        return sha256(token.getBytes(StandardCharsets.UTF_8));
    }

    public static JsonNode readJson(byte[] bytes) {
        return readJson(bytes, 0, bytes.length);
    }

    public static JsonNode readJson(byte[] bytes, int offset, int length) {
        try {
            String text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, offset, length)).toString();
            return JSON.reader().with(com.fasterxml.jackson.databind.DeserializationFeature
                    .FAIL_ON_TRAILING_TOKENS).readTree(text);
        } catch (IOException error) {
            throw new IllegalArgumentException("Invalid publication JSON", error);
        }
    }

    public static JsonNode parseToolResult(String kind, byte[] bytes, int maxBytes) {
        require(Set.of("manifest", "page", "result").contains(kind)
                && bytes != null && bytes.length <= maxBytes, "Invalid tool-result record size");
        JsonNode value = readJson(bytes);
        ObjectNode selected = JSON.createObjectNode().put("$schema", "https://json-schema.org/draft/2020-12/schema")
                .put("$ref", "#/$defs/" + kind);
        selected.set("$defs", RESULT_SCHEMA.path("$defs"));
        JsonSchema schema = JsonSchemaFactory.getInstance(VersionFlag.V202012).getSchema(selected);
        require(schema.validate(value).isEmpty(), "Invalid tool-result " + kind);
        return value;
    }

    private static JsonNode resultSchema() {
        try (InputStream stream = ToolPublicationContract.class.getResourceAsStream(
                "/contracts/managed-tool-result-v1.schema.json")) {
            if (stream == null) {
                throw new IllegalStateException("Tool-result schema is missing");
            }
            return JSON.readTree(stream);
        } catch (IOException error) {
            throw new IllegalStateException("Tool-result schema could not be read", error);
        }
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static JsonNode canonical(JsonNode node) {
        if (!node.isObject()) {
            return node.isNumber() ? JSON.getNodeFactory().numberNode(node.longValue()) : node;
        }
        ObjectNode result = JSON.createObjectNode();
        List<String> names = new ArrayList<>();
        node.fieldNames().forEachRemaining(names::add);
        names.sort(String::compareTo);
        names.forEach(name -> result.set(name, canonical(node.get(name))));
        return result;
    }

    private static String canonicalText(JsonNode node) {
        if (node.isTextual()) {
            String value = node.textValue();
            StringBuilder result = new StringBuilder("\"");
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                if (c == '"' || c == '\\') {
                    result.append('\\').append(c);
                } else if (c == '\b') {
                    result.append("\\b");
                } else if (c == '\t') {
                    result.append("\\t");
                } else if (c == '\n') {
                    result.append("\\n");
                } else if (c == '\f') {
                    result.append("\\f");
                } else if (c == '\r') {
                    result.append("\\r");
                } else if (c < 0x20 || Character.isSurrogate(c)
                        && !(Character.isHighSurrogate(c) && i + 1 < value.length()
                                && Character.isLowSurrogate(value.charAt(i + 1)))
                        && !(Character.isLowSurrogate(c) && i > 0
                                && Character.isHighSurrogate(value.charAt(i - 1)))) {
                    result.append("\\u");
                    for (int shift = 12; shift >= 0; shift -= 4) {
                        result.append(Character.forDigit((c >> shift) & 15, 16));
                    }
                } else {
                    result.append(c);
                }
            }
            return result.append('"').toString();
        }
        if (node.isObject()) {
            List<String> fields = new ArrayList<>();
            node.fieldNames().forEachRemaining(fields::add);
            List<String> parts = new ArrayList<>();
            for (String field : fields) {
                parts.add(canonicalText(JSON.getNodeFactory().textNode(field)) + ":"
                        + canonicalText(node.get(field)));
            }
            return "{" + String.join(",", parts) + "}";
        }
        if (node.isArray()) {
            List<String> parts = new ArrayList<>();
            node.forEach(item -> parts.add(canonicalText(item)));
            return "[" + String.join(",", parts) + "]";
        }
        return node.toString();
    }

    private static void ref(JsonNode r, String kind) {
        closed(r, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        id(r.get("resourceId"));
        require(kind.equals(text(r, "kind")) && count(r.get("schemaVersion"), 1) == 1,
                "Invalid publication resource kind");
        count(r.get("byteLength"), MAX_BODY_BYTES);
        digest(r.get("digest"));
    }

    private static void protocol(JsonNode r) {
        require(PROTOCOL.equals(text(r, "publication")), "Invalid publication protocol");
    }

    private static void scope(JsonNode key) {
        closed(key, Set.of("tenantId", "workspaceId", "sessionId"));
        key.forEach(ToolPublicationContract::id);
    }

    private static void closed(JsonNode node, Set<String> keys) {
        require(node != null && node.isObject() && node.size() == keys.size(),
                "Invalid publication fields");
        node.fieldNames().forEachRemaining(key -> require(keys.contains(key),
                "Unknown publication field"));
    }

    private static String id(JsonNode node) {
        require(node != null && node.isTextual() && !node.textValue().isEmpty(),
                "Invalid publication ID");
        String value = node.textValue();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            require(c > 31 && (c < 127 || c > 159), "Control character in ID");
            if (Character.isHighSurrogate(c)) {
                require(++i < value.length() && Character.isLowSurrogate(value.charAt(i)),
                        "Invalid ID surrogate");
            } else {
                require(!Character.isLowSurrogate(c), "Invalid ID surrogate");
            }
        }
        require(value.getBytes(StandardCharsets.UTF_8).length <= 512
                && Normalizer.isNormalized(value, Normalizer.Form.NFC), "Invalid ID encoding");
        return value;
    }

    private static void token(JsonNode node) {
        require(id(node).matches("[a-z0-9_-]{1,128}"), "Invalid publication token ID");
    }

    private static void digest(JsonNode node) {
        require(node != null && node.isTextual() && node.textValue().matches("[0-9a-f]{64}"),
                "Invalid publication digest");
    }

    private static void wireDigest(JsonNode node) {
        require(node != null && node.isTextual()
                && node.textValue().matches("sha256:[0-9a-f]{64}"), "Invalid wire digest");
    }

    private static long count(JsonNode node, long maximum) {
        BigDecimal value = node != null && node.isNumber()
                && Double.isFinite(node.doubleValue()) ? node.decimalValue() : null;
        require(value != null && value.stripTrailingZeros().scale() <= 0
                && value.compareTo(BigDecimal.ONE) >= 0
                && value.compareTo(BigDecimal.valueOf(maximum)) <= 0,
                "Invalid publication count");
        return value.longValueExact();
    }

    static String text(JsonNode node, String key) {
        return node == null ? "" : node.path(key).asText("");
    }

    static void require(boolean condition, String reason) {
        if (!condition) {
            throw new IllegalArgumentException(reason);
        }
    }
}
