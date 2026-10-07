package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class CsiNativeActivationProofTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JsonNode fixture = fixture();
    private final JsonNode expected = fixture.path("expected");
    private final JsonNode key = expected.path("sessionKey");
    private final RuntimeProvisionRequest original = CsiFilesRetirementProfile.request(new ContextBinding(
            key.path("tenantId").textValue(), key.path("workspaceId").textValue(), 1, "unit-storage", ".",
            CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), expected.path("cwd").textValue(),
            key.path("sessionId").textValue());
    private final Function<JsonNode, byte[]> resources = ref -> {
        for (JsonNode resource : fixture.path("originalResources")) {
            if (ref.path("resourceId").equals(resource.path("ref").path("resourceId"))) {
                return Base64.getDecoder().decode(resource.path("bytesBase64").textValue());
            }
        }
        return null;
    };

    @Test
    void acceptsUnmodifiedNativeProducerBytesAndRenewalWithChangedLease() {
        assertEquals("6e576ea3a0b44449a5679a6fb22be154f6ea3116f6ee8de1c49b9db90e1c8889",
                CsiNativeActivationProof.sha256(fixtureBytes()));
        var genesis = genesis();
        var installTransaction = transaction(1, genesis.lastRecordUuid());
        var install = activation(installTransaction, request(1), genesis, null, resources);
        var renewalTransaction = transaction(2, installTransaction.lastRecordUuid());
        var renewal = activation(renewalTransaction, request(2), genesis, install, resources);
        assertEquals(expected.path("activationId").textValue(), install.activationId());
        assertEquals(expected.path("writerId").textValue(), install.workerId());
        assertEquals(60000, install.leaseDurationMs());
        assertEquals(90000, renewal.leaseDurationMs());
        assertEquals(install.installRef(), renewal.installRef());
        assertEquals(1, renewal.renewalSequence());
        assertEquals(1, request(2).path("resources").size());
        assertEquals(install.installRef(), request(2).path("resources").get(0));
        assertTrue(!request(2).path("resources").get(0).has("bytesBase64"));
        for (var value : List.of(installTransaction, renewalTransaction)) {
            JsonNode event = value.events().getFirst();
            assertEquals(-1, event.path("payload").path("expiresAt").longValue()
                    - event.path("occurredAt").longValue() - event.path("payload").path("leaseDurationMs").longValue());
        }
    }

    @Test
    void rejectsDuplicateTrailingInvalidUtf8AndOversizedLines() {
        for (byte[] bytes : List.of("{\"uuid\":1,\"uuid\":2}\n".getBytes(StandardCharsets.UTF_8),
                "{} {}\n".getBytes(StandardCharsets.UTF_8), new byte[] {(byte) 0xc0, (byte) 0x80, '\n'},
                "{}".getBytes(StandardCharsets.UTF_8), "{}\n\n".getBytes(StandardCharsets.UTF_8),
                ("{\"padding\":\"" + "x".repeat(1024 * 1024) + "\"}\n").getBytes(StandardCharsets.UTF_8))) {
            rejected(() -> CsiNativeActivationProof.records(bytes));
        }
    }

    @Test
    void rejectsImportedOrExpandedGenesisEvenWithMatchingResourceDigest() throws IOException {
        var genesisRecords = records(0);
        JsonNode definitionRef = genesisRecords.getLast().path("managedSession").path("definitionRef");
        ObjectNode definition = (ObjectNode) JSON.readTree(resources.apply(definitionRef));
        for (String field : List.of("hooks", "mcpServers", "approvalMode")) {
            ObjectNode expanded = definition.deepCopy().put(field, "unqualified");
            byte[] bytes = JSON.writeValueAsBytes(expanded);
            var mutated = records(0);
            ObjectNode ref = (ObjectNode) mutated.getLast().path("managedSession").path("definitionRef");
            ref.put("digest", CsiNativeActivationProof.sha256(bytes)).put("byteLength", bytes.length);
            rejected(() -> CsiNativeActivationProof.genesis(mutated, original,
                    candidate -> candidate.path("resourceId").equals(ref.path("resourceId")) ? bytes : resources.apply(candidate)));
        }
        var imported = records(0);
        ((ObjectNode) imported.getLast().path("managedSession")).put("createdBy", "imported");
        rejected(() -> CsiNativeActivationProof.genesis(imported, original, resources));
    }

    @Test
    void rejectsDifferentWorkerBodyAndExtraSubjectWithValidEventDigest() throws IOException {
        var genesis = genesis();
        for (String field : List.of("workerId", "phase", "epoch")) {
            var parsed = transaction(1, genesis.lastRecordUuid());
            ObjectNode payload = (ObjectNode) parsed.events().getFirst().path("payload");
            if (field.equals("epoch")) {
                payload.put(field, 2);
            } else {
                payload.put(field, "different");
            }
            JsonNode metadata = digestForEvents(request(1), parsed.events());
            rejected(() -> activation(parsed, metadata, genesis, null, resources));
        }
        var parsed = transaction(1, genesis.lastRecordUuid());
        ((ObjectNode) parsed.events().getFirst()).set("subject", parsed.events().getFirst().path("payload").path("subject"));
        JsonNode metadata = digestForEvents(request(1), parsed.events());
        rejected(() -> activation(parsed, metadata, genesis, null, resources));
        var valid = transaction(1, genesis.lastRecordUuid());
        JsonNode ref = valid.events().getFirst().path("payload").path("installRef");
        byte[] wrong = resources.apply(ref).clone();
        wrong[0] ^= 1;
        rejected(() -> activation(valid, request(1), genesis, null, candidate -> wrong));
    }

    @Test
    void rejectsReplacementAndDuplicateActivationEvents() {
        var genesis = genesis();
        var installed = transaction(1, genesis.lastRecordUuid());
        var previous = activation(installed, request(1), genesis, null, resources);
        rejected(() -> activation(installed, request(1), genesis, previous, resources));
        var doubled = new CsiNativeActivationProof.Transaction(List.of(installed.events().getFirst(),
                installed.events().getFirst()), installed.lastRecordUuid());
        assertTrue(CsiNativeActivationProof.hasActivation(doubled));
        rejected(() -> activation(doubled, request(1), genesis, null, resources));
        var renewal = transaction(2, installed.lastRecordUuid());
        ((ObjectNode) renewal.events().getFirst().path("payload")).put("renewalSeq", 2);
        rejected(() -> activation(renewal, request(2), genesis, previous, resources));
    }

    @Test
    void rejectsChangedEnvelopeChainAndMarkerDigest() {
        var genesis = genesis();
        var changed = records(1);
        ((ObjectNode) changed.getFirst()).put("parentUuid", "different");
        rejected(() -> CsiNativeActivationProof.transaction(changed, request(1), original, genesis.lastRecordUuid()));
        var metadata = request(1).deepCopy();
        ((ObjectNode) metadata).put("commitDigest", "0".repeat(64));
        rejected(() -> CsiNativeActivationProof.transaction(records(1), metadata, original, genesis.lastRecordUuid()));
    }

    @Test
    void refusesChangedEventWithUnchangedValidCommitMarker() {
        var genesis = genesis();
        var changed = records(1);
        ObjectNode event = (ObjectNode) changed.getFirst().path("managedSession");
        event.put("occurredAt", event.path("occurredAt").longValue() + 1);
        rejected(() -> CsiNativeActivationProof.transaction(changed, request(1), original, genesis.lastRecordUuid()));
    }

    @Test
    void nativeTimeBoundaryAcceptsMaximumAndRefusesLargerSafeIntegersWithValidDigest() throws IOException {
        var genesis = genesis();
        for (long[] values : List.of(new long[] {8_639_999_999_940_000L, 8_640_000_000_000_000L},
                new long[] {8_640_000_000_000_001L, 8_640_000_000_060_000L},
                new long[] {1000, 8_640_000_000_000_001L})) {
            var parsed = transaction(1, genesis.lastRecordUuid());
            ((ObjectNode) parsed.events().getFirst()).put("occurredAt", values[0]);
            ((ObjectNode) parsed.events().getFirst().path("payload")).put("expiresAt", values[1]);
            JsonNode metadata = digestForEvents(request(1), parsed.events());
            if (values[1] == 8_640_000_000_000_000L) {
                assertEquals(values[1], activation(parsed, metadata, genesis, null, resources).expiresAt());
            } else {
                rejected(() -> activation(parsed, metadata, genesis, null, resources));
            }
        }
    }

    private CsiNativeActivationProof.Genesis genesis() {
        return CsiNativeActivationProof.genesis(records(0), original, resources);
    }

    private CsiNativeActivationProof.Transaction transaction(int index, String parent) {
        return CsiNativeActivationProof.transaction(records(index), request(index), original, parent);
    }

    private CsiNativeActivationProof.Activation activation(CsiNativeActivationProof.Transaction transaction,
            JsonNode metadata, CsiNativeActivationProof.Genesis genesis, CsiNativeActivationProof.Activation previous,
            Function<JsonNode, byte[]> reader) {
        return CsiNativeActivationProof.activation(transaction, metadata, original,
                expected.path("writerId").textValue(), genesis.definitionDigest(), previous, reader);
    }

    private JsonNode request(int index) {
        return fixture.path("requests").get(index);
    }

    private List<JsonNode> records(int index) {
        return CsiNativeActivationProof.records(Base64.getDecoder().decode(request(index).path("recordBytesBase64").textValue()));
    }

    private static JsonNode digestForEvents(JsonNode metadata, List<JsonNode> events) throws IOException {
        ObjectNode copy = metadata.deepCopy();
        byte[] canonical = JSON.writeValueAsBytes(events.stream().map(CsiNativeActivationProofTest::sorted).toList());
        copy.put("eventsDigest", CsiNativeActivationProof.sha256(canonical));
        return copy;
    }

    private static Object sorted(JsonNode node) {
        if (node.isObject()) {
            Map<String, Object> values = new TreeMap<>();
            node.fields().forEachRemaining(field -> values.put(field.getKey(), sorted(field.getValue())));
            return values;
        }
        if (node.isArray()) {
            var values = new java.util.ArrayList<>();
            node.forEach(child -> values.add(sorted(child)));
            return values;
        }
        return JSON.convertValue(node, Object.class);
    }

    private static void rejected(Runnable action) {
        assertEquals("csi_original_activation_unavailable", assertThrows(RuntimeBrokerException.class, action::run).getCode());
    }

    private static JsonNode fixture() {
        try {
            return JSON.readTree(fixtureBytes());
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private static byte[] fixtureBytes() {
        try (var input = CsiNativeActivationProofTest.class.getResourceAsStream("/csi-native-activation-fixture.json")) {
            if (input == null) {
                throw new IllegalStateException("Native fixture is unavailable");
            }
            return input.readAllBytes();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }
}
