package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedToolMeasurements;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedActivityPublicationProjectionTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String EXECUTION = "publication-execution";

    @Test
    void opaqueReceiptPreservesKnownEvidenceAndBindsItsCompleteReference() throws Exception {
        Fixture fixture = new Fixture("success");
        fixture.receipt();
        JsonNode summary = fixture.summary().deepCopy();
        assertThat(summary.path("tools").path("requested").asInt()).isEqualTo(1);
        assertThat(summary.path("tools").path("execution").path("success").asInt()).isEqualTo(1);
        assertThat(summary.path("tools").path("delivery").path("partial").asInt()).isEqualTo(1);
        assertThat(summary.path("coverageReasons").toString()).contains("receipt_outcome_not_inline");
        assertThat(fixture.find(ManagedActivityDiagnostics.LINKS, EXECUTION).path("_receiptOutcomeRef"))
                .isEqualTo(fixture.outcomeRef);
        fixture.receipt();
        assertThat(fixture.summary()).isEqualTo(summary);
    }

    @Test
    void opaqueMeasurementNeedsItsReceiptAndContributesOnlyOnce() throws Exception {
        Fixture fixture = new Fixture("unknown");
        assertThatThrownBy(() -> fixture.measure(fixture.outcomeRef))
                .hasMessageContaining("matching committed receipt");
        fixture.receipt();
        fixture.measure(fixture.outcomeRef);
        JsonNode tools = fixture.summary().path("tools").deepCopy();
        assertThat(tools.path("requested").asInt()).isEqualTo(1);
        assertThat(tools.path("execution").path("success").asInt()).isEqualTo(1);
        assertThat(tools.path("measurements").path("executionDurationSamples").asText()).isEqualTo("1");
        fixture.measure(fixture.outcomeRef);
        assertThat(fixture.summary().path("tools")).isEqualTo(tools);
    }

    @Test
    void anotherOpaqueResourceWithTheSameDigestCannotReplaceTheReceipt() throws Exception {
        Fixture fixture = new Fixture("unknown");
        fixture.receipt();
        JsonNode before = fixture.summary().deepCopy();
        StoredResource original = fixture.resources.get("outcome");
        StoredResource other = new StoredResource("other-outcome", original.kind(), original.schemaVersion(),
                original.byteLength(), original.digest(), null);
        fixture.resources.put(other.resourceId(), other);
        ObjectNode otherRef = fixture.outcomeRef.deepCopy().put("resourceId", other.resourceId());
        assertThatThrownBy(() -> fixture.measure(otherRef)).hasMessageContaining("matching committed receipt");
        assertThat(fixture.summary()).isEqualTo(before);
        assertThat(fixture.find(ManagedActivityDiagnostics.LINKS, EXECUTION).path("_receiptOutcomeRef"))
                .isEqualTo(fixture.outcomeRef);
    }

    private static final class Fixture implements ManagedActivityDiagnosticProjection.State {
        private final Map<String, JsonNode> rows = new HashMap<>();
        private final Map<String, StoredResource> resources = new HashMap<>();
        private final ObjectNode outcomeRef;
        private final ObjectNode measurementRef;

        Fixture(String execution) throws Exception {
            ObjectNode call = JSON.createObjectNode().put("id", "call").put("name", "edit");
            ObjectNode fact = ManagedActivityDiagnostics.request("tenant", "session", "assistant", 0, call, 1, 1000)
                    .put("toolKind", "builtin").put("admission", "allowed").put("execution", execution)
                    .put("delivery", "partial").put("executionCallId", EXECUTION);
            fact.putObject("file").put("operation", "edit").put("path", "file.txt").put("cwdRelative", ".");
            ObjectNode source = JSON.createObjectNode().put("epochId", "epoch").put("startEventId", "start");
            ObjectNode observation = fact.deepCopy();
            observation.remove(List.of("requestSequence", "requestedAt"));
            source.putArray("observations").add(observation);
            ObjectNode summary = ManagedActivityDiagnostics.summary(source, 1, 1000);
            ManagedActivityDiagnostics.contribute(summary, null, fact);
            put(ManagedActivityDiagnostics.STATS, "latest", summary, 1, 1000);
            put(ManagedActivityDiagnostics.TOOLS, fact.path("invocationId").asText(), fact, 1, 1000);
            put(ManagedActivityDiagnostics.LINKS, EXECUTION, source, 1, 1000);
            StoredResource outcome = new StoredResource("outcome", "managed-tool-outcome", 1, 70 * 1024,
                    "a".repeat(64), null);
            resources.put(outcome.resourceId(), outcome);
            outcomeRef = ref(outcome);
            ObjectNode packet = JSON.readTree(VerificationFixtures.moduleRoot()
                    .resolve("../core/src/managed-runtime/contracts/managed-tool-measurements-v1.fixtures.json").toFile())
                    .path("evidence").deepCopy();
            packet.put("executionCallId", EXECUTION).set("invocationId", fact.get("invocationId"));
            byte[] bytes = JSON.writeValueAsBytes(packet);
            StoredResource measured = new StoredResource("measurement", ManagedToolMeasurements.KIND, 1,
                    bytes.length, DigestUtils.sha256Hex(bytes), bytes);
            resources.put(measured.resourceId(), measured);
            measurementRef = ref(measured);
        }

        void receipt() {
            ObjectNode payload = JSON.createObjectNode().put("executionCallId", EXECUTION);
            payload.set("toolOutcomeRef", outcomeRef);
            apply("tool.receipt", payload, 2);
        }

        void measure(JsonNode outcome) {
            ObjectNode payload = JSON.createObjectNode().put("executionCallId", EXECUTION);
            payload.set("toolOutcomeRef", outcome);
            payload.set("measurementsRef", measurementRef);
            apply("tool.measured", payload, 3);
        }

        private void apply(String kind, ObjectNode payload, long sequence) {
            ObjectNode event = JSON.createObjectNode().put("kind", kind).put("sequence", sequence).put("occurredAt", 1000);
            event.set("payload", payload);
            ManagedActivityDiagnosticProjection.reduce("tenant", "session", event, resources::get, this);
        }

        JsonNode summary() {
            return find(ManagedActivityDiagnostics.STATS, "latest");
        }

        @Override
        public JsonNode find(String domain, String id) {
            JsonNode value = rows.get(domain + ":" + id);
            return value == null ? null : value.deepCopy();
        }

        @Override
        public void put(String domain, String id, JsonNode body, long sequence, long at) {
            rows.put(domain + ":" + id, body.deepCopy());
        }

        @Override
        public void link(String execution, JsonNode body, String resource, long sequence, long at) {
            put(ManagedActivityDiagnostics.LINKS, execution, body, sequence, at);
        }

        private static ObjectNode ref(StoredResource resource) {
            return JSON.createObjectNode().put("resourceId", resource.resourceId()).put("kind", resource.kind())
                    .put("schemaVersion", resource.schemaVersion()).put("byteLength", resource.byteLength())
                    .put("digest", resource.digest());
        }
    }
}
