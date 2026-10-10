package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

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
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

// FG7c (issue #13802): the channel process-crash gates. The control plane
// runs in its own JVM (HostedChannelCrashFixtureMain) so the IT can SIGKILL
// and reboot it mid-flight; the adapter driver is itself the killable,
// stoppable channel worker. JDBC stays with the IT across every bounce.
class HostedChannelProcessCrashIT {
    private static final String MODEL = "fg7-model";
    private static final String TOKEN = "fg7-harness-token";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final Pattern LISTENING = Pattern.compile(
            "listening on http://127\\.0\\.0\\.1:(\\d+)");
    private final ObjectMapper json = new ObjectMapper();
    private final StringBuilder harnessLog = new StringBuilder();
    private final List<String> modelMarkers = new ArrayList<>();

    @TempDir
    private Path temporary;

    private HttpServer model;
    private int modelPort;
    private Process harness;
    private int harnessPort = -1;
    private int brokerPort = -1;
    private Process fixture;
    private JdbcTemplate jdbc;
    private HostedChannelGateSupport support;
    private String controlUrl;

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

    /** All four cases must run on a POSIX host: the kills are signals. */
    @Test
    @Timeout(600)
    void fg7cProcessCrashesNeverReplayChannelEffectsOnMySql()
            throws Exception {
        assertThat(System.getProperty("os.name"))
                .as("FG7c sends POSIX signals").doesNotContainIgnoringCase(
                        "windows");
        assertThat(System.getProperty("mysql.url"))
                .as("FG7c requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user"))
                .as("FG7c requires -Dmysql.user").isNotBlank();
        List<String> cases = List.of("spring-kill-dispatch",
                "spring-kill-receipt", "adapter-kill", "adapter-stop");
        String selected = System.getProperty("qwen.fg7c.case");
        if (selected != null) {
            assertThat(cases).contains(selected);
            cases = List.of(selected);
        }
        jdbc = new JdbcTemplate(new DriverManagerDataSource(
                required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", "")));
        jdbc.setQueryTimeout(10);
        // Workspace mounts demand a canonical directory; macOS /var is a link.
        temporary = temporary.toRealPath();
        support = new HostedChannelGateSupport(jdbc, required("node.executable"),
                repoRoot());
        startModel();
        // One broker port per method: the control plane re-binds it across
        // every kill, so the long-lived harness keeps one live broker URL.
        harnessPort = freePort();
        brokerPort = freePort();
        Path casesRoot = Path.of(System.getProperty("user.dir"), "target",
                "fg7-cases");
        deleteRecursively(casesRoot);
        Files.createDirectories(casesRoot);
        String tenant = "hosted-channel-crash-" + UUID.randomUUID();
        for (String fault : cases) {
            try {
                runCrashCase(tenant, fault, casesRoot);
            } catch (Exception | AssertionError failure) {
                throw new AssertionError(fault + " failed; harness log:\n"
                        + harnessLogSnapshot() + "\ncase logs:\n"
                        + caseLogs(casesRoot.resolve(fault)), failure);
            }
        }
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (!Files.exists(root)) {
            return;
        }
        for (Path entry : Files.walk(root)
                .sorted((left, right) -> right.getNameCount()
                        - left.getNameCount())
                .toList()) {
            Files.delete(entry);
        }
    }

    private static String caseLogs(Path caseDir) throws IOException {
        // A case that dies before its directory exists (e.g. killFixture's
        // assertion) must never mask the original failure.
        if (!Files.isDirectory(caseDir)) {
            return "<no case directory>";
        }
        StringBuilder dump = new StringBuilder();
        for (Path log : Files.list(caseDir)
                .filter(entry -> entry.getFileName().toString()
                        .startsWith("driver-")
                        && entry.getFileName().toString().endsWith(".log"))
                .toList()) {
            dump.append("== ").append(log.getFileName()).append('\n')
                    .append(Files.readString(log)).append('\n');
        }
        return dump.toString();
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        assertThat(value).as("Pass -D" + name).isNotBlank();
        return value;
    }

    // --- child-JVM control plane ---

    private void startFixture(Path root, String tenant, int internalPort)
            throws Exception {
        Files.deleteIfExists(root.resolve("ready.json"));
        Path log = root.resolve("fixture-" + UUID.randomUUID() + ".log");
        ProcessBuilder builder = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", System.getProperty("java.class.path"),
                HostedChannelCrashFixtureMain.class.getName(),
                root.toString(), required("node.executable"),
                cliEntry().toString(), tenant,
                String.valueOf(internalPort), String.valueOf(freePort()),
                String.valueOf(brokerPort));
        builder.environment().put("FG7C_MYSQL_URL", required("mysql.url"));
        builder.environment().put("FG7C_MYSQL_USER", required("mysql.user"));
        builder.environment().put("FG7C_MYSQL_PASSWORD",
                System.getProperty("mysql.password", ""));
        builder.environment().put("FG7C_HARNESS_URL",
                "http://127.0.0.1:" + harnessPort);
        fixture = builder.redirectErrorStream(true).redirectOutput(log.toFile())
                .start();
        await("control plane ready", 90, () -> {
            if (!fixture.isAlive()) {
                return new IllegalStateException("fixture exited:\n"
                        + HostedChannelGateSupport.safeRead(log));
            }
            return Files.exists(root.resolve("ready.json")) ? true : null;
        });
        JsonNode ready = json.readTree(
                Files.readString(root.resolve("ready.json")));
        controlUrl = ready.path("controlUrl").asText();
    }

