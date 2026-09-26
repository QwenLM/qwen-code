package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/**
 * Pins the fake worker that the provisioner tests start to both closed boot
 * key sets, and its boot v2 answers to the managed-context/1 fixtures, so
 * that Broker tests of boot v2 can rely on it.
 */
class FakeAttestationWorkerTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void servesBootV2AsTheSharedFixturesDescribe() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        JsonNode fixtures = fixtures();
        Process worker = start(JSON.writeValueAsBytes(fixtures.get("boot")));
        try {
            BufferedReader stdout = new BufferedReader(new InputStreamReader(
                    worker.getInputStream(), StandardCharsets.UTF_8));
            JsonNode ready = JSON.readTree(stdout.readLine());
            JsonNode expected = fixtures.get("ready");
            assertEquals(fieldNames(expected), fieldNames(ready));
            for (String field : fieldNames(expected)) {
                if (!"url".equals(field)) {
                    assertEquals(expected.get(field), ready.get(field), field);
                }
            }
            URI origin = URI.create(ready.get("url").asText());
            assertEquals("127.0.0.1", origin.getHost());

            JsonNode attestation = fixtures.get("attestationCases").get(0);
            assertEquals("canonical", attestation.get("id").asText());
            HttpResponse<String> attested = post(origin,
                    "/internal/managed-runtime/v3/attest",
                    attestation.get("body"));
            assertEquals(200, attested.statusCode());
            assertEquals(fixtures.get("attestationResponse"),
                    JSON.readTree(attested.body()));

            JsonNode step = fixtures.get("installationSequences").get(0)
                    .get("steps").get(0);
            HttpResponse<String> installed = post(origin,
                    "/internal/managed-runtime/v3/context",
                    step.get("request"));
            assertEquals(200, installed.statusCode());
            assertEquals(step.get("expected").get("body"),
                    JSON.readTree(installed.body()));
            assertEquals(400, post(origin,
                    "/internal/managed-runtime/v3/context", "{".getBytes(
                            StandardCharsets.UTF_8)).statusCode());

            assertEquals(404, post(origin,
                    "/internal/managed-runtime/v2/attest",
                    attestation.get("body")).statusCode());
        } finally {
            worker.destroyForcibly().waitFor(10, TimeUnit.SECONDS);
        }
    }

    @Test
    void refusesABootOutsideBothClosedKeySets() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        ObjectNode v2 = (ObjectNode) fixtures().get("boot");
        ObjectNode v1 = v2.deepCopy();
        v1.remove(List.of("managedContext", "mountRoot", "storageId"));
        v1.put("workspaceCwd", "/runtime/workspace").put("version", 1);
        // Each refused document changes one thing in a document the fake
        // accepts.
        assertEquals(List.of(1, 2), List.of(readyVersion(v1),
                readyVersion(v2)));
        List<JsonNode> refused = new ArrayList<>();
        for (ObjectNode boot : List.of(v1, v2)) {
            refused.add(boot.deepCopy().put("extra", true));
            refused.add(boot.deepCopy().put("version",
                    3 - boot.get("version").asInt()));
            refused.add(boot.deepCopy().put("version",
                    boot.get("version").asText()));
            ObjectNode missing = boot.deepCopy();
            missing.remove(boot.get("version").asInt() == 1 ? "workspaceCwd"
                    : "mountRoot");
            refused.add(missing);
        }
        refused.add(v2.deepCopy().put("managedContext", "managed-context/2"));
        // Two keys joined by a comma must not pass for both.
        ObjectNode joined = v1.deepCopy();
        joined.remove(List.of("tenantId", "token"));
        refused.add(joined.put("tenantId,token", "fixture-token"));

        List<byte[]> inputs = new ArrayList<>();
        for (JsonNode document : refused) {
            inputs.add(JSON.writeValueAsBytes(document));
        }
        // Not JSON, and a parse error would quote the unquoted token.
        String token = "leak1";
        inputs.add(JSON.writeValueAsString(v2.deepCopy().put("token", token))
                .replace('"' + token + '"', token)
                .getBytes(StandardCharsets.UTF_8));
        for (byte[] input : inputs) {
            String label = new String(input, StandardCharsets.UTF_8);
            Process worker = start(input);
            try {
                assertTrue(worker.waitFor(30, TimeUnit.SECONDS), label);
                assertNotEquals(0, worker.exitValue(), label);
                assertEquals("", new String(
                        worker.getInputStream().readAllBytes(),
                        StandardCharsets.UTF_8), label);
                assertFalse(new String(worker.getErrorStream().readAllBytes(),
                        StandardCharsets.UTF_8).contains(token), label);
            } finally {
                worker.destroyForcibly().waitFor(10, TimeUnit.SECONDS);
            }
        }
    }

    /** The version of the fake's ready line for an accepted document. */
    private static int readyVersion(JsonNode boot) throws Exception {
        Process worker = start(JSON.writeValueAsBytes(boot));
        try {
            BufferedReader stdout = new BufferedReader(new InputStreamReader(
                    worker.getInputStream(), StandardCharsets.UTF_8));
            return JSON.readTree(stdout.readLine()).get("version").asInt();
        } finally {
            worker.destroyForcibly().waitFor(10, TimeUnit.SECONDS);
        }
    }

    private static Process start(byte[] boot) throws IOException {
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        Process worker = new ProcessBuilder("node", script.toString()).start();
        try (OutputStream stdin = worker.getOutputStream()) {
            stdin.write(boot);
        }
        return worker;
    }

    private static HttpResponse<String> post(URI origin, String path,
            JsonNode body) throws IOException, InterruptedException {
        return post(origin, path, JSON.writeValueAsBytes(body));
    }

    private static HttpResponse<String> post(URI origin, String path,
            byte[] body) throws IOException, InterruptedException {
        return HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(origin.resolve(path))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private static List<String> fieldNames(JsonNode node) {
        List<String> names = new ArrayList<>();
        node.fieldNames().forEachRemaining(names::add);
        names.sort(null);
        return names;
    }

    private static JsonNode fixtures() throws IOException {
        Path current = Path.of(System.getProperty("user.dir"))
                .toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            Path candidate = current.resolve(Path.of("packages", "cli", "src",
                    "serve", "contracts", "managed-context-v1.fixtures.json"));
            if (Files.isRegularFile(candidate)) {
                return JSON.readTree(candidate.toFile());
            }
            current = current.getParent();
        }
        throw new AssertionError("cannot locate the shared contract fixtures");
    }
}
