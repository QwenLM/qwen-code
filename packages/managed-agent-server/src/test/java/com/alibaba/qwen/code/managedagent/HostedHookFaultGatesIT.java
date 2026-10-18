package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
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
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertAll;

// FG13c (issues #14054/#14449): the Hook owner-restart matrix. A managed
// command Hook is a decision gate with a process behind it — the command
// runs in the Runtime worker's delegated cgroup unit and the receipt lives
// in that worker's memory. A Harness restart can read the receipt through
// the record's original owner and settle honestly; a worker loss cannot,
// and must stay unknown. These cells kill the packaged Harness, the
// durable worker and the Hook command for real against JDBC ground truth.
@EnabledOnOs(OS.LINUX)
class HostedHookFaultGatesIT {
    private static final String PROFILE = "hosted-workspace-files/1";
    private static final String TOKEN = "hook-fault-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private static final String PROOF = "FG13_HOOK_TOOL_PROOF";
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "hook-fault-" + UUID.randomUUID();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
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

    @Test
    @Timeout(300)
    void fg13cHarnessKillDuringCommandSettlesFromTheOriginalReceiptOnMySql() throws Exception {
        boot("30000", "default");
        JsonNode definition = api("POST", "/v1/agents", definition(), "definition", 202);
        String session = createSession(definition.path("id").asText(), "initial");
        submit(session, "FG13_HARNESS_KILL");
        waitFor(() -> {
            assertThat(events("hook.call")).hasSize(1);
            assertThat(events("hook.child")).hasSize(1);
        });
        JsonNode hook = events("hook.call").getFirst();
        JsonNode child = events("hook.child").getFirst();
        assertThat(running(hook)).isTrue();
        assertThat(running(child)).isTrue();
        assertThat(Files.readString(cgroup(hook).resolve("cgroup.events"))).contains("populated 1");
        JsonNode executionBefore = hookExecution(session);
        String executionId = executionBefore.path("hookExecutionId").asText();
        String runtimeSessionId = executionBefore.path("runtimeSessionId").asText();
        JsonNode worker = worker(session);
        int generation = generation(session);

        // The kill must land while the gate still holds: a command that had
        // already allowed would let the old Harness settle the record, and
        // the later status read would pass without proving anything.
        assertThat(events("hook.allow")).as("Hook still holding at the kill").isEmpty();
        replaceHarness();
        // The public POST can be refused by the control plane's active-Turn
        // check before it reaches the Harness, so it is a refusal probe, not
        // the reconciliation trigger.
        submitRefused(session, "FG13_AFTER");
        waitFor(() -> assertThat(events("hook.allow")).hasSize(1));
        waitFor(() -> assertThat(running(hook)).isFalse());
        waitFor(() -> assertThat(running(child)).isFalse());
        assertThat(worker(session)).isEqualTo(worker);
        assertThat(generation(session)).isEqualTo(generation);
        // The replacement Harness holds no receipt, but the record's
        // runtimeSessionId still names the worker that does. Read the
        // operation through the Harness status route: it asks that original
        // owner and settles the record from the receipt still in the
        // worker's memory. The status route is also the attachment probe —
        // a 404 means this Harness does not serve the Session yet, and only
        // then is a passive re-attach worth asking for.
        HarnessConnector connector = spring.getBean(HarnessConnector.class);
        long[] attachedAt = {0};
        waitFor(() -> {
            HarnessAttach attach = attachment(connector, session);
            if (attach != null) {
                var status = hookStatus(session, executionId, attach);
                if (status.statusCode() == 200) {
                    assertThat(json.readTree(status.body()).path("state").asText()).isEqualTo("settled");
                    return;
                }
                // A missing Session and a stale process generation both mean
                // this attachment cannot serve the route; anything else is a
                // real refusal and should fail with its own body.
                assertThat(json.readTree(status.body()).path("code").asText())
                        .as("hook status: %s", status.body())
                        .isIn("hosted_session_not_found", "hosted_harness_generation_mismatch");
            }
            // A Session the coordinator already attached is resident with a
            // Hook-pending Turn, and a second passive load of it is refused;
            // retry at most once a second so that attachment can win.
            String refusal = null;
            if (System.nanoTime() - attachedAt[0] > 1_000_000_000L) {
                attachedAt[0] = System.nanoTime();
                try {
                    connector.createOrLoad(tenant, session, true, true);
                } catch (RuntimeException refused) {
                    refusal = refused.getMessage();
                }
            }
            throw new AssertionError("no attachment is serving the Hook status route yet"
                    + (refusal == null ? "" : ": " + refusal));
        });
        waitFor(() -> assertThat(hookExecution(session).at("/run/state").asText()).isEqualTo("settled"));
        assertThat(worker(session)).isEqualTo(worker);
        assertThat(generation(session)).isEqualTo(generation);
        JsonNode executionAfter = hookExecution(session);
        assertThat(executionAfter.path("resultRef").isNull()).isFalse();
        assertThat(executionAfter.path("hookExecutionId").asText()).isEqualTo(executionId);
        assertThat(executionAfter.path("runtimeSessionId").asText()).isEqualTo(runtimeSessionId);
        assertThat(events("hook.call")).hasSize(1);
        assertThat(events("hook.allow")).hasSize(1);
        assertHookUnitsEmpty();
        assertThat(modelFailure.get()).isNull();
    }

