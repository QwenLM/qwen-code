package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedHostedRecoveryRecordsTest {
    private final ObjectMapper json = new ObjectMapper();

    private ObjectNode cleanup() {
        ObjectNode body = json.createObjectNode().put("v", 1).put("promptId", "prompt")
                .put("runtimeSessionId", "prompt").put("bindingId", "binding")
                .put("generation", "1").put("workspaceGeneration", "1").put("fileHistoryTurnId", "prompt");
        body.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", "session");
        return body;
    }

    private void validate(String kind, ObjectNode body) {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        ManagedHostedRecoveryRecords.validateResource(new ManagedSessionStoreModels.StoredResource(
                "resource", kind, 1, bytes.length, "a".repeat(64), bytes), "tenant", "workspace", "session",
                id -> { throw new AssertionError("No nested resource belongs to this cleanup descriptor"); });
    }

    @Test
    void requiresCompleteClosedRecoveryEnvelopes() {
        for (String kind : ManagedHostedRecoveryRecords.KINDS) {
            ObjectNode incomplete = cleanup();
            incomplete.remove("bindingId");
            assertThatThrownBy(() -> validate(kind, incomplete)).isInstanceOf(RuntimeException.class);
        }
        ObjectNode extra = cleanup().put("unexpected", true);
        assertThatThrownBy(() -> validate("hosted-turn-cleanup", extra)).isInstanceOf(RuntimeException.class);
        assertThatCode(() -> validate("hosted-turn-cleanup", cleanup())).doesNotThrowAnyException();
    }

    @Test
    void rejectsCoercedVersionsForeignScopesAndWrongOwners() {
        assertThatThrownBy(() -> validate("hosted-turn-cleanup", cleanup().put("v", "1"))).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> validate("hosted-turn-cleanup", cleanup().put("v", 1.5))).isInstanceOf(RuntimeException.class);
        ObjectNode foreign = cleanup();
        ((ObjectNode) foreign.get("sessionKey")).put("sessionId", "foreign");
        assertThatThrownBy(() -> validate("hosted-turn-cleanup", foreign)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> validate("hosted-turn-cleanup", cleanup().put("runtimeSessionId", "other"))).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> validate("hosted-turn-cleanup", cleanup().put("generation", "9223372036854775808"))).isInstanceOf(RuntimeException.class);
    }

    @Test
    void validatesTypedReferencesBeforeResolvingThem() {
        var partial = json.createObjectNode().put("resourceId", "missing").put("kind", "hosted-model-request");
        assertThatThrownBy(() -> ManagedHostedRecoveryRecords.reference(partial, "hosted-model-request", "tenant", "workspace", "session",
                id -> {
                    throw new AssertionError("Malformed ref reached storage");
                })).isInstanceOf(RuntimeException.class);
        var ref = partial.put("schemaVersion", 2).put("byteLength", 2).put("digest", "a".repeat(64));
        assertThatThrownBy(() -> ManagedHostedRecoveryRecords.reference(ref, "hosted-model-request", "tenant", "workspace", "session",
                id -> {
                    throw new AssertionError("Unsupported ref reached storage");
                })).isInstanceOf(RuntimeException.class);
    }

    @Test
    void acceptsCanonicalWakeRuntimeOwner() {
        String prompt = "monitor:wake:run";
        ObjectNode body = cleanup().put("promptId", prompt).put("fileHistoryTurnId", prompt)
                .put("runtimeSessionId", "wake-" + ToolPublicationContract.sha256(prompt.getBytes(StandardCharsets.UTF_8)));
        assertThatCode(() -> validate("hosted-turn-cleanup", body)).doesNotThrowAnyException();
        assertThatThrownBy(() -> validate("hosted-turn-cleanup", body.put("runtimeSessionId", prompt)))
                .isInstanceOf(RuntimeException.class);
    }

    @Test
    void sharesClosureMemoAcrossRootsAndStillRejectsConflictingMetadata() {
        byte[] bytes = "{}".getBytes(StandardCharsets.UTF_8);
        var nested = new ManagedSessionStoreModels.StoredResource("shared", "managed-definition", 1,
                bytes.length, "a".repeat(64), bytes);
        var ref = json.createObjectNode().put("resourceId", "shared").put("kind", nested.kind())
                .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", nested.digest());
        var seen = new java.util.HashMap<String, com.fasterxml.jackson.databind.JsonNode>();
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        java.util.function.Function<String, ManagedSessionStoreModels.StoredResource> reader = id -> {
            reads.incrementAndGet();
            return nested;
        };
        for (int i = 0; i < 12; i++) {
            byte[] root = json.createObjectNode().put("v", 3).set("definitionRef", ref).toString().getBytes(StandardCharsets.UTF_8);
            ManagedHostedRecoveryRecords.validateResource(new ManagedSessionStoreModels.StoredResource(
                    "root-" + i, "managed-action-options", 1, root.length, "b".repeat(64), root),
                    "tenant", "workspace", "session", reader, seen);
        }
        org.assertj.core.api.Assertions.assertThat(reads.get()).isEqualTo(1);
        assertThatThrownBy(() -> ManagedHostedRecoveryRecords.reference(ref.deepCopy().put("digest", "c".repeat(64)),
                "managed-definition", "tenant", "workspace", "session", reader, seen))
                .isInstanceOf(RuntimeException.class);
        org.assertj.core.api.Assertions.assertThat(reads.get()).isEqualTo(1);
    }

    @Test
    void validatesAgentSkillReferencesInsideTheManagedDefinitionClosure() {
        byte[] bytes = "[{\"name\":\"review\",\"description\":\"Review\",\"body\":\"Read the diff.\"}]"
                .getBytes(StandardCharsets.UTF_8);
        var skills = new ManagedSessionStoreModels.StoredResource("skills", "managed-agent-skills", 1,
                bytes.length, ToolPublicationContract.sha256(bytes), bytes);
        ObjectNode agent = json.createObjectNode();
        agent.set("skillsRef", reference(skills));
        ObjectNode body = json.createObjectNode();
        body.set("agentDefinition", agent);
        var definition = stored("definition", "managed-definition", body);
        var ref = reference(definition);
        java.util.function.Function<String, ManagedSessionStoreModels.StoredResource> reader = id -> {
            if (id.equals(definition.resourceId())) {
                return definition;
            }
            if (id.equals(skills.resourceId())) {
                return skills;
            }
            throw new IllegalStateException("Missing nested resource");
        };
        assertThatCode(() -> ManagedHostedRecoveryRecords.reference(ref, "managed-definition",
                "tenant", "workspace", "session", reader)).doesNotThrowAnyException();
        assertThatThrownBy(() -> ManagedHostedRecoveryRecords.reference(ref, "managed-definition",
                "tenant", "workspace", "session", id -> {
                    if (id.equals(definition.resourceId())) {
                        return definition;
                    }
                    throw new IllegalStateException("Missing skills");
                })).hasMessageContaining("Missing skills");
        assertThatThrownBy(() -> ManagedHostedRecoveryRecords.reference(ref, "managed-definition",
                "tenant", "workspace", "session", id -> id.equals(definition.resourceId()) ? definition
                        : new ManagedSessionStoreModels.StoredResource("skills", skills.kind(), 1,
                                skills.byteLength(), "0".repeat(64), bytes)))
                .hasMessageContaining("Hosted nested resource conflicts");
    }

    @Test
    void acceptsDigestCleanupIdentityForTheMaximumStablePrompt() {
        String prompt = "a".repeat(512);
        String original = "hosted-cleanup:" + prompt + ":" + prompt;
        String cleanupId = "hosted-cleanup:" + ToolPublicationContract.sha256(original.getBytes(StandardCharsets.UTF_8));
        ObjectNode body = cleanup().put("promptId", prompt).put("runtimeSessionId", prompt).put("fileHistoryTurnId", prompt);
        var resource = stored("cleanup", "hosted-turn-cleanup", body);
        ObjectNode payload = json.createObjectNode().put("cleanupId", cleanupId).put("state", "owed");
        payload.set("descriptorRef", reference(resource));
        for (String state : java.util.List.of("owed", "confirmed")) {
            payload.put("state", state);
            assertThatCode(() -> ManagedHostedRecoveryRecords.validateEvent("hosted.cleanup", payload,
                    "tenant", "workspace", "session", id -> resource)).doesNotThrowAnyException();
        }
        payload.put("cleanupId", original);
        assertThatThrownBy(() -> ManagedHostedRecoveryRecords.validateEvent("hosted.cleanup", payload,
                "tenant", "workspace", "session", id -> resource)).hasMessageContaining("512 UTF-8 bytes");
    }

    @Test
    void acceptsLegacyAndBooleanPreparedRetryPolicies() {
        ObjectNode legacy = modelRequest();
        assertThatCode(() -> validateModel(legacy)).doesNotThrowAnyException();
        for (boolean allow : new boolean[] {true, false}) {
            ObjectNode body = modelRequest();
            ((ObjectNode) body.get("prepared")).put("allowPersistentRetry", allow);
            assertThatCode(() -> validateModel(body)).doesNotThrowAnyException();
        }
    }

    @ParameterizedTest
    @ValueSource(longs = {0, 15, 16, 20, ManagedSessionStoreModels.MAX_SAFE_COUNTER})
    void acceptsNonnegativeSafeModelRoundCounters(long round) {
        assertThatCode(() -> validateModel(modelRequest().put("round", round))).doesNotThrowAnyException();
    }

    @Test
    void rejectsInvalidModelRoundCounters() {
        for (var value : java.util.List.of(json.getNodeFactory().numberNode(-1),
                json.getNodeFactory().numberNode(1.5), json.getNodeFactory().textNode("16"),
                json.getNodeFactory().numberNode(ManagedSessionStoreModels.MAX_SAFE_COUNTER + 1))) {
            ObjectNode body = modelRequest();
            body.set("round", value);
            assertThatThrownBy(() -> validateModel(body)).hasMessageContaining("round");
        }
    }

    @Test
    void rejectsInvalidPreparedRetryTypesAndUnknownFields() {
        for (var value : java.util.List.of(json.getNodeFactory().nullNode(), json.getNodeFactory().textNode("true"),
                json.getNodeFactory().numberNode(1), json.createObjectNode(), json.createArrayNode())) {
            ObjectNode body = modelRequest();
            ((ObjectNode) body.get("prepared")).set("allowPersistentRetry", value);
            assertThatThrownBy(() -> validateModel(body)).hasMessageContaining("retry policy");
        }
        ObjectNode legacyExtra = modelRequest();
        ((ObjectNode) legacyExtra.get("prepared")).put("unexpected", true);
        assertThatThrownBy(() -> validateModel(legacyExtra)).hasMessageContaining("exactly");
        ObjectNode currentExtra = modelRequest();
        ((ObjectNode) currentExtra.get("prepared")).put("allowPersistentRetry", true).put("unexpected", true);
        assertThatThrownBy(() -> validateModel(currentExtra)).hasMessageContaining("exactly");
    }

    private ObjectNode modelRequest() {
        ObjectNode body = json.createObjectNode().put("v", 1).put("promptId", "prompt")
                .put("sourceBootId", "boot").put("sourceEventEpoch", "epoch").put("messageId", "message")
                .put("round", 0).put("throughSequence", 1).put("pendingToolResults", false).putNull("workspaceContext");
        body.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", "session");
        body.set("definitionRef", reference(stored("definition", "managed-definition", json.createObjectNode())));
        body.set("rootSnapshotRef", reference(stored("root", "managed-root", json.createObjectNode())));
        body.putObject("sourceActivation").put("activationId", "activation").put("epoch", 1);
        ObjectNode prepared = body.putObject("prepared").put("routeSelector", "openai:fixture")
                .put("providerPin", "a".repeat(64)).put("promptTokensForClamp", 0);
        ObjectNode request = prepared.putObject("request").put("model", "fixture");
        request.putArray("contents");
        request.putObject("config");
        prepared.putArray("history");
        prepared.putArray("completedToolCallIds");
        return body;
    }

    private void validateModel(ObjectNode body) {
        body.put("requestDigest", ToolPublicationContract.sha256(body.get("prepared").toString().getBytes(StandardCharsets.UTF_8)));
        var resources = java.util.Map.of(
                "definition", stored("definition", "managed-definition", json.createObjectNode()),
                "root", stored("root", "managed-root", json.createObjectNode()));
        ManagedHostedRecoveryRecords.validateResource(stored("request", "hosted-model-request", body),
                "tenant", "workspace", "session", resources::get);
    }

    private ManagedSessionStoreModels.StoredResource stored(String id, String kind, ObjectNode body) {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        return new ManagedSessionStoreModels.StoredResource(id, kind, 1, bytes.length, ToolPublicationContract.sha256(bytes), bytes);
    }

    private ObjectNode reference(ManagedSessionStoreModels.StoredResource resource) {
        return json.createObjectNode().put("resourceId", resource.resourceId()).put("kind", resource.kind())
                .put("schemaVersion", resource.schemaVersion()).put("byteLength", resource.byteLength()).put("digest", resource.digest());
    }
}
