package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

class HostedSideQueryProcessIT {
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final String MODEL = "same-explicit-model";
    private static final String TOKEN = "ephemeral-side-query-fixture-token";
    private final ObjectMapper json = new ObjectMapper();
    private final Map<String, Map<String, Object>> submissions = new ConcurrentHashMap<>();
    private final Map<String, JsonNode> results = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> attempts = new ConcurrentHashMap<>();
    private final List<String> staged = new CopyOnWriteArrayList<>();
    private final AtomicInteger brokerCalls = new AtomicInteger();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private final CountDownLatch releaseModel = new CountDownLatch(1);

    @Test
    @Timeout(60)
    void javaSdkRunsAndCancelsInstanceQueriesWithoutAttachingSessions() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).isRegularFile();
        Path temporary = Files.createTempDirectory(Path.of("/tmp"), "qwen-managed-side-query-process-");
        Path workspace = Files.createDirectory(temporary.resolve("workspace"));
        Path config = Files.createDirectory(temporary.resolve("config"));
        Files.writeString(config.resolve("settings.json"), "{\"telemetry\":{\"enabled\":false}}");
        Path isolation = temporary.resolve("isolated-home.mjs");
        Files.writeString(isolation, "import os from 'node:os';\n"
                + "import { syncBuiltinESMExports } from 'node:module';\n"
                + "os.homedir = () => " + json.writeValueAsString(temporary.toString()) + ";\n"
                + "syncBuiltinESMExports();\n");
        int harnessPort = HostedGateTestSupport.reservePort();
        HttpServer callback = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService callbackExecutor = Executors.newVirtualThreadPerTaskExecutor();
        callback.setExecutor(callbackExecutor);
        String callbackUrl = "http://127.0.0.1:" + callback.getAddress().getPort();
        callback.createContext("/", exchange -> handle(exchange, callbackUrl));
        callback.start();
        Path log = temporary.resolve("harness.log");
        Process process = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(System.getProperty("qwen.node", "node"),
                    "--import", isolation.toString(), cli.toString(), "serve", "--profile", "hosted-harness", "--http-bridge",
                    "--hosted-harness-capability-digest", DIGEST, "--hostname", "127.0.0.1",
                    "--port", Integer.toString(harnessPort), "--no-web", "--safe-mode", "--bare",
                    "--managed-runtime-broker-url", callbackUrl)
                    .directory(workspace.toFile()).redirectErrorStream(true).redirectOutput(log.toFile());
            Map<String, String> environment = builder.environment();
            environment.clear();
            for (String name : List.of("PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")) {
                if (System.getenv(name) != null) {
                    environment.put(name, System.getenv(name));
                }
            }
            environment.put("QWEN_HOME", config.toString());
            environment.put("QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString());
            environment.put("QWEN_SERVER_TOKEN", TOKEN);
            environment.put("QWEN_MANAGED_RUNTIME_BROKER_TOKEN", "ephemeral-broker-token");
            environment.put("QWEN_HOSTED_HARNESS_INSTANCE_ID", "side-query-process-fixture");
            environment.put("QWEN_CODE_SYSTEM_SETTINGS_PATH", temporary.resolve("system.json").toString());
            environment.put("QWEN_CODE_SYSTEM_DEFAULTS_PATH", temporary.resolve("defaults.json").toString());
            environment.put("QWEN_CODE_TRUSTED_FOLDERS_PATH", temporary.resolve("trust.json").toString());
            environment.put("TMPDIR", temporary.toString());
            process = builder.start();
            Process child = process;
            String harnessUrl = "http://127.0.0.1:" + harnessPort;
            await(() -> {
                assertThat(child.isAlive()).as("Hosted process output: %s", read(log)).isTrue();
                try (var client = client(harnessUrl)) {
                    return client.capabilities().getFeatures().contains("side-query/1");
                } catch (RuntimeException starting) {
                    return false;
                }
            });
            try (var client = client(harnessUrl)) {
                Map<String, Object> claim = Map.of("instanceId", "side-query-process-fixture",
                        "bootId", client.capabilities().getBootId(), "generation", 1, "token", TOKEN);
                assertCold(client);
                for (String query : List.of("a", "b")) {
                    Map<String, Object> body = submission(query, claim, callbackUrl);
                    assertThat(client.submitSideQuery(body).get("queryId")).isEqualTo(query);
                    await(() -> results.containsKey(query));
                    assertThat(results.get(query).path("status").asText()).isEqualTo("completed");
                    assertThat(results.get(query).path("text").asText()).isEqualTo("answer-" + query);
                    assertThat(client.submitSideQuery(body).get("queryId")).isEqualTo(query);
                    await(() -> Boolean.FALSE.equals(client.readSideQuery(query, claim).get("active")));
                    assertThat(attempts.get(query).get()).isEqualTo(1);
                }
                client.submitSideQuery(submission("failure", claim, callbackUrl));
                await(() -> results.containsKey("failure"));
                assertThat(results.get("failure").path("status").asText()).isEqualTo("failed");
                await(() -> Boolean.FALSE.equals(client.readSideQuery("failure", claim).get("active")));
                assertThat(attempts.get("failure").get()).isEqualTo(1);

                Map<String, Object> cancellation = submission("cancel", claim, callbackUrl);
                client.submitSideQuery(cancellation);
                await(() -> results.containsKey("cancel")
                        && results.get("cancel").path("status").asText().equals("running")
                        && results.get("cancel").path("text").asText().equals("answer-cancel"));
                assertThat(client.readSideQuery("cancel", claim).get("active")).isEqualTo(true);
                assertThat(client.submitSideQuery(cancellation).get("active")).isEqualTo(true);
                assertThat(attempts.get("cancel").get()).isEqualTo(1);
                assertCold(client);
                assertThat(client.cancelSideQuery("cancel", claim).get("queryId")).isEqualTo("cancel");
                await(() -> results.containsKey("cancel")
                        && results.get("cancel").path("status").asText().equals("interrupted"));
                assertThat(results.get("cancel").path("text").asText()).isEqualTo("answer-cancel");
                await(() -> Boolean.FALSE.equals(client.readSideQuery("cancel", claim).get("active")));
                assertThat(attempts.get("cancel").get()).isEqualTo(1);
                releaseModel.countDown();
                assertCold(client);
                assertThat(brokerCalls.get()).isZero();
                assertThat(staged).containsExactlyInAnyOrder("a", "b", "failure", "cancel");
                assertThat(failure.get()).isNull();
                System.out.println("SIDE_QUERY_PROCESS_EVIDENCE capability=side-query/1"
                        + " sdkSubmitStatusCancel=true sameModelSeparateEndpoints=true"
                        + " modelAttemptsPerQuery=1 failureRetries=0 attachedSessions=0 brokerCalls=0");
            }
        } finally {
            releaseModel.countDown();
            if (process != null) {
                process.destroy();
                if (!process.waitFor(5, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    assertThat(process.waitFor(3, TimeUnit.SECONDS)).isTrue();
                }
            }
            callback.stop(0);
            callbackExecutor.shutdownNow();
        }
    }

    private HostedHarnessClient client(String baseUrl) {
        return HostedHarnessClient.builder().baseUri(URI.create(baseUrl)).bearerToken(TOKEN)
                .capabilityDigest(DIGEST).requestTimeout(Duration.ofSeconds(2))
                .connectTimeout(Duration.ofSeconds(1)).heartbeatInterval(Duration.ZERO).build();
    }

    private Map<String, Object> submission(String query, Map<String, Object> claim, String callbackUrl) {
        Map<String, Object> body = Map.of("queryId", query, "sessionId", "cold-session-" + query,
                "claim", claim, "modelConfigDigest", "sha256:" + DigestUtils.sha256Hex(query),
                "deadlineAt", System.currentTimeMillis() + 30_000,
                "store", Map.of("baseUrl", callbackUrl + "/sessions/cold-session-" + query + "/side-queries/" + query,
                        "token", TOKEN, "tenantId", "tenant"));
        submissions.put(query, body);
        return body;
    }

    private void handle(HttpExchange exchange, String callbackUrl) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            if (!path.startsWith("/sessions/") && !path.startsWith("/model-")) {
                brokerCalls.incrementAndGet();
                respond(exchange, 500, Map.of("error", "Runtime must not be used"));
                return;
            }
            JsonNode request = json.readTree(exchange.getRequestBody());
            if (path.startsWith("/model-")) {
                model(exchange, path.split("/")[1].substring("model-".length()), request);
                return;
            }
            String[] segments = path.split("/");
            String query = segments[4];
            String operation = segments[segments.length - 1];
            Map<String, Object> submission = submissions.get(query);
            assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer " + TOKEN);
            assertThat(exchange.getRequestHeaders().getFirst("X-Qwen-Tenant-Id")).isEqualTo("tenant");
            assertThat(exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Max-Readable-Storage-Version"))
                    .isEqualTo("4");
            assertThat(request.path("claim")).isEqualTo(json.valueToTree(submission.get("claim")));
            Object result = switch (operation) {
                case "input" -> Map.ofEntries(Map.entry("queryId", query),
                        Map.entry("sessionId", "cold-session-" + query), Map.entry("tenantId", "tenant"),
                        Map.entry("workspaceId", "workspace"), Map.entry("kind", "btw"),
                        Map.entry("question", "question-" + query), Map.entry("privateHistory", List.of()),
                        Map.entry("processingVersion", "side-query/1"),
                        Map.entry("modelConfigDigest", submission.get("modelConfigDigest")),
                        Map.entry("deadlineAt", submission.get("deadlineAt")),
                        Map.entry("source", json.readTree("{\"journalRevision\":0,\"committedSequence\":0,"
                                + "\"lastCommitDigest\":null,\"completedTurnSequence\":0}")));
                case "model-config" -> Map.of("digest", submission.get("modelConfigDigest"), "config", Map.of("protocol", "openai",
                        "model", MODEL, "base_url", callbackUrl + "/model-" + query + "/v1",
                        "api_key", "fixture-key-" + query, "generation_config", Map.of("max_tokens", 100)));
                case "stage" -> {
                    assertThat(request.path("resource").path("kind").asText()).isEqualTo("managed-side-query-input");
                    staged.add(query);
                    yield Map.of();
                }
                case "input-ready" -> Map.of();
                case "running" -> Map.of("started", true);
                case "heartbeat" -> Map.of("active", true);
                case "result" -> {
                    results.put(query, request.path("update"));
                    yield Map.of();
                }
                default -> throw new AssertionError("Unexpected callback: " + operation);
            };
            respond(exchange, 200, result);
        } catch (Throwable error) {
            failure.compareAndSet(null, error);
            respond(exchange, 500, Map.of("error", error.getClass().getSimpleName()));
        } finally {
            exchange.close();
        }
    }

    private void model(HttpExchange exchange, String query, JsonNode request) throws Exception {
        attempts.computeIfAbsent(query, ignored -> new AtomicInteger()).incrementAndGet();
        assertThat(exchange.getRequestURI().getPath()).isEqualTo("/model-" + query + "/v1/chat/completions");
        assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer fixture-key-" + query);
        assertThat(request.path("model").asText()).isEqualTo(MODEL);
        assertThat(request.path("messages").toString()).contains("question-" + query);
        for (String other : List.of("a", "b", "failure", "cancel")) {
            if (!other.equals(query)) {
                assertThat(request.path("messages").toString()).doesNotContain("question-" + other + "\"");
            }
        }
        assertThat(request.has("tools")).isFalse();
        if (query.equals("failure")) {
            respond(exchange, 503, Map.of("error", Map.of("message", "deterministic fixture failure")));
            return;
        }
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        String chunk = "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                + "\"model\":\"" + MODEL + "\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\","
                + "\"content\":\"answer-" + query + "\"},\"finish_reason\":null}]}\n\n";
        exchange.getResponseBody().write(chunk.getBytes(StandardCharsets.UTF_8));
        exchange.getResponseBody().flush();
        if (query.equals("cancel")) {
            assertThat(releaseModel.await(30, TimeUnit.SECONDS)).isTrue();
            return;
        }
        String done = "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                + "\"model\":\"" + MODEL + "\",\"choices\":[{\"index\":0,\"delta\":{},"
                + "\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        exchange.getResponseBody().write(done.getBytes(StandardCharsets.UTF_8));
    }

    private void respond(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = json.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    private static void assertCold(HostedHarnessClient client) {
        Map<?, ?> counters = (Map<?, ?>) client.readInstance().get("counters");
        for (String name : List.of("attachedSessions", "activeTurns", "openingSessions", "heldResources")) {
            assertThat(((Number) counters.get(name)).intValue()).as(name).isZero();
        }
    }

    private static void await(BooleanSupplier predicate) throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        while (!predicate.getAsBoolean()) {
            assertThat(System.nanoTime()).as("Timed out awaiting Hosted side-query state").isLessThan(deadline);
            Thread.sleep(25);
        }
    }

    private static String read(Path path) {
        try {
            return Files.readString(path);
        } catch (IOException notReady) {
            return "No Hosted output yet";
        }
    }
}
