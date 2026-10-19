/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

// FG11c slice 2 (issue #14446): the Spring-side crash gates for the
// automation domains. The scanner and its lease live in Spring, so the
// control plane runs in its own JVM (HostedAutomationCrashFixtureMain) and
// the IT kills it with a POSIX signal mid-fire. This class starts with the
// fixture plumbing and the first crash window; the remaining windows land
// on top of the same lifecycle.
class HostedAutomationSpringCrashIT {
    private static final String MODEL = "fg11c2-model";
    private static final String TOKEN = "fg11-harness-token";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final Pattern LISTENING = Pattern.compile(
            "listening on http://127\\.0\\.0\\.1:(\\d+)");
    private final ObjectMapper json = new ObjectMapper();
    private final StringBuilder harnessLog = new StringBuilder();

    @TempDir
    private Path temporary;

    private HttpServer model;
    private int modelPort;
    private Process harness;
    private int harnessPort = -1;
    private int brokerPort = -1;
    private Process fixture;
    private JdbcTemplate jdbc;
    private String controlUrl;
    private String internalUrl;

    @AfterEach
    void tearDown() throws Exception {
        if (fixture != null) {
            fixture.destroyForcibly();
            fixture.waitFor(10, TimeUnit.SECONDS);
            fixture = null;
        }
        if (harness != null) {
            harness.descendants().forEach(child -> child.destroyForcibly());
            harness.destroyForcibly();
            harness = null;
        }
        if (model != null) {
            model.stop(0);
            model = null;
        }
    }

