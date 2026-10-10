package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

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
                id -> { throw new AssertionError("Malformed ref reached storage"); })).isInstanceOf(RuntimeException.class);
        var ref = partial.put("schemaVersion", 2).put("byteLength", 2).put("digest", "a".repeat(64));
        assertThatThrownBy(() -> ManagedHostedRecoveryRecords.reference(ref, "hosted-model-request", "tenant", "workspace", "session",
                id -> { throw new AssertionError("Unsupported ref reached storage"); })).isInstanceOf(RuntimeException.class);
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
}
