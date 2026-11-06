package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

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
}