    private void killFixture() throws Exception {
        long generation = fixture.pid();
        fixture.destroyForcibly();
        assertThat(fixture.waitFor(15, TimeUnit.SECONDS))
                .as("the killed generation " + generation + " exited")
                .isTrue();
    }

    // --- cases ---

    private void runCrashCase(String tenant, String fault, Path casesRoot)
            throws Exception {
        if (fixture != null) {
            // One living control plane at a time: the previous case's last
            // generation still holds this method's shared broker port.
            killFixture();
        }
        Path caseDir = Files.createDirectories(casesRoot.resolve(fault));
        Path stateDir = Files.createDirectories(caseDir.resolve("state"));
        String channelId = "fg7c-" + fault;
        String marker = "fg7-" + fault.replace("spring-kill-", "kill-");
        int internalPort = freePort();
        startFixture(caseDir, tenant, internalPort);
        Map<String, Object> base = support.caseBase(tenant, fault, stateDir,
                internalPort);
        base.put("channelId", channelId);
        base.put("subject", marker);
        if (harness == null) {
            // The long-lived harness boots behind the first control plane,
            // carrying the broker URL every later generation re-binds.
            startHarness("http://127.0.0.1:" + brokerPort);
        }
        switch (fault) {
            case "spring-kill-dispatch" -> {
                Process driver = support.driverBuilder(caseDir, "full-turn",
                        base, Map.of("dropVerb", "claim", "expectDelivery",
                                false, "holdAfterDrop", true, "maxTicks",
                                300)).start();
                try {
                    support.awaitLog(caseDir, "driver-full-turn.log",
                            "FG7_DROPPED claim");
                    killFixture();
                    startFixture(caseDir, tenant, internalPort);
                    assertThat(driver.waitFor(300, TimeUnit.SECONDS))
                            .as("driver exits behind the bounce:\n%s",
                                    HostedChannelGateSupport.safeRead(caseDir
                                            .resolve("driver-full-turn.log")))
                            .isTrue();
                    assertThat(driver.exitValue())
                            .as(HostedChannelGateSupport.safeRead(caseDir
                                    .resolve("driver-full-turn.log"))).isZero();
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
                JsonNode results = support.resultsOf(caseDir, "full-turn");
                assertThat(HostedChannelGateSupport.relayCount(results, "claim",
                        true)).as("the carrying claim answer died with the"
                                + " server").isEqualTo(1);
                assertThat(results.path("sends"))
                        .as("at most one external effect: nothing sent")
                        .isEmpty();
                assertThat(support.claimRows(tenant, channelId)).isEqualTo(1);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = results.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                control("expire", "tenant=" + tenant + "&channel=" + channelId);
                control("reconcile", "");
                assertThat(support.deliveryProjection(tenant, sessionId,
                        deliveryId).get("delivery_state"))
                        .as("the stranded dispatch settles unknown, blocked")
                        .isEqualTo("unknown");
                assertThat(support.ledger(tenant, channelId, deliveryId)
                        .get("state")).isEqualTo("unknown");
                JsonNode cold = support.drive(caseDir, "resume-cold", base);
                assertThat(cold.path("sends"))
                        .as("cold start never auto-resends").isEmpty();
            }
            case "spring-kill-receipt" -> {
                Process driver = support.driverBuilder(caseDir, "full-turn",
                        base, Map.of("dropVerb", "receipt", "maxTicks", 300))
                        .start();
                try {
                    support.awaitLog(caseDir, "driver-full-turn.log",
                            "FG7_DROPPED receipt");
                    killFixture();
                    startFixture(caseDir, tenant, internalPort);
                    assertThat(driver.waitFor(300, TimeUnit.SECONDS))
                            .as("driver converges behind the bounce:\n%s",
                                    HostedChannelGateSupport.safeRead(caseDir
                                            .resolve("driver-full-turn.log")))
                            .isTrue();
                    assertThat(driver.exitValue())
                            .as(HostedChannelGateSupport.safeRead(caseDir
                                    .resolve("driver-full-turn.log"))).isZero();
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
                JsonNode results = support.resultsOf(caseDir, "full-turn");
                assertThat(results.path("sends"))
                        .as("at most one physical send across the bounce")
                        .hasSize(1);
                assertThat(HostedChannelGateSupport.relayCount(results,
                        "receipt", true)).isEqualTo(1);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = results.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                Map<String, Object> row = support.ledger(tenant, channelId,
                        deliveryId);
                assertThat(row.get("state")).isEqualTo("delivered");
                assertThat(row.get("provider_receipt")).isEqualTo(results
                        .path("sends").get(0).path("messageId").asText());
                assertThat(support.claimRows(tenant, channelId)).isEqualTo(1);
                assertThat(modelCallsFor(marker)).isEqualTo(1);
            }
            case "adapter-kill" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                Process driver = support.driverBuilder(caseDir,
                        "pull-terminate", base, Map.of()).start();
                try {
                    support.awaitLog(caseDir, "driver-pull-terminate.log",
                            "FG7_AWAIT_KILL");
                    driver.destroyForcibly();
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
                assertThat(support.claimRows(tenant, channelId)).isEqualTo(1);
                control("expire", "tenant=" + tenant + "&channel=" + channelId);
                control("reconcile", "");
                assertThat(support.deliveryProjection(tenant, sessionId,
                        deliveryId).get("delivery_state"))
                        .as("the lease settles the unknown outcome")
                        .isEqualTo("unknown");
                assertThat(support.resultsOf(caseDir, "pull-terminate")
                        .path("sends")).hasSize(1);
                JsonNode cold = support.drive(caseDir, "resume-cold", base);
                assertThat(cold.path("sends"))
                        .as("a cold adapter never auto-resends").isEmpty();
                assertThat(support.deliveryProjection(tenant, sessionId,
                        deliveryId).get("delivery_state")).isEqualTo("unknown");
            }
            case "adapter-stop" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                Path hold = caseDir.resolve("receipt-hold-release");
                Process driver = support.driverBuilder(caseDir, "pull", base,
                        Map.of("holdAfterSendFile", hold.toString())).start();
                try {
                    support.awaitLog(caseDir, "driver-pull.log", "FG7_HELD");
                    signal(driver, "STOP");
                    control("expire",
                            "tenant=" + tenant + "&channel=" + channelId);
                    control("reconcile", "");
                    assertThat(support.deliveryProjection(tenant, sessionId,
                            deliveryId).get("delivery_state"))
                            .as("the frozen worker's claim settles unknown")
                            .isEqualTo("unknown");
                    signal(driver, "CONT");
                    Files.writeString(hold, "go");
                    assertThat(driver.waitFor(150, TimeUnit.SECONDS))
                            .as("the held receipt crosses after CONT")
                            .isTrue();
                    assertThat(driver.exitValue())
                            .as(HostedChannelGateSupport.safeRead(
                                    caseDir.resolve("driver-pull.log")))
                            .isZero();
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
                JsonNode results = support.resultsOf(caseDir, "pull");
                assertThat(results.path("sends")).hasSize(1);
                JsonNode record = support.deliveryRecord(tenant, sessionId,
                        deliveryId);
                assertThat(record.path("run").path("delivery").path("state")
                        .asText())
                        .as("the late honest receipt lands the legal"
                                + " unknown -> delivered step")
                        .isEqualTo("delivered");
                assertThat(record.path("segments").get(0).path("receipt")
                        .path("providerMessageId").asText())
                        .isEqualTo(results.path("sends").get(0)
                                .path("messageId").asText());
                assertThat(support.claimRows(tenant, channelId)).isEqualTo(1);
            }
            default -> throw new IllegalArgumentException(fault);
        }
    }

    private void signal(Process process, String name) throws Exception {
        Process kill = new ProcessBuilder("kill", "-" + name,
                String.valueOf(process.pid())).start();
        assertThat(kill.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(kill.exitValue()).isZero();
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

    // --- fixture ---

    private static int freePort() throws IOException {
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
            JsonNode request = json.readTree(exchange.getRequestBody());
            String text = request.path("messages").toString();
            String marker = "fg7-unknown";
            for (String candidate : List.of("kill-dispatch", "kill-receipt",
                    "adapter-kill", "adapter-stop")) {
                if (text.contains("fg7-" + candidate)) {
                    marker = "fg7-" + candidate;
                    break;
                }
            }
            synchronized (modelMarkers) {
                modelMarkers.add(marker);
            }
            ObjectNode chunk = json.createObjectNode();
            chunk.put("id", "fg7-fixture").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", MODEL);
            ObjectNode choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "fg7-reply-" + marker);
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

    private int modelCallsFor(String marker) {
        synchronized (modelMarkers) {
            int count = 0;
            for (String entry : modelMarkers) {
                if (entry.equals(marker)) {
                    count++;
                }
            }
            return count;
        }
    }

    private void startHarness(String brokerUrl) throws Exception {
        Path cli = cliEntry();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable").isNotBlank();
        Path home = temporary.resolve("harness-home");
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
                brokerUrl, "--managed-runtime-broker-token",
                "fg7-broker-token")
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
                "../../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).as("Build and bundle the packaged CLI first")
                .isRegularFile();
        return cli;
    }

    private static Path repoRoot() {
        return cliEntry().getParent().getParent();
    }

    private void await(String description, int seconds,
            Supplier<Object> probe) throws Exception {
        Object outcome;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (System.nanoTime() < deadline) {
            try {
                outcome = probe.get();
            } catch (RuntimeException ignored) {
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
        throw new AssertionError(description + " timed out; harness log:\n"
                + harnessLogSnapshot());
    }

    private String harnessLogSnapshot() {
        synchronized (harnessLog) {
            return harnessLog.toString();
        }
    }

    private void awaitPlanned(String tenant, String sessionId,
            String deliveryId) throws Exception {
        await("delivery " + deliveryId + " planned", 90,
                () -> support.deliveryProjection(tenant, sessionId,
                        deliveryId) != null ? true : null);
    }
}
