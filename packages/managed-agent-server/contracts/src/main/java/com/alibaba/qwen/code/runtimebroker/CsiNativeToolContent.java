package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRelativePath;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.canonical;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.closed;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.id;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.number;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.reference;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.sha256;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.text;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.utf8;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.uuid;

/** Pure allocation-content rules shared with durable CSI validation. */
public final class CsiNativeToolContent {
    private CsiNativeToolContent() { }

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final Set<String> FIELDS = Set.of("sessionId", "promptId", "callId", "argsDigest", "batchId",
            "functionCallId", "partIndex", "ordinal", "inputRef", "toolDefinitionRef", "dispatchMode");

    private static final String JS_WHITESPACE = "[\\x09-\\x0d\\x20\\x{a0}\\x{1680}\\x{2000}-\\x{200a}"
            + "\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";

    private static final Pattern JS_TRIM = Pattern.compile("^" + JS_WHITESPACE + "+|" + JS_WHITESPACE + "+$");

    private static final JsonNode DEFINITIONS = definitions();

    public static String trim(String value) {
        return JS_TRIM.matcher(value).replaceAll("");
    }

    public static ObjectNode qualifyContent(RuntimeProvisionRequest original, CsiNativeActivationProof.OriginalBatch batch,
            JsonNode ref, String requestDigest, byte[] inputBytes, byte[] definitionBytes) {
        closed(ref, FIELDS);
        String session = original.getIsolationKey();
        uuid(id(ref, "callId"));
        uuid(id(ref, "batchId"));
        require(session.equals(id(ref, "sessionId")) && batch.promptId().equals(id(ref, "promptId"))
                && batch.batch().messageId().equals(id(ref, "batchId")) && "deferred".equals(text(ref, "dispatchMode")));
        long ordinal = number(ref.get("ordinal"));
        require(ordinal < batch.batch().calls().size());
        var call = batch.batch().calls().get((int) ordinal);
        require(call.id().equals(id(ref, "functionCallId")) && call.partIndex() == number(ref.get("partIndex")));
        require(inputBytes != null && inputBytes.length <= 64 * 1024
                && definitionBytes != null && definitionBytes.length <= 64 * 1024);
        reference(ref.path("inputRef"), "managed-tool-input", ignored -> inputBytes);
        reference(ref.path("toolDefinitionRef"), "managed-tool-definition", ignored -> definitionBytes);
        require(!id(ref.path("inputRef"), "resourceId").equals(id(ref.path("toolDefinitionRef"), "resourceId")));
        var content = content(original, call, inputBytes, definitionBytes);
        String digest = "sha256:" + content.digest();
        require(digest.equals(text(ref, "argsDigest")) && digest.equals(requestDigest));
        return content.normalized();
    }

    public record Content(ObjectNode normalized, String digest) {
    }

    public static String refusalReason(RuntimeProvisionRequest original, CsiNativeActivationProof.FunctionCall call) {
        ObjectNode input;
        try {
            input = normalizedInput(call.name(), call.args());
        } catch (RuntimeBrokerException | WorkspaceException | IllegalArgumentException invalid) {
            return "CSI file input is invalid.";
        }
        ObjectNode payload = JSON.createObjectNode().put("toolName", call.name());
        payload.set("input", input);
        ObjectNode wrapper = JSON.createObjectNode().put("harnessSessionId", original.getIsolationKey())
                .put("runtimeSessionId", original.getIsolationKey()).put("payloadJson", canonical(payload));
        return utf8(canonical(wrapper)).length > 64 * 1024
                ? "CSI file input exceeds the durable Session limit." : null;
    }

    public static Content content(RuntimeProvisionRequest original, CsiNativeActivationProof.FunctionCall call,
            byte[] inputBytes, byte[] definitionBytes) {
        require(inputBytes != null && inputBytes.length <= 64 * 1024
                && definitionBytes != null && definitionBytes.length <= 64 * 1024);
        String session = original.getIsolationKey();
        JsonNode wrapper = CsiNativeActivationProof.readObject(inputBytes);
        closed(wrapper, Set.of("harnessSessionId", "runtimeSessionId", "payloadJson"));
        require(session.equals(id(wrapper, "harnessSessionId")) && session.equals(id(wrapper, "runtimeSessionId"))
                && wrapper.path("payloadJson").isTextual());
        byte[] payloadBytes = utf8(wrapper.path("payloadJson").textValue());
        JsonNode payload = CsiNativeActivationProof.readObject(payloadBytes);
        closed(payload, Set.of("toolName", "input"));
        require(call.name().equals(text(payload, "toolName")));
        ObjectNode normalized = normalizedInput(call.name(), call.args());
        require(canonical(normalized).equals(canonical(payload.path("input"))));
        JsonNode definition = CsiNativeActivationProof.readObject(definitionBytes);
        JsonNode expected = null;
        for (JsonNode item : DEFINITIONS) {
            if (call.name().equals(item.path("name").textValue())) {
                expected = item;
            }
        }
        require(expected != null && canonical(expected).equals(canonical(definition)));
        return new Content(normalized, sha256(payloadBytes));
    }

    private static ObjectNode normalizedInput(String name, JsonNode args) {
        Set<String> required = switch (name) {
            case "read_file" -> Set.of("file_path");
            case "write_file" -> Set.of("file_path", "content");
            case "edit" -> Set.of("file_path", "old_string", "new_string");
            default -> throw invalid();
        };
        Set<String> optional = "read_file".equals(name) ? Set.of("offset", "limit")
                : "edit".equals(name) ? Set.of("replace_all") : Set.of();
        require(args.isObject());
        args.fieldNames().forEachRemaining(field -> require(required.contains(field) || optional.contains(field)));
        for (String field : required) {
            require(args.path(field).isTextual());
            utf8(args.path(field).textValue());
        }
        for (String field : List.of("offset", "limit")) {
            if (args.has(field)) {
                require(number(args.get(field)) >= ("limit".equals(field) ? 1 : 0));
            }
        }
        require(!args.has("replace_all") || args.path("replace_all").isBoolean());
        ObjectNode result = args.deepCopy();
        result.put("file_path", WorkspaceRelativePath.normalize(trim(args.path("file_path").textValue())));
        require(!".".equals(result.path("file_path").textValue()));
        return result;
    }

    private static JsonNode definitions() {
        try (InputStream input = CsiNativeToolContent.class.getResourceAsStream("/csi-native-file-declarations.json")) {
            require(input != null);
            JsonNode definitions = CsiNativeActivationProof.readJson(input.readNBytes(64 * 1024 + 1));
            require(definitions.isArray() && definitions.size() == 3);
            return definitions;
        } catch (IOException error) {
            throw new IllegalStateException("Private CSI declarations are unavailable", error);
        }
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw invalid();
        }
    }

    private static RuntimeBrokerException invalid() {
        return new RuntimeBrokerException(409, "csi_native_reservation_conflict",
                "The original CSI native allocation proof is unavailable.", false);
    }
}
