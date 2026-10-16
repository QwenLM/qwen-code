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
    void acceptsChunkedFullResultsAndRetainsExactConvertedHistory() throws Exception {
        for (String status : List.of("success", "error")) {
            var before = prefix(12);
            ObjectNode envelope = JSON.createObjectNode().put("executionStatus", status);
            envelope.putArray("responseParts").addObject().put("text", "原文 😀\n".repeat(10_000));
            if (status.equals("error")) {
                envelope.putObject("error").put("message", "failure");
            }
            var changed = receipt(envelope, true);
            var after = advance(changed.transaction(), changed.metadata(), before);
            var body = after.receipts().values().iterator().next().body();
            assertEquals(envelope, body.path("envelope"));
            assertEquals(CsiNativeActivationProof.convertedResult(envelope, before.pendingBatch().calls().getFirst()),
                    body.path("history").path("parts"));
        }
    }

    @Test
    void acceptsTheMaximumHttpResultIncludingDuplicatedRuntimeError() throws Exception {
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "error");
        envelope.putArray("responseParts");
        var error = envelope.putObject("error").put("message", "");
        int overhead = CsiNativeActivationProof.utf8(CsiNativeActivationProof.canonical(envelope)).length;
        error.put("message", "x".repeat(CsiNativeReadbackProtocol.EXECUTION_RESULT_LIMIT - overhead));
        var changed = receipt(envelope, true);
        assertEquals(envelope, advance(changed.transaction(), changed.metadata(), prefix(12))
                .receipts().values().iterator().next().body().path("envelope"));
        error.put("message", error.path("message").textValue() + "x");
        assertThrows(RuntimeBrokerException.class, () -> receipt(envelope, true));
    }

    @Test
    void advancesTheResultMessageAndCheckpointAfterAChunkedReceipt() throws Exception {
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts").addObject().put("text", "x".repeat(40 * 1024));
        var changed = receipt(envelope, true);
        var after = advance(changed.transaction(), changed.metadata(), prefix(12));
        var outcome = after.receipts().values().iterator().next();
        ObjectNode event = transaction(13).events().getFirst().deepCopy();
        ObjectNode metadata = request(13).deepCopy();
        ObjectNode record = (ObjectNode) JSON.readTree(reader.apply(event.path("payload").path("contentRef")));
        ((ObjectNode) record.path("message")).set("parts", outcome.body().path("history").path("parts"));
        JsonNode messageRef = publish("managed-message", JSON.writeValueAsBytes(record));
        ((ObjectNode) event.path("payload")).set("contentRef", messageRef);
        after = advance(new CsiNativeActivationProof.Transaction(List.of(event), transaction(13).lastRecordUuid()), metadata, after);
        event = transaction(14).events().getFirst().deepCopy();
        metadata = request(14).deepCopy();
        ObjectNode checkpoint = (ObjectNode) JSON.readTree(reader.apply(event.path("payload").path("stateRef")));
        for (JsonNode item : checkpoint.path("tools").path("items")) {
            if (outcome.body().path("executionCallId").equals(item.path("executionCallId"))) {
                ((ObjectNode) item).set("outcomeRef", outcome.ref());
            }
        }
        var checkpointRef = publish("managed-checkpoint", JSON.writeValueAsBytes(checkpoint));
        ((ObjectNode) event.path("payload")).set("stateRef", checkpointRef);
        metadata.put("contentDigest", checkpointRef.path("digest").textValue())
                .put("latestCheckpointResourceId", checkpointRef.path("resourceId").textValue());
        after = advance(new CsiNativeActivationProof.Transaction(List.of(event), transaction(14).lastRecordUuid()), metadata, after);
        assertEquals("settled", after.checkpoint().state().path("tools").path("items").get(0).path("state").textValue());
        assertEquals(outcome.ref(), after.checkpoint().state().path("tools").path("items").get(0).path("outcomeRef"));
    }

    @Test
    void refusesOversizedUnchunkedReceiptsAndMissingChangedOrRepeatedParts() throws Exception {
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts").addObject().put("text", "x".repeat(40 * 1024));
        var inline = receipt(envelope, false);
        assertThrows(RuntimeBrokerException.class, () -> advance(inline.transaction(), inline.metadata(), prefix(12)));
        for (String fault : List.of("missing", "digest", "duplicate", "short", "extra", "count")) {
            var changed = receipt(envelope, true);
            var ref = changed.transaction().events().getFirst().path("payload").path("toolOutcomeRef");
            ObjectNode manifest = (ObjectNode) JSON.readTree(reader.apply(ref));
            var parts = (com.fasterxml.jackson.databind.node.ArrayNode) manifest.path("parts");
            String partId = parts.get(0).path("resourceId").textValue();
            switch (fault) {
                case "missing" -> bodies.remove(partId);
                case "digest" -> bodies.get(partId)[0] ^= 1;
                case "duplicate" -> parts.set(1, parts.get(0));
                case "short" -> {
                    byte[] shortened = java.util.Arrays.copyOf(bodies.get(partId), 10);
                    bodies.put(partId, shortened);
                    ((ObjectNode) parts.get(0)).put("byteLength", shortened.length)
                            .put("digest", CsiNativeActivationProof.sha256(shortened));
                }
                case "extra" -> manifest.put("foreign", true);
                default -> {
                    while (parts.size() <= 69) {
                        parts.add(parts.get(0));
                    }
                }
            }
            var changedRef = publish("managed-tool-outcome-chunks", JSON.writeValueAsBytes(manifest));
            ((ObjectNode) changed.transaction().events().getFirst().path("payload")).set("toolOutcomeRef", changedRef);
            ((ObjectNode) changed.metadata()).put("contentDigest", changedRef.path("digest").textValue());
            assertThrows(RuntimeBrokerException.class, () -> advance(changed.transaction(), changed.metadata(), prefix(12)), fault);
        }
    }

    private Changed receipt(ObjectNode envelope, boolean chunked) throws Exception {
        var before = prefix(12);
        var tx = transaction(12);
        ObjectNode event = tx.events().getFirst().deepCopy();
        ObjectNode metadata = request(12).deepCopy();
        var oldRef = event.path("payload").path("toolOutcomeRef");
        ObjectNode body = (ObjectNode) JSON.readTree(reader.apply(oldRef));
        body.set("envelope", envelope);
        ((ObjectNode) body.path("history")).set("parts",
                CsiNativeActivationProof.convertedResult(envelope, before.pendingBatch().calls().getFirst()));
        byte[] bytes = JSON.writeValueAsBytes(body);
        JsonNode ref;
        if (chunked) {
            ObjectNode manifest = JSON.createObjectNode();
            var parts = manifest.putArray("parts");
            for (int offset = 0; offset < bytes.length; offset += 60 * 1024) {
                parts.add(publish("managed-tool-outcome-part",
                        java.util.Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + 60 * 1024))));
            }
            ref = publish("managed-tool-outcome-chunks", JSON.writeValueAsBytes(manifest));
        } else {
            ref = publish("managed-tool-outcome", bytes);
        }
        ((ObjectNode) event.path("payload")).set("toolOutcomeRef", ref);
        metadata.put("contentDigest", ref.path("digest").textValue());
        return new Changed(new CsiNativeActivationProof.Transaction(List.of(event), tx.lastRecordUuid()), metadata);
    }

    private JsonNode publish(String kind, byte[] bytes) {
        String resourceId = java.util.UUID.randomUUID().toString();
        bodies.put(resourceId, bytes);
        return JSON.createObjectNode().put("resourceId", resourceId).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", CsiNativeActivationProof.sha256(bytes));
    }

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
