package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
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
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.quote;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

// FG13f (issue #14449): a MessageDisplay command Hook suppresses the reply,
// the Harness is restarted so the Session is loaded from the store, and the
// next model request must not carry the suppressed text.
@EnabledOnOs(OS.LINUX)
class HostedHookMessageDisplayReloadIT {
    private static final String PROFILE = "hosted-workspace-files/1";
    private static final String TOKEN = "hook-message-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private static final String SECRET = "FG13F_SECRET";
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "hook-message-" + UUID.randomUUID();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure =
            new AtomicReference<>();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private Path cli;
    private Path workspace;
    private Path evidence;
    private Path hookRoot;
    private String node;
    private String hookDigest;
    private int port;
    private int harnessPort;
    private int brokerPort;
    private int boots;
    private HttpServer model;
    private ExecutorService modelExecutor;
    private ServletWebServerApplicationContext spring;
    private JdbcTemplate jdbc;
    private Process harness;

    @BeforeEach
    void boot() throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG13f requires a disposable MySQL")
                .startsWith("jdbc:mysql:");
        node = System.getProperty("node.executable");
        assertThat(node).isNotBlank();
        cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        temporary = temporary.toRealPath();
        workspace = Files.createDirectories(
                temporary.resolve("workspace/child"));
        Files.setLastModifiedTime(workspace.getParent(),
                FileTime.fromMillis(1));
        Files.createDirectory(temporary.resolve("decoy"));
        Files.createDirectory(temporary.resolve("broker"),
                PosixFilePermissions.asFileAttribute(
                        PosixFilePermissions.fromString("rwx------")));
        evidence = temporary.resolve("processes.jsonl");
        String delegated = System.getenv("QWEN_MANAGED_HOOK_CGROUP_ROOT");
        assertThat(delegated)
                .as("Run Maven inside a delegated Linux cgroup v2 subtree")
                .isNotBlank();
        hookRoot = Files.createDirectory(
                Path.of(delegated).resolve("hook-message-" + UUID.randomUUID()));
        Path program = temporary.resolve("hook-message-process.mjs");
        try (var resource = getClass().getResourceAsStream(
                "/hosted-hook-fault-process.mjs")) {
            assertThat(resource).isNotNull();
            Files.copy(resource, program);
        }
        hookDigest = DigestUtils.sha256Hex("hook:"
                + Files.readString(program));
        Map<String, Object> hook = new java.util.LinkedHashMap<>();
        hook.put("hookId", "display");
        hook.put("eventName", "MessageDisplay");
        hook.put("sequential", false);
        hook.put("failClosed", false);
        hook.put("async", false);
        hook.put("config", Map.of("type", "command", "command",
                quote(node) + " " + quote(program.toString()) + " hook "
                        + quote(evidence.toString()) + " " + quote("0") + " "
                        + quote("hook-suppress"), "timeout", 60000));
        hook.put("onceKey", null);
        json.writeValue(temporary.resolve("hooks.json").toFile(),
                Map.of("version", 1, "catalogs", List.of(Map.of("tenantId",
                        tenant, "workspaceId", "workspace", "catalogId",
                        "fg13f-hooks", "catalogRevision", 1,
                        "definitionDigest", catalogDigest(), "hooks",
                        List.of(hook)))));
        Path worker = temporary.resolve("worker.mjs");
        Files.writeString(worker, "process.env.QWEN_MANAGED_HOOK_CONFIG="
                + json.writeValueAsString(
                        temporary.resolve("hooks.json").toString())
                + "; process.env.QWEN_MANAGED_HOOK_CGROUP_ROOT="
                + json.writeValueAsString(hookRoot.toString())
                + "; process.argv[1]="
                + json.writeValueAsString(cli.toString())
                + "; await import("
                + json.writeValueAsString(cli.toUri().toString()) + ");\n");
        try (var control = new ServerSocket(0, 1,
                InetAddress.getByName("127.0.0.1"));
                var hosted = new ServerSocket(0, 1,
                        InetAddress.getByName("127.0.0.1"));
                var runtime = new ServerSocket(0, 1,
                        InetAddress.getByName("127.0.0.1"))) {
            port = control.getLocalPort();
            harnessPort = hosted.getLocalPort();
            brokerPort = runtime.getLocalPort();
        }
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelExecutor = Executors.newVirtualThreadPerTaskExecutor();
        model.setExecutor(modelExecutor);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(
                        "--server.address=127.0.0.1",
                        "--server.port=" + port,
                        "--spring.datasource.url="
                                + System.getProperty("mysql.url"),
                        "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                        "--spring.datasource.username="
                                + System.getProperty("mysql.user"),
                        "--spring.datasource.password="
                                + System.getProperty("mysql.password", ""),
                        "--qwen.managed-agent.trusted-actor-header=X-Qwen-Actor-Id",
                        "--qwen.managed-agent.definition-tool-profiles="
                                + PROFILE,
                        "--qwen.managed-agent.session-store.enabled=true",
                        "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:"
                                + port,
                        "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                        "--qwen.managed-agent.session-store.writer-lease-duration=3s",
                        "--qwen.managed-agent.harness.enabled=true",
                        "--qwen.managed-agent.harness.workspace-files-enabled=true",
                        "--qwen.managed-agent.harness.base-url=http://127.0.0.1:"
                                + harnessPort,
                        "--qwen.managed-agent.harness.token=" + TOKEN,
                        "--qwen.managed-agent.harness.capability-digest="
                                + CAPABILITY,
                        "--qwen.managed-agent.runtime-broker.enabled=true",
                        "--qwen.managed-agent.runtime-broker.port="
                                + brokerPort,
                        "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                        "--qwen.managed-agent.runtime-broker.durable-local-process=true",
                        "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                        "--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled=true",
                        "--qwen.managed-agent.runtime-broker.workspace-cwd="
                                + temporary.resolve("decoy"),
                        "--qwen.managed-agent.runtime-broker.state-directory="
                                + temporary.resolve("broker"),
                        "--qwen.managed-agent.runtime-broker.credential-key-id=hook-message",
                        "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                        "--qwen.managed-agent.runtime-broker.node-executable="
                                + node,
                        "--qwen.managed-agent.runtime-broker.worker-entry="
                                + worker,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id="
                                + tenant,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root="
                                + workspace.getParent());
        jdbc = spring.getBean(JdbcTemplate.class);
        spring.getBean(WorkspaceStorageGuard.class).register(tenant, "storage",
                UUID.randomUUID().toString());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref,"
                + " policy_ref, state) VALUES (?, 'workspace', 1, 'storage',"
                + " 'Hooks', ?, ?, 'ACTIVE')", tenant,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'workspace', ?,"
                + " 'OPERATOR')", tenant,
                "actor".getBytes(StandardCharsets.UTF_8));
        startHarness();
    }

    @Test
    @Timeout(300)
    void fg13fMessageDisplaySuppressionSurvivesReloadOnMySql()
            throws Exception {
        String agent = api("POST", "/v1/agents", definition(), "definition",
                202).path("id").asText();
        String session = createSession(agent, "reload");
        String first = submit(session, "FG13F_TURN1");
        waitFor(() -> assertThat(events("hook.call")).hasSize(1));
        waitFor(() -> assertThat(events("hook.suppress")).hasSize(1));
        waitFor(() -> assertThat(turnStatus(session, first))
                .isEqualTo("COMPLETED"));
        assertThat(events("hook.call").getFirst().path("eventName").asText())
                .isEqualTo("MessageDisplay");
        assertThat(publicRows(session))
                .as("the suppressed text never reaches the ledger")
                .noneMatch(row -> row.contains(SECRET));

        replaceHarness();
        String second = submit(session, "FG13F_TURN2");
        waitFor(() -> assertThat(turnStatus(session, second))
                .isEqualTo("COMPLETED"));
        assertThat(modelRequests.getLast().toString())
                .as("the reloaded history does not carry the suppressed text")
                .doesNotContain(SECRET);
        assertThat(modelRequests.getLast().toString()).contains("FG13F_TURN2");
        assertThat(modelFailure.get()).isNull();
    }

    private String catalogDigest() {
        return DigestUtils.sha256Hex(hookDigest + 1);
    }

    private Map<String, Object> definition() {
        return Map.of("model", Map.of(), "instructions",
                "Reply to the prompt.",
                "tools", List.of(Map.of("type", "hosted_profile", "profile",
                        PROFILE)),
                "permission_policy", Map.of("approval_mode", "yolo"),
                "hook_catalog", Map.of("catalog_id", "fg13f-hooks",
                        "catalog_revision", 1, "definition_digest",
                        catalogDigest()));
    }

    private String createSession(String agent, String key) throws Exception {
        return api("POST", "/v1/agents/sessions", Map.of("agent_id", agent,
                "input", List.of(), "workspace", Map.of("workspace_id",
                        "workspace", "cwd_relative", "child")), key, 202)
                .path("id").asText();
    }

    private String submit(String session, String prompt) throws Exception {
        return api("POST", "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.input.message", "input",
                        List.of(Map.of("type", "input_text", "text", prompt))),
                prompt, 202).path("turn_id").asText();
    }

    private String turnStatus(String session, String turn) {
        return jdbc.queryForObject("SELECT status FROM ma_turn WHERE"
                + " tenant_id = ? AND session_id = ? AND turn_id = ?",
                String.class, tenant, session, turn);
    }

    private List<String> publicRows(String session) {
        return jdbc.queryForList("SELECT data_json FROM ma_public_event"
                + " WHERE tenant_id = ? AND session_id = ?", String.class,
                tenant, session);
    }

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode request = json.readTree(exchange.getRequestBody());
            modelRequests.add(request);
            String prompt = "";
            for (JsonNode message : request.path("messages")) {
                if ("user".equals(message.path("role").asText())
                        && message.path("content").toString().contains(
                                "FG13F_")) {
                    String text = message.path("content").toString();
                    var matcher = java.util.regex.Pattern
                            .compile("FG13F_[A-Z0-9_]+").matcher(text);
                    prompt = "";
                    while (matcher.find()) {
                        prompt = matcher.group();
                    }
                }
            }
            assertThat(prompt).isNotBlank();
            if ("FG13F_TURN2".equals(prompt)) {
                assertThat(request.toString())
                        .as("reloaded history").doesNotContain(SECRET);
            }
            var chunk = json.createObjectNode().put("id", "hook-message")
                    .put("object", "chat.completion.chunk").put("created", 0)
                    .put("model", "hook-message-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            delta.put("content", "FG13F_TURN2".equals(prompt)
                    ? "FG13F_DONE" : SECRET);
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
            byte[] response = (first + "data: "
                    + json.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n").getBytes(
                            StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "text/event-stream");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
        } catch (Exception | AssertionError failure) {
            modelFailure.compareAndSet(null, failure);
        } finally {
            exchange.close();
        }
    }

    private void replaceHarness() throws Exception {
        long original = harness.pid();
        harness.destroyForcibly();
        assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(harness.exitValue()).isEqualTo(137);
        startHarness();
        assertThat(harness.pid()).isNotEqualTo(original);
    }

    private void startHarness() throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home-" + ++boots));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:"
                + model.getAddress().getPort() + "/v1";
        json.writeValue(config.resolve("settings.json").toFile(),
                Map.of("security", Map.of("auth", Map.of("selectedType",
                        "openai")), "telemetry", Map.of("enabled", false),
                        "model", Map.of("name", "hook-message-fixture"),
                        "modelProviders", Map.of("openai", List.of(Map.of(
                                "id", "hook-message-fixture", "envKey",
                                "OPENAI_API_KEY", "baseUrl", modelUrl)))));
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web",
                "--workspace", temporary.resolve("decoy").toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:"
                        + brokerPort, "--managed-runtime-broker-token", TOKEN)
                .directory(temporary.resolve("decoy").toFile())
                .redirectErrorStream(true)
                .redirectOutput(temporary.resolve("harness-" + boots + ".log")
                        .toFile());
        var env = builder.environment();
        env.clear();
        env.put("PATH", System.getenv("PATH"));
        env.putAll(Map.of("HOME", home.toString(), "QWEN_HOME",
                config.toString(), "QWEN_RUNTIME_DIR",
                home.resolve("runtime").toString(), "OPENAI_API_KEY",
                "fixture-only", "OPENAI_BASE_URL", modelUrl,
                "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", CAPABILITY,
                "QWEN_CODE_MODELS_DEV_REFRESH", "off"));
        for (String key : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            env.put(key, home.resolve(key + ".json").toString());
        }
        harness = builder.start();
        waitFor(() -> {
            assertThat(harness.isAlive()).as("Harness log: %s",
                    temporary.resolve("harness-" + boots + ".log")).isTrue();
            HttpResponse<String> capabilities = http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                            + harnessPort + "/capabilities"))
                            .timeout(Duration.ofSeconds(2))
                            .header("Authorization", "Bearer " + TOKEN)
                            .build(), HttpResponse.BodyHandlers.ofString());
            assertThat(capabilities.statusCode()).isEqualTo(200);
        });
    }

    private List<JsonNode> events(String kind) throws Exception {
        if (!Files.exists(evidence)) {
            return List.of();
        }
        List<JsonNode> result = new ArrayList<>();
        for (String line : Files.readAllLines(evidence)) {
            JsonNode event = json.readTree(line);
            if (kind.equals(event.path("event").asText())) {
                result.add(event);
            }
        }
        return result;
    }

    private JsonNode api(String method, String path, Object body, String key,
            int... expected) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(10))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("X-Qwen-Actor-Id", "actor")
                .header("Content-Type", "application/json")
                .method(method, body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(
                                json.writeValueAsString(body)));
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        var response = http.send(request.build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode())
                .as("%s %s: %s", method, path, response.body())
                .isIn(java.util.Arrays.stream(expected).boxed().toList());
        return json.readTree(response.body());
    }

    private void waitFor(org.junit.jupiter.api.function.Executable assertion) {
        await().atMost(Duration.ofSeconds(60))
                .ignoreException(java.net.ConnectException.class)
                .failFast(() -> {
                    if (modelFailure.get() != null) {
                        throw new AssertionError("Model fixture: "
                                + temporary, modelFailure.get());
                    }
                }).untilAsserted(assertion::execute);
    }

    @AfterEach
    void stop() {
        saveEvidence();
        if (model != null) {
            model.stop(0);
        }
        if (modelExecutor != null) {
            modelExecutor.close();
        }
        if (harness != null) {
            harness.destroyForcibly();
            try {
                assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        if (spring != null) {
            spring.close();
        }
        try {
            HostedDurableWorkers.stop(temporary.resolve("broker"), json);
        } catch (Exception stopped) {
            // The worker directory is already gone.
        }
        try {
            if (hookRoot != null) {
                try (var units = Files.list(hookRoot)) {
                    for (Path unit : units.toList()) {
                        if (Files.exists(unit.resolve("cgroup.kill"))) {
                            Files.writeString(unit.resolve("cgroup.kill"), "1");
                        }
                    }
                }
                try (var entries = Files.walk(hookRoot)) {
                    for (Path entry : entries.filter(Files::isDirectory)
                            .sorted(Comparator.reverseOrder()).toList()) {
                        Files.deleteIfExists(entry);
                    }
                }
            }
        } catch (IOException ignored) {
            // Best effort: a still-populated unit keeps the subtree.
        }
        http.close();
    }

    private void saveEvidence() {
        if (jdbc == null) {
            return;
        }
        try {
            Path destination = Files.createDirectories(
                    Path.of("target/fg13-cases", "fg13f", tenant));
            System.out.println("HOSTED_HOOK_MESSAGE_DISPLAY_EVIDENCE "
                    + destination.toAbsolutePath());
            json.writeValue(destination.resolve("events.json").toFile(),
                    jdbc.queryForList("SELECT session_id, turn_id,"
                            + " event_type, terminal FROM ma_public_event"
                            + " WHERE tenant_id = ? ORDER BY sequence_id",
                            tenant));
            json.writeValue(destination.resolve("model-requests.json")
                    .toFile(), modelRequests);
            for (String name : List.of("processes.jsonl",
                    "harness-" + boots + ".log")) {
                Path source = temporary.resolve(name);
                if (Files.exists(source)) {
                    Files.copy(source, destination.resolve(source.getFileName()));
                }
            }
        } catch (IOException ignored) {
            // Evidence is best effort; the assertions already reported.
        }
    }
}
