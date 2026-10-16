package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/** Retained grant data tests only; no SQL ownership, native admission or physical qualification. */
class JdbcCsiHistoricalGrantTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JsonNode fixture = fixture();
    private final String session = fixture.path("sessionKey").path("sessionId").textValue();
    private final RuntimeProvisionRequest request = CsiFilesRetirementProfile.request(new ContextBinding(
            fixture.path("sessionKey").path("tenantId").textValue(),
            fixture.path("sessionKey").path("workspaceId").textValue(), 1, "unit-storage", ".",
            CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), fixture.path("cwd").textValue(), session);
    private final JdbcCsiFilesRetirementGuard.Original original = new JdbcCsiFilesRetirementGuard.Original(
            request, "binding", 1, RuntimeBindingRecord.State.DRAINING, true, 3, 2L);
    private final Map<String, byte[]> bodies = bodies();
    private final CsiNativeActivationProof.Prefix prefix = prefix();
    private final JdbcCsiExecutionAdmission.DispatchCheckpoint checkpoint = new JdbcCsiExecutionAdmission.DispatchCheckpoint(
            13, 13, prefix.checkpoint().ref());
    private final Map<String, Object> context = Map.of("identity", Map.of("owner", "unit-original"),
            "context", Map.of("revision", 1), "installedContext", Map.of("session", session));

    @Test
    void retainedContextUsesTheSameInstalledOwnerProtocolAndRejectsMalformedFields() {
        var installed = new ContextBinding(request.getScope().getTenantId(), request.getScope().getWorkspaceId(),
                1, "unit-storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1);
        var handle = JSON.createObjectNode();
        handle.putObject("profileIdentity").put("owner", "unit-original");
        handle.putObject("context").put("revision", 1);
        var result = JdbcCsiExecutionAdmission.historicalGrantContext(request, installed, handle);
        assertEquals(CsiNativeActivationProof.canonical(handle.path("profileIdentity")),
                CsiNativeActivationProof.canonical(JSON.valueToTree(result.get("identity"))));
        var actual = JSON.valueToTree(result.get("installedContext"));
        assertEquals(3, actual.path("protocolVersion").intValue());
        assertEquals(session, actual.path("sessionId").textValue());
        assertEquals(installed.getContextDigest(), actual.path("contextDigest").textValue());
        assertEquals(UUID.nameUUIDFromBytes(session.getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString(),
                actual.path("operationId").textValue());
        for (String field : List.of("profileIdentity", "context")) {
            var changed = handle.deepCopy();
            changed.put(field, "foreign");
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiExecutionAdmission.historicalGrantContext(request, installed, changed));
        }
        var foreign = new ContextBinding("other", installed.getWorkspaceId(), 1, "unit-storage", ".",
                CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1);
        assertThrows(RuntimeException.class, () -> JdbcCsiExecutionAdmission.historicalGrantContext(request, foreign, handle));
    }

    @Test
    void matchesBothOriginalReadIntentsAndCanonicalJsonPropertyOrder() {
        for (String id : prefix.intents().keySet()) {
            var execution = execution(id, true, ToolExecutionRecord.State.EXECUTING, "binding", 1);
            var grant = grant(execution, prefix);
            assertEquals(CsiNativeActivationProof.canonical(grant), CsiNativeActivationProof.canonical(
                    JSON.valueToTree(verify(execution, prefix, 13, 2, grant.toString(), checkpoint, context))));
            var reordered = JSON.createObjectNode();
            grant.properties().stream().sorted(Map.Entry.<String, JsonNode>comparingByKey().reversed())
                    .forEach(entry -> reordered.set(entry.getKey(), entry.getValue()));
            assertEquals(CsiNativeActivationProof.canonical(grant), CsiNativeActivationProof.canonical(
                    JSON.valueToTree(verify(execution, prefix, 13, 2, reordered.toString(), checkpoint, context))));
        }
    }

    @Test
    void refusesChangedMissingExtraAndAmbiguousGrantFields() {
        var execution = execution(prefix.intents().keySet().iterator().next(), true, ToolExecutionRecord.State.EXECUTING, "binding", 1);
        ObjectNode good = grant(execution, prefix);
        for (String field : good.properties().stream().map(Map.Entry::getKey).toList()) {
            ObjectNode changed = good.deepCopy();
            changed.remove(field);
            rejects(execution, prefix, 13, 2, changed.toString(), checkpoint, context);
            changed = good.deepCopy();
            changed.put(field, "foreign");
            rejects(execution, prefix, 13, 2, changed.toString(), checkpoint, context);
        }
        ObjectNode changed = good.deepCopy();
        changed.put("extra", true);
        rejects(execution, prefix, 13, 2, changed.toString(), checkpoint, context);
        for (String encoded : new String[] {null, "{} {}", "{\"protocolVersion\":1,\"protocolVersion\":1}",
                good + " {}", "{\"invalid\":\"\ud800\"}"}) {
            rejects(execution, prefix, 13, 2, encoded, checkpoint, context);
        }
        for (String field : List.of("bindingGeneration", "authorizedBindingVersion", "dispatchGeneration")) {
            changed = good.deepCopy();
            changed.put(field, 1);
            rejects(execution, prefix, 13, 2, changed.toString(), checkpoint, context);
            changed = good.deepCopy();
            changed.put(field, "01");
            rejects(execution, prefix, 13, 2, changed.toString(), checkpoint, context);
        }
    }

    @Test
    void requiresOriginalOwnerStrictSealCeilingAndActualCheckpointContext() {
        var id = prefix.intents().keySet().iterator().next();
        var execution = execution(id, true, ToolExecutionRecord.State.EXECUTING, "binding", 1);
        String encoded = grant(execution, prefix).toString();
        for (long ceiling : new long[] {-1, 0, 1, 4, Long.MAX_VALUE}) {
            rejects(execution, prefix, 13, ceiling, encoded, checkpoint, context);
        }
        rejects(execution(id, true, ToolExecutionRecord.State.EXECUTING, "foreign", 1), prefix, 13, 2, encoded, checkpoint, context);
        rejects(execution(id, true, ToolExecutionRecord.State.EXECUTING, "binding", 2), prefix, 13, 2, encoded, checkpoint, context);
        rejects(execution, prefix, 12, 2, encoded, checkpoint, context);
        rejects(execution, prefix, 13, 2, encoded, null, context);
        rejects(execution, prefix, 13, 2, encoded, checkpoint, null);
        rejects(execution, prefix, 13, 2, encoded,
                new JdbcCsiExecutionAdmission.DispatchCheckpoint(12, 13, checkpoint.ref()), context);
        rejects(execution, prefix, 13, 2, encoded,
                new JdbcCsiExecutionAdmission.DispatchCheckpoint(13, 12, checkpoint.ref()), context);
        for (String field : context.keySet()) {
            var changed = new HashMap<>(context);
            changed.put(field, Map.of("foreign", true));
            rejects(execution, prefix, 13, 2, encoded, checkpoint, changed);
            changed.put(field, null);
            rejects(execution, prefix, 13, 2, encoded, checkpoint, changed);
        }
        var extra = new HashMap<>(context);
        extra.put("foreign", true);
        rejects(execution, prefix, 13, 2, encoded, checkpoint, extra);
    }

    @Test
    void frozenPreparedReferenceMustPrecedeTheAuthorizationAndContainTheOriginalExecution() {
        var execution = execution(prefix.intents().keySet().iterator().next(), true, ToolExecutionRecord.State.EXECUTING, "binding", 1);
        ObjectNode ref = JSON.createObjectNode().put("resourceId", UUID.randomUUID().toString())
                .put("kind", "managed-file_history").put("schemaVersion", 1).put("byteLength", 2).put("digest", "a".repeat(64));
        var frozen = frozen(execution, ref, 12, execution.getExecutionCallId());
        var encoded = grant(execution, frozen).toString();
        assertEquals(ref, JSON.valueToTree(verify(execution, frozen, 13, 2, encoded, checkpoint, context)).path("preparedRef"));
        rejects(execution, prefix, 13, 2, encoded, checkpoint, context);
        rejects(execution, frozen(execution, ref, 11, execution.getExecutionCallId()), 13, 2, encoded, checkpoint, context);
        rejects(execution, frozen(execution, ref, 13, execution.getExecutionCallId()), 13, 2, encoded, checkpoint, context);
        rejects(execution, frozen(execution, ref, 12, "foreign"), 13, 2, encoded, checkpoint, context);
        ObjectNode changed = ref.deepCopy();
        changed.put("digest", "b".repeat(64));
        rejects(execution, frozen(execution, changed, 12, execution.getExecutionCallId()), 13, 2, encoded, checkpoint, context);
    }

    @Test
    void unauthorizedRowsCannotCarrySavedOrRuntimeDispatchEvidence() {
        var id = prefix.intents().keySet().iterator().next();
        var prepared = execution(id, false, ToolExecutionRecord.State.PREPARED, "binding", 1);
        assertNull(verify(prepared, prefix, 13, 2, null, null, null));
        rejects(prepared, prefix, 0, 2, null, null, null);
        rejects(prepared, prefix, 13, 2, "{}", null, null);
        rejects(prepared, prefix, 13, 2, null, checkpoint, context);
        for (var state : List.of(ToolExecutionRecord.State.EXECUTING, ToolExecutionRecord.State.UNKNOWN)) {
            rejects(execution(id, false, state, "binding", 1), prefix, 13, 2, null, null, null);
        }
    }

    private Map<String, Object> verify(ToolExecutionRecord execution, CsiNativeActivationProof.Prefix value,
            long revision, long ceiling, String saved, JdbcCsiExecutionAdmission.DispatchCheckpoint point, Map<String, Object> pinned) {
        return JdbcCsiExecutionAdmission.verifyHistoricalGrant(original, execution, value, revision, ceiling, saved, point, pinned);
    }

    private void rejects(ToolExecutionRecord execution, CsiNativeActivationProof.Prefix value,
            long revision, long ceiling, String saved, JdbcCsiExecutionAdmission.DispatchCheckpoint point, Map<String, Object> pinned) {
        assertThrows(RuntimeBrokerException.class, () -> verify(execution, value, revision, ceiling, saved, point, pinned));
    }

    private ObjectNode grant(ToolExecutionRecord execution, CsiNativeActivationProof.Prefix value) {
        var intent = value.intents().get(execution.getExecutionCallId());
        ObjectNode result = JSON.createObjectNode().put("protocolVersion", 1).put("runtimeBindingId", original.bindingId())
                .put("bindingGeneration", "1").put("authorizedBindingVersion", "1")
                .put("executionCallId", execution.getExecutionCallId()).put("dispatchGeneration", "1")
                .put("authorizationRevision", 13).put("authorizationSequence", 13);
        result.set("executionReference", JSON.valueToTree(execution.getReference()));
        result.putObject("intent").put("revision", intent.revision()).put("sequence", intent.sequence());
        result.set("checkpointRef", checkpoint.ref());
        var batch = value.fileHistory().batches().get((String) execution.getReference().get("batchId"));
        result.set("preparedRef", batch == null ? JSON.nullNode() : batch.preparedRef());
        context.forEach((key, item) -> result.set(key, JSON.valueToTree(item)));
        return result;
    }

    private ToolExecutionRecord execution(String id, boolean authorized, ToolExecutionRecord.State state, String binding, long generation) {
        var intent = prefix.intents().get(id);
        var call = prefix.pendingBatch().calls().get((int) intent.payload().path("ordinal").longValue());
        var ref = new HashMap<String, Object>(Map.of("sessionId", session, "promptId", prefix.input().inputId(), "callId", id,
                "argsDigest", "sha256:" + intent.inputDigest(), "batchId", prefix.pendingBatch().messageId(),
                "functionCallId", call.id(), "partIndex", call.partIndex(), "ordinal", call.ordinal(),
                "inputRef", JSON.convertValue(intent.payload().path("argsRef"), Map.class),
                "toolDefinitionRef", JSON.convertValue(intent.payload().path("toolDefinitionRef"), Map.class)));
        ref.put("dispatchMode", "deferred");
        return new ToolExecutionRecord(id, session + ":" + id, binding, generation, session, session, prefix.input().inputId(), id,
                (String) ref.get("argsDigest"), ref, state, null, null, 0, false,
                authorized ? "original-dispatch" : null, authorized ? Instant.parse("2026-01-01T00:00:00Z") : null,
                authorized ? 1 : 0, 1, null, null, null, authorized ? 1L : null, authorized ? 1L : null);
    }

    private CsiNativeActivationProof.Prefix frozen(ToolExecutionRecord execution, JsonNode ref, long preparedSequence, String member) {
        var batch = new CsiNativeActivationProof.FrozenBatch(ref, ref,
                List.of(JSON.createObjectNode().put("executionCallId", member)), 11, preparedSequence);
        return new CsiNativeActivationProof.Prefix(prefix.input(), prefix.checkpoint(), prefix.lastMessageId(), prefix.attempt(),
                prefix.assistantCommitted(), prefix.stream(), prefix.usedIds(), prefix.pendingBatch(), prefix.batches(),
                new CsiNativeActivationProof.FileHistory(ref, JSON.createObjectNode(),
                        Map.of((String) execution.getReference().get("batchId"), batch)), prefix.intents(), prefix.receipts(), prefix.nextDeltaOrdinal());
    }

    private CsiNativeActivationProof.Prefix prefix() {
        Function<JsonNode, byte[]> reader = ref -> bodies.get(ref.path("resourceId").textValue());
        var genesis = CsiNativeActivationProof.genesis(records(fixture.path("sessionCreate")), request, reader);
        var prior = records(fixture.path("sessionCreate")).getLast().path("uuid").textValue();
        var activationTx = CsiNativeActivationProof.transaction(records(transaction(0)), transaction(0), request, prior);
        var activation = CsiNativeActivationProof.activation(activationTx, transaction(0), request,
                fixture.path("writerId").textValue(), genesis.definitionDigest(), null, reader);
        prior = activationTx.lastRecordUuid();
        var result = CsiNativeActivationProof.Prefix.empty();
        for (int index = 1; index <= 11; index++) {
            JsonNode metadata = transaction(index);
            var tx = CsiNativeActivationProof.transaction(records(metadata), metadata, request, prior);
            result = CsiNativeActivationProof.advance(tx, metadata, request, fixture.path("writerId").textValue(), genesis,
                    activation, metadata.path("expectedJournalRevision").longValue(), metadata.path("expectedCommittedSequence").longValue(), result, reader);
            prior = tx.lastRecordUuid();
        }
        return result;
    }

    private JsonNode transaction(int index) {
        return fixture.path("transactions").get(index);
    }

    private Map<String, byte[]> bodies() {
        var result = new HashMap<String, byte[]>();
        for (JsonNode tx : List.of(fixture.path("sessionCreate"), fixture.path("transactions"))) {
            if (tx.isArray()) {
                tx.forEach(item -> addBodies(result, item));
            } else {
                addBodies(result, tx);
            }
        }
        return result;
    }

    private static void addBodies(Map<String, byte[]> result, JsonNode request) {
        for (JsonNode resource : request.path("resources")) {
            if (resource.has("bytesBase64")) {
                result.put(resource.path("resourceId").textValue(), Base64.getDecoder().decode(resource.path("bytesBase64").textValue()));
            }
        }
    }

    private static List<JsonNode> records(JsonNode request) {
        return CsiNativeActivationProof.records(Base64.getDecoder().decode(request.path("recordBytesBase64").textValue()));
    }

    private static JsonNode fixture() {
        try (var stream = JdbcCsiHistoricalGrantTest.class.getResourceAsStream("/csi-native-read-continuation-fixture.json")) {
            if (stream == null) {
                throw new IllegalStateException("Original native Read fixture is unavailable");
            }
            return JSON.readTree(stream);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }
}
