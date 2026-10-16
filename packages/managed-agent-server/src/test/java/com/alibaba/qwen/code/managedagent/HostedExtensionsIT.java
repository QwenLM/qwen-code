package com.alibaba.qwen.code.managedagent;

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

@EnabledOnOs(OS.LINUX)
class HostedExtensionsIT {
    private static final String PROFILE = "hosted-workspace-mcp/1";
    private static final String TOKEN = "extension-process-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "extensions-" + UUID.randomUUID();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private Path cli;
    private Path workspace;
    private Path evidence;
    private Path hookRoot;
    private Path canaryRoot;
    private String node;
    private String mcpDigest;
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
    private Process canary;

    @Test
    @Timeout(240)
    void publishedExtensionsSurviveHarnessReplacementCancellationAndCloseOnMySql() throws Exception {
        boot();
        JsonNode definition = api("POST", "/v1/agents", definition(1), "definition", 202);
        String agent = definition.path("id").asText();
        String session = createSession(agent, "initial");
        completeTurn(session, "EXT_BASE");
        JsonNode worker = worker(session);
        JsonNode mcp = events("mcp.start").getFirst();
        assertThat(running(worker)).isTrue();
        assertThat(running(mcp)).isTrue();
        assertEffects("EXT_BASE");
        assertThat(api("POST", "/v1/agents/" + agent, definition(2), "revision-two", 202)
                .path("revision").asText()).isEqualTo("2");

        replaceHarness();
        completeTurn(session, "EXT_COLD");
        assertThat(worker(session)).isEqualTo(worker);
        assertThat(events("mcp.start")).containsExactly(mcp);
        assertThat(jdbc.queryForObject("SELECT agent_revision FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isEqualTo("1");
        assertThat(jdbc.queryForObject("SELECT agent_definition_digest FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isEqualTo(definition.path("digest").asText());
        assertEffects("EXT_BASE", "EXT_COLD");

        completeTurn(session, "EXT_DENY");
        assertEffects("EXT_BASE", "EXT_COLD");
        String cancellation = submit(session, "EXT_CANCEL");
        waitFor(() -> assertThat(events("hook.child")).hasSize(1));
        JsonNode child = events("hook.child").getFirst();
        JsonNode hook = events("hook.hold").getFirst();
        assertThat(running(child)).isTrue();
        assertThat(running(hook)).isTrue();
        assertThat(Files.readString(cgroup(child).resolve("cgroup.events"))).contains("populated 1");
        api("POST", "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.cancel", "turn_id", cancellation), "cancel", 202);
        waitFor(() -> {
            assertThat(turnStatus(session, cancellation)).isEqualTo("CANCELLED");
            assertThat(running(child)).isFalse();
            assertThat(running(hook)).isFalse();
            assertHookUnitsEmpty();
        });
        assertThat(canary.isAlive()).isTrue();
        assertEffects("EXT_BASE", "EXT_COLD");
        completeTurn(session, "EXT_AFTER_CANCEL");
        assertEffects("EXT_BASE", "EXT_COLD", "EXT_AFTER_CANCEL");
        close(session, worker, mcp);

        String revised = createSession(agent, "revised");
        completeTurn(revised, "EXT_NEW");
        assertThat(jdbc.queryForObject("SELECT agent_revision FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, revised)).isEqualTo("2");
        JsonNode revisedMcp = events("mcp.start").getLast();
        assertThat(revisedMcp.path("revision").asInt()).isEqualTo(2);
        close(revised, worker(revised), revisedMcp);
        assertEffects("EXT_BASE", "EXT_COLD", "EXT_AFTER_CANCEL", "EXT_NEW");
        assertThat(events("hook.call")).allSatisfy(event -> {
            assertThat(event.path("cwd").asText()).isEqualTo(workspace.toString());
            assertThat(event.at("/input/cwd").asText()).isEqualTo(workspace.toString());
        });
        assertThat(events("mcp.start")).allSatisfy(event ->
                assertThat(event.path("cwd").asText()).isEqualTo(workspace.toString()));
        assertThat(events("hook.call").stream().filter(event -> event.path("revision").asInt() == 2).toList())
                .hasSize(2);
        assertThat(canary.isAlive()).isTrue();
        assertThat(modelFailure.get()).isNull();
    }

    @Test
    @Timeout(180)
    void disconnectedMcpEffectIsNotReplayedAfterHarnessReplacementOnMySql() throws Exception {
        boot();
        Map<String, Object> mcpOnly = new java.util.LinkedHashMap<>(definition(1));
        mcpOnly.remove("hook_catalog");
        String agent = api("POST", "/v1/agents", mcpOnly, "definition", 202).path("id").asText();
        String session = createSession(agent, "unknown");
        String original = submit(session, "EXT_UNKNOWN");
        waitFor(() -> {
            assertEffects("EXT_UNKNOWN");
            assertThat(running(events("mcp.start").getFirst())).isFalse();
            assertThat(execution(session, original).path("execution_state").asText()).isEqualTo("UNKNOWN");
        });
        JsonNode originalExecution = execution(session, original);
        for (String field : List.of("execution_status", "result_json", "settled_at")) {
            assertThat(originalExecution.path(field).isNull()).as(field).isTrue();
        }
        JsonNode worker = worker(session);
        assertThat(running(worker)).isTrue();
        int requests = modelRequests.size();
        replaceHarness();
        waitFor(() -> {
            String log = Files.readString(temporary.resolve("harness-2.log"));
            assertThat(log.lines().anyMatch(line -> line.contains("recovery of session " + session)
                    && line.contains("runtime_broker_execution_unknown"))).isTrue();
            assertThat(log.lines().anyMatch(line -> line.contains("/session/" + session + "/load")
                    && line.contains("code=hosted_turn_recovery_required") && line.contains("status=409")
                    && line.contains("reason=takeover_failed"))).isTrue();
        });
        assertThat(turnStatus(session, original)).isEqualTo("RUNNING");
        JsonNode retry = api("POST", "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.input.message", "input", List.of(Map.of("type", "input_text", "text", "EXT_RETRY_UNKNOWN"))),
                "retry-unknown", 409);
        assertThat(retry.at("/error/code").asText()).isEqualTo("turn_active");
        assertEffects("EXT_UNKNOWN");
        assertThat(events("mcp.start")).hasSize(1);
        assertThat(events("mcp.request").stream().filter(event -> "tools/call".equals(event.path("method").asText())).toList())
                .hasSize(1);
        assertThat(worker(session)).isEqualTo(worker);
        assertThat(running(worker)).isTrue();
        assertThat(execution(session, original)).isEqualTo(originalExecution);
        assertThat(modelRequests).hasSize(requests);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                Integer.class, tenant, session)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution e JOIN ma_runtime_binding b"
                + " ON b.binding_id = e.binding_id AND b.runtime_generation = e.runtime_generation"
                + " WHERE b.tenant_id = ? AND e.harness_session_id = ?", Integer.class, tenant, session)).isEqualTo(1);
        JsonNode refused = api("POST", "/v1/agents/sessions/" + session + "/close", null, "unsafe-close", 409);
        assertThat(refused.at("/error/code").asText()).isEqualTo("turn_active");
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isNotEqualTo("CLOSED");
        assertThat(canary.isAlive()).isTrue();
        assertThat(modelFailure.get()).isNull();
    }

    private JsonNode execution(String session, String turn) {
        var rows = jdbc.queryForList("SELECT e.execution_call_id, e.tool_call_id, e.runtime_session_id, e.binding_id,"
                + " e.runtime_generation, e.execution_state, e.execution_status, e.result_json, e.settled_at, e.reference_json"
                + " FROM ma_tool_execution e JOIN ma_runtime_binding b ON b.binding_id = e.binding_id"
                + " AND b.runtime_generation = e.runtime_generation JOIN ma_turn t ON t.tenant_id = b.tenant_id"
                + " AND t.session_id = e.harness_session_id AND t.prompt_id = e.turn_id"
                + " WHERE t.tenant_id = ? AND t.session_id = ? AND t.turn_id = ? AND b.workspace_id = 'workspace'",
                tenant, session, turn);
        assertThat(rows).hasSize(1);
        return json.valueToTree(rows.getFirst());
    }

    private void boot() throws Exception {
        assertThat(System.getProperty("mysql.url")).as("Extension acceptance requires disposable MySQL 8.4")
                .startsWith("jdbc:mysql:");
        node = System.getProperty("node.executable");
        assertThat(node).isNotBlank();
        cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        temporary = temporary.toRealPath();
        workspace = Files.createDirectories(temporary.resolve("workspace/child"));
        Files.setLastModifiedTime(workspace.getParent(), FileTime.fromMillis(1));
        Files.createDirectory(temporary.resolve("decoy"));
        Files.createDirectory(temporary.resolve("broker"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        evidence = temporary.resolve("processes.jsonl");
        String delegated = System.getenv("QWEN_MANAGED_HOOK_CGROUP_ROOT");
        assertThat(delegated).as("Run Maven inside a delegated Linux cgroup v2 subtree").isNotBlank();
        hookRoot = Files.createDirectory(Path.of(delegated).resolve("extensions-" + UUID.randomUUID()));
        canaryRoot = Files.createDirectory(Path.of(delegated).resolve("extensions-canary-" + UUID.randomUUID()));
        canary = new ProcessBuilder(node, "-e", "require('fs').writeFileSync(process.argv[1] + '/cgroup.procs',"
                + " String(process.pid)); setInterval(() => {}, 1000)", canaryRoot.toString())
                .redirectError(temporary.resolve("canary.log").toFile()).start();
        waitFor(() -> assertThat(Files.readString(canaryRoot.resolve("cgroup.procs")))
                .contains(Long.toString(canary.pid())));
        Path program = temporary.resolve("extension-process.mjs");
        try (var resource = getClass().getResourceAsStream("/hosted-extension-process.mjs")) {
            assertThat(resource).isNotNull();
            Files.copy(resource, program);
        }
        mcpDigest = DigestUtils.sha256Hex("mcp:" + Files.readString(program));
        hookDigest = DigestUtils.sha256Hex("hook:" + Files.readString(program));
        List<Map<String, Object>> servers = new ArrayList<>();
        List<Map<String, Object>> catalogs = new ArrayList<>();
        for (int revision = 1; revision <= 2; revision++) {
            servers.add(Map.of("tenantId", tenant, "workspaceId", "workspace", "serverId", "fixture",
                    "serverRevision", revision, "definitionDigest", DigestUtils.sha256Hex(mcpDigest + revision), "transport", "stdio", "command", node,
                    "args", List.of(program.toString(), "mcp", evidence.toString(), Integer.toString(revision))));
            Map<String, Object> hook = new java.util.LinkedHashMap<>(Map.of("hookId", "pre", "eventName", "PreToolUse",
                    "sequential", false, "failClosed", true, "async", false, "config", Map.of("type", "command", "command",
                            quote(node) + " " + quote(program.toString()) + " hook " + quote(evidence.toString())
                                    + " " + revision, "timeout", 60000)));
            hook.put("onceKey", null);
            catalogs.add(Map.of("tenantId", tenant, "workspaceId", "workspace", "catalogId", "fixture-hooks",
                    "catalogRevision", revision, "definitionDigest", DigestUtils.sha256Hex(hookDigest + revision), "hooks", List.of(hook)));
        }
        json.writeValue(temporary.resolve("mcp.json").toFile(), Map.of("version", 1, "servers", servers));
        json.writeValue(temporary.resolve("hooks.json").toFile(), Map.of("version", 1, "catalogs", catalogs));
        Path worker = temporary.resolve("worker.mjs");
        Files.writeString(worker, "process.env.QWEN_MANAGED_MCP_CONFIG="
                + json.writeValueAsString(temporary.resolve("mcp.json").toString())
                + "; process.env.QWEN_MANAGED_HOOK_CONFIG="
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
                        "--qwen.managed-agent.runtime-broker.credential-key-id=extensions",
                        "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                        "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                        "--qwen.managed-agent.runtime-broker.worker-entry=" + worker,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + workspace.getParent());
        jdbc = spring.getBean(JdbcTemplate.class);
        spring.getBean(WorkspaceStorageGuard.class).register(tenant, "storage", UUID.randomUUID().toString());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage', 'Extensions', ?, ?, 'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        startHarness();
    }

    private Map<String, Object> definition(int revision) {
        return Map.of("model", Map.of(), "instructions", "Use the explicitly published extension proof.",
                "tools", List.of(Map.of("type", "hosted_profile", "profile", PROFILE)),
                "permission_policy", Map.of("approval_mode", "yolo"),
                "skills", List.of(Map.of("name", "proof", "description", "Load the pinned acceptance instructions.",
                        "body", "EXT_SKILL_REVISION_" + revision, "base_directory", ".")),
                "mcp_servers", List.of(Map.of("server_id", "fixture", "server_revision", revision, "definition_digest", DigestUtils.sha256Hex(mcpDigest + revision))),
                "hook_catalog", Map.of("catalog_id", "fixture-hooks", "catalog_revision", revision, "definition_digest", DigestUtils.sha256Hex(hookDigest + revision)));
    }

    private String createSession(String agent, String key) throws Exception {
        return api("POST", "/v1/agents/sessions", Map.of("agent_id", agent, "input", List.of(),
                "workspace", Map.of("workspace_id", "workspace", "cwd_relative", "child")), key, 202).path("id").asText();
    }

    private String submit(String session, String prompt) throws Exception {
        return api("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type", "agent.session.input.message",
                "input", List.of(Map.of("type", "input_text", "text", prompt))), prompt, 202).path("turn_id").asText();
    }

    private void completeTurn(String session, String prompt) throws Exception {
        String turn = submit(session, prompt);
        waitFor(() -> assertThat(turnStatus(session, turn)).as("%s, %s", prompt, temporary).isEqualTo("COMPLETED"));
        assertThat(api("GET", "/v1/agents/sessions/" + session + "/events", null, null, 200).toString())
                .contains("EXT_DONE_" + prompt);
    }

    private String turnStatus(String session, String turn) {
        return jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                String.class, tenant, session, turn);
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
                "telemetry", Map.of("enabled", false), "model", Map.of("name", "extension-fixture"),
                "modelProviders", Map.of("openai", List.of(Map.of("id", "extension-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl)))));
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
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", CAPABILITY, "QWEN_HOSTED_LIFECYCLE_V2_PROFILES", PROFILE,
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
                if ("user".equals(message.path("role").asText()) && message.path("content").toString().contains("EXT_")) {
                    String text = message.path("content").toString();
                    prompt = text.substring(text.lastIndexOf("EXT_")).replaceAll("[^A-Z_].*", "");
                    results.clear();
                } else if ("tool".equals(message.path("role").asText())) {
                    results.add(message);
                }
            }
            assertThat(prompt).isNotBlank();
            boolean skill = List.of("EXT_BASE", "EXT_COLD", "EXT_NEW").contains(prompt);
            int revision = "EXT_NEW".equals(prompt) ? 2 : 1;
            List<String> names = new ArrayList<>();
            request.path("tools").forEach(tool -> names.add(tool.at("/function/name").asText()));
            assertThat(names).contains("skill");
            List<JsonNode> mcpTools = new ArrayList<>();
            request.path("tools").forEach(tool -> {
                if (tool.at("/function/name").asText().startsWith("mcp_")) {
                    mcpTools.add(tool);
                }
            });
            assertThat(mcpTools).hasSize(1);
            assertThat(mcpTools.getFirst().at("/function/description").asText())
                    .contains("Append a durable process acceptance proof.");
            String mcpName = mcpTools.getFirst().at("/function/name").asText();
            if (skill && !results.isEmpty()) {
                assertThat(results.getFirst().toString()).contains("EXT_SKILL_REVISION_" + revision)
                        .doesNotContain("EXT_SKILL_REVISION_" + (3 - revision));
            }
            int step = results.size();
            boolean call = step < (skill ? 2 : 1);
            var chunk = json.createObjectNode().put("id", "extensions").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", "extension-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            if (call) {
                boolean load = skill && step == 0;
                delta.putArray("tool_calls").addObject().put("index", 0).put("id", "call_" + prompt + "_" + step)
                        .put("type", "function").putObject("function").put("name", load ? "skill" : mcpName)
                        .put("arguments", json.writeValueAsString(load ? Map.of("skill", "proof") : Map.of("value", prompt)));
            } else {
                assertThat(results.getLast().toString()).contains("EXT_DENY".equals(prompt)
                        ? "EXT_DENIED" : "EXT_MCP_" + revision + "_" + prompt);
                delta.put("content", "EXT_DONE_" + prompt);
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

    private void close(String session, JsonNode worker, JsonNode mcp) throws Exception {
        assertThat(running(worker)).isTrue();
        assertThat(running(mcp)).isTrue();
        String operation = api("POST", "/v1/agents/sessions/" + session + "/close", null, "close-" + session, 202).path("id").asText();
        waitFor(() -> assertThat(api("GET", "/v1/agents/sessions/" + session + "/operations/" + operation,
                null, null, 200).path("status").asText()).isEqualTo("completed"));
        assertThat(running(worker)).isFalse();
        assertThat(running(mcp)).isFalse();
        assertHookUnitsEmpty();
        String binding = worker.path("binding").asText();
        assertThat(jdbc.queryForObject("SELECT binding_state FROM ma_runtime_binding WHERE binding_id = ?",
                String.class, binding)).isEqualTo("RELEASED");
        assertThat(jdbc.queryForObject("SELECT drain_receipt_json FROM ma_runtime_binding WHERE binding_id = ?",
                String.class, binding)).isNotBlank();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE binding_id = ?"
                + " AND session_state NOT IN ('RELEASED', 'FAILED')", Integer.class, binding)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE binding_id = ? AND holder_key IS NOT NULL",
                Integer.class, binding)).isZero();
        assertThat(canary.isAlive()).isTrue();
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

    private void assertEffects(String... expected) throws Exception {
        assertThat(events("mcp.effect").stream().map(event -> event.path("value").asText()).toList()).containsExactly(expected);
        List<String> effects = new ArrayList<>();
        Path proof = workspace.resolve("mcp-proof.jsonl");
        if (Files.exists(proof)) {
            for (String line : Files.readAllLines(proof)) {
                effects.add(json.readTree(line).path("value").asText());
            }
        }
        assertThat(effects).containsExactly(expected);
        assertThat(temporary.resolve("decoy/mcp-proof.jsonl")).doesNotExist();
    }

    private JsonNode api(String method, String path, Object body, String key, int... expected) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(10)).header("X-Qwen-Tenant-Id", tenant).header("X-Qwen-Actor-Id", "actor")
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
        await().atMost(Duration.ofSeconds(40)).ignoreException(java.net.ConnectException.class).failFast(() -> {
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
                () -> { if (canary != null) {
                    canary.destroyForcibly();
                    assertThat(canary.waitFor(10, TimeUnit.SECONDS)).isTrue();
                } },
                () -> { if (evidence != null && Files.exists(evidence)) {
                    for (String kind : List.of("mcp.start", "hook.hold", "hook.child")) {
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
                    for (Path root : new Path[]{hookRoot, canaryRoot}) {
                        if (root == null) {
                            continue;
                        }
                        try (var entries = Files.walk(root)) {
                            for (Path entry : entries.filter(Files::isDirectory).sorted(Comparator.reverseOrder()).toList()) {
                                Files.delete(entry);
                            }
                        }
                    }
                }, http::close);
    }

    private void saveEvidence() throws Exception {
        Path destination = Files.createDirectories(Path.of("target/failsafe-reports/hosted-extension-evidence", tenant));
        System.out.println("HOSTED_EXTENSIONS_EVIDENCE " + destination.toAbsolutePath());
        json.writeValue(destination.resolve("model-requests.json").toFile(), modelRequests);
        for (String name : List.of("processes.jsonl", "workspace/child/mcp-proof.jsonl", "harness-1.log", "harness-2.log")) {
            Path source = temporary.resolve(name);
            if (Files.exists(source)) {
                Files.copy(source, destination.resolve(source.getFileName()));
            }
        }
        if (jdbc != null) {
            json.writeValue(destination.resolve("turns.json").toFile(), jdbc.queryForList(
                    "SELECT session_id, turn_id, prompt_id, status, error_code FROM ma_turn WHERE tenant_id = ?", tenant));
            json.writeValue(destination.resolve("bindings.json").toFile(), jdbc.queryForList(
                    "SELECT binding_id, runtime_generation, binding_state, drain_receipt_json FROM ma_runtime_binding WHERE tenant_id = ?", tenant));
            json.writeValue(destination.resolve("executions.json").toFile(), jdbc.queryForList(
                    "SELECT e.execution_call_id, e.tool_call_id, e.runtime_session_id, e.harness_session_id, e.turn_id,"
                            + " e.execution_state, e.execution_status, e.result_json, e.settled_at FROM ma_tool_execution e"
                            + " JOIN ma_runtime_binding b ON b.binding_id = e.binding_id AND b.runtime_generation = e.runtime_generation"
                            + " WHERE b.tenant_id = ?", tenant));
        }
    }
}
