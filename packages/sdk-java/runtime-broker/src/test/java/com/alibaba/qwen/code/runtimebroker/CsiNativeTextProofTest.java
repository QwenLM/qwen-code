package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class CsiNativeTextProofTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JsonNode fixture = fixture();
    private final JsonNode expected = fixture.path("expected");
    private final RuntimeProvisionRequest original = CsiFilesRetirementProfile.request(new ContextBinding(
            expected.path("sessionKey").path("tenantId").textValue(),
            expected.path("sessionKey").path("workspaceId").textValue(), 1, "unit-storage", ".",
            CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), expected.path("cwd").textValue(),
            expected.path("sessionKey").path("sessionId").textValue());
    private final Map<String, byte[]> bodies = bodies();
    private final Function<JsonNode, byte[]> reader = ref -> bodies.get(ref.path("resourceId").textValue());
    private final String writer = expected.path("writerId").textValue();
    private final CsiNativeActivationProof.Genesis genesis = CsiNativeActivationProof.genesis(records(0), original, reader);
    private final CsiNativeActivationProof.Activation activation = CsiNativeActivationProof.activation(
            transaction(1), request(1), original, writer, genesis.definitionDigest(), null, reader);

    @Test
    void acceptsUntouchedFiveTurnPrefixWithRefusalFractionalUsageAndChunkedMessage() {
        assertEquals(33, fixture.path("requests").size());
        assertEquals(46, bodies.size());
        int settlements = 0;
        var prefix = CsiNativeActivationProof.Prefix.empty();
        for (int index = 2; index < 32; index++) {
            var before = prefix;
            prefix = advance(index, prefix, reader);
            if ("settleTurn".equals(request(index).path("operation").textValue())) {
                settlements++;
                assertNull(prefix.input());
                assertNull(prefix.attempt());
                assertEquals(before.lastMessageId(), prefix.lastMessageId());
                assertEquals(request(index).path("latestCheckpointResourceId").textValue(), prefix.checkpointResourceId());
            } else if (index != 3) {
                assertEquals(before.checkpointResourceId(), prefix.checkpointResourceId());
            }
        }
        assertEquals(5, settlements);
        assertEquals("ckpt-41", prefix.checkpoint().state().path("identity").path("checkpointId").textValue());
        assertEquals(39, prefix.checkpoint().state().path("resume").path("throughSequence").longValue());
        assertTrue(prefix.usedIds().contains("198ae314-9da7-4d8c-a916-35313bb54ac6"));
        var completed = prefix;
        rejected(() -> advance(32, completed, reader));
    }

    @Test
    void refusesMessageBeforeCheckpointAssistantBeforeTerminalAndDuplicateStart() {
        rejected(() -> advance(4, prefix(3), reader));
        rejected(() -> advance(7, prefix(6), reader));
        rejected(() -> advance(5, prefix(6), reader));
        rejected(() -> advance(7, prefix(8), reader));
        rejected(() -> advance(9, prefix(8), reader));
    }

    @Test
    void refusesDifferentPromptParentRoleAndUnsupportedPartsWithMatchingBodyDigest() throws IOException {
        for (String field : List.of("daemonPromptId", "parentUuid", "type", "sessionId", "cwd", "version")) {
            mutatedBody(4, "contentRef", record -> record.put(field, "different"));
        }
        mutatedBody(4, "contentRef", record -> ((ObjectNode) record.path("message").path("parts").get(0))
                .put("text", "different text"));
        mutatedBody(7, "contentRef", record -> record.put("model", "different-model"));
        mutatedBody(7, "contentRef", record -> ((ObjectNode) record.path("message").path("parts").get(0))
                .putObject("functionCall"));
    }

    @Test
    void refusesWrongAttemptRouteUsageAndFullCheckpointStateWithMatchingBodyDigest() throws IOException {
        mutatedBody(5, "routeRef", route -> route.put("turnId", "different"));
        mutatedBody(5, "routeRef", route -> ((ObjectNode) route.path("budget")).put("promptId", "different"));
        mutatedBody(5, "routeRef", route -> ((ObjectNode) route.path("budget")).put("budget", 10));
        mutatedBody(6, "usageRef", usage -> usage.put("model", "different-model"));
        mutatedBody(6, "usageRef", usage -> usage.putArray("attempts"));
        mutatedBody(8, "resultRef", result -> ((ObjectNode) result.path("systemPayload")).put("state", "error"));
        mutatedBody(8, "stateRef", state -> ((ObjectNode) state.path("identity")).put("coveredSequence", 10));
        mutatedBody(8, "stateRef", state -> ((ObjectNode) state.path("identity")).put("previousCheckpointId", "ckpt-3"));
        mutatedBody(8, "stateRef", state -> ((ObjectNode) state.path("identity")).put("inputDigest", "different"));
        mutatedBody(8, "stateRef", state -> ((ObjectNode) state.path("resume").path("recording"))
                .put("lastCompletedUuid", "invented"));
        mutatedBody(8, "stateRef", state -> ((ObjectNode) state.path("resume")).put("initialTurn", 0.0));
    }

    @Test
    void refusesMissingOrReorderedChunkPartsAndInvalidUtf8() throws IOException {
        var tx = transaction(27);
        JsonNode manifestRef = tx.events().getFirst().path("payload").path("contentRef");
        JsonNode manifest = JSON.readTree(reader.apply(manifestRef));
        String first = manifest.path("parts").get(0).path("resourceId").textValue();
        rejected(() -> advance(27, prefix(27), ref -> first.equals(ref.path("resourceId").textValue()) ? null : reader.apply(ref)));
        mutatedBody(27, "contentRef", body -> {
            var parts = (com.fasterxml.jackson.databind.node.ArrayNode) body.path("parts");
            JsonNode firstPart = parts.remove(0);
            parts.add(firstPart);
        });
        byte[] broken = reader.apply(manifest.path("parts").get(0)).clone();
        broken[0] = (byte) 0xff;
        ObjectNode changedManifest = manifest.deepCopy();
        ((ObjectNode) changedManifest.path("parts").get(0)).put("digest", CsiNativeActivationProof.sha256(broken));
        byte[] manifestBytes = JSON.writeValueAsBytes(changedManifest);
        ObjectNode changedRef = (ObjectNode) manifestRef;
        changedRef.put("byteLength", manifestBytes.length).put("digest", CsiNativeActivationProof.sha256(manifestBytes));
        String manifestId = changedRef.path("resourceId").textValue();
        rejected(() -> CsiNativeActivationProof.advance(tx, request(27), original, writer, genesis, activation,
                request(27).path("expectedCommittedSequence").longValue(), prefix(27), ref -> {
                    String resourceId = ref.path("resourceId").textValue();
                    return first.equals(resourceId) ? broken : manifestId.equals(resourceId) ? manifestBytes : reader.apply(ref);
                }));
    }

    @Test
    void refusesSplitSettlementAndStandaloneLaterCheckpoint() {
        var complete = transaction(8);
        for (JsonNode event : complete.events()) {
            var split = new CsiNativeActivationProof.Transaction(List.of(event), complete.lastRecordUuid());
            rejected(() -> CsiNativeActivationProof.advance(split, request(8), original, writer, genesis,
                    activation, 8, prefix(8), reader));
        }
        ObjectNode standalone = request(8).deepCopy();
        standalone.put("operation", "commitCheckpoint");
        rejected(() -> CsiNativeActivationProof.advance(complete, standalone, original, writer, genesis,
                activation, 8, prefix(8), reader));
    }

    private void mutatedBody(int index, String field, java.util.function.Consumer<ObjectNode> change) throws IOException {
        var tx = transaction(index);
        JsonNode event = tx.events().get(field.equals("stateRef") ? 1 : 0);
        ObjectNode ref = (ObjectNode) event.path("payload").path(field);
        ObjectNode body = (ObjectNode) JSON.readTree(reader.apply(ref));
        change.accept(body);
        byte[] bytes = JSON.writeValueAsBytes(body);
        ref.put("byteLength", bytes.length).put("digest", CsiNativeActivationProof.sha256(bytes));
        ObjectNode metadata = request(index).deepCopy();
        if (field.equals("routeRef") || field.equals("resultRef")) {
            metadata.put("contentDigest", ref.path("digest").textValue());
        }
        String changedId = ref.path("resourceId").textValue();
        // Derived semantic negative: original transaction framing was parsed before changing its body/ref.
        rejected(() -> CsiNativeActivationProof.advance(tx, metadata, original, writer, genesis, activation,
                metadata.path("expectedCommittedSequence").longValue(), prefix(index),
                candidate -> changedId.equals(candidate.path("resourceId").textValue()) ? bytes : reader.apply(candidate)));
    }

    private CsiNativeActivationProof.Prefix prefix(int exclusive) {
        var prefix = CsiNativeActivationProof.Prefix.empty();
        for (int index = 2; index < exclusive; index++) {
            prefix = advance(index, prefix, reader);
        }
        return prefix;
    }

    private CsiNativeActivationProof.Prefix advance(int index, CsiNativeActivationProof.Prefix prefix,
            Function<JsonNode, byte[]> resources) {
        return CsiNativeActivationProof.advance(transaction(index), request(index), original, writer, genesis,
                activation, request(index).path("expectedCommittedSequence").longValue(), prefix, resources);
    }

    private CsiNativeActivationProof.Transaction transaction(int index) {
        return CsiNativeActivationProof.transaction(records(index), request(index), original,
                records(index - 1).getLast().path("uuid").textValue());
    }

    private List<JsonNode> records(int index) {
        return CsiNativeActivationProof.records(Base64.getDecoder().decode(request(index).path("recordBytesBase64").textValue()));
    }

    private JsonNode request(int index) {
        return fixture.path("requests").get(index);
    }

    private Map<String, byte[]> bodies() {
        Map<String, byte[]> result = new HashMap<>();
        for (JsonNode resource : fixture.path("originalResources")) {
            byte[] bytes = Base64.getDecoder().decode(resource.path("bytesBase64").textValue());
            assertEquals(resource.path("ref").path("digest").textValue(), CsiNativeActivationProof.sha256(bytes));
            assertEquals(resource.path("ref").path("byteLength").longValue(), bytes.length);
            result.put(resource.path("ref").path("resourceId").textValue(), bytes);
        }
        return result;
    }

    private static JsonNode fixture() {
        try (var stream = CsiNativeTextProofTest.class.getResourceAsStream("/csi-native-text-fixture.json")) {
            if (stream == null) {
                throw new IllegalStateException("Original native text fixture is unavailable");
            }
            return JSON.readTree(stream);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void rejected(Runnable action) {
        assertEquals("csi_original_activation_unavailable", assertThrows(RuntimeBrokerException.class, action::run).getCode());
    }
}
