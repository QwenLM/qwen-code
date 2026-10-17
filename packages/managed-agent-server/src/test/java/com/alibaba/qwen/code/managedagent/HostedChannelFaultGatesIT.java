package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.ManagedChannelService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

// FG7 (issue #13802): multi-process fault gates for the channel domains.
// One Spring (channels on an isolated internal listener) and one packaged
// Harness per letter; route Sessions come from the production ingress path.
// The driver (integration-tests/helpers/hosted-channel-fault-driver.ts)
// carries the real ManagedEmailAdapter through a lose-once proxy; JDBC is
// the ground truth and every fault must prove it fired.
class HostedChannelFaultGatesIT {
    private static final String MODEL = "fg7-model";
    private static final String TOKEN = "fg7-harness-token";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final String ACTOR = "actor";
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
    private ServletWebServerApplicationContext spring;
    private JdbcTemplate jdbc;
    private HostedChannelGateSupport support;
    private int internalPort;

    @AfterEach
    void tearDown() {
        if (spring != null) {
            spring.close();
            spring = null;
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
    @Timeout(420)
    void fg7aLostAdapterRepliesRecoverByIdentityOnMySql() throws Exception {
        runLetter("fg7a", List.of("inbound-reply", "claim-reply",
                "receipt-reply"), null);
    }

    @Test
    @Timeout(420)
    @ExtendWith(OutputCaptureExtension.class)
    void fg7bChannelStoreFailuresLeaveNoExternalEffectOnMySql(
            CapturedOutput output) throws Exception {
        runLetter("fg7b", List.of("route-admit", "delivery-commit",
                "commit-reply-restart"), output);
    }

    @Test
    @Timeout(600)
    void fg7dChannelCancellationsSettlePhysicallyOnMySql() throws Exception {
        runLetter("fg7d", List.of("cancel-planned", "cancel-sending",
                "cancel-replay", "cancel-unsettled", "task-cancel-planned",
                "task-cancel-claimed"), null);
    }

    @Test
    @Timeout(600)
    void fg7eDeliveryReadsStayContinuousAcrossGapsOnMySql() throws Exception {
        runLetter("fg7e", List.of("delivery-page-resume",
                "delivery-state-progress"), null);
    }

    @Test
    @Timeout(600)
    void fg7fUnknownDeliveryStaysHonestOnMySql() throws Exception {
        runLetter("fg7f", List.of("provider-ambiguous",
                "receipt-never-arrived", "out-of-plan-ordinal"), null);
    }

    private void runLetter(String letter, List<String> allCases,
            CapturedOutput output) throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG7 requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user"))
                .as("FG7 requires -Dmysql.user").isNotBlank();
        assertThat(System.getProperty("node.executable"))
                .as("Pass -Dnode.executable").isNotBlank();
        String selected = System.getProperty("qwen." + letter + ".case");
        List<String> cases = allCases;
        if (selected != null) {
            assertThat(cases).contains(selected);
            cases = List.of(selected);
        }
        // Per-letter subroot: wiping it at method start cannot erase the
        // evidence of a letter (or the crash class) that ran earlier.
        Path casesRoot = Path.of(System.getProperty("user.dir"), "target",
                "fg7-cases", letter);
        deleteRecursively(casesRoot);
        Files.createDirectories(casesRoot);
        String tenant = "hosted-channel-" + UUID.randomUUID();
        start(tenant);
        for (String fault : cases) {
            try {
                Path caseDir = Files.createDirectories(
                        casesRoot.resolve(fault));
                if (letter.equals("fg7b")) {
                    fg7bStoreFailure(tenant, fault, output, caseDir);
                } else {
                    runCase(tenant, fault, caseDir);
                }
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

    private static String caseLogs(Path caseDir) {
        // A case that dies before its directory exists must never mask the
        // original failure — and neither may an I/O error reading its logs.
        if (!Files.isDirectory(caseDir)) {
            return "<no case directory>";
        }
        StringBuilder dump = new StringBuilder();
        try {
            for (Path log : Files.list(caseDir)
                    .filter(entry -> entry.getFileName().toString()
                            .startsWith("driver-")
                            && entry.getFileName().toString()
                                    .endsWith(".log"))
                    .toList()) {
                dump.append("== ").append(log.getFileName()).append('\n')
                        .append(HostedChannelGateSupport.safeRead(log))
                        .append('\n');
            }
        } catch (IOException failure) {
            dump.append("<case logs unreadable: ").append(failure)
                    .append('>');
        }
        return dump.toString();
    }

    private void start(String tenant) throws Exception {
        // Workspace mounts demand a canonical directory; macOS /var is a link.
        temporary = temporary.toRealPath();
        modelMarkers.clear();
        startModel();
        int internal = freePort();
        // The harness pins its port so the control plane can name it in
        // base-url before the packaged process exists; the harness opens
        // Workspace sessions only after the broker URL it carries is live.
        harnessPort = freePort();
        int brokerPort = freePort();
        startSpring(tenant, internal, brokerPort);
        support = new HostedChannelGateSupport(jdbc,
                System.getProperty("node.executable"), repoRoot());
        startHarness("http://127.0.0.1:" + brokerPort);
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
            String marker = "FG7-UNKNOWN-SUBJECT";
            for (String candidate : List.of("inbound-reply", "claim-reply",
                    "receipt-reply", "route-admit", "delivery-commit",
                    "commit-reply-restart", "cancel-planned",
                    "cancel-sending", "cancel-replay", "cancel-unsettled",
                    "task-cancel-planned", "task-cancel-claimed",
                    "delivery-page-resume", "delivery-state-progress",
                    "provider-ambiguous", "out-of-plan-ordinal",
                    "receipt-never-arrived")) {
                if (text.contains("fg7-" + candidate)) {
                    marker = candidate;
                    break;
                }
            }
            String reply = "fg7-reply-" + marker;
            synchronized (modelMarkers) {
                modelMarkers.add(marker);
            }
            ObjectNode chunk = json.createObjectNode();
            chunk.put("id", "fg7-fixture").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", MODEL);
            ObjectNode choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", reply);
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
                // qwen serve falls back attemptPort+1 on EADDRINUSE; a
                // harness on a fallback port invalidates the pre-baked
                // harness.base-url, so the bound port must be the reserved one.
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

    private static Path repoRoot() {
        return cliEntry().getParent().getParent();
    }

    private void startSpring(String tenant, int internal, int brokerPort)
            throws Exception {
        Path cli = cliEntry();
        String node = System.getProperty("node.executable");
        Path workspace = Files.createDirectories(
                temporary.resolve("workspace-mount"));
        var application = new SpringApplicationBuilder(
                ManagedAgentServerApplication.class);
        application.initializers(context -> context.getBeanFactory()
                .registerSingleton("fg7Authentication", impersonation(tenant)));
        spring = (ServletWebServerApplicationContext) application.run(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getProperty("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--spring.datasource.druid.max-active=8",
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + internal,
                "--qwen.managed-agent.session-store.workspace-id=workspace-0",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.base-url=http://127.0.0.1:" + harnessPort,
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                "--qwen.managed-agent.runtime-broker.token=fg7-broker-token",
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + workspace,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage-0",
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + workspace,
                "--qwen.managed-agent.channels.enabled=true",
                "--qwen.managed-agent.channels.claim-lease=30m",
                "--qwen.managed-agent.channels.scan-delay=30s",
                "--qwen.managed-agent.internal-server.address=127.0.0.1",
                "--qwen.managed-agent.internal-server.port=" + internal);
        internalPort = internal;
        jdbc = spring.getBean(JdbcTemplate.class);
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " (?, ?, 1, ?, 'Workspace', ?, ?, 'ACTIVE')", tenant,
                "workspace-0", "storage-0",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, ?, ?,"
                + " 'OPERATOR')", tenant, "workspace-0",
                ACTOR.getBytes(StandardCharsets.UTF_8));
    }

    private FilterRegistrationBean<Filter> impersonation(String tenant) {
        AuthenticatedTenantActor actor = new AuthenticatedTenantActor() {
            public String tenantId() {
                return tenant;
            }

            public String actorId() {
                return ACTOR;
            }

            public String getName() {
                return "fg7-fixture";
            }
        };
        FilterRegistrationBean<Filter> registration =
                new FilterRegistrationBean<>((request, response, chain) ->
                        chain.doFilter(new HttpServletRequestWrapper(
                                (HttpServletRequest) request) {
                            @Override
                            public Principal getUserPrincipal() {
                                return actor;
                            }
                        }, response));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        registration.setAsyncSupported(true);
        registration.setDispatcherTypes(DispatcherType.REQUEST,
                DispatcherType.ASYNC);
        registration.addUrlPatterns("/v1/agent-channels/*", "/v1/agents/*");
        return registration;
    }

    // --- shared case steps ---

    private void await(String description, int seconds,
            Supplier<Object> probe) throws Exception {
        Object outcome;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        Throwable lastFailure = null;
        while (System.nanoTime() < deadline) {
            try {
                outcome = probe.get();
            } catch (RuntimeException failure) {
                // A persistently failing probe must reach the timeout
                // report, not burn the deadline as a bare timeout.
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

    private void awaitPlanned(String tenant, String sessionId,
            String deliveryId) throws Exception {
        await("delivery " + deliveryId + " planned", 90,
                () -> support.deliveryProjection(tenant, sessionId,
                        deliveryId) != null ? true : null);
    }

    private void createChannelTrigger(String tenant, String channelId,
            String table, String timing, String condition, String marker,
            List<String> triggers) {
        String trigger = support.newTriggerName();
        triggers.add(trigger);
        String channel = "ma_operation".equals(table)
                ? "JSON_UNQUOTE(JSON_EXTRACT(NEW.request_json, '$.channelId'))" : "NEW.channel_id";
        jdbc.execute("CREATE TRIGGER " + trigger + " " + timing + " ON "
                + table + " FOR EACH ROW BEGIN IF NEW.tenant_id = '" + tenant
                + "' AND " + channel + " = '" + channelId + "' AND ("
                + condition + ") THEN SIGNAL SQLSTATE '45000' SET"
                + " MESSAGE_TEXT = '" + marker + "'; END IF; END");
    }

    private Map<String, Object> cancelDelivery(String tenant, String sessionId,
            String deliveryId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", UUID.randomUUID().toString());
        body.put("kind", "cancel_delivery");
        body.put("deliveryId", deliveryId);
        @SuppressWarnings("unchecked")
        Map<String, Object> answer =
                (Map<String, Object>) spring.getBean(HarnessConnector.class)
                        .runChannelOperation(tenant, sessionId, body)
                        .get("delivery");
        return answer;
    }

    /** The route Session's one delivery task, read publicly. */
    private JsonNode deliveryTask(String tenant, String sessionId)
            throws Exception {
        HttpResponse<String> response = publicCall(tenant,
                "/v1/agents/sessions/" + sessionId + "/tasks", null);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        List<JsonNode> tasks = new java.util.ArrayList<>();
        json.readTree(response.body()).path("data").forEach(task -> {
            if ("channel_delivery".equals(task.path("kind").asText())) {
                tasks.add(task);
            }
        });
        assertThat(tasks).as("delivery tasks").hasSize(1);
        return tasks.getFirst();
    }

    /** A public GET, or a POST under {@code key} when one is given. */
    private HttpResponse<String> publicCall(String tenant, String route,
            String key) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + spring.getWebServer().getPort()
                        + route)).timeout(Duration.ofSeconds(20))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("Accept", "application/json");
        if (key != null) {
            request.header("Idempotency-Key", key)
                    .POST(HttpRequest.BodyPublishers.noBody());
        } else {
            request.GET();
        }
        return HttpClient.newHttpClient().send(request.build(),
                HttpResponse.BodyHandlers.ofString());
    }

    /** Park one pull mid-send; resume it by creating {@code release}. */
    private HostedChannelGateSupport.DriverLaunch startParkedPull(
            Path caseDir, Map<String, Object> base, Path release)
            throws Exception {
        return startParkedPull(caseDir, base, release, 1);
    }

    private HostedChannelGateSupport.DriverLaunch startParkedPull(
            Path caseDir, Map<String, Object> base, Path release,
            int expectedSends) throws Exception {
        return support.startDriver(caseDir, "pull-parked", base,
                Map.of("smtpMode", "park", "smtpReleaseFile",
                        release.toString(), "expectedSends", expectedSends));
    }

    private void awaitSending(String tenant, String sessionId,
            String deliveryId, String channelId) throws Exception {
        await("delivery claimed and sending", 120, () -> {
            Map<String, Object> projection = support.deliveryProjection(tenant,
                    sessionId, deliveryId);
            return projection != null
                    && "sending".equals(projection.get("delivery_state"))
                    && support.claimRows(tenant, channelId) == 1 ? true : null;
        });
    }

    private JsonNode readsDeliveries(String tenant, String channelId,
            String cursor, int limit) throws Exception {
        String query = "?limit=" + limit
                + (cursor == null ? "" : "&cursor=" + cursor);
        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                        + spring.getWebServer().getPort()
                        + "/v1/agent-channels/" + channelId + "/deliveries"
                        + query)).timeout(Duration.ofSeconds(10))
                        .header("X-Qwen-Tenant-Id", tenant)
                        .header("Accept", "application/json").GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return json.readTree(response.body());
    }

    private JsonNode readDelivery(String tenant, String channelId,
            String deliveryId, int status) throws Exception {
        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                        + spring.getWebServer().getPort()
                        + "/v1/agent-channels/" + channelId + "/deliveries/"
                        + deliveryId)).timeout(Duration.ofSeconds(10))
                        .header("X-Qwen-Tenant-Id", tenant).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        return json.readTree(response.body());
    }

    private void abortPageRead(String tenant, String channelId)
            throws IOException {
        try (Socket socket = new Socket("127.0.0.1",
                spring.getWebServer().getPort())) {
            OutputStream out = socket.getOutputStream();
            out.write(("GET /v1/agent-channels/" + channelId
                    + "/deliveries?limit=2 HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    + "X-Qwen-Tenant-Id: " + tenant
                    + "\r\nConnection: close\r\n\r\n")
                    .getBytes(StandardCharsets.UTF_8));
            out.flush();
            InputStream in = socket.getInputStream();
            byte[] buffer = new byte[256];
            int read = in.read(buffer);
            assertThat(read).as("the page read began before the abort")
                    .isGreaterThan(0);
            // The abort must be real: the rest of the page body has to be
            // sitting in the socket unread, or nothing ever came loose.
            assertThat(in.read())
                    .as("the abort left the page body unread")
                    .isNotEqualTo(-1);
        }
    }

    private List<String> pageIdentify(String tenant, String channelId,
            int limit) throws Exception {
        List<String> identities = new ArrayList<>();
        String cursor = null;
        for (int page = 0; page < 8; page++) {
            JsonNode current = readsDeliveries(tenant, channelId, cursor,
                    limit);
            for (JsonNode row : current.path("data")) {
                identities.add(row.path("id").asText());
            }
            if (!current.path("has_more").asBoolean()) {
                break;
            }
            cursor = current.path("next_cursor").asText();
        }
        return identities;
    }

    // --- the cases ---

    private void runCase(String tenant, String fault, Path caseDir)
            throws Exception {
        Path stateDir = Files.createDirectories(caseDir.resolve("state"));
        Map<String, Object> base = support.caseBase(tenant, fault, stateDir,
                internalPort);
        String channelId = "fg7-" + fault;
        switch (fault) {
            case "inbound-reply" -> {
                JsonNode results = support.drive(caseDir, "full-turn", base,
                        Map.of("dropVerb", "inbound"));
                assertThat(HostedChannelGateSupport.relayCount(results,
                        "inbound", true)).as("the lost admission fired")
                        .isEqualTo(1);
                assertThat(HostedChannelGateSupport.relayCountOk(results,
                        "inbound"))
                        .as("the adapter re-drove after the loss")
                        .isGreaterThanOrEqualTo(1);
                assertThat(results.path("sends")).hasSize(1);
                HostedChannelGateSupport.assertSendsTo(results);
                String sessionId = support.channelSession(tenant, channelId);
                Map<String, Object> route = support.routeRow(tenant,
                        channelId);
                assertThat(route.get("state")).isEqualTo("admitted");
                assertThat(support.inputAcceptedCount(tenant, sessionId))
                        .as("one platform event commits exactly one input")
                        .isEqualTo(1);
                assertThat(((Number) support.routeProjection(tenant, sessionId)
                        .get("revision")).intValue())
                        .as("the route chain never re-opens").isEqualTo(1);
                assertThat(modelCallsFor(fault)).as("one input, one turn")
                        .isEqualTo(1);
            }
            case "claim-reply" -> {
                JsonNode results = support.drive(caseDir, "full-turn", base,
                        Map.of("dropVerb", "claim", "expectDelivery", false,
                                "holdAfterDrop", true, "maxTicks", 90));
                assertThat(HostedChannelGateSupport.relayCount(results, "claim",
                        true)).as("the carrying claim answer was destroyed")
                        .isEqualTo(1);
                assertThat(HostedChannelGateSupport.relayCountOk(results,
                        "claim"))
                        .as("the adapter kept re-asking the outbox")
                        .isGreaterThanOrEqualTo(2);
                HostedChannelGateSupport.assertSendsEmpty(results,
                        "a lost dispatch answer never sends");
                String deliveryId = results.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                assertThat(support.claimRows(tenant, channelId))
                        .as("the retry never mints a second claim")
                        .isEqualTo(1);
                String sessionId = support.channelSession(tenant, channelId);
                support.expireClaims(tenant, channelId);
                spring.getBean(ManagedChannelService.class).reconcile();
                assertThat(support.deliveryProjection(tenant, sessionId,
                        deliveryId).get("delivery_state"))
                        .as("the lease settles the stranded dispatch"
                                + " unknown, never silently accepted")
                        .isEqualTo("unknown");
                assertThat(support.ledger(tenant, channelId, deliveryId)
                        .get("state")).isEqualTo("unknown");
                JsonNode cold = support.drive(caseDir, "resume-cold", base);
                HostedChannelGateSupport.assertSendsEmpty(cold,
                        "a cold adapter never auto-resends");
                assertThat(support.deliveryProjection(tenant, sessionId,
                        deliveryId).get("delivery_state")).isEqualTo("unknown");
            }
            case "receipt-reply" -> {
                JsonNode results = support.drive(caseDir, "full-turn", base,
                        Map.of("dropVerb", "receipt"));
                assertThat(HostedChannelGateSupport.relayCount(results,
                        "receipt", true)).isEqualTo(1);
                assertThat(HostedChannelGateSupport.relayCountOk(results,
                        "receipt"))
                        .as("the report re-drove, never the send")
                        .isGreaterThanOrEqualTo(1);
                assertThat(results.path("sends")).hasSize(1);
                HostedChannelGateSupport.assertSendsTo(results);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = results.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                JsonNode record = support.deliveryRecord(tenant, sessionId,
                        deliveryId);
                assertThat(record.path("segments").get(0).path("receipt")
                        .path("providerMessageId").asText())
                        .isEqualTo(results.path("sends").get(0)
                                .path("messageId").asText());
                assertThat(record.path("run").path("delivery").path("state")
                        .asText()).isEqualTo("delivered");
                Map<String, Object> row = support.ledger(tenant, channelId,
                        deliveryId);
                assertThat(row.get("state")).as("the ledger follows the record")
                        .isEqualTo("delivered");
                assertThat(row.get("provider_receipt")).isEqualTo(results
                        .path("sends").get(0).path("messageId").asText());
            }
            case "cancel-planned", "cancel-replay" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                Map<String, Object> first = cancelDelivery(tenant, sessionId,
                        deliveryId);
                assertThat(first.get("state")).isEqualTo("cancelled");
                if (fault.equals("cancel-replay")) {
                    Map<String, Object> again = cancelDelivery(tenant,
                            sessionId, deliveryId);
                    assertThat(again.get("state"))
                            .as("the replayed cancel answers the committed"
                                    + " cancellation")
                            .isEqualTo("cancelled");
                }
                assertThat(support.deliveryProjection(tenant, sessionId,
                        deliveryId).get("delivery_state"))
                        .isEqualTo("cancelled");
                JsonNode pull = support.drive(caseDir, "pull", base,
                        Map.of("expectDelivery", false));
                assertThat(HostedChannelGateSupport.relayCountOk(pull,
                        "claim"))
                        .as("the outbox pull reached the control plane")
                        .isGreaterThanOrEqualTo(1);
                HostedChannelGateSupport.assertSendsEmpty(pull,
                        "a settled cancellation never sends");
                assertThat(support.claimRows(tenant, channelId)).isZero();
                assertThat(support.ledgerRows(tenant, channelId))
                        .as("nothing ever reaches the ledger").isZero();
            }
            // #13746 F3: the public task cancel of a delivery. A planned
            // one is a pending task that advertises cancel, and the cancel
            // settles it before any send; once an adapter claims it, the
            // task runs and refuses a new cancel.
            case "task-cancel-planned" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                JsonNode task = deliveryTask(tenant, sessionId);
                assertThat(task.path("state").asText()).isEqualTo("pending");
                assertThat(task.path("action_capabilities").toString())
                        .isEqualTo("[\"cancel\"]");
                String route = "/v1/agents/sessions/" + sessionId + "/tasks/"
                        + task.path("id").asText() + "/cancel";
                HttpResponse<String> cancel = publicCall(tenant, route,
                        "fg7-task-cancel");
                assertThat(cancel.statusCode()).as(cancel.body())
                        .isEqualTo(202);
                String operationId = json.readTree(cancel.body()).path("id")
                        .asText();
                await("task cancel completed", 90, () -> {
                    try {
                        return "completed".equals(json.readTree(publicCall(
                                tenant, "/v1/agents/sessions/" + sessionId
                                        + "/operations/" + operationId,
                                null).body()).path("status").asText())
                                ? true : null;
                    } catch (Exception failure) {
                        throw new IllegalStateException(failure);
                    }
                });
                JsonNode replay = json.readTree(publicCall(tenant, route,
                        "fg7-task-cancel").body());
                assertThat(replay.path("id").asText()).isEqualTo(operationId);
                assertThat(replay.path("replayed").asBoolean()).isTrue();
                JsonNode settled = deliveryTask(tenant, sessionId);
                assertThat(settled.path("state").asText())
                        .isEqualTo("cancelled");
                assertThat(settled.path("action_capabilities")).isEmpty();
                assertThat(support.deliveryRecord(tenant, sessionId,
                        deliveryId).path("cancelRequested").asBoolean())
                        .isTrue();
                JsonNode pull = support.drive(caseDir, "pull", base,
                        Map.of("expectDelivery", false));
                assertThat(HostedChannelGateSupport.relayCountOk(pull,
                        "claim"))
                        .as("the outbox pull reached the control plane")
                        .isGreaterThanOrEqualTo(1);
                HostedChannelGateSupport.assertSendsEmpty(pull,
                        "a cancelled delivery task never sends");
                assertThat(support.ledgerRows(tenant, channelId))
                        .as("nothing ever reaches the ledger").isZero();
            }
            case "task-cancel-claimed" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                Path release = caseDir.resolve("smtp-release");
                HostedChannelGateSupport.DriverLaunch launch = startParkedPull(
                        caseDir, base, release);
                Process driver = launch.process();
                try {
                    awaitSending(tenant, sessionId, deliveryId, channelId);
                    JsonNode task = deliveryTask(tenant, sessionId);
                    assertThat(task.path("state").asText())
                            .isEqualTo("running");
                    assertThat(task.path("action_capabilities")).isEmpty();
                    HttpResponse<String> cancel = publicCall(tenant,
                            "/v1/agents/sessions/" + sessionId + "/tasks/"
                                    + task.path("id").asText() + "/cancel",
                            "fg7-task-cancel-claimed");
                    assertThat(cancel.statusCode()).as(cancel.body())
                            .isEqualTo(409);
                    assertThat(json.readTree(cancel.body()).path("error")
                            .path("code").asText())
                            .isEqualTo("task_action_unavailable");
                    Files.writeString(release, "go");
                    assertThat(driver.waitFor(120, TimeUnit.SECONDS))
                            .isTrue();
                    assertThat(driver.exitValue()).isZero();
                    assertThat(support.resultsOf(caseDir, launch.tag())
                            .path("sends")).hasSize(1);
                    assertThat(deliveryTask(tenant, sessionId).path("state")
                            .asText()).isEqualTo("completed");
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
            }
            case "cancel-sending" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                Path release = caseDir.resolve("smtp-release");
                HostedChannelGateSupport.DriverLaunch launch = startParkedPull(
                        caseDir, base, release);
                Process driver = launch.process();
                String tag = launch.tag();
                try {
                    awaitSending(tenant, sessionId, deliveryId, channelId);
                    Map<String, Object> answer = cancelDelivery(tenant,
                            sessionId, deliveryId);
                    assertThat(answer.get("state"))
                            .as("a sending delivery is flagged, not settled")
                            .isEqualTo("sending");
                    assertThat(answer.get("cancelRequested")).isEqualTo(true);
                    Files.writeString(release, "go");
                    assertThat(driver.waitFor(120, TimeUnit.SECONDS))
                            .as("parked driver completion:\n%s",
                                    HostedChannelGateSupport.safeRead(caseDir
                                            .resolve("driver-" + tag
                                                    + ".log")))
                            .isTrue();
                    assertThat(driver.exitValue())
                            .as(HostedChannelGateSupport.safeRead(caseDir
                                    .resolve("driver-" + tag + ".log")))
                            .isZero();
                    JsonNode results = support.resultsOf(caseDir, tag);
                    assertThat(results.path("sends")).hasSize(1);
                    HostedChannelGateSupport.assertSendsTo(results);
                    JsonNode record = support.deliveryRecord(tenant, sessionId,
                            deliveryId);
                    assertThat(record.path("run").path("delivery")
                            .path("state").asText())
                            .as("the terminal is the physical settlement")
                            .isEqualTo("delivered");
                    assertThat(record.path("cancelRequested").asBoolean())
                            .isTrue();
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
            }
            case "cancel-unsettled" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                Path release = caseDir.resolve("smtp-release");
                HostedChannelGateSupport.DriverLaunch launch = support
                        .startDriver(caseDir, "pull-terminate", base, Map.of(
                                "smtpMode", "park", "smtpReleaseFile",
                                release.toString()));
                Process driver = launch.process();
                String tag = launch.tag();
                try {
                    awaitSending(tenant, sessionId, deliveryId, channelId);
                    cancelDelivery(tenant, sessionId, deliveryId);
                    Files.writeString(release, "go");
                    support.awaitLog(caseDir, "driver-" + tag + ".log",
                            "FG7_AWAIT_KILL", driver);
                    driver.destroyForcibly();
                    support.expireClaims(tenant, channelId);
                    spring.getBean(ManagedChannelService.class).reconcile();
                    JsonNode record = support.deliveryRecord(tenant, sessionId,
                            deliveryId);
                    assertThat(record.path("run").path("delivery")
                            .path("state").asText())
                            .as("the terminal is the physical unknown,"
                                    + " never a fabricated cancelled")
                            .isEqualTo("unknown");
                    assertThat(record.path("cancelRequested").asBoolean())
                            .isTrue();
                    JsonNode cold = support.drive(caseDir, "resume-cold",
                            base);
                    HostedChannelGateSupport.assertSendsEmpty(cold,
                            "a cold adapter never auto-resends");
                    assertThat(support.deliveryProjection(tenant, sessionId,
                            deliveryId).get("delivery_state"))
                            .isEqualTo("unknown");
                    JsonNode terminated = support.resultsOf(caseDir, tag);
                    assertThat(terminated.path("sends")).hasSize(1);
                    HostedChannelGateSupport.assertSendsTo(terminated);
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
            }
            case "delivery-page-resume" -> {
                JsonNode firstMail = support.drive(caseDir, "admit", base);
                String firstInput = firstMail.path("admissionInputIds").get(0)
                        .asText();
                JsonNode secondMail = support.drive(caseDir, "admit", base,
                        Map.of("mailUid", 2));
                String secondInput = secondMail.path("admissionInputIds")
                        .get(0).asText();
                String firstDelivery = firstInput + ":reply";
                String secondDelivery = secondInput + ":reply";
                String firstSession = support.sessionOfInput(tenant, channelId,
                        firstInput);
                String secondSession = support.sessionOfInput(tenant,
                        channelId, secondInput);
                awaitPlanned(tenant, firstSession, firstDelivery);
                awaitPlanned(tenant, secondSession, secondDelivery);
                Path release = caseDir.resolve("smtp-release");
                HostedChannelGateSupport.DriverLaunch launch = startParkedPull(
                        caseDir, base, release, 2);
                Process driver = launch.process();
                String tag = launch.tag();
                try {
                    // The claim answer carries BOTH deliveries and parks the
                    // first send: parked is the only stable read gate — the
                    // cold attach of a second Session takes as long as it
                    // takes, and any row-count predicate races ahead of it.
                    support.awaitLog(caseDir, "driver-" + tag + ".log",
                            "FG7_CLAIM_PARKED", driver);
                    abortPageRead(tenant, channelId);
                    List<String> sending = pageIdentify(tenant, channelId, 1);
                    assertThat(sending)
                            .containsExactlyInAnyOrder(firstDelivery,
                                    secondDelivery);
                    Files.writeString(release, "go");
                    assertThat(driver.waitFor(150, TimeUnit.SECONDS))
                            .as("parked driver completion").isTrue();
                    assertThat(driver.exitValue())
                            .as(HostedChannelGateSupport.safeRead(caseDir
                                    .resolve("driver-" + tag + ".log")))
                            .isZero();
                    await("both delivered", 60, () -> {
                        for (String delivery : List.of(firstDelivery,
                                secondDelivery)) {
                            Map<String, Object> row = support.ledger(tenant,
                                    channelId, delivery);
                            Map<String, Object> projection = support
                                    .deliveryProjection(tenant,
                                            delivery.equals(firstDelivery)
                                                    ? firstSession
                                                    : secondSession,
                                            delivery);
                            if (row == null
                                    || !"delivered".equals(row.get("state"))
                                    || projection == null
                                    || !"delivered".equals(projection.get(
                                            "delivery_state"))) {
                                return null;
                            }
                        }
                        return true;
                    });
                    assertThat(pageIdentify(tenant, channelId, 1))
                            .as("the aborted client's re-read meets no"
                                    + " duplicates and no gaps")
                            .containsExactly(sending.toArray(String[]::new));
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
            }
            case "delivery-state-progress" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                readDelivery(tenant, channelId, deliveryId, 404);
                Path release = caseDir.resolve("smtp-release");
                HostedChannelGateSupport.DriverLaunch launch = startParkedPull(
                        caseDir, base, release);
                Process driver = launch.process();
                String tag = launch.tag();
                try {
                    support.awaitLog(caseDir, "driver-" + tag + ".log",
                            "FG7_CLAIM_PARKED", driver);
                    assertThat(readDelivery(tenant, channelId, deliveryId, 200)
                            .path("state").asText())
                            .as("the read follows the ledger, never ahead")
                            .isEqualTo("sending");
                    Files.writeString(release, "go");
                    assertThat(driver.waitFor(120, TimeUnit.SECONDS)).isTrue();
                    assertThat(driver.exitValue())
                            .as(HostedChannelGateSupport.safeRead(caseDir
                                    .resolve("driver-" + tag + ".log")))
                            .isZero();
                    await("ledger delivered", 60, () -> {
                        Map<String, Object> row = support.ledger(tenant,
                                channelId, deliveryId);
                        return row != null
                                && "delivered".equals(row.get("state"))
                                        ? true : null;
                    });
                    JsonNode after = readDelivery(tenant, channelId,
                            deliveryId, 200);
                    assertThat(after.path("state").asText())
                            .as("no read reports delivered before the receipt"
                                    + " commit")
                            .isEqualTo("delivered");
                    assertThat(after.path("provider_receipt").asText())
                            .isNotBlank();
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
            }
            case "provider-ambiguous" -> {
                JsonNode results = support.drive(caseDir, "full-turn", base,
                        Map.of("smtpMode", "accept-timeout"));
                assertThat(results.path("sends"))
                        .as("the ambiguous send is never retried").hasSize(1);
                HostedChannelGateSupport.assertSendsTo(results);
                assertThat(results.path("receipts").get(0).path("outcome")
                        .asText()).isEqualTo("unknown");
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = results.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                JsonNode record = support.deliveryRecord(tenant, sessionId,
                        deliveryId);
                assertThat(record.path("run").path("delivery").path("state")
                        .asText()).isEqualTo("unknown");
                assertThat(record.path("segments").get(0).path("receipt")
                        .isNull())
                        .as("unknown never masquerades as a receipt")
                        .isTrue();
                assertThat(support.ledger(tenant, channelId, deliveryId)
                        .get("state")).isEqualTo("unknown");
            }
            case "receipt-never-arrived" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                HostedChannelGateSupport.DriverLaunch launch = support
                        .startDriver(caseDir, "pull-terminate", base,
                                Map.of());
                Process driver = launch.process();
                String tag = launch.tag();
                try {
                    support.awaitLog(caseDir, "driver-" + tag + ".log",
                            "FG7_AWAIT_KILL", driver);
                    driver.destroyForcibly();
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
                assertThat(support.claimRows(tenant, channelId)).isEqualTo(1);
                support.expireClaims(tenant, channelId);
                spring.getBean(ManagedChannelService.class).reconcile();
                await("the lease settles unknown", 30,
                        () -> "unknown".equals(support.deliveryProjection(
                                tenant, sessionId, deliveryId)
                                        .get("delivery_state"))
                                ? true : null);
                JsonNode terminated = support.resultsOf(caseDir, tag);
                assertThat(terminated.path("sends")).hasSize(1);
                HostedChannelGateSupport.assertSendsTo(terminated);
                Map<String, Object> originalRow = support.ledger(tenant,
                        channelId, deliveryId);
                JsonNode cold = support.drive(caseDir, "resume-cold", base);
                HostedChannelGateSupport.assertSendsEmpty(cold,
                        "a cold adapter never auto-resends");
                JsonNode resent = support.drive(caseDir, "resend", base,
                        Map.of("resendDeliveryId", deliveryId));
                assertThat(resent.path("resent").path("possibleDuplicate")
                        .asBoolean()).as("a resend always warns").isTrue();
                String resendId = resent.path("resent").path("deliveryId")
                        .asText();
                assertThat(resendId).isEqualTo(deliveryId + ":r1");
                assertThat(resent.path("resent").path("resentFrom").asText())
                        .isEqualTo(deliveryId);
                assertThat(resent.path("sends")).hasSize(1);
                HostedChannelGateSupport.assertSendsTo(resent);
                assertThat(resent.path("sends").get(0).path("messageId")
                        .asText()).isNotEqualTo(terminated.path("sends").get(0)
                        .path("messageId").asText());
                assertThat(support.deliveryProjection(tenant, sessionId,
                        deliveryId).get("delivery_state"))
                        .as("the original stays unknown")
                        .isEqualTo("unknown");
                assertThat(support.ledger(tenant, channelId, resendId)
                        .get("state")).isEqualTo("delivered");
                Map<String, Object> resendRow = support.ledger(tenant,
                        channelId, resendId);
                assertThat(resendRow.get("segment_id"))
                        .as("the resend repeats the same segment identity")
                        .isEqualTo(originalRow.get("segment_id"));
                assertThat(resendRow.get("segment_ordinal"))
                        .isEqualTo(originalRow.get("segment_ordinal"));
                assertThat(support.claimRows(tenant, channelId)).isEqualTo(2);
            }
            case "out-of-plan-ordinal" -> {
                JsonNode admitted = support.drive(caseDir, "admit", base);
                String sessionId = support.channelSession(tenant, channelId);
                String deliveryId = admitted.path("admissionInputIds").get(0)
                        .asText() + ":reply";
                awaitPlanned(tenant, sessionId, deliveryId);
                Path release = caseDir.resolve("smtp-release");
                HostedChannelGateSupport.DriverLaunch launch = startParkedPull(
                        caseDir, base, release);
                Process driver = launch.process();
                String tag = launch.tag();
                try {
                    support.awaitLog(caseDir, "driver-" + tag + ".log",
                            "FG7_CLAIM_PARKED", driver);
                    JsonNode probe = support.drive(caseDir, "probe", base,
                            Map.of("probeDeliveryId", deliveryId));
                    assertThat(probe.path("probeStatus").asInt())
                            .as("an out-of-plan ordinal is refused")
                            .isEqualTo(409);
                    assertThat(probe.path("probeErrorCode").asText())
                            .as("the refusal is the missing-segment one")
                            .isEqualTo("channel_operation_conflict");
                    assertThat(support.ledger(tenant, channelId, deliveryId)
                            .get("state"))
                            .as("the refusal advances nothing")
                            .isEqualTo("sending");
                    Files.writeString(release, "go");
                    assertThat(driver.waitFor(120, TimeUnit.SECONDS))
                            .as("parked driver completion").isTrue();
                    assertThat(driver.exitValue())
                            .as(HostedChannelGateSupport.safeRead(caseDir
                                    .resolve("driver-" + tag + ".log")))
                            .isZero();
                    JsonNode settled = support.resultsOf(caseDir, tag);
                    assertThat(settled.path("sends"))
                            .as("recovery re-reads identity; nothing re-sends")
                            .hasSize(1);
                    HostedChannelGateSupport.assertSendsTo(settled);
                    JsonNode record = support.deliveryRecord(tenant, sessionId,
                            deliveryId);
                    assertThat(record.path("segments")).hasSize(1);
                    assertThat(record.path("segments").get(0).path("receipt")
                            .path("providerMessageId").asText())
                            .isEqualTo(settled.path("sends").get(0)
                                    .path("messageId").asText());
                    assertThat(support.claimRows(tenant, channelId))
                            .isEqualTo(1);
                } finally {
                    if (driver.isAlive()) {
                        driver.destroyForcibly();
                    }
                }
            }
            default -> throw new IllegalArgumentException(fault);
        }
    }

