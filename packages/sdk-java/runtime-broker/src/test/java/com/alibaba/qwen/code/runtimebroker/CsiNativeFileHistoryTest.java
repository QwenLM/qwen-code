package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Structural transition units; manual prefixes do not qualify a SQL owner or physical preimage. */
class CsiNativeFileHistoryTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "550e8400-e29b-41d4-a716-446655440001";
    private static final String PROMPT = "550e8400-e29b-41d4-a716-446655440002";
    private static final String BATCH = "550e8400-e29b-41d4-a716-446655440003";
    private static final String USER = "550e8400-e29b-41d4-a716-446655440004";
    private final RuntimeProvisionRequest original = CsiFilesRetirementProfile.request(new ContextBinding(
            "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", OWNER);
    private final Map<String, byte[]> resources = new HashMap<>();
    private final CsiNativeActivationProof.Activation activation = new CsiNativeActivationProof.Activation(
            "activation", "worker", null, 60_000, 1_000_000, 0);

    @Test
    void acceptsInitialIntentAndPreparedWithOriginalMembershipAndIntentSequence() throws Exception {
        var initial = initial();
        var conversation = conversation(initial);
        assertFalse(conversation.assistantCommitted());
        var intentBody = body(conversation, preparation());
        var intent = commit(conversation, intentBody, 14);
        assertEquals(15, intent.fileHistory().batches().get(BATCH).intentSequence());
        assertEquals(3, intent.fileHistory().batches().get(BATCH).invocations().size());
        var preparedBody = prepared(intent);
        var result = commit(intent, preparedBody, 19);
        var frozen = result.fileHistory().batches().get(BATCH);
        assertEquals(intent.fileHistory().ref(), frozen.intentRef());
        assertEquals(result.fileHistory().ref(), frozen.preparedRef());
        assertEquals(15, frozen.intentSequence());
        assertEquals(initial.fileHistory().body().path("backupDirectory"), result.fileHistory().body().path("backupDirectory"));
        assertThrows(RuntimeException.class, () -> commit(result, prepared(result), 20));
    }

    @Test
    void refusesCoherentHistoryBytesWithChangedPathsOwnerParentOrInput() throws Exception {
        var previous = conversation(initial());
        var intent = body(previous, preparation());
        for (String fault : List.of("paths", "owner", "parent", "input", "extra")) {
            ObjectNode changed = intent.deepCopy();
            switch (fault) {
                case "paths" -> ((ObjectNode) changed.path("preparation")).set("paths", JSON.valueToTree(List.of("caller.txt")));
                case "owner" -> changed.put("runtimeSessionId", UUID.randomUUID().toString());
                case "parent" -> ((ObjectNode) changed.path("record")).putNull("parentUuid");
                case "input" -> ((ObjectNode) changed.path("preparation").path("invocations").get(1))
                        .put("requestDigest", "sha256:" + "0".repeat(64));
                default -> changed.put("grant", true);
            }
            assertThrows(RuntimeException.class, () -> commit(previous, changed, 14), fault);
        }
    }

    @Test
    void refusesPreparedBeforeIntentAndChangedImmutableMembershipOrPreimageEvidence() throws Exception {
        var previous = conversation(initial());
        var intent = commit(previous, body(previous, preparation()), 14);
        for (String fault : List.of("intent", "read", "directory", "fingerprint", "snapshot")) {
            ObjectNode changed = prepared(intent);
            switch (fault) {
                case "intent" -> ((ObjectNode) changed.path("preparation")).set("intentRef", previous.fileHistory().ref());
                case "read" -> ((ArrayNode) changed.path("preparation").path("invocations")).remove(0);
                case "directory" -> ((ObjectNode) changed.path("backupDirectory")).put("directoryInode", "99");
                case "fingerprint" -> ((ObjectNode) changed.path("state").path("files")).set("new.txt",
                        JSON.valueToTree(Map.of("digest", "sha256:" + "a".repeat(64), "mode", 420)));
                default -> ((ObjectNode) changed.path("state").path("snapshots").get(0)).put("promptId", "foreign");
            }
            mirror(changed);
            assertThrows(RuntimeException.class, () -> commit(intent, changed, 19), fault);
        }
        assertThrows(RuntimeException.class, () -> commit(previous, prepared(intent), 19));
    }

    @Test
    void excludesGeneratedProjectionFromStableSemanticDigestButStillChecksItsParent() throws Exception {
        var previous = conversation(initial());
        ObjectNode first = body(previous, preparation());
        ObjectNode retry = first.deepCopy();
        ((ObjectNode) retry.path("record")).put("uuid", UUID.randomUUID().toString())
                .put("timestamp", "2026-10-10T00:00:00.000Z");
        assertEquals(digest(first), digest(retry));
        assertEquals(commit(previous, first, 14).fileHistory().body().path("preparation"),
                commit(previous, retry, 14).fileHistory().body().path("preparation"));
    }

    private CsiNativeActivationProof.Prefix initial() throws Exception {
        return commit(CsiNativeActivationProof.Prefix.empty(), body(CsiNativeActivationProof.Prefix.empty(), null), 1);
    }

    private CsiNativeActivationProof.Prefix conversation(CsiNativeActivationProof.Prefix initial) throws Exception {
        JsonNode parts;
        try (var input = getClass().getResourceAsStream("/csi-native-function-parts-baseline.json")) {
            parts = JSON.readTree(input);
        }
        var before = new CsiNativeActivationProof.Prefix(new CsiNativeActivationProof.Input(PROMPT, "unit", USER, true),
                new CsiNativeActivationProof.Checkpoint(JSON.createObjectNode(), JSON.createObjectNode()), USER,
                new CsiNativeActivationProof.Attempt("unit-attempt", JSON.createObjectNode(), JSON.createObjectNode(),
                        JSON.createObjectNode().put("model", "unit-model"), "output_committed"),
                false, null, Set.of(USER), null, Map.of(), initial.fileHistory());
        ObjectNode record = JSON.createObjectNode().put("uuid", BATCH).put("parentUuid", USER)
                .put("sessionId", OWNER).put("timestamp", "2026-10-09T00:00:00.000Z").put("type", "assistant")
                .put("cwd", "/workspace").put("version", "hosted-harness/1").put("daemonPromptId", PROMPT)
                .put("model", "unit-model");
        record.putObject("message").put("role", "model").set("parts", parts);
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", 14)
                .put("eventId", "message:" + BATCH).put("kind", "message.committed").put("occurredAt", 1000);
        event.set("sessionKey", JSON.valueToTree(Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", OWNER)));
        event.set("subject", JSON.valueToTree(Map.of("type", "activation", "scopeId", "activation", "activationId", "activation", "epoch", 1)));
        ObjectNode payload = event.putObject("payload").put("messageId", BATCH).put("role", "assistant").put("parentMessageId", USER);
        payload.set("contentRef", publish("managed-message", JSON.writeValueAsBytes(record)));
        ObjectNode metadata = JSON.createObjectNode().put("operation", "commitMessage").put("commandId", "recorder:" + BATCH)
                .put("writerId", "worker").put("writerGeneration", 1).put("activationEpoch", 1).put("contentDigest", "a".repeat(64));
        metadata.putNull("latestCheckpointResourceId");
        return CsiNativeActivationProof.advance(new CsiNativeActivationProof.Transaction(List.of(event), "unit-envelope"),
                metadata, original, "worker", new CsiNativeActivationProof.Genesis("a".repeat(64), "unit-definition", "unit-root", USER),
                activation, 13, before, ref -> resources.get(ref.path("resourceId").textValue()));
    }

    private ObjectNode preparation() throws Exception {
        var prefix = conversation(CsiNativeActivationProof.Prefix.empty());
        ObjectNode result = JSON.createObjectNode().put("stage", "intent").put("turnId", PROMPT)
                .put("promptId", PROMPT).put("batchId", BATCH);
        var invocations = result.putArray("invocations");
        var paths = new java.util.TreeSet<String>();
        for (var call : prefix.pendingBatch().calls()) {
            String payload = JSON.writeValueAsString(Map.of("toolName", call.name(), "input", call.args()));
            JsonNode inputRef = publish("managed-tool-input", JSON.writeValueAsBytes(Map.of(
                    "harnessSessionId", OWNER, "runtimeSessionId", OWNER, "payloadJson", payload)));
            JsonNode declaration = null;
            try (var input = getClass().getResourceAsStream("/csi-native-file-declarations.json")) {
                for (JsonNode candidate : JSON.readTree(input)) if (call.name().equals(candidate.path("name").textValue())) declaration = candidate;
            }
            var item = invocations.addObject().put("executionCallId", "unit-execution-" + call.ordinal())
                    .put("callId", UUID.randomUUID().toString()).put("functionCallId", call.id()).put("toolName", call.name())
                    .put("partIndex", call.partIndex()).put("ordinal", call.ordinal())
                    .put("requestDigest", "sha256:" + CsiNativeActivationProof.sha256(payload.getBytes(StandardCharsets.UTF_8)));
            item.set("inputRef", inputRef);
            item.set("toolDefinitionRef", publish("managed-tool-definition", JSON.writeValueAsBytes(declaration)));
            if (!call.name().equals("read_file")) paths.add(call.args().path("file_path").textValue());
        }
        result.set("paths", JSON.valueToTree(paths));
        return result;
    }

    private ObjectNode body(CsiNativeActivationProof.Prefix previous, JsonNode preparation) {
        ObjectNode body = previous.fileHistory() == null ? JSON.createObjectNode() : previous.fileHistory().body().deepCopy();
        long revision = previous.fileHistory() == null ? 1 : body.path("revision").longValue() + 1;
        String command = preparation == null ? "csi-file-history:bind:" + OWNER
                : "csi-file-history:" + preparation.path("stage").textValue() + ":" + BATCH;
        body.put("operationId", command).put("revision", revision).put("schemaVersion", 2)
                .put("profile", CsiFilesRetirementProfile.PROFILE).put("runtimeSessionId", OWNER);
        body.set("previousRecordRef", previous.fileHistory() == null ? JSON.nullNode() : previous.fileHistory().ref());
        if (previous.fileHistory() == null) {
            body.set("state", JSON.createObjectNode().put("ownerSessionId", OWNER).set("snapshots", JSON.createArrayNode()));
            ((ObjectNode) body.path("state")).set("files", JSON.createObjectNode());
            body.set("backupDirectory", JSON.valueToTree(Map.of("volumeDevice", "1", "volumeInode", "2", "directoryDevice", "1", "directoryInode", "3")));
            body.set("retainedBackups", JSON.createArrayNode());
        }
        body.set("preparation", preparation == null ? JSON.nullNode() : preparation);
        ObjectNode record = JSON.createObjectNode().put("uuid", UUID.randomUUID().toString()).put("sessionId", OWNER)
                .put("timestamp", "2026-10-09T00:00:00.000Z").put("type", "system").put("subtype", "file_history_snapshot")
                .put("cwd", "/workspace").put("version", "hosted-harness/1");
        record.put("parentUuid", previous.lastMessageId());
        body.set("record", record);
        mirror(body);
        return body;
    }

    private ObjectNode prepared(CsiNativeActivationProof.Prefix intent) {
        ObjectNode preparation = intent.fileHistory().body().path("preparation").deepCopy();
        preparation.put("stage", "prepared").set("intentRef", intent.fileHistory().ref());
        ObjectNode body = body(intent, preparation);
        var snapshot = ((ArrayNode) body.path("state").path("snapshots")).addObject()
                .put("promptId", PROMPT).put("timestamp", "2026-10-09T00:00:00.000Z");
        ObjectNode backups = snapshot.putObject("trackedFileBackups");
        for (JsonNode path : preparation.path("paths")) {
            backups.putObject(path.textValue()).putNull("backupFileName").put("version", 1)
                    .put("backupTime", "2026-10-09T00:00:00.000Z");
            ((ObjectNode) body.path("state").path("files")).putNull(path.textValue());
        }
        mirror(body);
        return body;
    }

    private static void mirror(ObjectNode body) {
        ((ObjectNode) body.path("record")).set("systemPayload", JSON.createObjectNode().set("snapshots", body.path("state").path("snapshots")));
    }

    private CsiNativeActivationProof.Prefix commit(CsiNativeActivationProof.Prefix previous, ObjectNode body, long sequence) throws Exception {
        var event = JSON.createObjectNode().put("v", 1).put("sequence", sequence + 1).put("eventId", "file_history:" + body.path("revision").longValue())
                .put("kind", "domain.committed").put("occurredAt", 1000);
        event.set("sessionKey", JSON.valueToTree(Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", OWNER)));
        var payload = event.putObject("payload").put("domain", "file_history").put("version", 1)
                .put("operationId", body.path("operationId").textValue());
        payload.set("recordRef", publish("managed-file_history", JSON.writeValueAsBytes(body)));
        var metadata = JSON.createObjectNode().put("operation", "commitFileHistory").put("commandId", body.path("operationId").textValue())
                .put("writerId", "worker").put("writerGeneration", 1).put("activationEpoch", 1).put("contentDigest", digest(body));
        metadata.putNull("latestCheckpointResourceId");
        return CsiNativeActivationProof.advance(new CsiNativeActivationProof.Transaction(List.of(event), "unit-envelope"),
                metadata, original, "worker", null, activation, sequence, previous,
                ref -> resources.get(ref.path("resourceId").textValue()));
    }

    private static String digest(ObjectNode body) {
        ObjectNode semantic = body.deepCopy();
        semantic.remove(List.of("operationId", "revision", "previousRecordRef", "record"));
        return CsiNativeActivationProof.sha256(CsiNativeActivationProof.canonical(semantic).getBytes(StandardCharsets.UTF_8));
    }

    private JsonNode publish(String kind, byte[] bytes) {
        String resourceId = UUID.randomUUID().toString();
        resources.put(resourceId, bytes);
        return JSON.valueToTree(Map.of("resourceId", resourceId, "kind", kind, "schemaVersion", 1,
                "byteLength", bytes.length, "digest", CsiNativeActivationProof.sha256(bytes)));
    }
}