    @Test
    @Timeout(300)
    void fg13cWorkerKillLeavesTheHookUnknownAndKeepsTheSessionOnMySql() throws Exception {
        boot("-1", "default");
        JsonNode definition = api("POST", "/v1/agents", definition(), "definition", 202);
        String session = createSession(definition.path("id").asText(), "initial");
        submit(session, "FG13_WORKER_KILL");
        waitFor(() -> {
            assertThat(events("hook.call")).hasSize(1);
            assertThat(events("hook.child")).hasSize(1);
        });
        assertThat(events("hook.allow")).isEmpty();
        JsonNode hook = events("hook.call").getFirst();
        JsonNode child = events("hook.child").getFirst();
        JsonNode worker = worker(session);
        int generation = generation(session);

        assertThat(running(worker)).as("worker alive before SIGKILL").isTrue();
        assertThat(ProcessHandle.of(worker.path("pid").asLong()).orElseThrow().destroyForcibly()).isTrue();
        waitFor(() -> assertThat(running(worker)).isFalse());
        waitFor(() -> {
            JsonNode execution = hookExecution(session);
            assertThat(execution.at("/run/state").asText()).isEqualTo("recovery_blocked");
            assertThat(execution.at("/run/execution").asText()).isEqualTo("outcome_unknown");
        });
        assertThat(events("hook.call")).hasSize(1);
        assertThat(events("hook.allow")).isEmpty();
        // The worker loss is the accepted H2 limit: the command and its
        // descendant outlive the worker with no owner, receipt or timer.
        assertThat(running(hook)).isTrue();
        assertThat(running(child)).isTrue();
        assertThat(Files.readString(cgroup(hook).resolve("cgroup.events"))).contains("populated 1");
        JsonNode refused = api("POST", "/v1/agents/sessions/" + session + "/close", null, "close", 409, 503);
        assertThat(refused.toString()).containsAnyOf("turn_active", "runtime_reconciliation_required");
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isNotEqualTo("CLOSED");
        assertThat(generation(session)).isEqualTo(generation);
        JsonNode after = hookExecution(session);
        assertThat(after.at("/run/state").asText()).isEqualTo("recovery_blocked");
        assertThat(after.at("/run/execution").asText()).isEqualTo("outcome_unknown");
        assertThat(modelFailure.get()).isNull();
    }

