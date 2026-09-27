package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion.VersionFlag;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class ToolPublicationContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    static Path contracts() {
        Path current = Path.of(System.getProperty("user.dir"));
        while (current != null) {
            Path path = current.resolve("packages/core/src/managed-runtime/contracts");
            if (Files.isDirectory(path)) {
                return path;
            }
            current = current.getParent();
        }
        throw new IllegalStateException("Contract directory missing");
    }

    @Test
    void runsEverySharedFixtureThroughTheRealParserAndSchema() throws Exception {
        JsonNode suite = JSON.readTree(contracts().resolve(
                "managed-tool-publication-v1.fixtures.json").toFile());
        JsonNode schema = JSON.readTree(contracts().resolve(
                "managed-tool-publication-v1.schema.json").toFile());
        var factory = JsonSchemaFactory.getInstance(VersionFlag.V202012);
        for (JsonNode example : suite.required("cases")) {
            String kind = example.required("kind").asText();
            JsonNode value = example.required("value");
            var selected = schema.deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) selected)
                    .remove("oneOf");
            ((com.fasterxml.jackson.databind.node.ObjectNode) selected)
                    .put("$ref", "#/$defs/" + kind);
            assertThat(factory.getSchema(selected).validate(value).isEmpty())
                    .as(example.required("id").asText())
                    .isEqualTo(example.required("schemaValid").asBoolean());
            if (example.required("valid").asBoolean()) {
                assertThat(ToolPublicationContract.parse(kind, value)).isEqualTo(value);
            } else {
                assertThatThrownBy(() -> ToolPublicationContract.parse(kind, value))
                        .as(example.required("id").asText())
                        .isInstanceOf(IllegalArgumentException.class);
            }
        }
        for (JsonNode vector : suite.required("digestVectors")) {
            assertThat(ToolPublicationContract.bindingDigest(vector.required("binding")))
                    .as(vector.required("id").asText()).isEqualTo(vector.required("digest").asText());
        }
        assertThat(ToolPublicationContract.tokenHash(suite.path("tokenVector").path("token").asText()))
                .isEqualTo(suite.path("tokenVector").path("hash").asText());
        assertThatThrownBy(() -> ToolPublicationContract.tokenHash("A".repeat(42) + "B"))
                .isInstanceOf(IllegalArgumentException.class);
        JsonNode binding = suite.required("cases").get(0).required("value");
        assertThat(ToolPublicationContract.bindingDigest(binding))
                .isEqualTo(suite.required("bindingDigest").asText());
        ToolPublicationContract.requirePayload(binding,
                suite.required("payloadJson").asText());
        assertThatThrownBy(() -> ToolPublicationContract.requirePayload(binding,
                " " + suite.required("payloadJson").asText()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsAmbiguousOrUnboundedWireBytes() {
        assertThatThrownBy(() -> ToolPublicationContract.parseBytes("binding",
                new byte[] {(byte) 0xff})).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ToolPublicationContract.parseBytes("binding",
                "{\"publication\":1,\"publication\":2}".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ToolPublicationContract.parseBytes("binding",
                new byte[65537])).isInstanceOf(IllegalArgumentException.class);
    }
}
