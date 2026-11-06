package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

class ManagedModelDiagnosticsTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void sharesTheHostedProducerFixtures() throws Exception {
        var fixtures = json.readTree(VerificationFixtures.moduleRoot()
                .resolve("../core/src/managed-runtime/contracts/managed-model-statistics-v1.fixtures.json").toFile());
        for (var value : fixtures.get("valid")) {
            assertDoesNotThrow(() -> ManagedModelDiagnostics.requireBody(value.get("kind").asText(), value.get("body")),
                    value.get("name").asText());
        }
        for (var value : fixtures.get("invalid")) {
            assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(value.get("kind").asText(), value.get("body")))
                    .as(value.get("name").asText()).isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
        }
    }

    @Test
    void rejectsUnboundedCollectionsAndUnknownFields() throws Exception {
        var fixtures = json.readTree(VerificationFixtures.moduleRoot()
                .resolve("../core/src/managed-runtime/contracts/managed-model-statistics-v1.fixtures.json").toFile());
        ObjectNode body = fixtures.get("valid").get(0).get("body").deepCopy();
        body.withObject("/statistics").put("legacyModels", "unbounded");
        assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body))
                .isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
        body.withObject("/statistics").remove("legacyModels");
        var recent = body.withObject("/statistics").withArray("recent");
        for (int index = 0; index < 21; index++) {
            recent.addNull();
        }
        assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body))
                .isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "0.0", "1.0", "1e3", "9007199254740990", "9007199254740991", "9007199254740991.0"})
    void acceptsSafeCountersAndIntegralJsonNumbers(String value) throws Exception {
        ObjectNode body = mainBody();
        body.withObject("/statistics").set("rawOutputTokensTotal", json.readTree(value));
        body.withObject("/statistics/totals/tokens").set("prompt", json.readTree(value));
        body.withObject("/context").set("inputTokens", json.readTree(value));
        body.withObject("/context/breakdown").set("messages", json.readTree(value));
        ObjectNode budget = body.putObject("budget").put("sessionId", "session-1").put("promptId", "turn-1");
        budget.set("budget", json.readTree(value));
        budget.set("outputTokensAtTurnStart", json.readTree(value));
        assertDoesNotThrow(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body));
    }

    @ParameterizedTest
    @ValueSource(strings = {"1", "1.0", "9007199254740990", "9007199254740991", "9007199254740991.0"})
    void acceptsTheFullSafeSnapshotRevisionRange(String value) throws Exception {
        ObjectNode body = mainBody();
        body.withObject("/statistics").set("snapshotRevision", json.readTree(value));
        assertDoesNotThrow(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body));
    }

    @ParameterizedTest
    @ValueSource(strings = {"-1", "1.5", "9007199254740992", "1e400", "\"1\"", "null"})
    void rejectsUnsafeCountersAndSnapshotRevisions(String value) throws Exception {
        for (String field : List.of("observedAt", "snapshotRevision")) {
            ObjectNode body = mainBody();
            body.withObject("/statistics").set(field, json.readTree(value));
            assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body))
                    .as(field).isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"-1", "9007199254740992", "1e400", "\"1\"", "null"})
    void rejectsInvalidRawOutputValues(String value) throws Exception {
        ObjectNode body = mainBody();
        body.withObject("/statistics").set("rawOutputTokensTotal", json.readTree(value));
        assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body))
                .isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
        body.withObject("/statistics").put("rawOutputTokensTotal", 0);
        ObjectNode budget = body.putObject("budget").put("sessionId", "session-1").put("promptId", "turn-1").putNull("budget");
        budget.set("outputTokensAtTurnStart", json.readTree(value));
        assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body))
                .isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
    }

    @Test
    void theConfiguredBudgetStillRequiresAnInteger() throws Exception {
        ObjectNode body = mainBody();
        body.putObject("budget").put("sessionId", "session-1").put("promptId", "turn-1")
                .put("budget", 1.5).put("outputTokensAtTurnStart", 0.5);
        assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body))
                .isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
    }

    @Test
    void zeroIsNotASnapshotRevision() throws Exception {
        ObjectNode body = mainBody();
        body.withObject("/statistics").put("snapshotRevision", 0);
        assertThatThrownBy(() -> ManagedModelDiagnostics.requireBody(ManagedModelDiagnostics.MAIN_KIND, body))
                .isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
    }

    private ObjectNode mainBody() throws Exception {
        return json.readTree(VerificationFixtures.moduleRoot()
                .resolve("../core/src/managed-runtime/contracts/managed-model-statistics-v1.fixtures.json").toFile())
                .get("valid").get(0).get("body").deepCopy();
    }
}
