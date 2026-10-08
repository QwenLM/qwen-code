package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Tuple-validation units only; the supplied prefix does not prove native SQL admission. */
class CsiNativeToolReservationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION = "550e8400-e29b-41d4-a716-446655440001";
    private static final String PROMPT = "550e8400-e29b-41d4-a716-446655440002";
    private static final String BATCH = "550e8400-e29b-41d4-a716-446655440003";
    private final RuntimeProvisionRequest request = CsiFilesRetirementProfile.request(new ContextBinding(
            "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", SESSION);
    private final JdbcCsiFilesRetirementGuard.Original original = new JdbcCsiFilesRetirementGuard.Original(request,
            "binding", 1, RuntimeBindingRecord.State.READY, false, 1, 2L);

    @Test
    void tupleValidationRetainsObservedNonUuidFunctionIdsAndFullPartPositions() throws Exception {
        JsonNode parts = capturedParts();
        var prefix = prefix(parts);
        assertEquals(5, parts.size());
        for (int index = 0; index < 3; index++) {
            var tuple = tuple(prefix, index);
            assertDoesNotThrow(() -> CsiNativeToolReservation.qualify(original, prefix, tuple.execution(), tuple.input(), tuple.definition()));
            assertEquals(index + 2, tuple.execution().getReference().get("partIndex"));
            assertEquals("owned-provider-nonuuid-" + index, tuple.execution().getReference().get("functionCallId"));
        }
    }

    @Test
    void refusesChangedPartFunctionOrdinalOwnerAndDefinitionWithMatchingMetadata() throws Exception {
        var prefix = prefix(capturedParts());
        var tuple = tuple(prefix, 0);
        for (String field : new String[] {"functionCallId", "batchId", "partIndex", "ordinal", "sessionId", "promptId"}) {
            Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
            ref.put(field, field.equals("partIndex") || field.equals("ordinal") ? 7 : UUID.randomUUID().toString());
            rejects(prefix, copy(tuple.execution(), ref), tuple.input(), tuple.definition());
        }
        ObjectNode definition = (ObjectNode) JSON.readTree(tuple.definition());
        ((ObjectNode) definition.path("parametersJsonSchema")).put("additionalProperties", true);
        byte[] changed = JSON.writeValueAsBytes(definition);
        Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
        ref.put("toolDefinitionRef", ref("managed-tool-definition", changed));
        rejects(prefix, copy(tuple.execution(), ref), tuple.input(), changed);
    }

    @Test
    void requiresRawPayloadDigestRatherThanReserializedJsonOrWrapperDigest() throws Exception {
        var prefix = prefix(capturedParts());
        var tuple = tuple(prefix, 0);
        ObjectNode wrapper = (ObjectNode) JSON.readTree(tuple.input());
        String payload = wrapper.path("payloadJson").textValue();
        wrapper.put("payloadJson", " \n" + payload);
        byte[] changed = JSON.writeValueAsBytes(wrapper);
        Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
        ref.put("inputRef", ref("managed-tool-input", changed));
        rejects(prefix, copy(tuple.execution(), ref), changed, tuple.definition());
        String digest = "sha256:" + CsiNativeActivationProof.sha256((" \n" + payload).getBytes(StandardCharsets.UTF_8));
        ref.put("argsDigest", digest);
        ToolExecutionRecord exact = copy(tuple.execution(), ref);
        assertDoesNotThrow(() -> CsiNativeToolReservation.qualify(original, prefix, exact, changed, tuple.definition()));
        ref.put("argsDigest", "sha256:" + CsiNativeActivationProof.sha256(changed));
        rejects(prefix, copy(tuple.execution(), ref), changed, tuple.definition());
    }

    @Test
    void normalizesOriginalEcmascriptWhitespaceAndLexicalPathButRejectsTraversalAndExtraArgs() throws Exception {
        JsonNode parts = capturedParts();
        ((ObjectNode) parts.get(2).path("functionCall").path("args")).put("file_path", "\ufeff ./dir//marker.txt \u00a0");
        var prefix = prefix(parts);
        var tuple = tuple(prefix, 0);
        ObjectNode wrapper = (ObjectNode) JSON.readTree(tuple.input());
        ObjectNode payload = (ObjectNode) JSON.readTree(wrapper.path("payloadJson").textValue());
        ((ObjectNode) payload.path("input")).put("file_path", "dir/marker.txt");
        wrapper.put("payloadJson", JSON.writeValueAsString(payload));
        byte[] bytes = JSON.writeValueAsBytes(wrapper);
        Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
        ref.put("inputRef", ref("managed-tool-input", bytes));
        ref.put("argsDigest", "sha256:" + CsiNativeActivationProof.sha256(wrapper.path("payloadJson").textValue().getBytes(StandardCharsets.UTF_8)));
        ToolExecutionRecord normalized = copy(tuple.execution(), ref);
        assertDoesNotThrow(() -> CsiNativeToolReservation.qualify(original, prefix, normalized, bytes, tuple.definition()));
        for (String path : new String[] {"../outside", "/outside", "./C:outside", "dir\\file"}) {
            ((ObjectNode) prefix.pendingBatch().calls().getFirst().args()).put("file_path", path);
            rejects(prefix, normalized, bytes, tuple.definition());
        }
        ((ObjectNode) prefix.pendingBatch().calls().getFirst().args()).put("file_path", "dir/marker.txt").put("foreign", true);
        rejects(prefix, normalized, bytes, tuple.definition());
    }

    @Test
    void refusesMissingPendingBatchDuplicateJsonTrailingBytesAndInlineHashMismatch() throws Exception {
        var prefix = prefix(capturedParts());
        var tuple = tuple(prefix, 0);
        rejects(CsiNativeActivationProof.Prefix.empty(), tuple.execution(), tuple.input(), tuple.definition());
        byte[] changed = tuple.input().clone();
        changed[0] = (byte) 0xff;
        rejects(prefix, tuple.execution(), changed, tuple.definition());
        for (String text : new String[] {"{} {}", "{\"input\":{},\"input\":{}}"}) {
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
            ref.put("inputRef", ref("managed-tool-input", bytes));
            rejects(prefix, copy(tuple.execution(), ref), bytes, tuple.definition());
        }
    }

    private static void rejects(CsiNativeActivationProof.Prefix prefix, ToolExecutionRecord execution, byte[] input, byte[] definition) {
        assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.qualify(
                new JdbcCsiFilesRetirementGuard.Original(CsiFilesRetirementProfile.request(new ContextBinding(
                        "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", SESSION),
                        "binding", 1, RuntimeBindingRecord.State.READY, false, 1, 2L), prefix, execution, input, definition));
    }

    private static JsonNode capturedParts() throws Exception {
        try (var stream = CsiNativeToolReservationTest.class.getResourceAsStream("/csi-native-function-parts-baseline.json")) {
            return JSON.readTree(stream);
        }
    }

    private static CsiNativeActivationProof.Prefix prefix(JsonNode parts) {
        var calls = new ArrayList<CsiNativeActivationProof.FunctionCall>();
        for (int index = 0; index < parts.size(); index++) {
            JsonNode call = parts.get(index).path("functionCall");
            if (!call.isMissingNode()) {
                calls.add(new CsiNativeActivationProof.FunctionCall(call.path("id").textValue(), call.path("name").textValue(),
                        call.path("args").deepCopy(), index, calls.size()));
            }
        }
        return new CsiNativeActivationProof.Prefix(new CsiNativeActivationProof.Input(PROMPT, "unit", "user", true),
                null, BATCH, null, false, null, Set.of(), new CsiNativeActivationProof.PendingBatch(BATCH, JSON.createObjectNode(), calls));
    }

    private static Tuple tuple(CsiNativeActivationProof.Prefix prefix, int ordinal) throws Exception {
        var call = prefix.pendingBatch().calls().get(ordinal);
        String payload = JSON.writeValueAsString(Map.of("toolName", call.name(), "input", call.args()));
        byte[] input = JSON.writeValueAsBytes(Map.of("harnessSessionId", SESSION, "runtimeSessionId", SESSION, "payloadJson", payload));
        byte[] definition;
        try (var stream = CsiNativeToolReservationTest.class.getResourceAsStream("/csi-native-file-declarations.json")) {
            definition = JSON.writeValueAsBytes(JSON.readTree(stream).get(ordinal));
        }
        String id = UUID.randomUUID().toString();
        Map<String, Object> reference = new HashMap<>(Map.of("sessionId", SESSION, "promptId", PROMPT,
                "callId", id, "argsDigest", "sha256:" + CsiNativeActivationProof.sha256(payload.getBytes(StandardCharsets.UTF_8)),
                "batchId", BATCH, "functionCallId", call.id(), "ordinal", ordinal, "partIndex", call.partIndex(),
                "inputRef", ref("managed-tool-input", input), "toolDefinitionRef", ref("managed-tool-definition", definition)));
        reference.put("dispatchMode", "deferred");
        return new Tuple(ToolExecutionRecord.prepared("unit-execution", SESSION + ":" + id, "binding", 1,
                SESSION, SESSION, PROMPT, id, (String) reference.get("argsDigest"), reference), input, definition);
    }

    private static Map<String, Object> ref(String kind, byte[] bytes) {
        return Map.of("resourceId", UUID.randomUUID().toString(), "kind", kind, "schemaVersion", 1,
                "byteLength", bytes.length, "digest", CsiNativeActivationProof.sha256(bytes));
    }

    private static ToolExecutionRecord copy(ToolExecutionRecord original, Map<String, Object> ref) {
        return ToolExecutionRecord.prepared(original.getExecutionCallId(), original.getIdempotencyKey(), original.getBindingId(), 1,
                SESSION, (String) ref.get("sessionId"), (String) ref.get("promptId"), (String) ref.get("callId"),
                (String) ref.get("argsDigest"), ref);
    }

    private record Tuple(ToolExecutionRecord execution, byte[] input, byte[] definition) {
    }
}
