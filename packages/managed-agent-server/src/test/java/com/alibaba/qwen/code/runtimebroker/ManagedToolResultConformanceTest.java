package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;

/**
 * Pins the managed-tool-result/1 contract (O1a) to the language-neutral
 * schema and fixtures that the TypeScript module replays. Java has no
 * segment store or Tool v3 client yet, so this test fixes the constants,
 * routes, error table and closed key sets, and recomputes every segment,
 * seal and prefix digest from the bytes the fixtures publish.
 */
class ManagedToolResultConformanceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CONTRACT_DIR = findContractDirectory();
    private static final Path FIXTURES = CONTRACT_DIR.resolve(
            "managed-tool-result-v1.fixtures.json");
    private static final Path SCHEMA = CONTRACT_DIR.resolve(
            "managed-tool-result-v1.schema.json");

    private static final Map<String, Set<String>> REQUIRED_KEYS = Map.ofEntries(
            Map.entry("manifest", Set.of("toolResult", "type", "tenantId",
                    "sessionId", "turnId", "executionCallId", "callId",
                    "invocationDigest", "bindingGeneration", "captureId",
                    "revision", "executionStatus", "exitCode", "signal",
                    "captureScope", "capturePolicy", "captureStatus",
                    "captureReason", "upstreamTruncated", "contents")),
            Map.entry("descriptor", Set.of("streamId", "role", "mimeType",
                    "state", "byteLength", "digest", "missingRanges",
                    "body")),
            Map.entry("pageReference", Set.of("ref", "segmentCount",
                    "byteLength")),
            Map.entry("missingRange", Set.of("start", "end")),
            Map.entry("page", Set.of("toolResult", "type", "captureId",
                    "streamId", "firstOrdinal", "offset", "segments")),
            Map.entry("segment", Set.of("byteLength", "digest")),
            Map.entry("capture", Set.of("captureStatus", "captureReason",
                    "manifest", "previewTruncated", "deliveryStatus")),
            Map.entry("result", Set.of("executionStatus", "responseParts",
                    "capture")),
            Map.entry("captureRequest", Set.of("tenantId", "sessionId",
                    "turnId", "executionCallId", "bindingGeneration",
                    "capturePolicy")),
            Map.entry("receipt", Set.of("executionCallId", "manifest",
                    "deliveryStatus", "historyRevision")),
            Map.entry("executeRequest", Set.of("protocolVersion",
                    "toolResult", "reference", "toolName", "input",
                    "capture")),
            Map.entry("statusRequest", Set.of("protocolVersion",
                    "toolResult", "reference")),
            Map.entry("cancelRequest", Set.of("protocolVersion",
                    "toolResult", "reference")),
            Map.entry("acknowledgeRequest", Set.of("protocolVersion",
                    "toolResult", "reference", "receipt")),
            Map.entry("executeResponse", Set.of("protocolVersion",
                    "toolResult", "state")),
            Map.entry("statusResponse", Set.of("protocolVersion",
                    "toolResult", "state")),
            Map.entry("cancelResponse", Set.of("protocolVersion",
                    "toolResult", "state")),
            Map.entry("acknowledgeResponse", Set.of("protocolVersion",
                    "toolResult", "state")));
    private static final Map<String, Set<String>> OPTIONAL_KEYS = Map.of(
            "result", Set.of("error"),
            "statusRequest", Set.of("afterSequence"),
            "executeResponse", Set.of("result"),
            "statusResponse", Set.of("result", "lastSequence"),
            "cancelResponse", Set.of("result"),
            "acknowledgeResponse", Set.of("result"));

    @Test
    void pinsTheTokenKindsLimitsAndRoutes() throws IOException {
        JsonNode fixtures = read(FIXTURES);
        JsonNode properties = read(SCHEMA).required("properties");
        JsonNode kinds = JSON.readTree("""
                {"manifest": "managed-tool-result-manifest",
                 "page": "managed-tool-result-page",
                 "content": "managed-tool-result-content"}
                """);
        JsonNode limits = JSON.readTree("""
                {"maxManifestBytes": 65536, "maxPageBytes": 262144,
                 "maxContents": 32, "maxPagesPerStream": 64,
                 "maxSegmentsPerPage": 1024, "maxSegmentBytes": 16777216,
                 "maxOrdinal": 65535, "maxMimeTypeLength": 255,
                 "maxIdBytes": 512, "maxTokenLength": 128}
                """);
        ArrayNode routes = JSON.createArrayNode();
        for (String key : List.of("execute", "status", "cancel",
                "acknowledge")) {
            routes.add(JSON.createObjectNode()
                    .put("key", key)
                    .put("method", "POST")
                    .put("path", "/internal/managed-runtime/v3/" + key)
                    .put("protocolVersion", 3)
                    .put("requestBodyLimitBytes",
                            key.equals("execute") ? 262144 : 16384)
                    .put("responseBodyLimitBytes", 1048576)
                    .put("cacheControl", "no-store"));
        }

        // Whole JSON nodes, so 1.0 or 2^32+1 cannot pass for 1.
        assertEquals(JSON.readTree("1"), fixtures.required("contractVersion"));
        assertEquals(JSON.readTree("\"managed-tool-result/1\""),
                fixtures.required("toolResult"));
        assertEquals(kinds, fixtures.required("kinds"));
        assertEquals(limits, fixtures.required("limits"));
        assertEquals(routes, fixtures.required("routes"));
        assertEquals(kinds, properties.required("kinds").required("const"));
        assertEquals(limits, properties.required("limits").required("const"));
        assertEquals(routes, properties.required("routes").required("const"));
        assertEquals(JSON.readTree("{\"const\": \"managed-tool-result/1\"}"),
                read(SCHEMA).required("$defs").required("toolResult"));
    }

    @Test
    void pinsTheErrorTable() throws IOException {
        JsonNode errors = JSON.readTree("""
                [{"status": 401, "code": "managed_runtime_unauthorized",
                  "classification": "credentials"},
                 {"status": 400, "code": "managed_runtime_attestation_invalid",
                  "classification": "protocol"},
                 {"status": 413,
                  "code": "managed_runtime_attestation_too_large",
                  "classification": "protocol"},
                 {"status": 409, "code": "managed_runtime_identity_conflict",
                  "classification": "identity"},
                 {"status": 409, "code": "managed_tool_result_conflict",
                  "classification": "identity"},
                 {"status": 404, "code": null,
                  "classification": "incompatible"},
                 {"status": null, "code": "managed_tool_result_invalid",
                  "classification": "protocol"},
                 {"status": null, "code": "managed_tool_result_conflict",
                  "classification": "identity"},
                 {"status": null,
                  "code": "managed_tool_result_digest_mismatch",
                  "classification": "integrity"}]
                """);
        JsonNode fixtures = read(FIXTURES);

        assertEquals(errors, fixtures.required("errors"));
        assertEquals(errors, read(SCHEMA).required("properties")
                .required("errors").required("const"));
        Set<String> storeCodes = new TreeSet<>();
        errors.forEach(error -> {
            if (error.required("status").isNull()) {
                storeCodes.add(error.required("code").textValue());
            }
        });
        Set<String> refusals = new TreeSet<>();
        for (JsonNode sequence : fixtures.required("segmentSequences")) {
            for (JsonNode step : sequence.required("steps")) {
                JsonNode expected = step.required("expected");
                if ("refused".equals(expected.required("status").textValue())) {
                    refusals.add(expected.required("code").textValue());
                }
            }
        }
        assertEquals(storeCodes, refusals);
    }

    @Test
    void pinsEveryClosedKeySet() throws IOException {
        JsonNode definitions = read(SCHEMA).required("$defs");
        for (Map.Entry<String, Set<String>> entry : REQUIRED_KEYS.entrySet()) {
            String name = entry.getKey();
            JsonNode definition = definitions.required(name);
            Set<String> all = new TreeSet<>(entry.getValue());
            all.addAll(OPTIONAL_KEYS.getOrDefault(name, Set.of()));

            assertEquals(new TreeSet<>(entry.getValue()),
                    strings(definition.required("required")), name);
            assertEquals(all, keys(definition.required("properties")), name);
            JsonNode additional = definition.required("additionalProperties");
            assertTrue(additional.isBoolean() && !additional.booleanValue(),
                    name);
            // Conditions may narrow a record, but nothing may reopen it.
            Set<String> keywords = keys(definition);
            keywords.remove("allOf");
            assertEquals(Set.of("additionalProperties", "properties",
                    "required", "type"), keywords, name);
        }
        JsonNode fixtures = read(FIXTURES);
        assertEquals(new TreeSet<>(REQUIRED_KEYS.get("manifest")),
                keys(fixtures.required("manifest")));
        for (JsonNode page : fixtures.required("pages")) {
            assertEquals(new TreeSet<>(REQUIRED_KEYS.get("page")),
                    keys(page));
        }
        JsonNode requests = fixtures.required("requests");
        for (String route : List.of("execute", "status", "cancel",
                "acknowledge")) {
            JsonNode request = requests.required(route);
            assertEquals(JSON.readTree("3"), request.required(
                    "protocolVersion"), route);
            assertEquals(fixtures.required("toolResult"),
                    request.required("toolResult"), route);
        }
    }

    @Test
    void recomputesEverySegmentSealAndPrefixDigest() throws IOException {
        int published = 0;
        int sealed = 0;
        int prefixes = 0;
        for (JsonNode sequence : read(FIXTURES).required(
                "segmentSequences")) {
            String id = sequence.required("id").textValue();
            Map<String, byte[]> stored = new HashMap<>();
            for (JsonNode step : sequence.required("steps")) {
                JsonNode request = step.required("request");
                JsonNode expected = step.required("expected");
                if (!"ok".equals(expected.required("status").textValue())) {
                    continue;
                }
                JsonNode result = expected.required("result");
                String stream = request.required("captureId").textValue()
                        + "/" + request.required("streamId").textValue();
                switch (step.required("op").textValue()) {
                    case "publish" -> {
                        byte[] bytes = bytes(request.required("bytes"));
                        int ordinal = request.required("ordinal").intValue();
                        byte[] previous = stored.putIfAbsent(
                                stream + "#" + ordinal, bytes);
                        assertArrayEquals(previous == null ? bytes : previous,
                                bytes, id);
                        assertEquals(ordinal,
                                result.required("ordinal").intValue(), id);
                        assertEquals(bytes.length,
                                result.required("byteLength").longValue(), id);
                        assertEquals(sha256(bytes),
                                result.required("digest").textValue(), id);
                        published++;
                    }
                    case "seal" -> {
                        int count = result.required("segmentCount").intValue();
                        for (String key : stored.keySet()) {
                            if (key.startsWith(stream + "#")) {
                                assertTrue(Integer.parseInt(key.substring(
                                        stream.length() + 1)) < count, id);
                            }
                        }
                        byte[] bytes = concatenate(stored, stream, count);
                        assertEquals(bytes.length,
                                result.required("byteLength").longValue(), id);
                        assertEquals(sha256(bytes),
                                result.required("digest").textValue(), id);
                        sealed++;
                    }
                    default -> {
                        int count = result.required("segmentCount").intValue();
                        assertTrue(!stored.containsKey(stream + "#" + count),
                                id);
                        byte[] bytes = concatenate(stored, stream, count);
                        assertEquals(bytes.length,
                                result.required("byteLength").longValue(), id);
                        assertEquals(sha256(bytes),
                                result.required("digest").textValue(), id);
                        prefixes++;
                    }
                }
            }
        }
        assertTrue(published > 0 && sealed > 0 && prefixes > 0);
    }

    @Test
    void describesTheCanonicalStdoutWithItsPages() throws IOException {
        JsonNode fixtures = read(FIXTURES);
        byte[] stdout = bytes(fixtures.required("stdout"));
        JsonNode stream = fixtures.required("manifest").required("contents")
                .required(0);
        JsonNode pageRefs = stream.required("body").required("pages");
        JsonNode pages = fixtures.required("pages");

        assertEquals(stdout.length, stream.required("byteLength").longValue());
        assertEquals(sha256(stdout), stream.required("digest").textValue());
        int offset = 0;
        int ordinal = 0;
        for (int index = 0; index < pages.size(); index++) {
            JsonNode page = pages.required(index);
            JsonNode pageRef = pageRefs.required(index);
            assertEquals(offset, page.required("offset").longValue());
            assertEquals(ordinal, page.required("firstOrdinal").longValue());
            assertEquals(pageRef.required("segmentCount").intValue(),
                    page.required("segments").size());
            long pageBytes = 0;
            for (JsonNode segment : page.required("segments")) {
                int length = segment.required("byteLength").intValue();
                assertEquals(sha256(Arrays.copyOfRange(stdout, offset,
                        offset + length)), segment.required("digest")
                        .textValue());
                offset += length;
                pageBytes += length;
                ordinal++;
            }
            assertEquals(pageRef.required("byteLength").longValue(),
                    pageBytes);
        }
        assertEquals(stdout.length, offset);
    }

    @Test
    void usesEachCaseIdOnceInEachList() throws IOException {
        JsonNode fixtures = read(FIXTURES);
        int lists = 0;
        for (Map.Entry<String, JsonNode> field : fixtures.properties()) {
            if (!field.getKey().endsWith("Cases")
                    && !field.getKey().endsWith("Sequences")) {
                continue;
            }
            Set<String> ids = new HashSet<>();
            for (JsonNode fixture : field.getValue()) {
                String id = fixture.required("id").textValue();
                assertTrue(ids.add(id), () -> "duplicate " + field.getKey()
                        + " id: " + id);
            }
            lists++;
        }
        assertEquals(12, lists);
    }

    private static byte[] concatenate(Map<String, byte[]> stored,
            String stream, int count) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int ordinal = 0; ordinal < count; ordinal++) {
            byte[] segment = stored.get(stream + "#" + ordinal);
            assertTrue(segment != null, stream + " lacks segment " + ordinal);
            bytes.writeBytes(segment);
        }
        return bytes.toByteArray();
    }

    private static byte[] bytes(JsonNode spec) {
        if (spec.has("base64")) {
            return Base64.getDecoder().decode(
                    spec.required("base64").textValue());
        }
        JsonNode fill = spec.required("fill");
        byte[] bytes = new byte[fill.required("length").intValue()];
        Arrays.fill(bytes, (byte) fill.required("byte").intValue());
        return bytes;
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException exception) {
            throw new AssertionError(exception);
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

    private static JsonNode read(Path path) throws IOException {
        assertTrue(Files.isRegularFile(path),
                () -> "missing shared contract: " + path);
        return JSON.readTree(path.toFile());
    }

    private static Path findContractDirectory() {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            Path candidate = current.resolve(Path.of("packages", "core", "src",
                    "managed-runtime", "contracts"));
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            current = current.getParent();
        }
        throw new AssertionError("cannot locate the shared contract fixtures");
    }
}
