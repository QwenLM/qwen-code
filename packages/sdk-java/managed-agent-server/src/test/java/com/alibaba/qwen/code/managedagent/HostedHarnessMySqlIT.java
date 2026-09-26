package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonEvent;
import com.alibaba.qwen.code.daemon.GetHarnessTranscript;
import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.daemon.ManagedSessionStoreConnection;
import com.alibaba.qwen.code.daemon.PromptReceipt;
import com.alibaba.qwen.code.daemon.StreamHarnessEvents;
import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

@Disabled("This branch's Hosted Harness requires a Runtime Broker; this"
        + " gate covers main's no-Broker, no-tool profile, which the"
        + " branch does not wire. Hosted flows run in"
        + " run-managed-hosted-runtime-e2e.ts.")
class HostedHarnessMySqlIT {
    private static final String MODEL = "hosted-mysql-fixture";
    private static final String TOKEN = "hosted-mysql-private-token";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final Pattern LISTENING = Pattern.compile(
            "listening on http://127\\.0\\.0\\.1:(\\d+)");
    private final ObjectMapper json = new ObjectMapper();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    private final CountDownLatch cancellationRequested = new CountDownLatch(1);
    private final CountDownLatch releaseCancellation = new CountDownLatch(1);
    private final StringBuilder output = new StringBuilder();
    private final String tenant = "hosted-mysql-" + UUID.randomUUID();
    private final String sessionId = UUID.randomUUID().toString();
    private final ScheduledExecutorService watchdog =
            Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService modelExecutor =
            Executors.newCachedThreadPool();

    @TempDir
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private HttpServer model;
    private Process child;
    private Thread outputReader;
    private JdbcTemplate jdbc;
    private int harnessPort;
    private int springPort;
    private int modelPort;