    @Test
    @Timeout(300)
    void fg13cCommandKillBlocksAndRecordsNonBlockingErrorOnMySql() throws Exception {
        boot("-1", "hook-solo");
        JsonNode definition = api("POST", "/v1/agents", definition(), "definition", 202);
        String session = createSession(definition.path("id").asText(), "initial");
        submit(session, "FG13_COMMAND_KILL");
        waitFor(() -> assertThat(events("hook.call")).hasSize(1));
        JsonNode hook = events("hook.call").getFirst();
        assertThat(running(hook)).isTrue();
        assertThat(Files.readString(cgroup(hook).resolve("cgroup.events"))).contains("populated 1");
        assertThat(ProcessHandle.of(hook.path("pid").asLong()).orElseThrow().destroyForcibly()).isTrue();
        waitFor(() -> assertThat(running(hook)).isFalse());
        waitFor(() -> {
            JsonNode execution = hookExecution(session);
            assertThat(execution.at("/run/state").asText()).isEqualTo("settled");
            assertThat(execution.at("/run/execution").asText()).isEqualTo("settled");
        });
        assertThat(events("hook.call")).hasSize(1);
        assertThat(events("hook.child")).isEmpty();
        assertThat(hookResult(session).path("outcome").asText()).isEqualTo("non_blocking_error");
        // The decision gate turned the killed command into a block: the tool
        // never reached the model as an executed read.
        waitFor(() -> assertThat(modelRequests.toString()).contains("Hook evaluation failed."));
        assertThat(modelRequests.toString()).doesNotContain(PROOF);
        assertHookUnitsEmpty();
        assertThat(modelFailure.get()).isNull();
    }

