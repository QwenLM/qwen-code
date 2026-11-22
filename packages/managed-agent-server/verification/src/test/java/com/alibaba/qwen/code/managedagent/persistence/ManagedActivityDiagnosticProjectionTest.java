package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedActivityDiagnosticProjectionTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void externalPublicationOutcomePreservesKnownFactsAndRecordsPartialCoverage() {
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
        ObjectNode envelope = outcome.putObject("envelope").put("executionStatus", "error");
        envelope.putArray("responseParts").add("x".repeat(100_000));
        envelope.putObject("capture").put("captureStatus", "unavailable").put("captureReason", "storage_failed")
                .put("previewTruncated", false).put("deliveryStatus", "pending").putNull("manifest");
        ObjectNode history = outcome.putObject("history").put("messageId", "11111111-1111-4111-8111-111111111111")
                .put("timestamp", "2026-09-28T00:00:00Z").put("model", "test");
        history.putArray("parts").addObject().put("text", "Shell capture unavailable");
        byte[] bytes = outcome.toString().getBytes(StandardCharsets.UTF_8);
        StoredResource external = new StoredResource("outcome", "managed-tool-outcome", 1,
                bytes.length, DigestUtils.sha256Hex(bytes), null);
        var state = new ReceiptState();
        JsonNode before = state.invocation.deepCopy();
        JsonNode counters = state.summary.path("tools").deepCopy();
        ObjectNode event = receipt(external);

        ManagedActivityDiagnosticProjection.reduce("tenant", "session", event, id -> external, state);
        ManagedActivityDiagnosticProjection.reduce("tenant", "session", event, id -> external, state);

        assertThat(state.find(ManagedActivityDiagnostics.TOOLS, before.path("invocationId").asText())).isEqualTo(before);
        assertThat(state.summary.path("tools")).isEqualTo(counters);
        assertThat(state.summary.path("tools").path("execution").path("error").asLong()).isEqualTo(1);
        assertThat(state.summary.path("tools").path("delivery").path("partial").asLong()).isEqualTo(1);
        assertThat(state.summary.path("coverageReasons")).isEqualTo(JSON.createArrayNode().add("receipt_outcome_not_inline"));
        assertThat(state.summary.path("lastEvidenceSequence").asText()).isEqualTo("3");
    }

    @Test
    void inlineOutcomeStillEnrichesExecutionWithoutLosingPartialDelivery() {
        ObjectNode outcome = JSON.createObjectNode();
        outcome.putObject("envelope").put("executionStatus", "success")
                .putObject("capture").put("captureStatus", "complete").put("deliveryStatus", "pending");
        byte[] bytes = outcome.toString().getBytes(StandardCharsets.UTF_8);
        StoredResource inline = new StoredResource("outcome", "managed-tool-outcome", 1,
                bytes.length, DigestUtils.sha256Hex(bytes), bytes);
        var state = new ReceiptState();

        ManagedActivityDiagnosticProjection.reduce("tenant", "session", receipt(inline), id -> inline, state);

        JsonNode invocation = state.find(ManagedActivityDiagnostics.TOOLS, state.invocation.path("invocationId").asText());
        assertThat(invocation.path("execution").asText()).isEqualTo("success");
        assertThat(invocation.path("capture").asText()).isEqualTo("complete");
        assertThat(invocation.path("delivery").asText()).isEqualTo("partial");
        assertThat(state.summary.path("tools").path("requested").asLong()).isEqualTo(1);
        assertThat(state.summary.path("tools").path("execution").path("success").asLong()).isEqualTo(1);
        assertThat(state.summary.path("tools").path("execution").path("error").asLong()).isZero();
        assertThat(state.summary.path("coverageReasons")).isEmpty();
    }

    @Test
    void missingInlineBytesRemainAnIntegrityError() {
        StoredResource missing = new StoredResource("outcome", "managed-tool-outcome", 1,
                100, "a".repeat(64), null);
        assertThatThrownBy(() -> ManagedActivityDiagnosticProjection.reduce("tenant", "session", receipt(missing),
                id -> missing, new ReceiptState())).isInstanceOf(RuntimeBrokerException.class);
    }

    @Test
    void externalOutcomeStillRequiresTheCommittedReference() {
        StoredResource external = new StoredResource("outcome", "managed-tool-outcome", 1,
                100_000, "a".repeat(64), null);
        ObjectNode event = receipt(external);
        ((ObjectNode) event.path("payload").path("toolOutcomeRef")).put("digest", "b".repeat(64));
        assertThatThrownBy(() -> ManagedActivityDiagnosticProjection.reduce("tenant", "session", event,
                id -> external, new ReceiptState())).isInstanceOf(ManagedAgentException.class);
    }

    private static ObjectNode receipt(StoredResource outcome) {
        ObjectNode event = JSON.createObjectNode().put("kind", "tool.receipt").put("sequence", 3).put("occurredAt", 3000);
        event.putObject("payload").put("executionCallId", "execution").putObject("toolOutcomeRef")
                .put("resourceId", outcome.resourceId()).put("kind", outcome.kind()).put("schemaVersion", outcome.schemaVersion())
                .put("byteLength", outcome.byteLength()).put("digest", outcome.digest());
        return event;
    }

    private static final class ReceiptState implements ManagedActivityDiagnosticProjection.State {
        private final Map<String, Map<String, JsonNode>> records = new HashMap<>();
        private final ObjectNode summary;
        private final ObjectNode invocation;

        ReceiptState() {
            summary = ManagedActivityDiagnostics.summary(JSON.createObjectNode().put("epochId", "epoch")
                    .put("startEventId", "message:assistant"), 1, 1000);
            invocation = ManagedActivityDiagnostics.request("tenant", "session", "assistant", 0,
                    JSON.createObjectNode().put("name", "Shell").put("id", "call"), 1, 1000)
                    .put("executionCallId", "execution").put("toolKind", "hosted").put("admission", "allowed")
                    .put("execution", "error").put("capture", "unavailable").put("delivery", "partial");
            ManagedActivityDiagnostics.contribute(summary, null, invocation);
            put(ManagedActivityDiagnostics.STATS, "latest", summary, 1, 1000);
            put(ManagedActivityDiagnostics.TOOLS, invocation.path("invocationId").asText(), invocation, 1, 1000);
            ObjectNode evidence = JSON.createObjectNode();
            ObjectNode observation = invocation.deepCopy();
            observation.remove(java.util.List.of("requestSequence", "requestedAt"));
            ManagedActivityDiagnostics.requireFact(observation);
            evidence.putArray("observations").add(observation);
            link("execution", evidence, "diagnostics", 2, 2000);
        }

        @Override public JsonNode find(String domain, String id) {
            return records.getOrDefault(domain, Map.of()).get(id);
        }

        @Override public void put(String domain, String id, JsonNode body, long sequence, long at) {
            records.computeIfAbsent(domain, key -> new HashMap<>()).put(id, body);
        }

        @Override public void link(String execution, JsonNode body, String resource, long sequence, long at) {
            put(ManagedActivityDiagnostics.LINKS, execution, body, sequence, at);
        }
    }
}
