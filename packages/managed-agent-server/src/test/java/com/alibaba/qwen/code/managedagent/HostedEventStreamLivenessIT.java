package com.alibaba.qwen.code.managedagent;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.store.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.management.HotSpotDiagnosticMXBean;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.management.ManagementFactory;
import java.net.HttpURLConnection;
import java.net.InetAddress;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Hosted event-stream liveness on the packaged chain (#14135): Spring on
 * MySQL, the packaged Hosted Harness, and a TCP relay between them that
 * can hold the events connection half-open or stall it. The numbers are
 * the shipped ones: a 15 s Harness keepalive against the client's 45 s
 * idle bound, checked every 4.5 s. Each case owns its database: a Turn a
 * case leaves waiting on a retry must not be dispatched by a later
 * class's Spring, nor theirs by this one.
 */
class HostedEventStreamLivenessIT {
    private static final String MODEL = "hosted-liveness-fixture";
    private static final String TOKEN = "hosted-liveness-private-token";
    private static final String DIGEST = "sha256:" + "b".repeat(64);
    private static final Pattern LISTENING = Pattern.compile(
            "listening on http://127\\.0\\.0\\.1:(\\d+)");
    private static final long KEEPALIVE_MILLIS = 15_000;
    private static final long IDLE_BOUND_MILLIS = 45_000;
    // The watchdog's tick: an abort lands at most this far past the bound.
    private static final long TICK_MILLIS = IDLE_BOUND_MILLIS / 10;
    // Scheduling slack on a loaded runner, on top of the tick.
    private static final long SLACK_MILLIS = 3_000;
    // Longer than the bound, inside the Harness's 120 s first-response wait.
    private static final long QUIET_MILLIS = IDLE_BOUND_MILLIS + 10_000;
    private static final String IDLE_RETRY =
            "failure=HostedHarnessStreamIdleException";

    private final ObjectMapper json = new ObjectMapper();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure =
            new AtomicReference<>();
    private final CountDownLatch modelHeld = new CountDownLatch(1);
    private final CountDownLatch releaseModel = new CountDownLatch(1);
    private final StringBuilder output = new StringBuilder();
    private final String tenant = "hosted-liveness-" + UUID.randomUUID();
    private final ExecutorService modelExecutor =
            Executors.newCachedThreadPool();
    private final ListAppender<ILoggingEvent> coordinatorLog =
            new ListAppender<>();

    @TempDir
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private HttpServer model;
    private Process harness;
    private Thread outputReader;
    private HostedEventStreamRelay relay;
    private IsolatedManagedSchemaMySqlTestDatabase database;
    private JdbcTemplate jdbc;
    private int harnessPort;
    private int springPort;
    private int modelPort;

    // Probe 1: a Turn with no events for longer than the bound keeps its
    // stream, because the keepalives keep arriving.
    @Test
    @Timeout(240)
    void aQuietTurnOutlivesTheIdleBound() throws Exception {
        start();
        String id = createSession("LIVENESS_QUIET");
        awaitTurnCompleted(id, QUIET_MILLIS / 1000 + 60);

        assertThat(idleRetries()).as("idle retries").isEmpty();
        assertThat(turn(id).get("retry_count")).isEqualTo(0);
        assertThat(relay.eventStreams()).isEqualTo(1);
        List<Long> gaps = keepaliveGapsMillis();
        System.out.println("HOSTED_LIVENESS_KEEPALIVE_GAPS_MS " + gaps);
        // The quiet phase spans the bound, so several keepalives crossed
        // the relay, each well inside the bound.
        assertThat(gaps).hasSizeGreaterThanOrEqualTo(2);
        assertThat(gaps).allSatisfy(gap -> assertThat(gap)
                .isLessThan(KEEPALIVE_MILLIS + SLACK_MILLIS));
        assertThat(modelRequests).hasSize(1);
        assertThat(modelFailure.get()).isNull();
    }

    // Probe 2: the Harness is SIGKILLed behind a relay that keeps the
    // Spring side open, with no restart and no other call. The Turn's
    // reader ends with the typed outcome within the bound plus one tick,
    // and the Turn goes to a retry instead of hanging.
    @Test
    @Timeout(240)
    void aKilledHarnessBehindAHalfOpenStreamEndsTheReadWithinTheBound()
            throws Exception {
        start();
        String id = createSession("LIVENESS_HOLD");
        awaitStreamLive();
        // The release check below proves something only if it sees the
        // reader while it is parked.
        await(() -> parkedReaders().size() == 1, 10, "parked reader");
        relay.holdOnUpstreamDeath();
        long killed = System.nanoTime();
        harness.descendants().forEach(ProcessHandle::destroyForcibly);
        harness.destroyForcibly();
        assertThat(harness.waitFor(20, TimeUnit.SECONDS)).isTrue();

        await(() -> !idleRetries().isEmpty(),
                (IDLE_BOUND_MILLIS + TICK_MILLIS + SLACK_MILLIS) / 1000 + 10,
                "idle retry");
        long detected = System.nanoTime();
        long silence = TimeUnit.NANOSECONDS.toMillis(
                detected - relay.lastEventStreamByte());
        long sinceKill = TimeUnit.NANOSECONDS.toMillis(detected - killed);
        System.out.println("HOSTED_LIVENESS_HALF_OPEN silenceMs=" + silence
                + " sinceKillMs=" + sinceKill);
        assertThat(silence).isBetween(IDLE_BOUND_MILLIS - 200,
                IDLE_BOUND_MILLIS + TICK_MILLIS + SLACK_MILLIS);
        assertThat(idleRetries().getFirst()).contains("turn=");
        assertThat(((Number) turn(id).get("retry_count")).intValue())
                .isGreaterThanOrEqualTo(1);
        // The original finding: Turn readers stayed parked in
        // HarnessEventStream.next on the half-open stream.
        await(() -> parkedReaders().isEmpty(), 10, "reader release");
    }

    // Probe 4: a Turn cancel while the reader is parked on a quiet stream
    // still settles through the original cancel command.
    @Test
    @Timeout(180)
    void aCancelDuringAQuietReadSettlesThroughTheCancelCommand()
            throws Exception {
        start();
        String id = createSession("LIVENESS_HOLD");
        awaitStreamLive();
        String turnId = api("GET", "/v1/agents/sessions/" + id + "/turns",
                null, null, 200).path("data").get(0).path("id").asText();
        api("POST", "/v1/agents/sessions/" + id + "/events", "cancel-" + turnId,
                "{\"type\":\"agent.session.cancel\",\"turn_id\":\"" + turnId
                        + "\"}", 202);
        await(() -> api("GET", "/v1/agents/sessions/" + id + "/events", null,
                null, 200).path("data").toString()
                .contains("\"turn.cancelled\""), 60, "Turn cancellation");

        assertThat(idleRetries()).as("idle retries").isEmpty();
        assertThat(turn(id).get("status")).isEqualTo("CANCELLED");
        assertThat(modelRequests).hasSize(1);
    }

    // Probe 5: the Harness stays alive but its stream stops reaching
    // Spring. After the idle timeout the Turn re-attaches, and the record
    // decides: the model runs once and the Turn completes once.
    @Test
    @Timeout(240)
    void aStalledStreamReattachesWithoutReplayingTheTurn() throws Exception {
        start();
        String id = createSession("LIVENESS_HOLD");
        awaitStreamLive();
        relay.stallOpenEventStreams();

        await(() -> !idleRetries().isEmpty(),
                (IDLE_BOUND_MILLIS + TICK_MILLIS + SLACK_MILLIS) / 1000
                        + KEEPALIVE_MILLIS / 1000 + 10,
                "idle retry");
        await(() -> relay.eventStreams() >= 2, 60, "re-attached stream");
        releaseModel.countDown();
        awaitTurnCompleted(id, 60);

        assertThat(idleRetries()).hasSize(1);
        assertThat(modelRequests).hasSize(1);
        assertThat(modelFailure.get()).isNull();
        String events = api("GET", "/v1/agents/sessions/" + id + "/events",
                null, null, 200).path("data").toString();
        assertThat(occurrences(events, "\"turn.completed\"")).isEqualTo(1);
        assertThat(turn(id).get("status")).isEqualTo("COMPLETED");
    }

    private void start() throws Exception {
        Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the packaged CLI first")
                .isRegularFile();
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        startModel();
        startHarness(cli);
        relay = new HostedEventStreamRelay(harnessPort);
        try (ServerSocket socket = new ServerSocket(0, 0,
                InetAddress.getLoopbackAddress())) {
            springPort = socket.getLocalPort();
        }
        spring = (ServletWebServerApplicationContext)
                new SpringApplicationBuilder(
                        ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=" + springPort,
                "--spring.datasource.url=" + database.url(),
                "--spring.datasource.username=" + required("mysql.user"),
                "--spring.datasource.password="
                        + System.getProperty("mysql.password", ""),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.druid.max-active=3",
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:"
                        + springPort,
                "--qwen.managed-agent.session-store.workspace-id=hosted-liveness-workspace",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.base-url=http://127.0.0.1:"
                        + relay.port(),
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.runtime-broker.enabled=false",
                "--qwen.managed-agent.dispatch.scan-delay=100ms",
                "--qwen.managed-agent.dispatch.lease-duration=5s",
                "--qwen.managed-agent.dispatch.lease-renew-interval=1s",
                "--qwen.managed-agent.dispatch.retry-initial-delay=500ms",
                "--qwen.managed-agent.dispatch.retry-max-delay=1s");
        // Attached after the context starts: Spring Boot resets logback
        // while it boots.
        coordinatorLog.start();
        ((Logger) LoggerFactory.getLogger(HarnessCoordinator.class))
                .addAppender(coordinatorLog);
    }

    private String createSession(String marker) {
        return api("POST", "/v1/agents/sessions", "create-" + marker,
                "{\"agent_id\":\"qwen-code\",\"input\":[{\"type\":\"input_text\","
                        + "\"text\":\"" + marker + "\"}]}", 202)
                .path("id").asText();
    }

    // The Turn is running inside the model call and its events stream has
    // carried at least one keepalive through the relay.
    private void awaitStreamLive() throws InterruptedException {
        assertThat(modelHeld.await(60, TimeUnit.SECONDS))
                .as("model call\n%s", logs()).isTrue();
        await(() -> relay.openEventStreams() == 1
                && !relay.keepalives().isEmpty(),
                KEEPALIVE_MILLIS / 1000 + 15, "first keepalive");
    }

    private void awaitTurnCompleted(String id, long seconds)
            throws InterruptedException {
        await(() -> api("GET", "/v1/agents/sessions/" + id + "/events", null,
                null, 200).path("data").toString()
                .contains("\"turn.completed\""), seconds, "Turn completion");
    }

    private List<String> idleRetries() {
        List<String> retries = new ArrayList<>();
        for (ILoggingEvent event : List.copyOf(coordinatorLog.list)) {
            String message = event.getFormattedMessage();
            if (message.contains("will retry") && message.contains(IDLE_RETRY)) {
                retries.add(message);
            }
        }
        return retries;
    }

    private List<Long> keepaliveGapsMillis() {
        List<Long> stamps = relay.keepalives();
        List<Long> gaps = new ArrayList<>();
        for (int index = 1; index < stamps.size(); index++) {
            gaps.add(TimeUnit.NANOSECONDS.toMillis(
                    stamps.get(index) - stamps.get(index - 1)));
        }
        return gaps;
    }

    // Turn readers run on virtual threads, which Thread.getAllStackTraces()
    // leaves out; a JDK thread dump lists them with their stacks.
    private List<String> parkedReaders() {
        Path dump = temporary.resolve("threads-" + UUID.randomUUID() + ".txt")
                .toAbsolutePath();
        try {
            ManagementFactory.getPlatformMXBean(HotSpotDiagnosticMXBean.class)
                    .dumpThreads(dump.toString(),
                            HotSpotDiagnosticMXBean.ThreadDumpFormat.TEXT_PLAIN);
            List<String> parked = new ArrayList<>();
            // Each thread starts a line with "#<id>", its frames indented.
            for (String thread : Files.readString(dump).split("\n(?=#)")) {
                if (thread.contains(".HarnessEventStream.next(")) {
                    parked.add(thread.lines().findFirst().orElseThrow());
                }
            }
            return parked;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } finally {
            try {
                Files.deleteIfExists(dump);
            } catch (IOException ignored) {
                // The temporary directory goes with the test.
            }
        }
    }

    private Map<String, Object> turn(String id) {
        return jdbc.queryForMap("SELECT status, retry_count FROM ma_turn"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, id);
    }

    private static int occurrences(String text, String token) {
        int count = 0;
        for (int at = text.indexOf(token); at >= 0;
                at = text.indexOf(token, at + token.length())) {
            count++;
        }
        return count;
    }

    private JsonNode api(String method, String path, String idempotencyKey,
            String body, int expected) {
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(
                    URI.create("http://127.0.0.1:" + springPort + path))
                    .timeout(Duration.ofSeconds(10))
                    .header("X-Qwen-Tenant-Id", tenant)
                    .header("Accept", "application/json")
                    .method(method, body == null
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body));
            if (body != null) {
                request.header("Content-Type", "application/json");
            }
            if (idempotencyKey != null) {
                request.header("Idempotency-Key", idempotencyKey);
            }
            HttpResponse<String> response = HttpClient.newHttpClient().send(
                    request.build(), HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).as("%s %s: %s", method, path,
                    response.body()).isEqualTo(expected);
            return json.readTree(response.body());
        } catch (IOException failure) {
            throw new UncheckedIOException(failure);
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(failure);
        }
    }

    private void startModel() throws IOException {
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelPort = model.getAddress().getPort();
        model.setExecutor(modelExecutor);
        model.createContext("/v1/chat/completions", this::respondToModel);
        model.start();
    }

    // Holds the reply without writing a byte, so the Harness commits no
    // event and its stream carries only keepalives.
    private void respondToModel(HttpExchange exchange) throws IOException {
        try {
            JsonNode request = json.readTree(exchange.getRequestBody());
            modelRequests.add(request);
            String messages = request.path("messages").toString();
            if (messages.contains("LIVENESS_QUIET")) {
                Thread.sleep(QUIET_MILLIS);
            } else if (messages.contains("LIVENESS_HOLD")) {
                modelHeld.countDown();
                if (!releaseModel.await(150, TimeUnit.SECONDS)) {
                    return;
                }
            }
            ObjectNode chunk = json.createObjectNode();
            chunk.put("id", "liveness-fixture")
                    .put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", MODEL);
            ObjectNode choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "LIVENESS_REPLY");
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
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
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
        Files.writeString(config.resolve("settings.json"),
                json.writeValueAsString(Map.of(
                        "security", Map.of("auth",
                                Map.of("selectedType", "openai")),
                        "model", Map.of("name", MODEL),
                        "telemetry", Map.of("enabled", false),
                        "modelProviders", Map.of("openai", List.of(Map.of(
                                "id", MODEL, "envKey", "OPENAI_API_KEY",
                                "baseUrl", modelUrl))))));
        ProcessBuilder builder = new ProcessBuilder(
                System.getProperty("qwen.node", "node"), cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--port", "0", "--hostname", "127.0.0.1", "--require-auth",
                "--no-web", "--workspace", workspace.toString())
                .directory(workspace.toFile()).redirectErrorStream(true);
        Map<String, String> environment = builder.environment();
        environment.clear();
        for (String name : List.of("PATH", "SystemRoot", "WINDIR", "COMSPEC",
                "PATHEXT")) {
            if (System.getenv(name) != null) {
                environment.put(name, System.getenv(name));
            }
        }
        environment.putAll(Map.of("HOME", home.toString(),
                "USERPROFILE", home.toString(),
                "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString(),
                "OPENAI_API_KEY", "fake-local-key",
                "OPENAI_BASE_URL", modelUrl,
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
        outputReader = Thread.ofPlatform().daemon().start(() -> {
            try (var reader = harness.inputReader(StandardCharsets.UTF_8)) {
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
            assertThat(harness.isAlive()).as("Hosted Harness exited:\n%s",
                    logs()).isTrue();
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

    private void await(BooleanSupplier predicate, long seconds, String label)
            throws InterruptedException {
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

    @AfterEach
    void cleanup() throws Exception {
        releaseModel.countDown();
        ((Logger) LoggerFactory.getLogger(HarnessCoordinator.class))
                .detachAppender(coordinatorLog);
        try {
            if (harness != null) {
                harness.descendants().forEach(ProcessHandle::destroyForcibly);
                harness.destroy();
                if (!harness.waitFor(5, TimeUnit.SECONDS)) {
                    harness.destroyForcibly();
                }
                assertThat(harness.waitFor(5, TimeUnit.SECONDS))
                        .as("Hosted Harness must exit").isTrue();
            }
        } finally {
            try {
                // The relay goes first: its resets end any read still
                // parked on a held stream. Spring's close waits for its
                // Turn readers, so with a broken bound it would hang
                // the fork instead of failing the gate.
                if (relay != null) {
                    relay.close();
                }
                if (spring != null) {
                    spring.close();
                }
            } finally {
                if (database != null) {
                    database.close();
                }
                if (model != null) {
                    model.stop(0);
                }
                modelExecutor.shutdownNow();
                if (outputReader != null) {
                    outputReader.join(1000);
                }
                if (relay != null) {
                    assertThat(relay.faults()).as("relay faults").isEmpty();
                }
            }
        }
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(
                    "Required integration prerequisite: -D" + name);
        }
        return value;
    }
}
