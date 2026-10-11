package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion.VersionFlag;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
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
        var wrongInputDigest = (com.fasterxml.jackson.databind.node.ObjectNode) binding.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) wrongInputDigest.get("reference"))
                .put("argsDigest", "sha256:" + "0".repeat(64));
        assertThatThrownBy(() -> ToolPublicationContract.requirePayload(wrongInputDigest,
                suite.required("payloadJson").asText()))
                .hasMessageContaining("Canonical Shell input digest conflicts");
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

    @Test
    void acceptsEcmascriptCanonicalShellInputWithControlCharacters() throws Exception {
        JsonNode suite = JSON.readTree(contracts().resolve(
                "managed-tool-publication-v1.fixtures.json").toFile());
        ObjectNode binding = (ObjectNode) suite.required("cases").get(0)
                .required("value").deepCopy();
        String command = "echo " + (char) 27 + "[31m" + (char) 11 + "😀";
        String payload = JSON.writeValueAsString(Map.of("toolName", "run_shell_command",
                "input", Map.of("command", command)));
        binding.put("requestDigest", "sha256:" + ToolPublicationContract.sha256(
                payload.getBytes(StandardCharsets.UTF_8)));
        ((ObjectNode) binding.get("reference")).put("argsDigest",
                "sha256:2977495d23c926da571956f2cde4af68ca4c679f245ec2d76e2ebf1abf23091f");
        ToolPublicationContract.requirePayload(binding, payload);
    }

    @Test
    void admitsH3BackgroundShellAndMonitorPayloads() throws Exception {
        JsonNode suite = JSON.readTree(contracts().resolve(
                "managed-tool-publication-v1.fixtures.json").toFile());
        for (JsonNode vector : suite.required("payloadCases")) {
            ObjectNode binding = (ObjectNode) suite.required("cases").get(0)
                    .required("value").deepCopy();
            binding.put("requestDigest", vector.required("requestDigest").asText());
            ((ObjectNode) binding.get("reference")).put("argsDigest",
                    vector.required("argsDigest").asText());
            ToolPublicationContract.requirePayload(binding,
                    vector.required("payloadJson").asText());
        }
    }

    @Test
    void rejectsOutOfShapeH3Payloads() throws Exception {
        JsonNode suite = JSON.readTree(contracts().resolve(
                "managed-tool-publication-v1.fixtures.json").toFile());
        // Each vector carries correct requestDigest/argsDigest pins, so the
        // refusal can only come from the shape rule under test.
        String[][] rejected = {
                // unknown tool family
                {"{\"toolName\":\"write_file\",\"input\":{\"command\":\"x\"}}",
                        "sha256:411f38324b9bf797e7ecf5976730ec141d9e12be2d19532c4ba516090e2e4b62",
                        "sha256:cf35b664f0e85cbf24dfda38ea6991fa01d9d315e402baacd2c02f2e92d0947a"},
                // background flag must be boolean
                {"{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"x\",\"is_background\":\"yes\"}}",
                        "sha256:602898b4332eb8b28dda69a40d2b3624b9d07f6593b749f1afca9c693ce51894",
                        "sha256:0d22e860fb36fbd030c30ca0caebad9443183694f0e1412d2b11caf550b8571a"},
                // unknown shell input field
                {"{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"x\",\"shell\":\"bash\"}}",
                        "sha256:16125fd18f6212ddd9f0ed835e7929fa1dbc285caa632b3c34587d6cce2a6f7c",
                        "sha256:5162d0ee563de930a07dfff0db15a2166cab390b7e8d45abee7248c939270e23"},
                // monitor bounds come from the turn's admission clamps
                {"{\"toolName\":\"monitor\",\"input\":{\"command\":\"x\",\"max_events\":0}}",
                        "sha256:ea611ecaec0e65dc3449c8645d53242aafc21e7448527d524dcc86a1d7cf917c",
                        "sha256:8a87c588c0954e5046351b49417b4fa6de1ebd57de491a8fa211dd6e3e8c90dc"},
                {"{\"toolName\":\"monitor\",\"input\":{\"command\":\"x\",\"max_events\":10001}}",
                        "sha256:a3f1f57ac064649e969f919c14e946d7c955a9d4b6a2a4597222cad1a0994ed7",
                        "sha256:0d6eb0575da8c48def8e0fbaf23f2223b748512b45468a10d7daa763669700cf"},
                {"{\"toolName\":\"monitor\",\"input\":{\"command\":\"x\",\"idle_timeout_ms\":600001}}",
                        "sha256:8e42f98c8b03da607acd129b9a80181b250531d42db85100688f01d3491e260f",
                        "sha256:2b13f3ea4fc3d2e07a02dfc1937306298812f7c8700b5e0d7a9106d911bcac0b"},
        };
        for (String[] vector : rejected) {
            ObjectNode binding = (ObjectNode) suite.required("cases").get(0)
                    .required("value").deepCopy();
            binding.put("requestDigest", vector[1]);
            ((ObjectNode) binding.get("reference")).put("argsDigest", vector[2]);
            assertThatThrownBy(() -> ToolPublicationContract.requirePayload(binding, vector[0]))
                    .as(vector[0])
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }
}
