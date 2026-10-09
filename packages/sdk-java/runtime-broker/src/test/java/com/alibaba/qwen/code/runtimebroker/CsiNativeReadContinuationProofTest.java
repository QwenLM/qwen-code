package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

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

class CsiNativeReadContinuationProofTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JsonNode fixture = fixture();
    private final RuntimeProvisionRequest original = CsiFilesRetirementProfile.request(new ContextBinding(
            fixture.path("sessionKey").path("tenantId").textValue(),
            fixture.path("sessionKey").path("workspaceId").textValue(), 1, "unit-storage", ".",
            CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), fixture.path("cwd").textValue(),
            fixture.path("sessionKey").path("sessionId").textValue());
    private final Map<String, byte[]> bodies = bodies();
    private final Function<JsonNode, byte[]> reader = ref -> bodies.get(ref.path("resourceId").textValue());
    private final String writer = fixture.path("writerId").textValue();
    private final CsiNativeActivationProof.Genesis genesis = CsiNativeActivationProof.genesis(
            records(fixture.path("sessionCreate")), original, reader);
    private final CsiNativeActivationProof.Activation activation = CsiNativeActivationProof.activation(
            transaction(0), request(0), original, writer, genesis.definitionDigest(), null, reader);

    @Test
    void replaysOriginalTwoReadResultsAndTheSecondModelDeltaAtOrdinalOne() {
        var before = prefix(19);
        assertNull(before.stream());
        assertEquals(1, before.nextDeltaOrdinal());
        assertEquals(2, before.receipts().size());
        assertEquals("results_ready", before.checkpoint().state().path("continuation").path("phase").textValue());
        var continued = advance(19, before);
        assertEquals(2, continued.nextDeltaOrdinal());
        assertEquals(21, continued.stream().firstSequence());
        assertEquals(transaction(19).events().getFirst().path("payload").path("text").textValue(), continued.stream().text());
    }

    @Test
    void acceptsTheSilentRetryResetButRefusesAnyOtherJump() {
        var before = prefix(19);
        var reset = changedOrdinal(transaction(19), request(19), 0);
        var continued = advance(reset.transaction(), reset.metadata(), before);
        assertEquals(1, continued.nextDeltaOrdinal());
        assertEquals(21, continued.stream().firstSequence());
        var jump = changedOrdinal(transaction(19), request(19), 2);
        assertEquals("csi_original_activation_unavailable", assertThrows(RuntimeBrokerException.class,
                () -> advance(jump.transaction(), jump.metadata(), before)).getCode());
    }

    @Test
    void doesNotAllowResetInsideAnAlreadyVisibleMessage() {
        var before = advance(19, prefix(19));
        var next = changedOrdinal(transaction(19), request(19), 2);
        ((ObjectNode) next.transaction().events().getFirst()).put("sequence", 22);
        ((ObjectNode) next.metadata()).put("expectedCommittedSequence", 21).put("expectedJournalRevision", 21);
        assertEquals(3, advance(next.transaction(), next.metadata(), before).nextDeltaOrdinal());
        var repeated = changedOrdinal(transaction(19), request(19), 0);
        ObjectNode event = (ObjectNode) repeated.transaction().events().getFirst();
        event.put("sequence", 22);
        ((ObjectNode) repeated.metadata()).put("expectedCommittedSequence", 21).put("expectedJournalRevision", 21);
        assertEquals("csi_original_activation_unavailable", assertThrows(RuntimeBrokerException.class,
                () -> advance(repeated.transaction(), repeated.metadata(), before)).getCode());
    }

    @Test
    void resetsTheOrdinalAfterAnOriginalStreamRetraction() {
        var before = advance(19, prefix(19));
        ObjectNode metadata = request(19).deepCopy();
        String messageId = before.stream().messageId();
        String command = "assistant-retract:" + before.input().inputId() + ":" + messageId;
        metadata.put("operation", "assistantRetract").put("commandId", command)
                .put("expectedCommittedSequence", 21).put("expectedJournalRevision", 21)
                .put("contentDigest", CsiNativeActivationProof.sha256(CsiNativeActivationProof.utf8(messageId + ":21")));
        ObjectNode event = transaction(19).events().getFirst().deepCopy();
        event.put("sequence", 22).put("eventId", command).put("kind", "message.retracted");
        event.putObject("payload").put("messageId", messageId).put("turnId", before.input().inputId()).put("fromSequence", 21);
        var retracted = advance(new CsiNativeActivationProof.Transaction(List.of(event), "derived-retraction"), metadata, before);
        assertNull(retracted.stream());
        assertEquals(0, retracted.nextDeltaOrdinal());
    }

    private Changed changedOrdinal(CsiNativeActivationProof.Transaction tx, JsonNode metadata, int ordinal) {
        ObjectNode changed = metadata.deepCopy();
        String command = changed.path("commandId").textValue();
        command = command.substring(0, command.lastIndexOf(':') + 1) + ordinal;
        changed.put("commandId", command);
        ObjectNode event = tx.events().getFirst().deepCopy();
        event.put("eventId", command);
        return new Changed(new CsiNativeActivationProof.Transaction(List.of(event), tx.lastRecordUuid()), changed);
    }

    private CsiNativeActivationProof.Prefix prefix(int exclusive) {
        var prefix = CsiNativeActivationProof.Prefix.empty();
        for (int index = 1; index < exclusive; index++) {
            prefix = advance(index, prefix);
        }
        return prefix;
    }

    private CsiNativeActivationProof.Prefix advance(int index, CsiNativeActivationProof.Prefix prefix) {
        return advance(transaction(index), request(index), prefix);
    }

    private CsiNativeActivationProof.Prefix advance(CsiNativeActivationProof.Transaction tx, JsonNode metadata,
            CsiNativeActivationProof.Prefix prefix) {
        return CsiNativeActivationProof.advance(tx, metadata, original, writer, genesis, activation,
                metadata.path("expectedJournalRevision").longValue(), metadata.path("expectedCommittedSequence").longValue(),
                prefix, reader);
    }

    private CsiNativeActivationProof.Transaction transaction(int index) {
        JsonNode prior = index == 0 ? fixture.path("sessionCreate") : request(index - 1);
        return CsiNativeActivationProof.transaction(records(request(index)), request(index), original,
                records(prior).getLast().path("uuid").textValue());
    }

    private static List<JsonNode> records(JsonNode request) {
        return CsiNativeActivationProof.records(Base64.getDecoder().decode(request.path("recordBytesBase64").textValue()));
    }

    private JsonNode request(int index) {
        return fixture.path("transactions").get(index);
    }

    private Map<String, byte[]> bodies() {
        Map<String, byte[]> result = new HashMap<>();
        addBodies(result, fixture.path("sessionCreate"));
        fixture.path("transactions").forEach(request -> addBodies(result, request));
        return result;
    }

    private void addBodies(Map<String, byte[]> bodies, JsonNode request) {
        for (JsonNode resource : request.path("resources")) {
            byte[] bytes = resource.has("bytesBase64")
                    ? Base64.getDecoder().decode(resource.path("bytesBase64").textValue())
                    : bodies.get(resource.path("resourceId").textValue());
            assertNotNull(bytes);
            assertEquals(resource.path("digest").textValue(), CsiNativeActivationProof.sha256(bytes));
            assertEquals(resource.path("byteLength").longValue(), bytes.length);
            bodies.put(resource.path("resourceId").textValue(), bytes);
        }
    }

    private static JsonNode fixture() {
        try (var stream = CsiNativeReadContinuationProofTest.class.getResourceAsStream("/csi-native-read-continuation-fixture.json")) {
            if (stream == null) {
                throw new IllegalStateException("Original native Read fixture is unavailable");
            }
            return JSON.readTree(stream);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private record Changed(CsiNativeActivationProof.Transaction transaction, JsonNode metadata) {
    }
}