    private void boot(String holdMs, String signalMode) throws Exception {
        assertThat(System.getProperty("mysql.url")).as("Hook fault gates require disposable MySQL 8.4")
                .startsWith("jdbc:mysql:");
        node = System.getProperty("node.executable");
        assertThat(node).isNotBlank();
        cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        temporary = temporary.toRealPath();
        workspace = Files.createDirectories(temporary.resolve("workspace/child"));
        Files.writeString(workspace.resolve("proof.txt"), PROOF);
        Files.setLastModifiedTime(workspace.getParent(), FileTime.fromMillis(1));
        Files.createDirectory(temporary.resolve("decoy"));
        Files.createDirectory(temporary.resolve("broker"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        evidence = temporary.resolve("processes.jsonl");
        String delegated = System.getenv("QWEN_MANAGED_HOOK_CGROUP_ROOT");
        assertThat(delegated).as("Run Maven inside a delegated Linux cgroup v2 subtree").isNotBlank();
        hookRoot = Files.createDirectory(Path.of(delegated).resolve("hook-fault-" + UUID.randomUUID()));
        Path program = temporary.resolve("hook-fault-process.mjs");
        try (var resource = getClass().getResourceAsStream("/hosted-hook-fault-process.mjs")) {
            assertThat(resource).isNotNull();
            Files.copy(resource, program);
        }
        hookDigest = DigestUtils.sha256Hex("hook:" + Files.readString(program));
        Map<String, Object> hook = new java.util.LinkedHashMap<>(Map.of("hookId", "pre", "eventName", "PreToolUse",
                "sequential", false, "failClosed", true, "async", false, "config", Map.of("type", "command", "command",
                        quote(node) + " " + quote(program.toString()) + " hook " + quote(evidence.toString())
                                + " " + quote(holdMs) + " " + quote(signalMode), "timeout", 60000)));
        hook.put("onceKey", null);
        json.writeValue(temporary.resolve("hooks.json").toFile(), Map.of("version", 1, "catalogs", List.of(
                Map.of("tenantId", tenant, "workspaceId", "workspace", "catalogId", "fg13-hooks",
                        "catalogRevision", 1, "definitionDigest", catalogDigest(), "hooks", List.of(hook)))));
        Path worker = temporary.resolve("worker.mjs");
        Files.writeString(worker, "process.env.QWEN_MANAGED_HOOK_CONFIG="
                + json.writeValueAsString(temporary.resolve("hooks.json").toString())
                + "; process.env.QWEN_MANAGED_HOOK_CGROUP_ROOT=" + json.writeValueAsString(hookRoot.toString())
                + "; process.argv[1]=" + json.writeValueAsString(cli.toString())
                + "; await import(" + json.writeValueAsString(cli.toUri().toString()) + ");\n");
        try (var control = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
                var hosted = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
                var runtime = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            port = control.getLocalPort();
            harnessPort = hosted.getLocalPort();
            brokerPort = runtime.getLocalPort();
        }
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelExecutor = Executors.newVirtualThreadPerTaskExecutor();
        model.setExecutor(modelExecutor);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .run("--server.address=127.0.0.1", "--server.port=" + port,
                        "--spring.datasource.url=" + System.getProperty("mysql.url"),
                        "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                        "--spring.datasource.username=" + System.getProperty("mysql.user"),
                        "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                        "--qwen.managed-agent.trusted-actor-header=X-Qwen-Actor-Id",
                        "--qwen.managed-agent.definition-tool-profiles=" + PROFILE,
                        "--qwen.managed-agent.session-store.enabled=true",
                        "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + port,
                        "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                        "--qwen.managed-agent.session-store.writer-lease-duration=3s",
                        "--qwen.managed-agent.harness.enabled=true",
                        "--qwen.managed-agent.harness.workspace-files-enabled=true",
                        "--qwen.managed-agent.harness.base-url=http://127.0.0.1:" + harnessPort,
                        "--qwen.managed-agent.harness.token=" + TOKEN,
                        "--qwen.managed-agent.harness.capability-digest=" + CAPABILITY,
                        "--qwen.managed-agent.runtime-broker.enabled=true",
                        "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                        "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                        "--qwen.managed-agent.runtime-broker.durable-local-process=true",
                        "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                        "--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled=true",
                        "--qwen.managed-agent.runtime-broker.workspace-cwd=" + temporary.resolve("decoy"),
                        "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("broker"),
                        "--qwen.managed-agent.runtime-broker.credential-key-id=hook-fault",
                        "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                        "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                        "--qwen.managed-agent.runtime-broker.worker-entry=" + worker,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + workspace.getParent());
        jdbc = spring.getBean(JdbcTemplate.class);
        spring.getBean(WorkspaceStorageGuard.class).register(tenant, "storage", UUID.randomUUID().toString());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage', 'Hooks', ?, ?, 'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        startHarness();
    }

    private String catalogDigest() {
        return DigestUtils.sha256Hex(hookDigest + 1);
    }

    private Map<String, Object> definition() {
        return Map.of("model", Map.of(), "instructions", "Exercise the pinned Hook gate.",
                "tools", List.of(Map.of("type", "hosted_profile", "profile", PROFILE)),
                "permission_policy", Map.of("approval_mode", "yolo"),
                "hook_catalog", Map.of("catalog_id", "fg13-hooks", "catalog_revision", 1,
                        "definition_digest", catalogDigest()));
    }

    private String createSession(String agent, String key) throws Exception {
        return api("POST", "/v1/agents/sessions", Map.of("agent_id", agent, "input", List.of(),
                "workspace", Map.of("workspace_id", "workspace", "cwd_relative", "child")), key, 202)
                .path("id").asText();
    }

    private String submit(String session, String prompt) throws Exception {
        return api("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type", "agent.session.input.message",
                "input", List.of(Map.of("type", "input_text", "text", prompt))), prompt, 202).path("turn_id").asText();
    }

    /** The post-kill admission is refused while the Hook still runs. */
    private void submitRefused(String session, String prompt) throws Exception {
        api("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type", "agent.session.input.message",
                "input", List.of(Map.of("type", "input_text", "text", prompt))), prompt, 409);
    }

