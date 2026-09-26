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
    private static final Path TOOL_FIXTURES = CONTRACT_DIR.resolve(
            "managed-runtime-tool-v2.fixtures.json");
    private static final Path TOOL_SCHEMA = CONTRACT_DIR.resolve(
            "managed-runtime-tool-v2.schema.json");

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

    @Test
    void consumesTheSharedToolRouteContract() throws IOException {
        JsonNode suite = read(TOOL_FIXTURES);
        assertEquals(1, suite.required("contractVersion").intValue());
        JsonNode routes = suite.required("routes");
        assertEquals(3, routes.size());
        Set<String> keys = new HashSet<>();
        for (JsonNode route : routes) {
            String key = route.required("key").textValue();
            assertTrue(keys.add(key));
            assertEquals("POST", route.required("method").textValue());
            assertEquals("/internal/managed-runtime/v2/" + key,
                    route.required("path").textValue());
            assertEquals(2, route.required("protocolVersion").intValue());
            assertEquals("execute".equals(key) ? 256 * 1024 : 16 * 1024,
                    route.required("requestBodyLimitBytes").intValue());
            assertEquals(1024 * 1024,
                    route.required("responseBodyLimitBytes").intValue());
            assertEquals("no-store",
                    route.required("cacheControl").textValue());
        }
        assertEquals(Set.of("execute", "status", "cancel"), keys);
        JsonNode identity = suite.required("identity");
        assertEquals(Set.of("token", "leaseId", "epoch"),
                fieldNames(identity));
    }

    @Test
    void consumesEveryToolOutcomeClassification() throws IOException {
        JsonNode suites = read(TOOL_FIXTURES).required("suites");
        assertEquals(3, suites.size());
        Set<String> classifications = new HashSet<>();
        Set<String> routes = new HashSet<>();
        Set<String> states = new HashSet<>();
        Set<String> executionStatuses = new HashSet<>();
        for (JsonNode suite : suites) {
            assertTrue(routes.add(suite.required("route").textValue()));
            Set<String> ids = new HashSet<>();
            for (JsonNode fixture : suite.required("cases")) {
                String id = fixture.required("id").textValue();
                assertTrue(ids.add(id), () -> "duplicate fixture id: " + id);
                int status = fixture.required("expected").required("status")
                        .intValue();
                String classification = fixture.required("expected")
                        .required("classification").textValue();
                assertEquals(classify(status), classification, id);
                classifications.add(classification);
                JsonNode body = fixture.required("expected").get("body");
                if (body != null) {
                    String state = body.required("state").textValue();
                    states.add(state);
                    assertEquals("settled".equals(state), body.has("result"), id);
                    if (body.has("result")) {
                        executionStatuses.add(body.required("result")
                                .required("executionStatus").textValue());
                    }
                }
            }
        }
        assertEquals(Set.of("execute", "status", "cancel"), routes);
        assertEquals(Set.of("prepared", "executing", "cancel_requested",
                "settled", "unknown"), states);
        assertEquals(Set.of("not_started", "success", "error", "cancelled"),
                executionStatuses);
        assertEquals(Set.of("ok", "credentials", "protocol", "identity",
                "incompatible"), classifications);
    }

    @Test
    void pinsClosedToolRequestAndResponseShapes() throws IOException {
        JsonNode suites = read(TOOL_FIXTURES).required("suites");
        for (JsonNode suite : suites) {
            String route = suite.required("route").textValue();
            JsonNode body = suite.required("canonicalRequest")
                    .required("body");
            Set<String> reference = fieldNames(
                    body.required("reference"));
            assertEquals(Set.of("sessionId", "promptId", "callId",
                    "argsDigest"), reference, route);
            switch (route) {
                case "execute" -> assertEquals(
                        Set.of("protocolVersion", "reference", "toolName",
                                "input"), fieldNames(body));
                case "status" -> assertEquals(
                        Set.of("protocolVersion", "reference",
                                "afterSequence"), fieldNames(body));
                case "cancel" -> assertEquals(
                        Set.of("protocolVersion", "reference"),
                        fieldNames(body));
                default -> throw new AssertionError("unknown route " + route);
            }
        }
        JsonNode settled = findSuiteCase(suites, "status",
                "settled-with-result");
        assertEquals(Set.of("protocolVersion", "state", "result",
                "lastSequence"),
                fieldNames(settled.required("expected").required("body")));
        JsonNode unknown = findSuiteCase(suites, "status", "unknown-is-ok");
        assertEquals(Set.of("protocolVersion", "state"),
                fieldNames(unknown.required("expected").required("body")));
        JsonNode result = settled.required("expected").required("body")
                .required("result");
        assertEquals(Set.of("executionStatus", "responseParts"),
                fieldNames(result));
        JsonNode errorResult = findSuiteCase(suites, "status", "settled-with-error")
                .required("expected").required("body").required("result");
        assertEquals(Set.of("executionStatus", "responseParts", "error"),
                fieldNames(errorResult));
        assertEquals("error", errorResult.required("executionStatus").textValue());
        assertEquals(Set.of("message", "type"),
                fieldNames(errorResult.required("error")));
        JsonNode withoutCursor = findSuiteCase(suites, "status", "without-cursor")
                .required("request").required("body");
        assertEquals(Set.of("protocolVersion", "reference"),
                fieldNames(withoutCursor));

        JsonNode definitions = read(TOOL_SCHEMA).required("$defs");
        for (String name : new String[] {"executeRequestBody",
                "statusRequestBody", "cancelRequestBody"}) {
            assertFalse(definitions.required(name)
                    .required("additionalProperties").booleanValue(), name);
        }
        assertFalse(definitions.required("toolResponseBody")
                .required("additionalProperties").booleanValue());
        assertFalse(definitions.required("reference")
                .required("additionalProperties").booleanValue());
    }

    private static JsonNode read(Path path) throws IOException {
        assertTrue(Files.isRegularFile(path), () -> "missing shared contract: " + path);
        return JSON.readTree(path.toFile());
    }

    static Path contractDirectory() {
        return findContractDirectory();
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

    private static JsonNode findSuiteCase(JsonNode suites, String route,
            String id) {
        for (JsonNode suite : suites) {
            if (route.equals(suite.required("route").textValue())) {
                return findCase(suite.required("cases"), id);
            }
        }
        throw new AssertionError("missing suite: " + route);
    }

    private static Set<String> fieldNames(JsonNode value) {
        Set<String> names = new HashSet<>();
        for (Map.Entry<String, JsonNode> field : value.properties()) {
            names.add(field.getKey());
        }
        return names;
    }

    private static String classify(int status) {
        return switch (status) {
            case 200, 401, 403, 400, 413, 409, 404, 405 ->
                    HttpRuntimeTransport.classificationFor(status);
            default -> throw new AssertionError(
                    "unclassified fixture status: " + status);
        };
    }
}
