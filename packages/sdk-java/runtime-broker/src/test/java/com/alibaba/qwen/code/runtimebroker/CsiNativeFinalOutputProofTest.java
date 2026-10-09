package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class CsiNativeFinalOutputProofTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JsonNode seed = fixture("csi-native-read-continuation-fixture.json");
    private final List<JsonNode> requests = requests();
    private final RuntimeProvisionRequest original = CsiFilesRetirementProfile.request(new ContextBinding(
            seed.path("sessionKey").path("tenantId").textValue(),
            seed.path("sessionKey").path("workspaceId").textValue(), 1, "unit-storage", ".",
            CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), seed.path("cwd").textValue(),
            seed.path("sessionKey").path("sessionId").textValue());
    private final Map<String, byte[]> bodies = bodies();
    private final Function<JsonNode, byte[]> reader = ref -> bodies.get(ref.path("resourceId").textValue());
    private final String writer = seed.path("writerId").textValue();
    private final CsiNativeActivationProof.Genesis genesis = CsiNativeActivationProof.genesis(
            records(seed.path("sessionCreate")), original, reader);
    private final CsiNativeActivationProof.Activation activation = CsiNativeActivationProof.activation(
            transaction(0), requests.getFirst(), original, writer, genesis.definitionDigest(), null, reader);

    @Test
    void validatesTheActualTypescriptAtomicChunkedOutputThenConsumesAndSettles() {
        var completed = prefix(21);
        assertTrue(completed.assistantCommitted());
        assertNull(completed.stream());
        assertEquals(23, requests.get(20).path("lastSequence").longValue());
        assertEquals("managed-message-chunks", completed.attempt().finalMessageRef().path("kind").textValue());
        assertEquals(completed.lastMessageId(), transaction(19).events().getFirst().path("payload").path("messageId").textValue());
        assertEquals(completed.intents().keySet(), CsiNativeActivationProof.completeOutputTail(completed, 23));
        var record = outputRecord();
        assertEquals("思考".repeat(17000), record.path("message").path("parts").get(0).path("text").textValue());
        assertEquals("original-signature", record.path("message").path("parts").get(0).path("thoughtSignature").textValue());
        assertEquals("AQID", record.path("message").path("parts").get(2).path("inlineData").path("data").textValue());
        var consumed = advance(21, completed);
        consumed.checkpoint().state().path("tools").path("items").forEach(item -> assertTrue(item.path("consumed").booleanValue()));
        assertThrows(RuntimeBrokerException.class, () -> CsiNativeActivationProof.completeOutputTail(consumed, 24));
        assertEquals("turn_settled", advance(22, consumed).checkpoint().state().path("continuation").path("phase").textValue());
    }

    @Test
    void retainsTheMarkerOnlyLegacyShapeWithoutGivingItCompleteOutputProof() {
        var tx = transaction(20);
        ObjectNode metadata = requests.get(20).deepCopy();
        metadata.put("contentDigest", tx.events().getFirst().path("payload").path("routeRef").path("digest").textValue());
        var marker = advance(new CsiNativeActivationProof.Transaction(List.of(tx.events().getFirst()), tx.lastRecordUuid()),
                metadata, prefix(20));
        assertNull(marker.attempt().finalMessageRef());
        assertThrows(RuntimeBrokerException.class, () -> CsiNativeActivationProof.completeOutputTail(marker, 22));
    }

    @Test
    void refusesDifferentAttemptScopeAndDigestBindings() {
        for (String field : List.of("modelAttemptId", "parentMessageId")) {
            Changed changed = changedRecord(record -> {});
            ((ObjectNode) changed.tx().events().get(1).path("payload")).put(field, "11111111-1111-4111-8111-111111111111");
            refused(changed);
        }
        Changed scope = changedRecord(record -> {});
        ((ObjectNode) scope.tx().events().get(1).path("subject")).put("epoch", 2);
        refused(scope);
        Changed digest = changedRecord(record -> {});
        ((ObjectNode) digest.metadata()).put("contentDigest", "0".repeat(64));
        refused(digest);
    }

    @Test
    void refusesAChangedParentModelStreamOrPromptInsideAReboundCompleteRecord() {
        for (String field : List.of("parentUuid", "model", "daemonPromptId")) {
            refused(changedRecord(record -> record.put(field, "foreign")));
        }
        refused(changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(1)).put("text", "changed visible stream")));
        refused(changedRecord(record -> ((ObjectNode) record.path("message")).put("role", "user")));
    }

    @Test
    void acceptsCanonicalInlineDataBeyondTheIdentifierStringLimit() {
        String encoded = Base64.getEncoder().encodeToString(new byte[8192]);
        Changed changed = changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(2).path("inlineData"))
                .put("data", encoded));
        assertNotNull(advance(changed.tx(), changed.metadata(), prefix(20)).attempt().finalMessageRef());
    }

    @Test
    void refusesUnsupportedPartsAndNonCanonicalInlineData() {
        for (String encoded : List.of("", "%%%", "AQI", "AR==")) {
            refused(changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(2).path("inlineData"))
                    .put("data", encoded)));
        }
        refused(changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(2).path("inlineData"))
                .put("mimeType", "invalid")));
        refused(changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(0)).put("thought", "true")));
        refused(changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(0)).put("thoughtSignature", 1)));
        refused(changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(1)).putObject("functionCall")));
        refused(changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(1)).put("unknown", true)));
    }

    @Test
    void doesNotClaimIndependentProviderAuthorshipOfLawfulThoughts() {
        Changed changed = changedRecord(record -> ((ObjectNode) record.path("message").path("parts").get(0))
                .put("thoughtSignature", "different lawful signature"));
        assertNotNull(advance(changed.tx(), changed.metadata(), prefix(20)).attempt().finalMessageRef());
    }

    @Test
    void requiresCompleteIntentReceiptMembershipBeforeColdClassification() {
        var originalPrefix = prefix(21);
        var receipts = new HashMap<>(originalPrefix.receipts());
        receipts.remove(receipts.keySet().iterator().next());
        var changed = new CsiNativeActivationProof.Prefix(originalPrefix.input(), originalPrefix.checkpoint(),
                originalPrefix.lastMessageId(), originalPrefix.attempt(), originalPrefix.assistantCommitted(),
                originalPrefix.stream(), originalPrefix.usedIds(), originalPrefix.pendingBatch(), originalPrefix.batches(),
                originalPrefix.fileHistory(), originalPrefix.intents(), receipts, originalPrefix.nextDeltaOrdinal());
        assertThrows(RuntimeBrokerException.class, () -> CsiNativeActivationProof.completeOutputTail(changed, 23));
    }

    private void refused(Changed changed) {
        assertEquals("csi_original_activation_unavailable", assertThrows(RuntimeBrokerException.class,
                () -> advance(changed.tx(), changed.metadata(), prefix(20))).getCode());
    }

    private Changed changedRecord(Consumer<ObjectNode> mutate) {
        ObjectNode record = outputRecord().deepCopy();
        ((ObjectNode) record.path("message").path("parts").get(0)).put("text", "short lawful thought");
        mutate.accept(record);
        byte[] bytes = CsiNativeActivationProof.utf8(record.toString());
        ObjectNode ref = JSON.createObjectNode().put("resourceId", "11111111-1111-4111-8111-111111111111")
                .put("kind", "managed-message").put("schemaVersion", 1).put("byteLength", bytes.length)
                .put("digest", CsiNativeActivationProof.sha256(bytes));
        bodies.put(ref.path("resourceId").textValue(), bytes);
        var tx = transaction(20);
        var events = tx.events().stream().<JsonNode>map(JsonNode::deepCopy).toList();
        ((ObjectNode) events.get(1).path("payload")).set("contentRef", ref);
        ObjectNode metadata = requests.get(20).deepCopy();
        var payload = events.getFirst().path("payload");
        var digest = JSON.createArrayNode().add("managed-final-output/1").add(payload.path("attemptId"));
        for (JsonNode item : List.of(payload.path("routeRef"), payload.path("inputCheckpointRef"), payload.path("usageRef"), ref)) {
            digest.add(JSON.createArrayNode().add(item.path("resourceId")).add(item.path("kind"))
                    .add(item.path("schemaVersion")).add(item.path("byteLength")).add(item.path("digest")));
        }
        metadata.put("contentDigest", CsiNativeActivationProof.sha256(CsiNativeActivationProof.utf8(digest.toString())));
        return new Changed(new CsiNativeActivationProof.Transaction(events, tx.lastRecordUuid()), metadata);
    }

    private JsonNode outputRecord() {
        JsonNode ref = transaction(20).events().get(1).path("payload").path("contentRef");
        JsonNode manifest = readJson(reader.apply(ref));
        var bytes = new ByteArrayOutputStream();
        manifest.path("parts").forEach(part -> bytes.writeBytes(reader.apply(part)));
        return readJson(bytes.toByteArray());
    }

    private CsiNativeActivationProof.Prefix prefix(int exclusive) {
        var prefix = CsiNativeActivationProof.Prefix.empty();
        for (int index = 1; index < exclusive; index++) {
            prefix = advance(index, prefix);
        }
        return prefix;
    }

    private CsiNativeActivationProof.Prefix advance(int index, CsiNativeActivationProof.Prefix prefix) {
        return advance(transaction(index), requests.get(index), prefix);
    }

    private CsiNativeActivationProof.Prefix advance(CsiNativeActivationProof.Transaction tx, JsonNode metadata,
            CsiNativeActivationProof.Prefix prefix) {
        return CsiNativeActivationProof.advance(tx, metadata, original, writer, genesis, activation,
                metadata.path("expectedJournalRevision").longValue(), metadata.path("expectedCommittedSequence").longValue(),
                prefix, reader);
    }

    private CsiNativeActivationProof.Transaction transaction(int index) {
        JsonNode prior = index == 0 ? seed.path("sessionCreate") : requests.get(index - 1);
        return CsiNativeActivationProof.transaction(records(requests.get(index)), requests.get(index), original,
                records(prior).getLast().path("uuid").textValue());
    }

    private static List<JsonNode> records(JsonNode request) {
        return CsiNativeActivationProof.records(Base64.getDecoder().decode(request.path("recordBytesBase64").textValue()));
    }

    private List<JsonNode> requests() {
        JsonNode tail = fixture("csi-native-final-output-fixture.json");
        assertEquals(18, tail.path("seedPrefixTransactions").intValue());
        List<JsonNode> requests = new ArrayList<>();
        for (int index = 0; index < 18; index++) {
            requests.add(seed.path("transactions").get(index));
        }
        tail.path("transactions").forEach(requests::add);
        return List.copyOf(requests);
    }

    private Map<String, byte[]> bodies() {
        Map<String, byte[]> result = new HashMap<>();
        List<JsonNode> all = new ArrayList<>(requests);
        all.addFirst(seed.path("sessionCreate"));
        for (JsonNode request : all) {
            for (JsonNode resource : request.path("resources")) {
                byte[] bytes = resource.has("bytesBase64")
                        ? Base64.getDecoder().decode(resource.path("bytesBase64").textValue())
                        : result.get(resource.path("resourceId").textValue());
                assertNotNull(bytes);
                assertEquals(resource.path("digest").textValue(), CsiNativeActivationProof.sha256(bytes));
                assertEquals(resource.path("byteLength").longValue(), bytes.length);
                result.put(resource.path("resourceId").textValue(), bytes);
            }
        }
        return result;
    }

    private static JsonNode fixture(String file) {
        try (var stream = CsiNativeFinalOutputProofTest.class.getResourceAsStream("/" + file)) {
            if (stream == null) {
                throw new IllegalStateException("Original final-output fixture is unavailable");
            }
            return JSON.readTree(stream);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private static JsonNode readJson(byte[] bytes) {
        try {
            return JSON.readTree(bytes);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private record Changed(CsiNativeActivationProof.Transaction tx, JsonNode metadata) {
    }
}