    private JsonNode hookExecution(String session) {
        List<JsonNode> records = HostedGateTestSupport.extensionRecords(jdbc, tenant, session, "hook_execution").stream()
                .filter(record -> !"__plan__".equals(record.path("hookId").asText()))
                .toList();
        assertThat(records).as("hook execution records").hasSize(1);
        assertThat(records.getFirst().path("eventName").asText()).isEqualTo("PreToolUse");
        return records.getFirst();
    }

    private JsonNode hookResult(String session) throws Exception {
        JsonNode ref = hookExecution(session).path("resultRef");
        assertThat(ref.isNull()).as("hook result ref").isFalse();
        String body = jdbc.queryForObject("SELECT CONVERT(inline_bytes USING utf8mb4) FROM ma_resource"
                + " WHERE session_scope_key = ? AND resource_id = ? AND tenant_id = ? AND session_id = ?",
                String.class, ManagedSessionStore.sessionScopeKey(tenant, session),
                ref.path("resourceId").asText(), tenant, session);
        return json.readTree(body);
    }

    // The Harness status route identifies the caller by the client id its
    // attach minted and the process generation it attached to; the connector
    // keeps both on the private attachment ref.
    private record HarnessAttach(String clientId, String bootId) {}

    private HarnessAttach attachment(HarnessConnector connector, String session) throws Exception {
        Field field = connector.getClass().getDeclaredField("attachments");
        field.setAccessible(true);
        for (Object value : ((Map<?, ?>) field.get(connector)).values()) {
            if (value instanceof HarnessSessionRef ref && session.equals(ref.getHarnessSessionId())) {
                return new HarnessAttach(ref.getHarnessClientId(), ref.getHarnessBootId());
            }
        }
        return null;
    }

