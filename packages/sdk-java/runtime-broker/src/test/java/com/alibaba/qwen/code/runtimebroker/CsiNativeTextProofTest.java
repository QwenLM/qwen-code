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
        rejected(() -> CsiNativeActivationProof.advance(tx, request(27), original, writer, genesis, activation, request(27).path("expectedJournalRevision").longValue(),
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
                    activation, request(8).path("expectedJournalRevision").longValue(), 8, prefix(8), reader));
        }
        ObjectNode standalone = request(8).deepCopy();
        standalone.put("operation", "commitCheckpoint");
        rejected(() -> CsiNativeActivationProof.advance(complete, standalone, original, writer, genesis,
                activation, standalone.path("expectedJournalRevision").longValue(), 8, prefix(8), reader));
    }

    @Test
    void acceptsOriginalTerminalAsFactAndRetainsSettledPredecessor() {
        var settled = prefix(32);
        var proof = terminal(records(32), request(32), activation, settled, reader);
        assertEquals(activation, proof.predecessorActivation());
        assertEquals(settled, proof.predecessorPrefix());
        assertEquals(41, proof.predecessorSequence());
        assertEquals("941bb2c6-c5a2-4571-8856-6e8820365fa9", proof.predecessorLastRecordUuid());
        assertEquals(request(31).path("commitDigest").textValue(), proof.predecessorCommitDigest());
        assertEquals(42, proof.terminalSequence());
        assertEquals("fc17e89d-c50c-4b55-b69d-aa58659e7242", proof.lastRecordUuid());
        JsonNode ref = proof.boundaryRef();
        ((ObjectNode) ref).put("digest", "changed");
        assertEquals("0c89c0851c49d8ce264f4359c8c7da89703971df8c5f4ef9b870a9612983180e",
                proof.boundaryRef().path("digest").textValue());
        rejected(() -> CsiNativeActivationProof.activation(transaction(32), request(32), original,
                writer, genesis.definitionDigest(), activation, reader));
        rejected(() -> advance(32, settled, reader));
        var savedActivation = proof.predecessorActivation();
        var savedPrefix = proof.predecessorPrefix();
        ((ObjectNode) activation.installRef()).put("digest", "changed source");
        ((ObjectNode) settled.checkpoint().state()).put("changed", true);
        ((ObjectNode) proof.predecessorActivation().installRef()).put("digest", "changed accessor");
        ((ObjectNode) proof.predecessorPrefix().checkpoint().state()).put("changed", true);
        assertEquals(savedActivation, proof.predecessorActivation());
        assertEquals(savedPrefix, proof.predecessorPrefix());
    }

    @Test
    void terminalSnapshotIsolatesConstructedHistoricalGraphWithoutGrantingHistoryAuthority() {
        ObjectNode mutable = JSON.createObjectNode().put("value", "original");
        var batch = new CsiNativeActivationProof.PendingBatch("message", mutable,
                List.of(new CsiNativeActivationProof.FunctionCall("call", "tool", mutable, 0, 0)));
        var frozen = new CsiNativeActivationProof.FrozenBatch(mutable, mutable, List.of(mutable), 1, 2);
        var historical = new CsiNativeActivationProof.Prefix(null,
                new CsiNativeActivationProof.Checkpoint(mutable, mutable), "message", null, false, null,
                new java.util.HashSet<>(List.of("used")), null,
                Map.of("batch", new CsiNativeActivationProof.OriginalBatch("prompt", batch)),
                new CsiNativeActivationProof.FileHistory(mutable, mutable, Map.of("batch", frozen)),
                Map.of("intent", new CsiNativeActivationProof.ToolIntent(mutable, 1, 1, "digest")),
                Map.of("receipt", new CsiNativeActivationProof.ToolReceipt(mutable, mutable, 1, 1, 1)), 0);
        var proof = new CsiNativeActivationProof.TerminalProof(activation, historical, mutable,
                41, "941bb2c6-c5a2-4571-8856-6e8820365fa9", "digest", 42,
                "fc17e89d-c50c-4b55-b69d-aa58659e7242");
        var saved = proof.predecessorPrefix();
        mutable.put("value", "source changed");
        historical.usedIds().add("source changed");
        var returned = proof.predecessorPrefix();
        returned.usedIds().add("accessor changed");
        ((ObjectNode) returned.batches().get("batch").batch().calls().getFirst().args()).put("value", "changed");
        ((ObjectNode) returned.fileHistory().batches().get("batch").invocations().getFirst()).put("value", "changed");
        ((ObjectNode) returned.intents().get("intent").payload()).put("value", "changed");
        ((ObjectNode) returned.receipts().get("receipt").body()).put("value", "changed");
        assertEquals(saved, proof.predecessorPrefix());
        assertEquals("original", proof.boundaryRef().path("value").textValue());
    }

    @Test
    void refusesTerminalClosedEventPayloadSubjectAndReferenceFieldsWithValidFrame() throws IOException {
        for (String section : List.of("event", "payload", "subject", "boundaryRef")) {
            ObjectNode source = terminalSection((ObjectNode) records(32).getFirst().path("managedSession"), section);
            for (String field : java.util.stream.StreamSupport.stream(
                    java.util.Spliterators.spliteratorUnknownSize(source.fieldNames(), 0), false).toList()) {
                changedTerminal(event -> terminalSection(event, section).remove(field), metadata -> { }, null);
            }
            changedTerminal(event -> terminalSection(event, section).put("unknown", true), metadata -> { }, null);
        }
        for (String field : List.of("activationId", "workerId", "phase")) {
            changedTerminal(event -> ((ObjectNode) event.path("payload")).put(field, "different"), metadata -> { }, null);
        }
        for (String field : List.of("epoch", "expiresAt", "leaseDurationMs")) {
            changedTerminal(event -> ((ObjectNode) event.path("payload")).put(field, 2), metadata -> { }, null);
        }
        changedTerminal(event -> ((ObjectNode) event.path("payload")).putObject("installRef"), metadata -> { }, null);
        changedTerminal(event -> ((ObjectNode) event.path("payload")).put("renewalSeq", 1), metadata -> { }, null);
        for (String field : List.of("type", "scopeId", "activationId")) {
            changedTerminal(event -> ((ObjectNode) event.path("payload").path("subject")).put(field, "different"), metadata -> { }, null);
        }
        changedTerminal(event -> ((ObjectNode) event.path("payload").path("subject")).put("epoch", 2), metadata -> { }, null);
        for (String field : List.of("kind", "eventId")) {
            changedTerminal(event -> event.put(field, "different"), metadata -> { }, null);
        }
        changedTerminal(event -> event.put("occurredAt", -1), metadata -> { }, null);
        changedTerminal(event -> ((ObjectNode) event.path("payload").path("boundaryRef")).put("kind", "managed-root"), metadata -> { }, null);
        changedTerminal(event -> ((ObjectNode) event.path("payload").path("boundaryRef")).put("schemaVersion", 2), metadata -> { }, null);
    }

    @Test
    void refusesTerminalMetadataAndPredecessorConflictsWithValidFrame() throws IOException {
        for (String field : List.of("operation", "commandId", "contentDigest", "writerId", "previousCommitDigest")) {
            changedTerminal(event -> { }, metadata -> metadata.put(field, "different"), null);
        }
        for (String field : List.of("writerGeneration", "activationEpoch", "firstSequence", "lastSequence", "eventCount")) {
            changedTerminal(event -> { }, metadata -> metadata.put(field, 2), null);
        }
        changedTerminal(event -> { }, metadata -> metadata.put("latestCheckpointResourceId", "checkpoint"), null);
        for (String field : List.of("checkpoint", "input", "attempt", "stream", "pendingBatch")) {
            ObjectNode changed = JSON.valueToTree(prefix(32));
            changed.set(field, switch (field) {
                case "checkpoint" -> JSON.nullNode();
                case "input" -> JSON.valueToTree(prefix(5).input());
                case "attempt" -> JSON.valueToTree(prefix(6).attempt());
                case "stream" -> JSON.valueToTree(new CsiNativeActivationProof.Stream("message", 1, "text"));
                default -> JSON.valueToTree(new CsiNativeActivationProof.PendingBatch("message", JSON.createObjectNode(), List.of()));
            });
            var incomplete = JSON.treeToValue(changed, CsiNativeActivationProof.Prefix.class);
            rejected(() -> terminal(records(32), request(32), activation, incomplete, reader));
        }
        var successor = new CsiNativeActivationProof.Activation(activation.activationId(), writer,
                activation.installRef(), activation.leaseDurationMs(), activation.expiresAt(), 0, 2, 3);
        rejected(() -> terminal(records(32), request(32), successor, prefix(32), reader));
        rejected(() -> CsiNativeActivationProof.terminal(records(32), request(32), original, genesis,
                activation, prefix(32), 40, records(31).getLast().path("uuid").textValue(),
                request(31).path("commitDigest").textValue(), reader));
        rejected(() -> CsiNativeActivationProof.terminal(records(32), request(32), original, genesis,
                activation, prefix(32), 41, records(32).getLast().path("uuid").textValue(),
                request(31).path("commitDigest").textValue(), reader));
    }

    @Test
    void refusesTerminalBoundaryGrammarAndBytesWithMatchingReferenceAndFrame() throws IOException {
        JsonNode ref = records(32).getFirst().path("managedSession").path("payload").path("boundaryRef");
        ObjectNode originalBody = (ObjectNode) JSON.readTree(reader.apply(ref));
        for (String field : List.of("version", "activationId", "epoch", "committedSequence", "lastRecordUuid")) {
            ObjectNode missing = originalBody.deepCopy();
            missing.remove(field);
            changedTerminal(event -> { }, metadata -> { }, JSON.writeValueAsBytes(missing));
            ObjectNode wrong = originalBody.deepCopy();
            wrong.put(field, "different");
            changedTerminal(event -> { }, metadata -> { }, JSON.writeValueAsBytes(wrong));
        }
        ObjectNode unknown = originalBody.deepCopy();
        unknown.put("unknown", true);
        changedTerminal(event -> { }, metadata -> { }, JSON.writeValueAsBytes(unknown));
        String body = new String(reader.apply(ref), java.nio.charset.StandardCharsets.UTF_8);
        for (byte[] bytes : List.of(
                (body + "{}").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                body.replace("\"version\":1", "\"version\":1,\"version\":1").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                (body + " ".repeat(16 * 1024)).getBytes(java.nio.charset.StandardCharsets.UTF_8),
                new byte[] {(byte) 0xff}, new byte[0])) {
            changedTerminal(event -> { }, metadata -> { }, bytes);
        }
        rejected(() -> terminal(records(32), request(32), activation, prefix(32), ignored -> null));
    }

    private void changedTerminal(java.util.function.Consumer<ObjectNode> changeEvent,
            java.util.function.Consumer<ObjectNode> changeMetadata, byte[] boundaryBytes) throws IOException {
        ObjectNode eventRecord = records(32).getFirst().deepCopy();
        ObjectNode markerRecord = records(32).getLast().deepCopy();
        ObjectNode event = (ObjectNode) eventRecord.path("managedSession");
        ObjectNode metadata = request(32).deepCopy();
        String resourceId = event.path("payload").path("boundaryRef").path("resourceId").textValue();
        if (boundaryBytes != null) {
            ((ObjectNode) event.path("payload").path("boundaryRef")).put("byteLength", boundaryBytes.length)
                    .put("digest", CsiNativeActivationProof.sha256(boundaryBytes));
        }
        changeEvent.accept(event);
        changeMetadata.accept(metadata);
        metadata.put("eventsDigest", CsiNativeActivationProof.sha256(CsiNativeActivationProof.canonical(
                JSON.createArrayNode().add(event)).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        ObjectNode marker = (ObjectNode) markerRecord.path("managedSession");
        marker.fieldNames().forEachRemaining(field -> marker.set(field, metadata.get(field)));
        metadata.put("commitDigest", CsiNativeActivationProof.sha256(CsiNativeActivationProof.canonical(marker)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        rejected(() -> terminal(List.of(eventRecord, markerRecord), metadata, activation, prefix(32),
                ref -> boundaryBytes != null && resourceId.equals(ref.path("resourceId").textValue())
                        ? boundaryBytes : reader.apply(ref)));
    }

    private static ObjectNode terminalSection(ObjectNode event, String section) {
        return (ObjectNode) switch (section) {
            case "event" -> event;
            case "payload" -> event.path("payload");
            default -> event.path("payload").path(section);
        };
    }

    private CsiNativeActivationProof.TerminalProof terminal(List<JsonNode> terminalRecords, JsonNode metadata,
            CsiNativeActivationProof.Activation previous, CsiNativeActivationProof.Prefix settled,
            Function<JsonNode, byte[]> resources) {
        return CsiNativeActivationProof.terminal(terminalRecords, metadata, original, genesis, previous, settled,
                41, records(31).getLast().path("uuid").textValue(), request(31).path("commitDigest").textValue(), resources);
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
        rejected(() -> CsiNativeActivationProof.advance(tx, metadata, original, writer, genesis, activation, metadata.path("expectedJournalRevision").longValue(),
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
                activation, request(index).path("expectedJournalRevision").longValue(), request(index).path("expectedCommittedSequence").longValue(), prefix, resources);
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