    @Test
    @Timeout(120)
    void javaClientUsesPackagedHarnessAndSpringStoreOnMySql() throws Exception {
        Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the packaged CLI first").isRegularFile();
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", ""));
        Properties timeouts = new Properties();
        timeouts.setProperty("connectTimeout", "5000");
        timeouts.setProperty("socketTimeout", "10000");
        dataSource.setConnectionProperties(timeouts);
        jdbc = new JdbcTemplate(dataSource);
        jdbc.setQueryTimeout(10);
        Map<String, Object> database = jdbc.queryForMap(
                "SELECT VERSION() AS version, @@version_comment AS engine");
        System.out.println("HOSTED_MYSQL_DATABASE " + json.writeValueAsString(database));
        assertThat(database.get("version").toString()).doesNotContainIgnoringCase("mariadb");
        assertThat(database.get("engine").toString()).containsIgnoringCase("mysql");

        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + required("mysql.url"),
                "--spring.datasource.username=" + required("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.hikari.maximum-pool-size=3",
                "--spring.datasource.hikari.connection-timeout=5000",
                "--spring.datasource.hikari.data-source-properties.connectTimeout=5000",
                "--spring.datasource.hikari.data-source-properties.socketTimeout=10000",
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.runtime-broker.enabled=false");
        springPort = spring.getWebServer().getPort();
        startModel();
        startHarness(cli);

        try (HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(URI.create("http://127.0.0.1:" + harnessPort))
                .bearerToken(TOKEN).capabilityDigest(DIGEST)
                .connectTimeout(Duration.ofSeconds(3))
                .requestTimeout(Duration.ofSeconds(10))
                .heartbeatInterval(Duration.ZERO).build()) {
            ManagedSessionStoreConnection store = ManagedSessionStoreConnection.builder()
                    .baseUri(URI.create("http://127.0.0.1:" + springPort))
                    .tenantId(tenant).workspaceId("hosted-mysql-workspace")
                    .writerId(client.capabilities().getBootId()).build();
            HarnessSessionRef session = client.createSession(CreateHarnessSession.builder()
                    .harnessSessionId(sessionId).managedSessionStore(store).build());
            assertThat(session.getHarnessSessionId()).isEqualTo(sessionId);
            assertWriter("ACTIVE", 1);
            SubmitHarnessTurn first = prompt(session, "MYSQL_FIRST");
            PromptReceipt receipt = client.submitTurn(first);
            List<JsonNode> events = awaitTurn(client, session, receipt);
            assertCompleted(events, "MYSQL_REPLY_1");
            assertThat(modelRequests.size()).isEqualTo(1);

            PromptReceipt replay = client.submitTurn(first);
            assertThat(replay.getPromptId()).isEqualTo(receipt.getPromptId());
            assertThat(replay.getLastEventId()).isEqualTo(receipt.getLastEventId());
            assertThat(replay.getEventEpoch()).isEqualTo(receipt.getEventEpoch());
            assertThat(awaitTurn(client, session, replay)).isEqualTo(events);
            assertThat(readEvents(client, session, events.getFirst().path("id").asLong(),
                    receipt.getEventEpoch(), events.size() - 1))
                    .isEqualTo(events.subList(1, events.size()));
            assertThat(modelRequests.size()).isEqualTo(1);

            client.closeSession(session);
            assertWriter("SEALED", 1);
            HarnessSessionRef loaded = client.loadSession(new LoadHarnessSession(sessionId, store));
            assertThat(loaded.getHarnessClientId()).isNotEqualTo(session.getHarnessClientId());
            assertWriter("ACTIVE", 2);
            assertTranscriptPrefix(events, transcript(client, loaded, receipt.getLastEventId()));

            PromptReceipt cancelled = client.submitTurn(prompt(loaded, "MYSQL_CANCEL"));
            assertThat(cancellationRequested.await(15, TimeUnit.SECONDS))
                    .as("The cancellation must reach the actual model request").isTrue();
            client.cancelTurn(loaded);
            await(() -> !client.getStatus(loaded).hasActivePrompt(), 5, "Explicit cancellation");
            List<JsonNode> cancelledEvents = awaitTurn(client, loaded, cancelled);
            JsonNode cancellation = terminal(cancelledEvents);
            assertThat(cancellation.path("type").asText()).isEqualTo("turn_complete");
            assertThat(cancellation.path("data").path("stopReason").asText())
                    .isEqualTo("cancelled");
            assertThat(cancelledEvents).noneMatch(event ->
                    "session_update".equals(event.path("type").asText()));
            releaseCancellation.countDown();

            assertCompleted(awaitTurn(client, loaded,
                    client.submitTurn(prompt(loaded, "MYSQL_AFTER_CANCEL"))), "MYSQL_REPLY_3");
            assertCompleted(awaitTurn(client, loaded,
                    client.submitTurn(prompt(loaded, "MYSQL_NEXT"))), "MYSQL_REPLY_4");
            assertThat(modelRequests.size()).isEqualTo(4);
            assertHistory(2, "MYSQL_FIRST", "MYSQL_REPLY_1", "MYSQL_AFTER_CANCEL");
            assertHistory(3, "MYSQL_FIRST", "MYSQL_REPLY_1", "MYSQL_AFTER_CANCEL",
                    "MYSQL_REPLY_3", "MYSQL_NEXT");
            for (JsonNode request : modelRequests) {
                assertThat(request.path("model").asText()).isEqualTo(MODEL);
                assertThat(request.path("tools").isMissingNode()
                        || request.path("tools").isArray() && request.path("tools").isEmpty()).isTrue();
            }
            List<JsonNode> committed = transcript(client, loaded, 0);
            client.detachSession(loaded);
            assertWriter("SEALED", 2);
            HarnessSessionRef reattached = client.loadSession(new LoadHarnessSession(sessionId, store));
            assertWriter("ACTIVE", 3);
            assertTranscriptPrefix(committed, transcript(client, reattached, 0));
            client.closeSession(reattached);
            assertWriter("SEALED", 3);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx"
                    + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, sessionId))
                    .isGreaterThan(4);
            assertThat(modelFailure.get()).isNull();
        } catch (Exception | AssertionError failure) {
            System.err.println("HOSTED_MYSQL_HARNESS_LOG\n" + logs());
            throw failure;
        }
    }

    private void startModel() throws IOException {
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelPort = model.getAddress().getPort();
        model.setExecutor(modelExecutor);
        model.createContext("/v1/chat/completions", this::respondToModel);
        model.start();
    }

    private void respondToModel(HttpExchange exchange) throws IOException {
        try {
            JsonNode request = json.readTree(exchange.getRequestBody());
            modelRequests.add(request);
            if (request.path("messages").toString().contains("MYSQL_CANCEL")) {
                cancellationRequested.countDown();
                assertThat(releaseCancellation.await(30, TimeUnit.SECONDS)).isTrue();
                return;
            }
            ObjectNode chunk = json.createObjectNode();
            chunk.put("id", "mysql-fixture").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", MODEL);
            ObjectNode choice = chunk.putArray("choices").addObject().put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "MYSQL_REPLY_" + modelRequests.size());
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
            byte[] body = (first + "data: " + json.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
        } catch (Exception | AssertionError failure) {
            modelFailure.compareAndSet(null, failure);
        } finally {
            exchange.close();
        }
    }

    private void startHarness(Path cli) throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home"));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        Path workspace = Files.createDirectory(temporary.resolve("workspace"));
        String modelUrl = "http://127.0.0.1:" + modelPort + "/v1";
        Files.writeString(config.resolve("settings.json"), json.writeValueAsString(Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")),
                "model", Map.of("name", MODEL), "telemetry", Map.of("enabled", false),
                "modelProviders", Map.of("openai", List.of(Map.of("id", MODEL,
                        "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl))))));
        ProcessBuilder builder = new ProcessBuilder(System.getProperty("qwen.node", "node"),
                cli.toString(), "serve", "--profile", "hosted-harness", "--http-bridge",
                "--port", "0", "--hostname", "127.0.0.1", "--require-auth", "--no-web",
                "--workspace", workspace.toString()).directory(workspace.toFile())
                .redirectErrorStream(true);
        Map<String, String> environment = builder.environment();
        environment.clear();
        for (String name : List.of("PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")) {
            if (System.getenv(name) != null) {
                environment.put(name, System.getenv(name));
            }
        }
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE", home.toString(),
                "QWEN_HOME", config.toString(), "QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString(),
                "OPENAI_API_KEY", "fake-local-key", "OPENAI_BASE_URL", modelUrl,
                "OPENAI_MODEL", MODEL, "QWEN_MODEL", MODEL,
                "QWEN_SERVER_TOKEN", TOKEN, "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        environment.put("QWEN_CODE_SYSTEM_SETTINGS_PATH", temporary.resolve("system-settings.json").toString());
        environment.put("QWEN_CODE_SYSTEM_DEFAULTS_PATH", temporary.resolve("system-defaults.json").toString());
        environment.put("QWEN_CODE_TRUSTED_FOLDERS_PATH", temporary.resolve("trusted-folders.json").toString());
        child = builder.start();
        watchdog.schedule(this::killChild, 100, TimeUnit.SECONDS);
        outputReader = Thread.ofPlatform().daemon().start(() -> {
            try (var reader = child.inputReader(StandardCharsets.UTF_8)) {
                char[] buffer = new char[2048];
                for (int count; (count = reader.read(buffer)) >= 0;) {
                    synchronized (output) {
                        output.append(buffer, 0, count);
                        if (output.length() > 16_384) {
                            output.delete(0, output.length() - 16_384);
                        }
                    }
                }
            } catch (IOException failure) {
                synchronized (output) {
                    output.append(failure);
                }
            }
        });
        await(() -> {
            assertThat(child.isAlive()).as("Hosted Harness exited:\n%s", logs()).isTrue();
            var match = LISTENING.matcher(logs());
            if (!match.find()) {
                return false;
            }
            harnessPort = Integer.parseInt(match.group(1));
            return true;
        }, 30, "Hosted Harness startup");
        await(this::harnessReady, 15, "Hosted Harness readiness");
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

    private SubmitHarnessTurn prompt(HarnessSessionRef session, String text) {
        List<Map<String, Object>> content = List.of(Map.of("type", "text", "text", text));
        return SubmitHarnessTurn.builder().session(session).promptId(UUID.randomUUID().toString())
                .payloadDigest(SubmitHarnessTurn.computePayloadDigest(content))
                .addContent(content.getFirst()).build();
    }

    private List<JsonNode> awaitTurn(HostedHarnessClient client, HarnessSessionRef session,
            PromptReceipt receipt) throws Exception {
        await(() -> !client.getStatus(session).hasActivePrompt(), 30, "Hosted turn settlement");
        List<JsonNode> committed = transcript(client, session, receipt.getLastEventId());
        assertThat(committed).isNotEmpty();
        assertThat(terminal(committed).path("promptId").asText()).isEqualTo(receipt.getPromptId());
        for (JsonNode event : committed) {
            assertThat(event.path("data").path("sessionId").asText()).isEqualTo(sessionId);
            if (event.has("promptId")) {
                assertThat(event.path("promptId").asText()).isEqualTo(receipt.getPromptId());
            }
        }
        List<JsonNode> streamed = readEvents(client, session, receipt.getLastEventId(),
                receipt.getEventEpoch(), committed.size());
        assertThat(streamed).isEqualTo(committed);
        return streamed;
    }

    private List<JsonNode> transcript(HostedHarnessClient client, HarnessSessionRef session,
            long after) {
        var page = client.getTranscript(GetHarnessTranscript.builder().session(session)
                .cursor(Long.toString(after)).limit(256).build());
        assertThat(page.hasMore()).isFalse();
        return page.getEvents().stream().map(value -> (JsonNode) json.valueToTree(value)).toList();
    }

    private List<JsonNode> readEvents(HostedHarnessClient client, HarnessSessionRef session,
            long after, String epoch, int count) throws IOException {
        // Stream.close cannot interrupt the client's synchronized blocking read.
        var deadline = watchdog.schedule(this::killChild, 10, TimeUnit.SECONDS);
        try (HarnessEventStream stream = client.streamEvents(StreamHarnessEvents.builder()
                .session(session).lastEventId(after).eventEpoch(epoch).build())) {
            List<JsonNode> result = new ArrayList<>();
            for (int i = 0; i < count; i++) {
                DaemonEvent event = stream.next();
                assertThat(event).isNotNull();
                ObjectNode envelope = json.createObjectNode().put("v", event.getVersion())
                        .put("id", event.getId()).put("type", event.getType());
                envelope.set("data", json.valueToTree(event.getData()));
                if (event.getPromptId() != null) {
                    envelope.put("promptId", event.getPromptId());
                }
                result.add(json.readTree(envelope.toString()));
            }
            return result;
        } finally {
            deadline.cancel(false);
        }
    }

    private void assertCompleted(List<JsonNode> events, String text) {
        JsonNode completed = terminal(events);
        assertThat(completed.path("type").asText()).isEqualTo("turn_complete");
        assertThat(completed.path("data").path("stopReason").asText()).isEqualTo("end_turn");
        assertThat(events.stream().filter(event -> "session_update".equals(event.path("type").asText()))
                .map(event -> event.path("data").path("update").path("content").path("text").asText()))
                .containsExactly(text);
        assertThat(events.stream().filter(event -> "session_update".equals(event.path("type").asText()))
                .mapToLong(event -> event.path("id").asLong()).max().orElseThrow())
                .isLessThan(completed.path("id").asLong());
    }

    private void assertHistory(int index, String... retained) {
        String history = modelRequests.get(index).path("messages").toString();
        for (String text : retained) {
            assertThat(history.contains(text))
                    .as("Model request %s after cancellation must retain %s", index + 1, text).isTrue();
        }
        assertThat(history.contains("MYSQL_CANCEL"))
                .as("Model request %s must not replay the cancelled prompt", index + 1).isFalse();
    }

    private JsonNode terminal(List<JsonNode> events) {
        List<JsonNode> terminals = events.stream().filter(event ->
                "turn_complete".equals(event.path("type").asText())
                        || "turn_error".equals(event.path("type").asText())).toList();
        assertThat(terminals).hasSize(1);
        return terminals.getFirst();
    }

    private void assertTranscriptPrefix(List<JsonNode> before, List<JsonNode> after) {
        assertThat(after).startsWith(before.toArray(JsonNode[]::new));
        for (int index = before.size(); index < after.size(); index++) {
            JsonNode event = after.get(index);
            assertThat(event.path("type").asText()).isEqualTo("managed_journal_event");
            assertThat(event.path("promptId").isMissingNode()).isTrue();
            assertThat(event.path("data")).isEqualTo(json.valueToTree(Map.of("sessionId", sessionId)));
            assertThat(event.path("id").asLong()).isEqualTo(after.get(index - 1).path("id").asLong() + 1);
        }
    }

    private void assertWriter(String state, long generation) {
        Map<String, Object> head = jdbc.queryForMap("SELECT state, writer_generation"
                + " FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?",
                tenant, sessionId);
        assertThat(head.get("state")).isEqualTo(state);
        assertThat(((Number) head.get("writer_generation")).longValue()).isEqualTo(generation);
    }

    private void await(BooleanSupplier predicate, int seconds, String label) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (System.nanoTime() < deadline) {
            if (predicate.getAsBoolean()) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError(label + " timed out\n" + logs());
    }

    private String logs() {
        synchronized (output) {
            return output.toString();
        }
    }

    private void killChild() {
        child.descendants().forEach(ProcessHandle::destroyForcibly);
        child.destroyForcibly();
    }

    @AfterEach
    void cleanup() throws Exception {
        releaseCancellation.countDown();
        watchdog.shutdownNow();
        try {
            if (child != null) {
                child.descendants().forEach(ProcessHandle::destroyForcibly);
                child.destroy();
                if (!child.waitFor(5, TimeUnit.SECONDS)) {
                    child.destroyForcibly();
                }
                assertThat(child.waitFor(5, TimeUnit.SECONDS)).as("Hosted child must exit").isTrue();
            }
        } finally {
            try {
                if (model != null) {
                    model.stop(0);
                }
            } finally {
                modelExecutor.shutdownNow();
                if (spring != null) {
                    spring.close();
                }
                if (outputReader != null) {
                    outputReader.join(1000);
                }
            }
        }
        for (int port : List.of(harnessPort, modelPort, springPort)) {
            if (port != 0) {
                try (ServerSocket socket = new ServerSocket()) {
                    socket.setReuseAddress(true);
                    socket.bind(new InetSocketAddress("127.0.0.1", port));
                }
            }
        }
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Required integration prerequisite: -D" + name);
        }
        return value;
    }
}