    @Test
    @Timeout(600)
    void fg11c2SpringFixtureBootsAndScansOnMySql() throws Exception {
        assertThat(System.getProperty("os.name"))
                .as("FG11c slice 2 sends POSIX signals")
                .doesNotContainIgnoringCase("windows");
        assertThat(System.getProperty("mysql.url"))
                .as("FG11c slice 2 requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user"))
                .as("FG11c slice 2 requires -Dmysql.user").isNotBlank();
        jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(
                new DriverManagerDataSource(required("mysql.url"),
                        required("mysql.user"),
                        System.getProperty("mysql.password", "")));
        jdbc.setQueryTimeout(10);
        temporary = temporary.toRealPath();
        String tenant = "hosted-automation-spring-" + UUID.randomUUID();
        startModel();
        harnessPort = freePort();
        brokerPort = freePort();
        Path root = Files.createDirectories(
                temporary.resolve("fixture"));
        startFixture(root, tenant);
        startHarness();
        // The control plane drives one scanner tick: with no definition
        // armed the tick must succeed and leave the ledger empty, which is
        // the baseline every crash case is measured against.
        control("scan", "");
        assertThat(occurrences(tenant)).as("no definition, no occurrence")
                .isZero();
        assertThat(fixture.isAlive()).as("fixture survived the tick").isTrue();
        assertThat(internalUrl).startsWith("http://127.0.0.1:");
    }

    private int occurrences(String tenant) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_schedule_occurrence"
                        + " WHERE tenant_id = ?", Integer.class, tenant);
        return count == null ? 0 : count;
    }

    private void control(String endpoint, String query) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(controlUrl
                + "/control/" + endpoint + (query.isEmpty() ? "" : "?"
                        + query))).timeout(Duration.ofSeconds(10)).POST(
                HttpRequest.BodyPublishers.noBody()).build();
        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(204);
    }

    private void startFixture(Path root, String tenant) throws Exception {
        Path log = root.resolve("fixture.log");
        ProcessBuilder builder = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", System.getProperty("java.class.path"),
                HostedAutomationCrashFixtureMain.class.getName(),
                root.toString(), required("node.executable"),
                cliEntry().toString(), tenant,
                String.valueOf(freePort()), String.valueOf(brokerPort));
        builder.environment().put("FG11C_MYSQL_URL", required("mysql.url"));
        builder.environment().put("FG11C_MYSQL_USER", required("mysql.user"));
        builder.environment().put("FG11C_MYSQL_PASSWORD",
                System.getProperty("mysql.password", ""));
        builder.environment().put("FG11C_HARNESS_URL",
                "http://127.0.0.1:" + harnessPort);
        fixture = builder.redirectErrorStream(true)
                .redirectOutput(log.toFile()).start();
        await("fixture ready", 90, () -> {
            if (!fixture.isAlive()) {
                return new IllegalStateException("fixture exited:\n"
                        + HostedChannelGateSupport.safeRead(log));
            }
            return Files.exists(root.resolve("ready.json")) ? true : null;
        });
        JsonNode ready = json.readTree(
                Files.readString(root.resolve("ready.json")));
        controlUrl = ready.path("controlUrl").asText();
        internalUrl = ready.path("internalUrl").asText();
    }

    private int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 0,
                java.net.InetAddress.getLoopbackAddress())) {
            return socket.getLocalPort();
        }
    }

    private void startModel() throws IOException {
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelPort = model.getAddress().getPort();
        model.createContext("/v1/chat/completions", this::respondToModel);
        model.start();
    }

    private void respondToModel(HttpExchange exchange) throws IOException {
        try {
            json.readTree(exchange.getRequestBody());
            ObjectNode chunk = json.createObjectNode();
            chunk.put("id", "fg11c2-fixture")
                    .put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", MODEL);
            ObjectNode choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "fg11c2-reply");
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
            byte[] body = (first + "data: " + json.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
        } finally {
            exchange.close();
        }
    }

    private void startHarness() throws Exception {
        Path cli = cliEntry();
        String node = required("node.executable");
        Path home = Files.createDirectories(temporary.resolve("harness-home"));
        Path config = Files.createDirectories(home.resolve(".qwen"));
        Path workspace = Files.createDirectories(
                temporary.resolve("harness-workspace"));
        String modelUrl = "http://127.0.0.1:" + modelPort + "/v1";
        Files.writeString(config.resolve("settings.json"),
                json.writeValueAsString(Map.of("security", Map.of("auth",
                        Map.of("selectedType", "openai")), "model",
                        Map.of("name", MODEL), "telemetry",
                        Map.of("enabled", false), "modelProviders",
                        Map.of("openai", List.of(Map.of("id", MODEL,
                                "envKey", "OPENAI_API_KEY", "baseUrl",
                                modelUrl))))));
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--port", String.valueOf(harnessPort), "--hostname",
                "127.0.0.1", "--require-auth", "--no-web", "--workspace",
                workspace.toString(), "--managed-runtime-broker-url",
                "http://127.0.0.1:" + brokerPort,
                "--managed-runtime-broker-token", "fg11-broker-token")
                .directory(workspace.toFile()).redirectErrorStream(true);
        Map<String, String> environment = builder.environment();
        environment.clear();
        for (String name : List.of("PATH", "SystemRoot", "WINDIR", "COMSPEC",
                "PATHEXT")) {
            if (System.getenv(name) != null) {
                environment.put(name, System.getenv(name));
            }
        }
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE",
                home.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", temporary.resolve("harness-runtime").toString(),
                "OPENAI_API_KEY", "fake-local-key", "OPENAI_BASE_URL", modelUrl,
                "OPENAI_MODEL", MODEL, "QWEN_MODEL", MODEL,
                "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        environment.put("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                temporary.resolve("system-settings.json").toString());
        environment.put("QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                temporary.resolve("system-defaults.json").toString());
        environment.put("QWEN_CODE_TRUSTED_FOLDERS_PATH",
                temporary.resolve("trusted-folders.json").toString());
        harness = builder.start();
        Thread.ofPlatform().daemon().start(() -> {
            try (var reader = harness.inputReader(StandardCharsets.UTF_8)) {
                char[] buffer = new char[2048];
                for (int count; (count = reader.read(buffer)) >= 0;) {
                    synchronized (harnessLog) {
                        harnessLog.append(buffer, 0, count);
                        if (harnessLog.length() > 32_768) {
                            harnessLog.delete(0, harnessLog.length() - 32_768);
                        }
                    }
                }
            } catch (IOException failure) {
                synchronized (harnessLog) {
                    harnessLog.append(failure);
                }
            }
        });
        await("harness listening", 90, () -> {
            if (!harness.isAlive()) {
                return new IllegalStateException("harness exited:\n"
                        + harnessLogSnapshot());
            }
            synchronized (harnessLog) {
                var match = LISTENING.matcher(harnessLog);
                if (!match.find()) {
                    return null;
                }
                if (Integer.parseInt(match.group(1)) != harnessPort) {
                    return new IllegalStateException("harness bound port "
                            + match.group(1) + " instead of the reserved "
                            + harnessPort + ":\n" + harnessLogSnapshot());
                }
                return true;
            }
        });
        await("harness ready", 30, () -> harnessReady() ? true : null);
    }

    private boolean harnessReady() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) URI.create("http://127.0.0.1:"
                    + harnessPort + "/capabilities").toURL().openConnection();
            connection.setRequestProperty("Authorization", "Bearer " + TOKEN);
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(1000);
            return connection.getResponseCode() == 200;
        } catch (IOException unavailable) {
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static Path cliEntry() {
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).as("Build and bundle the packaged CLI first")
                .isRegularFile();
        return cli;
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        assertThat(value).as("Pass -D" + name).isNotBlank();
        return value;
    }

    private void await(String description, int seconds,
            Supplier<Object> probe) throws Exception {
        Object outcome;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        Throwable lastFailure = null;
        while (System.nanoTime() < deadline) {
            try {
                outcome = probe.get();
            } catch (RuntimeException failure) {
                lastFailure = failure;
                outcome = null;
            }
            if (Boolean.TRUE.equals(outcome)) {
                return;
            }
            if (outcome instanceof IllegalStateException failure) {
                throw failure;
            }
            if (outcome instanceof Exception failure) {
                throw failure;
            }
            Thread.sleep(200);
        }
        String suffix = lastFailure == null ? ""
                : "\nlast probe failure: " + lastFailure;
        throw new AssertionError(description + " timed out; harness log:\n"
                + harnessLogSnapshot() + suffix, lastFailure);
    }

    private String harnessLogSnapshot() {
        synchronized (harnessLog) {
            return harnessLog.toString();
        }
    }
}