    private void fg7bStoreFailure(String tenant, String fault,
            CapturedOutput output, Path caseDir) throws Exception {
        Path stateDir = Files.createDirectories(caseDir.resolve("state"));
        Map<String, Object> base = support.caseBase(tenant, fault, stateDir,
                internalPort);
        String channelId = "fg7-" + fault;
        List<String> triggers = new ArrayList<>();
        try {
            switch (fault) {
                case "route-admit" -> {
                    createChannelTrigger(tenant, channelId,
                            "ma_operation", "BEFORE UPDATE",
                            "NEW.state = 'admitted' AND OLD.state = 'staged'",
                            "FG7B_route-admit", triggers);
                    JsonNode refused = support.drive(caseDir, "admit-attempt",
                            base);
                    assertThat(refused.path("pendingAfterAttempt").asInt())
                            .as("the refused binding stays visibly pending")
                            .isEqualTo(1);
                    assertThat(output).contains(
                            "java.sql.SQLException: FG7B_route-admit");
                    String sessionId = support.channelSession(tenant,
                            channelId);
                    await("the Harness committed the route revision", 60,
                            () -> support.routeProjection(tenant,
                                    sessionId) != null ? true : null);
                    assertThat(support.routeRow(tenant, channelId)
                            .get("state")).isEqualTo("staged");
                    for (String trigger : triggers) {
                        jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
                    }
                    triggers.clear();
                    JsonNode admitted = support.drive(caseDir, "admit", base);
                    assertThat(admitted.path("admissionInputIds")).hasSize(1);
                    assertThat(support.inputAcceptedCount(tenant, sessionId))
                            .as("the replay never commits a second input")
                            .isEqualTo(1);
                    assertThat(modelCallsFor(fault))
                            .as("the replay never re-runs the turn")
                            .isEqualTo(1);
                    JsonNode replayed = support.drive(caseDir, "pull", base);
                    assertThat(replayed.path("sends")).hasSize(1);
                    HostedChannelGateSupport.assertSendsTo(replayed);
                    assertThat(((Number) support.routeProjection(tenant,
                            sessionId).get("revision")).intValue())
                            .isEqualTo(1);
                }
                case "delivery-commit" -> {
                    createChannelTrigger(tenant, channelId,
                            "ma_delivery", "BEFORE UPDATE",
                            "OLD.transport_state = 'sending' AND NEW.transport_state = 'delivered'",
                            "FG7B_delivery-commit", triggers);
                    JsonNode first = support.drive(caseDir, "full-turn", base,
                            Map.of("exitAfterFirstReceiptError", true));
                    assertThat(first.path("receiptErrors").asInt()).isEqualTo(1);
                    assertThat(first.path("sends")).hasSize(1);
                    HostedChannelGateSupport.assertSendsTo(first);
                    assertThat(output).contains(
                            "java.sql.SQLException: FG7B_delivery-commit");
                    String sessionId = support.channelSession(tenant,
                            channelId);
                    String deliveryId = first.path("admissionInputIds").get(0)
                            .asText() + ":reply";
                    assertThat(support.deliveryProjection(tenant, sessionId,
                            deliveryId).get("delivery_state"))
                            .as("the record committed before the ledger")
                            .isEqualTo("delivered");
                    assertThat(support.ledger(tenant, channelId, deliveryId)
                            .get("state"))
                            .as("the failed commit blocks the delivery")
                            .isEqualTo("sending");
                    for (String trigger : triggers) {
                        jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
                    }
                    triggers.clear();
                    JsonNode resumed = support.drive(caseDir, "resume-cold",
                            base);
                    HostedChannelGateSupport.assertSendsEmpty(resumed,
                            "recovery never re-sends");
                    assertThat(resumed.path("receipts")).hasSize(1);
                    Map<String, Object> row = support.ledger(tenant, channelId,
                            deliveryId);
                    assertThat(row.get("state")).isEqualTo("delivered");
                    assertThat(row.get("provider_receipt")).isEqualTo(first
                            .path("sends").get(0).path("messageId").asText());
                    assertThat(support.claimRows(tenant, channelId))
                            .isEqualTo(1);
                }
                case "commit-reply-restart" -> {
                    JsonNode first = support.drive(caseDir, "full-turn", base,
                            Map.of("dropVerb", "receipt",
                                    "exitAfterFirstReceiptError", true));
                    assertThat(first.path("receiptErrors").asInt()).isEqualTo(1);
                    assertThat(HostedChannelGateSupport.relayCount(first,
                            "receipt", true)).isEqualTo(1);
                    JsonNode resumed = support.drive(caseDir, "resume-cold",
                            base);
                    HostedChannelGateSupport.assertSendsEmpty(resumed,
                            "a cold adapter never re-sends");
                    assertThat(resumed.path("receipts")).hasSize(1);
                    String deliveryId = first.path("admissionInputIds").get(0)
                            .asText() + ":reply";
                    Map<String, Object> row = support.ledger(tenant, channelId,
                            deliveryId);
                    assertThat(row.get("state")).isEqualTo("delivered");
                    assertThat(row.get("provider_receipt")).isEqualTo(first
                            .path("sends").get(0).path("messageId").asText());
                    assertThat(support.ledgerRows(tenant, channelId))
                            .as("no duplicate delivery rows").isEqualTo(1);
                    assertThat(support.channelSession(tenant, channelId))
                            .isNotBlank();
                }
                default -> throw new IllegalArgumentException(fault);
            }
        } finally {
            for (String trigger : triggers) {
                jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
            }
        }
    }
}
