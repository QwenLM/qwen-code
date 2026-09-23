package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ManagedRuntimeAttestationConformanceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CONTRACT_DIR = findContractDirectory();
    private static final Path FIXTURES = CONTRACT_DIR.resolve(
            "managed-runtime-attestation-v2.fixtures.json");
    private static final Path SCHEMA = CONTRACT_DIR.resolve(
            "managed-runtime-attestation-v2.schema.json");

    @Test
    void consumesTheSharedRouteAndLimitContract() throws IOException {
        JsonNode suite = read(FIXTURES);
        JsonNode route = suite.required("route");

        assertEquals(1, suite.required("contractVersion").intValue());
        assertEquals("attest", route.required("key").textValue());
        assertEquals("POST", route.required("method").textValue());
        assertEquals("/internal/managed-runtime/v2/attest",
                route.required("path").textValue());
        assertEquals(2, route.required("protocolVersion").intValue());
        assertEquals(16 * 1024, route.required("requestBodyLimitBytes").intValue());
        assertEquals(16 * 1024, route.required("responseBodyLimitBytes").intValue());
        assertEquals("no-store", route.required("cacheControl").textValue());
    }

    @Test
    void consumesEverySharedOutcomeClassification() throws IOException {
        JsonNode cases = read(FIXTURES).required("cases");
        Set<String> ids = new HashSet<>();
        Set<String> classifications = new HashSet<>();

        for (JsonNode fixture : cases) {
            String id = fixture.required("id").textValue();
            int status = fixture.required("expected").required("status").intValue();
            String classification = fixture.required("expected")
                    .required("classification").textValue();
            assertTrue(ids.add(id), () -> "duplicate fixture id: " + id);
            assertEquals(classify(status), classification, id);
            classifications.add(classification);
        }

        assertEquals(Set.of("ok", "credentials", "protocol", "identity", "incompatible"),
                classifications);
    }

    @Test
    void pinsClosedRequestAndResponseShapes() throws IOException {
        JsonNode suite = read(FIXTURES);
        JsonNode success = findCase(suite.required("cases"), "success");
        Set<String> requestFields = fieldNames(success.required("request").required("body"));
        Set<String> responseFields = fieldNames(success.required("expected").required("body"));

        assertEquals(Set.of("protocolVersion", "provisionRequestId", "tenantId",
                "workspaceId", "workspaceGeneration", "workspaceCwd",
                "capabilityDigest", "isolationClass"), requestFields);
        assertEquals(Set.of("protocolVersion", "runtimeInstanceId", "runtimeIncarnation",
                "leaseId", "epoch", "provisionRequestId", "tenantId", "workspaceId",
                "workspaceGeneration", "workspaceCwd", "capabilityDigest",
                "isolationClass"), responseFields);

        JsonNode definitions = read(SCHEMA).required("$defs");
        assertFalse(definitions.required("requestBody")
                .required("unevaluatedProperties").booleanValue());
        assertFalse(definitions.required("responseBody")
                .required("unevaluatedProperties").booleanValue());
    }

    private static JsonNode read(Path path) throws IOException {
        assertTrue(Files.isRegularFile(path), () -> "missing shared contract: " + path);
        return JSON.readTree(path.toFile());
    }

    private static Path findContractDirectory() {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            Path candidate = current.resolve(Path.of("packages", "cli", "src", "serve",
                    "contracts"));
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            current = current.getParent();
        }
        throw new AssertionError("cannot locate shared Managed Runtime contract fixtures");
    }

    private static JsonNode findCase(JsonNode cases, String id) {
        for (JsonNode fixture : cases) {
            if (id.equals(fixture.required("id").textValue())) {
                return fixture;
            }
        }
        throw new AssertionError("missing fixture: " + id);
    }

    private static Set<String> fieldNames(JsonNode value) {
        Set<String> names = new HashSet<>();
        for (Map.Entry<String, JsonNode> field : value.properties()) {
            names.add(field.getKey());
        }
        return names;
    }

    private static String classify(int status) {
        if (status == 200) {
            return "ok";
        }
        if (status == 401 || status == 403) {
            return "credentials";
        }
        if (status == 400 || status == 413) {
            return "protocol";
        }
        if (status == 409) {
            return "identity";
        }
        if (status == 404 || status == 405) {
            return "incompatible";
        }
        throw new AssertionError("unclassified fixture status: " + status);
    }
}
