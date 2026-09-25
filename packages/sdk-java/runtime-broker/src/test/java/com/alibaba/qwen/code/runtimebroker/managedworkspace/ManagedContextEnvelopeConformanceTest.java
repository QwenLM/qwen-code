package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.IntNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Pins the managed-context/1 envelope (W0a-2) to the language-neutral schema
 * and fixtures that the TypeScript implementation replays. Java builds and
 * checks these records once W0c wires the protocol; until then this test
 * fixes the closed key sets, the routes and the constants, and recomputes
 * every installation digest with {@link ContextBinding}.
 */
class ManagedContextEnvelopeConformanceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern DECIMAL = Pattern.compile("[1-9][0-9]{0,18}");
    private static final String IDENTITY_CONFLICT =
            "managed_runtime_identity_conflict";
    // Statuses and versions compare as whole JSON nodes, so 2.5 or 2^32+2
    // cannot pass for 2.
    private static final JsonNode OK = IntNode.valueOf(200);
    private static final JsonNode BAD_REQUEST = IntNode.valueOf(400);
    private static final JsonNode PROTOCOL_VERSION = IntNode.valueOf(3);

    private static final Set<String> BOOT_KEYS = Set.of("type", "version",
            "managedContext", "runtimeInstanceId", "runtimeIncarnation",
            "leaseId", "provisionRequestId", "token", "epoch",
            "capabilityDigest", "isolationClass", "tenantId", "workspaceId",
            "workspaceGeneration", "storageId", "mountRoot");
    private static final Set<String> READY_KEYS = Set.of("type", "version",
            "managedContext", "runtimeInstanceId", "runtimeIncarnation",
            "leaseId", "epoch", "url");
    private static final Set<String> ATTESTATION_KEYS = Set.of(
            "protocolVersion", "managedContext", "provisionRequestId",
            "tenantId", "workspaceId", "workspaceGeneration", "storageId",
            "mountRoot", "capabilityDigest", "isolationClass");
    private static final Set<String> RESPONSE_KEYS = union(ATTESTATION_KEYS,
            Set.of("runtimeInstanceId", "runtimeIncarnation", "leaseId",
                    "epoch"));
    private static final Set<String> INSTALLATION_KEYS = Set.of(
            "protocolVersion", "managedContext", "operationId", "sessionId",
            "binding", "contextDigest");
    private static final Set<String> BINDING_KEYS = Set.of("tenantId",
            "workspaceId", "workspaceGeneration", "storageId", "cwdRelative",
            "contextConfigRef", "contextRevision");
    private static final Set<String> RECEIPT_KEYS = Set.of("protocolVersion",
            "managedContext", "operationId", "sessionId", "runtimeInstanceId",
            "runtimeIncarnation", "epoch", "contextDigest", "contextRevision",
            "workspaceGeneration");
    /** The binding fields that must match the Workspace the Runtime booted. */
    private static final List<String> WORKSPACE_FIELDS = List.of("tenantId",
            "workspaceId", "workspaceGeneration", "storageId");

    @Test
    void pinsTheProtocolTokenVersionsAndRoutes() throws IOException {
        JsonNode fixtures = fixtures();
        JsonNode routes = JSON.readTree("""
                [{"key": "attest", "method": "POST",
                  "path": "/internal/managed-runtime/v3/attest",
                  "protocolVersion": 3, "requestBodyLimitBytes": 16384,
                  "responseBodyLimitBytes": 16384, "cacheControl": "no-store"},
                 {"key": "context", "method": "POST",
                  "path": "/internal/managed-runtime/v3/context",
                  "protocolVersion": 3, "requestBodyLimitBytes": 16384,
                  "responseBodyLimitBytes": 16384, "cacheControl": "no-store"}]
                """);

        // Whole JSON nodes, so 2.5 or 2^32+2 cannot pass for 2.
        assertEquals(JSON.readTree("1"), fixtures.required("contractVersion"));
        assertEquals(JSON.readTree("\"managed-context/1\""),
                fixtures.required("managedContext"));
        assertEquals(JSON.readTree("2"), fixtures.required("bootVersion"));
        assertEquals(JSON.readTree("2"), fixtures.required("readyVersion"));
        assertEquals(routes, fixtures.required("routes"));
        JsonNode properties = schema().required("properties");
        assertEquals(routes, properties.required("routes").required("const"));
        assertEquals(JSON.readTree("1"),
                properties.required("contractVersion").required("const"));
        assertEquals(JSON.readTree("2"),
                properties.required("bootVersion").required("const"));
        assertEquals(JSON.readTree("2"),
                properties.required("readyVersion").required("const"));
        for (String record : List.of("boot", "ready")) {
            JsonNode value = fixtures.required(record);
            assertEquals(JSON.readTree("\"" + record + "\""),
                    value.required("type"), record);
            assertEquals(JSON.readTree("2"), value.required("version"),
                    record);
            assertEquals(fixtures.required("managedContext"),
                    value.required("managedContext"), record);
        }
        assertEquals(fixtures.required("managedContext"), fixtures
                .required("attestationResponse").required("managedContext"));
    }

    @Test
    void pinsTheSchemaConstants() throws IOException {
        JsonNode definitions = schema().required("$defs");

        assertEquals(JSON.readTree("\"managed-context/1\""),
                definitions.required("managedContext").required("const"));
        assertEquals(JSON.readTree("\"boot\""),
                constant(definitions, "bootV2", "type"));
        assertEquals(JSON.readTree("2"),
                constant(definitions, "bootV2", "version"));
        assertEquals(JSON.readTree("\"ready\""),
                constant(definitions, "readyV2", "type"));
        assertEquals(JSON.readTree("2"),
                constant(definitions, "readyV2", "version"));
        for (String name : List.of("attestationRequestV3",
                "attestationResponseV3", "installationRequest", "receipt")) {
            assertEquals(JSON.readTree("3"),
                    constant(definitions, name, "protocolVersion"), name);
        }
        for (String name : List.of("attestationOutcome",
                "installationOutcome")) {
            JsonNode outcomes = definitions.required(name).required("oneOf");
            assertEquals(JSON.readTree("{\"const\": 200}"), outcomes.required(0)
                    .required("properties").required("status"), name);
            assertEquals(JSON.readTree("{\"enum\": [400, 409]}"),
                    outcomes.required(1).required("properties")
                            .required("status"), name);
        }
        JsonNode reference = JSON.readTree(
                "{\"$ref\": \"#/$defs/managedContext\"}");
        for (String name : List.of("bootV2", "readyV2",
                "attestationRequestV3", "attestationResponseV3",
                "installationRequest", "receipt")) {
            assertEquals(reference, definitions.required(name)
                    .required("properties").required("managedContext"), name);
        }
    }

    @Test
    void pinsTheErrorTable() throws IOException {
        JsonNode errors = JSON.readTree("""
                [{"status": 400, "code": "managed_runtime_attestation_invalid",
                  "classification": "protocol"},
                 {"status": 401, "code": "managed_runtime_unauthorized",
                  "classification": "credentials"},
                 {"status": 404, "code": null,
                  "classification": "incompatible"},
                 {"status": 409, "code": "managed_runtime_identity_conflict",
                  "classification": "identity"},
                 {"status": 409, "code": "managed_context_conflict",
                  "classification": "identity"},
                 {"status": 409, "code": "managed_context_unavailable",
                  "classification": "recovery"},
                 {"status": 413,
                  "code": "managed_runtime_attestation_too_large",
                  "classification": "protocol"}]
                """);
        JsonNode fixtures = fixtures();

        assertEquals(errors, fixtures.required("errors"));
        assertEquals(errors, schema().required("properties")
                .required("errors").required("const"));
        Set<String> listed = new HashSet<>();
        errors.forEach(error -> listed.add(error.required("status")
                + " " + error.required("code").textValue()));
        int refusals = 0;
        for (JsonNode fixture : fixtures.required("attestationCases")) {
            refusals += checkListed(listed, fixture.required("expected"));
        }
        for (JsonNode sequence : fixtures.required("installationSequences")) {
            for (JsonNode step : sequence.required("steps")) {
                refusals += checkListed(listed, step.required("expected"));
            }
        }
        assertTrue(refusals > 0);
    }

    @Test
    void pinsEveryClosedKeySet() throws IOException {
        Map<String, Set<String>> keySets = Map.of("bootV2", BOOT_KEYS,
                "readyV2", READY_KEYS, "attestationRequestV3",
                ATTESTATION_KEYS, "attestationResponseV3", RESPONSE_KEYS,
                "installationRequest", INSTALLATION_KEYS, "binding",
                BINDING_KEYS, "receipt", RECEIPT_KEYS);
        JsonNode definitions = schema().required("$defs");
        for (Map.Entry<String, Set<String>> keySet : keySets.entrySet()) {
            JsonNode definition = definitions.required(keySet.getKey());

            assertEquals(new TreeSet<>(keySet.getValue()),
                    strings(definition.required("required")),
                    keySet.getKey());
            assertEquals(new TreeSet<>(keySet.getValue()),
                    keys(definition.required("properties")), keySet.getKey());
            JsonNode additional = definition.required("additionalProperties");
            assertTrue(additional.isBoolean() && !additional.booleanValue(),
                    keySet.getKey());
            // No other keyword, such as patternProperties, may reopen it.
            assertEquals(Set.of("additionalProperties", "properties",
                    "required", "type"), keys(definition), keySet.getKey());
        }
        JsonNode fixtures = fixtures();
        assertEquals(new TreeSet<>(BOOT_KEYS), keys(fixtures.required("boot")));
        assertEquals(new TreeSet<>(READY_KEYS),
                keys(fixtures.required("ready")));
        assertEquals(new TreeSet<>(RESPONSE_KEYS),
                keys(fixtures.required("attestationResponse")));
    }

    @Test
    void answersAttestationWithTheBootIdentity() throws IOException {
        JsonNode fixtures = fixtures();
        JsonNode boot = fixtures.required("boot");
        JsonNode response = fixtures.required("attestationResponse");

        assertEquals(PROTOCOL_VERSION, response.required("protocolVersion"));
        for (String key : RESPONSE_KEYS) {
            if (!key.equals("protocolVersion")) {
                assertEquals(boot.required(key), response.required(key), key);
            }
        }
        int answered = 0;
        for (JsonNode fixture : fixtures.required("attestationCases")) {
            JsonNode expected = fixture.required("expected");
            if (OK.equals(expected.required("status"))) {
                String id = fixture.required("id").textValue();
                assertEquals(response, expected.required("body"), id);
                checkMarkers(fixtures, fixture.required("body"), id);
                answered++;
            }
        }
        assertTrue(answered > 0);
    }

    @Test
    void recomputesEveryInstallationDigestWithContextBinding()
            throws IOException {
        JsonNode fixtures = fixtures();
        JsonNode boot = fixtures.required("boot");
        int installed = 0;
        int mismatched = 0;
        for (JsonNode sequence : fixtures.required("installationSequences")) {
            String id = sequence.required("id").textValue();
            for (JsonNode step : sequence.required("steps")) {
                JsonNode request = step.required("request");
                JsonNode expected = step.required("expected");
                ContextBinding binding = buildOrNull(request.path("binding"));
                if (BAD_REQUEST.equals(expected.required("status"))) {
                    // A well-formed binding under a 400 is a digest mismatch
                    // or another field's fault; count the mismatches.
                    if (binding != null && !binding.getContextDigest().equals(
                            request.path("contextDigest").textValue())) {
                        mismatched++;
                    }
                    continue;
                }
                assertNotNull(binding, id);
                checkMarkers(fixtures, request, id);
                assertEquals(request.required("contextDigest").textValue(),
                        binding.getContextDigest(), id);
                boolean sameWorkspace = WORKSPACE_FIELDS.stream().allMatch(
                        field -> request.required("binding").required(field)
                                .equals(boot.required(field)));
                assertEquals(!IDENTITY_CONFLICT.equals(
                        expected.path("code").textValue()), sameWorkspace, id);
                if (OK.equals(expected.required("status"))) {
                    checkReceipt(boot, request, binding,
                            expected.required("body"), id);
                    installed++;
                }
            }
        }
        assertTrue(installed > 0);
        assertTrue(mismatched > 0);
    }

    @Test
    void usesEachCaseIdOnceInEachList() throws IOException {
        JsonNode fixtures = fixtures();
        for (String list : List.of("bootCases", "readyCases",
                "attestationCases", "installationSequences")) {
            Set<String> ids = new HashSet<>();
            for (JsonNode fixture : fixtures.required(list)) {
                String id = fixture.required("id").textValue();
                assertTrue(ids.add(id), () -> "duplicate " + list + " id: "
                        + id);
            }
        }
    }

    private static JsonNode constant(JsonNode definitions, String definition,
            String field) {
        return definitions.required(definition).required("properties")
                .required(field).required("const");
    }

    /** An accepted request carries protocol version 3 and the token. */
    private static void checkMarkers(JsonNode fixtures, JsonNode request,
            String id) {
        assertEquals(PROTOCOL_VERSION, request.required("protocolVersion"),
                id);
        assertEquals(fixtures.required("managedContext"),
                request.required("managedContext"), id);
    }

    /** Asserts that a refusal is in the error table; counts refusals. */
    private static int checkListed(Set<String> listed, JsonNode outcome) {
        JsonNode status = outcome.required("status");
        if (OK.equals(status)) {
            return 0;
        }
        String key = status + " " + outcome.required("code").textValue();
        assertTrue(listed.contains(key), () -> "not in the error table: "
                + key);
        return 1;
    }

    private static void checkReceipt(JsonNode boot, JsonNode request,
            ContextBinding binding, JsonNode receipt, String id) {
        assertEquals(new TreeSet<>(RECEIPT_KEYS), keys(receipt), id);
        assertEquals(PROTOCOL_VERSION, receipt.required("protocolVersion"), id);
        for (String key : List.of("managedContext", "runtimeInstanceId",
                "runtimeIncarnation", "epoch")) {
            assertEquals(boot.required(key), receipt.required(key), id);
        }
        for (String key : List.of("operationId", "sessionId",
                "contextDigest")) {
            assertEquals(request.required(key), receipt.required(key), id);
        }
        assertEquals(binding.getContextRevision(),
                decimal(receipt.required("contextRevision").textValue()), id);
        assertEquals(binding.getWorkspaceGeneration(),
                decimal(receipt.required("workspaceGeneration").textValue()),
                id);
    }

    /** The binding a request carries, or null when it is not one. */
    private static ContextBinding buildOrNull(JsonNode binding) {
        if (!binding.isObject() || !keys(binding).equals(
                new TreeSet<>(BINDING_KEYS))) {
            return null;
        }
        try {
            return new ContextBinding(binding.get("tenantId").textValue(),
                    binding.get("workspaceId").textValue(),
                    decimal(binding.get("workspaceGeneration").textValue()),
                    binding.get("storageId").textValue(),
                    binding.get("cwdRelative").textValue(),
                    binding.get("contextConfigRef").textValue(),
                    decimal(binding.get("contextRevision").textValue()));
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    // Java carries generations and revisions as long, so the wire text is
    // checked for the canonical decimal form where it is parsed.
    private static long decimal(String value) {
        if (value == null || !DECIMAL.matcher(value).matches()) {
            throw new IllegalArgumentException("not a canonical decimal");
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("decimal exceeds 64 bits",
                    exception);
        }
    }

    private static Set<String> keys(JsonNode object) {
        Set<String> keys = new TreeSet<>();
        object.fieldNames().forEachRemaining(keys::add);
        return keys;
    }

    private static Set<String> strings(JsonNode array) {
        Set<String> values = new TreeSet<>();
        array.forEach(value -> assertTrue(values.add(value.textValue()),
                () -> "duplicate key: " + value));
        return values;
    }

    private static Set<String> union(Set<String> first, Set<String> second) {
        Set<String> union = new HashSet<>(first);
        union.addAll(second);
        return Set.copyOf(union);
    }

    private static JsonNode fixtures() throws IOException {
        return read("managed-context-v1.fixtures.json");
    }

    private static JsonNode schema() throws IOException {
        return read("managed-context-v1.schema.json");
    }

    private static JsonNode read(String name) throws IOException {
        Path path = contractDirectory().resolve(name);
        assertTrue(Files.isRegularFile(path),
                () -> "missing shared contract: " + path);
        return JSON.readTree(path.toFile());
    }

    private static Path contractDirectory() {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            Path candidate = current.resolve(Path.of("packages", "cli", "src",
                    "serve", "contracts"));
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            current = current.getParent();
        }
        throw new AssertionError("cannot locate the shared contract fixtures");
    }
}