    private HttpResponse<String> hookStatus(String session, String executionId, HarnessAttach attach) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + harnessPort
                        + "/session/" + session + "/hooks/operations/" + executionId))
                .timeout(Duration.ofSeconds(10)).header("Authorization", "Bearer " + TOKEN)
                .header("X-Qwen-Client-Id", attach.clientId())
                .header("X-Qwen-Harness-Protocol-Version", "1")
                .header("X-Qwen-Harness-Boot-Id", attach.bootId()).GET().build();
        return http.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private int generation(String session) {
        return jdbc.queryForObject("SELECT runtime_generation FROM ma_runtime_binding WHERE tenant_id = ? AND isolation_key = ?",
                Integer.class, tenant, session);
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
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
        json.writeValue(config.resolve("settings.json").toFile(), Map.of("security", Map.of("auth", Map.of("selectedType", "openai")),
                "telemetry", Map.of("enabled", false), "model", Map.of("name", "hook-fault-fixture"),
                "modelProviders", Map.of("openai", List.of(Map.of("id", "hook-fault-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl)))));
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(), "serve", "--profile", "hosted-harness",
                "--http-bridge", "--hostname", "127.0.0.1", "--port", Integer.toString(harnessPort), "--require-auth",
                "--no-web", "--workspace", temporary.resolve("decoy").toString(), "--managed-runtime-broker-url",
                "http://127.0.0.1:" + brokerPort, "--managed-runtime-broker-token", TOKEN)
                .directory(temporary.resolve("decoy").toFile()).redirectErrorStream(true)
                .redirectOutput(temporary.resolve("harness-" + boots + ".log").toFile());
        var env = builder.environment();
        env.clear();
        env.put("PATH", System.getenv("PATH"));
        env.putAll(Map.of("HOME", home.toString(), "QWEN_HOME", config.toString(), "QWEN_RUNTIME_DIR", home.resolve("runtime").toString(),
                "OPENAI_API_KEY", "fixture-only", "OPENAI_BASE_URL", modelUrl, "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", CAPABILITY,
                "QWEN_CODE_MODELS_DEV_REFRESH", "off"));
        for (String key : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH", "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            env.put(key, home.resolve(key + ".json").toString());
        }
        harness = builder.start();
        waitFor(() -> {
            assertThat(harness.isAlive()).as("Harness log: %s", temporary.resolve("harness-" + boots + ".log")).isTrue();
            assertThat(http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + harnessPort + "/capabilities"))
                    .timeout(Duration.ofSeconds(2)).header("Authorization", "Bearer " + TOKEN).build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(200);
        });
    }

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode request = json.readTree(exchange.getRequestBody());
            modelRequests.add(request);
            String prompt = "";
            List<JsonNode> results = new ArrayList<>();
            for (JsonNode message : request.path("messages")) {
                if ("user".equals(message.path("role").asText()) && message.path("content").toString().contains("FG13_")) {
                    String text = message.path("content").toString();
                    var matcher = java.util.regex.Pattern.compile("FG13_[A-Z_]+").matcher(text);
                    prompt = "";
                    while (matcher.find()) {
                        prompt = matcher.group();
                    }
                    results.clear();
                } else if ("tool".equals(message.path("role").asText())) {
                    results.add(message);
                }
            }
            assertThat(prompt).isNotBlank();
            List<String> names = new ArrayList<>();
            request.path("tools").forEach(tool -> names.add(tool.at("/function/name").asText()));
            assertThat(names).contains("read_file");
            boolean call = results.isEmpty()
                    && List.of("FG13_HARNESS_KILL", "FG13_WORKER_KILL", "FG13_COMMAND_KILL").contains(prompt);
            var chunk = json.createObjectNode().put("id", "hook-fault").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", "hook-fault-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            if (call) {
                delta.putArray("tool_calls").addObject().put("index", 0).put("id", "call_" + prompt)
                        .put("type", "function").putObject("function").put("name", "read_file")
                        .put("arguments", json.writeValueAsString(Map.of("file_path", "proof.txt")));
            } else {
                delta.put("content", "FG13_DONE_" + prompt);
            }
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", call ? "tool_calls" : "stop");
            byte[] response = (first + "data: " + json.writeValueAsString(chunk) + "\n\ndata: [DONE]\n\n")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
        } catch (Exception | AssertionError failure) {
            modelFailure.compareAndSet(null, failure);
        } finally {
            exchange.close();
        }
    }

    private JsonNode worker(String session) throws Exception {
        String binding = jdbc.queryForObject("SELECT binding_id FROM ma_runtime_binding WHERE tenant_id = ? AND isolation_key = ?",
                String.class, tenant, session);
        JsonNode handle = json.readTree(jdbc.queryForObject("SELECT resource_handle_json FROM ma_runtime_binding WHERE binding_id = ?",
                String.class, binding));
        JsonNode registration = json.readTree(Files.readString(temporary.resolve("broker").resolve(handle.path("resourceId").asText() + ".json")));
        return json.createObjectNode().put("binding", binding).put("pid", registration.path("pid").asLong())
                .put("startTicks", registration.path("started").asText().replace("ticks:", ""))
                .put("bootId", handle.path("bootId").asText());
    }

    private boolean running(JsonNode process) throws Exception {
        if (!Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).strip().equals(process.path("bootId").asText())) {
            return false;
        }
        Path stat = Path.of("/proc", process.path("pid").asText(), "stat");
        String value;
        try {
            value = Files.readString(stat);
        } catch (NoSuchFileException stopped) {
            return false;
        }
        String[] fields = value.substring(value.lastIndexOf(')') + 2).split(" ");
        return !"Z".equals(fields[0]) && fields[19].equals(process.path("startTicks").asText());
    }

    private Path cgroup(JsonNode process) {
        Path path = Path.of("/sys/fs/cgroup" + process.path("cgroup").asText().substring(3));
        assertThat(path).startsWith(hookRoot);
        return path;
    }

    private void assertHookUnitsEmpty() throws Exception {
        try (var units = Files.list(hookRoot)) {
            for (Path unit : units.filter(Files::isDirectory).toList()) {
                assertThat(Files.readString(unit.resolve("cgroup.events"))).contains("populated 0");
            }
        }
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

    private JsonNode api(String method, String path, Object body, String key, int... expected) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(60)).header("X-Qwen-Tenant-Id", tenant).header("X-Qwen-Actor-Id", "actor")
                .header("Content-Type", "application/json").method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        var response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("%s %s: %s", method, path, response.body()).isIn(java.util.Arrays.stream(expected).boxed().toList());
        return json.readTree(response.body());
    }

    private void waitFor(org.junit.jupiter.api.function.Executable assertion) {
        await().atMost(Duration.ofSeconds(60)).ignoreException(java.net.ConnectException.class).failFast(() -> {
            if (modelFailure.get() != null) {
                throw new AssertionError("Model fixture: " + temporary, modelFailure.get());
            }
        }).untilAsserted(assertion::execute);
    }

    private static String quote(String text) {
        return "'" + text.replace("'", "'\"'\"'") + "'";
    }

    @AfterEach
    void stop() {
        assertAll(this::saveEvidence,
                () -> { if (model != null) {
                    model.stop(0);
                } },
                () -> { if (modelExecutor != null) {
                    modelExecutor.close();
                } },
                () -> { if (harness != null) {
                    harness.destroyForcibly();
                    assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
                } },
                () -> { if (evidence != null && Files.exists(evidence)) {
                    for (String kind : List.of("hook.call", "hook.child")) {
                        for (JsonNode process : events(kind)) {
                            if (running(process)) {
                                ProcessHandle.of(process.path("pid").asLong()).orElseThrow().destroyForcibly();
                                await().atMost(Duration.ofSeconds(10)).until(() -> !running(process));
                            }
                        }
                    }
                } },
                () -> { if (spring != null) {
                    spring.close();
                } },
                () -> HostedDurableWorkers.stop(temporary.resolve("broker"), json),
                () -> {
                    if (hookRoot == null) {
                        return;
                    }
                    try (var units = Files.list(hookRoot)) {
                        for (Path unit : units.toList()) {
                            if (Files.exists(unit.resolve("cgroup.kill"))) {
                                Files.writeString(unit.resolve("cgroup.kill"), "1");
                            }
                        }
                    }
                    try (var entries = Files.walk(hookRoot)) {
                        for (Path entry : entries.filter(Files::isDirectory).sorted(Comparator.reverseOrder()).toList()) {
                            Files.delete(entry);
                        }
                    }
                }, http::close);
    }

    private void saveEvidence() throws Exception {
        if (temporary == null) {
            return;
        }
        Path destination = Files.createDirectories(Path.of("target/failsafe-reports/hosted-hook-fault-evidence", tenant));
        System.out.println("HOSTED_HOOK_FAULT_EVIDENCE " + destination.toAbsolutePath());
        json.writeValue(destination.resolve("model-requests.json").toFile(), modelRequests);
        for (String name : List.of("processes.jsonl", "harness-1.log", "harness-2.log")) {
            Path source = temporary.resolve(name);
            if (Files.exists(source)) {
                Files.copy(source, destination.resolve(source.getFileName()));
            }
        }
        if (jdbc != null) {
            json.writeValue(destination.resolve("bindings.json").toFile(), jdbc.queryForList(
                    "SELECT binding_id, runtime_generation, binding_state, isolation_key FROM ma_runtime_binding WHERE tenant_id = ?", tenant));
            json.writeValue(destination.resolve("hook-executions.json").toFile(),
                    jdbc.queryForList("SELECT record_id, domain, state, runtime_state FROM ma_session_record"
                            + " WHERE tenant_id = ? AND domain = 'hook_execution'", tenant));
        }
    }
}
