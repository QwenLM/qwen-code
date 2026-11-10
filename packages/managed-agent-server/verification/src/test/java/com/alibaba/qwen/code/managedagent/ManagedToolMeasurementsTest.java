package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedToolMeasurements;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedToolMeasurementsTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void sharedPacketAndUtf8DigestContract() throws Exception {
        JsonNode fixture = json.readTree(Files.readString(Path.of("..", "..", "core", "src", "managed-runtime", "contracts", "managed-tool-measurements-v1.fixtures.json")));
        for (JsonNode sample : fixture.path("cases")) {
            if (sample.path("valid").asBoolean()) {
                ManagedToolMeasurements.requireMeasurements(sample.path("measurements"));
                ObjectNode evidence = fixture.path("evidence").deepCopy();
                evidence.set("measurements", sample.path("measurements"));
                JsonNode duration = ManagedToolMeasurements.publicMeasurements(evidence, 2).path("executionDurationMs");
                assertThat(duration.isNull() || duration.asText().matches("[0-9]+")).isTrue();
            } else {
                assertThatThrownBy(() -> ManagedToolMeasurements.requireMeasurements(sample.path("measurements")))
                        .as(sample.path("id").asText()).isInstanceOf(RuntimeException.class);
            }
        }
        ManagedToolMeasurements.requireEvidence(fixture.path("evidence"));
        assertThat(DigestUtils.sha256Hex(CsiNativeActivationProof.canonical(fixture.path("wire"))))
                .isEqualTo(fixture.path("resultDigest").asText());
        ObjectNode payload = json.createObjectNode().put("executionCallId", "execution");
        payload.putObject("toolOutcomeRef").put("digest", "a".repeat(64));
        payload.putObject("measurementsRef").put("digest", "b".repeat(64));
        ObjectNode event = json.createObjectNode().put("kind", "tool.measured");
        event.set("payload", payload);
        String digest = ManagedToolMeasurements.commitDigest(payload);
        assertThat(ManagedActivityDiagnostics.matchesCommit(List.of(event), "recordToolMeasurements", "execution", digest)).isTrue();
        assertThat(ManagedActivityDiagnostics.matchesCommit(List.of(event), "recordToolMeasurements", "other", digest)).isFalse();
        assertThat(ManagedActivityDiagnostics.matchesCommit(List.of(event), "recordToolMeasurements", "execution", "c".repeat(64))).isFalse();
        assertThat(ManagedActivityDiagnostics.matchesCommit(List.of(event), "recordToolReceipt", "execution", digest)).isFalse();
        assertThat(ManagedActivityDiagnostics.matchesCommit(List.of(event, event), "recordToolMeasurements", "execution", digest)).isFalse();
    }

    @Test
    void transformedOrUnprovenInputsDoNotClaimModelProposalLines() throws Exception {
        JsonNode fixture = json.readTree(Files.readString(Path.of("..", "..", "core", "src", "managed-runtime", "contracts", "managed-tool-measurements-v1.fixtures.json")));
        for (String proposal : List.of("modified", "unknown")) {
            ObjectNode evidence = fixture.path("evidence").deepCopy();
            evidence.put("modelProposal", proposal);
            ManagedToolMeasurements.requireEvidence(evidence);
            ObjectNode measured = ManagedToolMeasurements.publicMeasurements(evidence, 2);
            assertThat(measured.path("availability").asText()).isEqualTo("partial");
            assertThat(measured.path("file").path("modelLinesAdded").isNull()).isTrue();
            assertThat(measured.path("file").path("modelLinesRemoved").isNull()).isTrue();
            assertThat(measured.path("file").path("appliedLinesAdded").asText()).isEqualTo("2");
            ObjectNode metrics = json.createObjectNode().put("requested", "1");
            ObjectNode fact = json.createObjectNode();
            fact.set("measurements", measured);
            ManagedToolMeasurements.contribute(metrics, fact, 1);
            ManagedToolMeasurements.availability(metrics);
            assertThat(metrics.path("measurements").path("modelDiffSamples").asText()).isEqualTo("0");
            assertThat(metrics.path("measurements").path("appliedDiffSamples").asText()).isEqualTo("1");
            assertThat(metrics.path("measurements").path("availability").asText()).isEqualTo("partial");
        }
    }

    @Test
    void lazyContributionKeepsLegacyBytesAndUsesSamplesRatherThanRequests() throws Exception {
        JsonNode fixture = json.readTree(Files.readString(Path.of("..", "..", "core", "src", "managed-runtime", "contracts", "managed-tool-measurements-v1.fixtures.json")));
        ObjectNode epoch = json.createObjectNode().put("epochId", "e").put("startEventId", "message:a");
        ObjectNode summary = ManagedActivityDiagnostics.summary(epoch, 1, 1000);
        ObjectNode call = json.createObjectNode().put("id", "call").put("name", "edit");
        ObjectNode before = ManagedActivityDiagnostics.request("tenant", "session", "a", 0, call, 1, 1000);
        before.put("toolKind", "builtin").put("execution", "error").put("delivery", "unavailable");
        before.putObject("file").put("operation", "edit").putNull("path").putNull("cwdRelative");
        ManagedActivityDiagnostics.contribute(summary, null, before);
        String legacy = summary.toString();
        ManagedActivityDiagnostics.contribute(summary, before, before.deepCopy());
        assertThat(summary.toString()).isEqualTo(legacy).doesNotContain("measurements");
        ObjectNode after = before.deepCopy().put("execution", "success").put("_measurementEvidenceDigest", "a".repeat(64)).put("_measurementOutcomeKnown", true);
        after.set("measurements", ManagedToolMeasurements.publicMeasurements(fixture.path("evidence"), 2));
        ManagedActivityDiagnostics.contribute(summary, before, after);
        JsonNode measured = summary.path("tools").path("measurements").deepCopy();
        assertThat(measured.path("executionDurationSamples").asText()).isEqualTo("1");
        assertThat(measured.path("executionDurationMs").asText()).isEqualTo("0");
        assertThat(measured.path("modelLinesAdded").asText()).isEqualTo("3");
        assertThat(measured.path("appliedLinesAdded").asText()).isEqualTo("2");
        ManagedActivityDiagnostics.contribute(summary, after, after.deepCopy());
        assertThat(summary.path("tools").path("measurements")).isEqualTo(measured);
        ObjectNode weaker = before.deepCopy().put("delivery", "complete");
        ObjectNode merged = ManagedActivityDiagnostics.merge(after, weaker, false);
        assertThat(merged.path("execution").asText()).isEqualTo("success");
        assertThat(merged.path("delivery").asText()).isEqualTo("complete");
        assertThat(merged.has("conflictingEvidence")).isFalse();
        ManagedActivityDiagnostics.contribute(summary, after, merged);
        ManagedActivityDiagnostics.contribute(summary, null, before.deepCopy().put("invocationId", "b".repeat(64)));
        assertThat(summary.path("tools").path("requested").asInt()).isEqualTo(2);
        assertThat(summary.path("tools").path("measurements").path("executionDurationSamples").asText()).isEqualTo("1");
        assertThat(summary.path("tools").path("measurements").path("availability").asText()).isEqualTo("partial");
        assertThat(summary.path("toolBuckets").get(0).path("metrics").has("measurements")).isFalse();
        ObjectNode unknown = after.deepCopy().put("execution", "error").put("_measurementOutcomeKnown", false);
        assertThat(ManagedActivityDiagnostics.merge(unknown, before.deepCopy().put("execution", "success"), true).path("execution").asText()).isEqualTo("success");
    }
}
