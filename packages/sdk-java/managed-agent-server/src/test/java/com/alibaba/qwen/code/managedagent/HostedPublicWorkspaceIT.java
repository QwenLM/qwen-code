package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
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
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.io.CleanupMode;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;

class HostedPublicWorkspaceIT {
    private static final String TOKEN = "g0-local-fixture";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final String tenant = "g0-" + UUID.randomUUID();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    // Holds the model reply to a G0_CANCEL prompt so the test can cancel a running Turn.
    private volatile CountDownLatch heldReply = new CountDownLatch(1);
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private HttpServer model;
    private Process harness;
    private JdbcTemplate jdbc;
    private int port;
    private Path decoy;
    private String node;

    @Test
    @Timeout(150)
    void publicCreationRunsFilesThroughProductionWorkspaceBinding() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the CLI first").isRegularFile();
        node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        decoy = Files.createDirectory(temporary.resolve("harness-decoy"));
        Files.createDirectory(temporary.resolve("broker"));
        List<Path> roots = List.of(Files.createDirectory(temporary.resolve("workspace-a")),
                Files.createDirectory(temporary.resolve("workspace-b")));
        for (Path root : roots) Files.createDirectory(root.resolve("child"));
        port = freePort();
        int harnessPort = freePort();
        int brokerPort = freePort();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        startSpring(cli, roots, harnessPort, brokerPort);
        startHarness(cli, harnessPort, brokerPort);

        for (int index = 0; index < roots.size(); index++) {
            String workspace = "workspace-" + index;
            register(workspace, "storage-" + index);
            boolean webShell = index == 1;
            String route = webShell ? "/api/agent/web-shell/v1/sessions/create" : "/v1/agents/sessions";
            Map<String, Object> input = Map.of("type", "input_text", "text", "G0_FILES");
            Map<String, Object> body = webShell
                    ? Map.of("agentId", "qwen-code", "idempotencyKey", workspace, "input", List.of(input),
                            "workspace", Map.of("workspaceId", workspace, "cwdRelative", "child"))
                    : Map.of("agent_id", "qwen-code", "input", List.of(input), "workspace",
                            Map.of("workspace_id", workspace, "cwd_relative", "child"));
            JsonNode created = request("POST", route, body, workspace, "actor", 202);
            String session = created.path(webShell ? "sessionId" : "id").asText();
            assertThat(session).isNotBlank();
            await().atMost(Duration.ofSeconds(35)).failFast(() -> {
                String status = jdbc.queryForObject("SELECT status FROM managed_agent_turn WHERE session_id = ?",
                        String.class, session);
                assertThat(status).as("Turn: %s; events: %s; model requests: %s; Harness: %s",
                        jdbc.queryForList("SELECT status, error_code FROM managed_agent_turn WHERE session_id = ?", session),
                        jdbc.queryForList("SELECT event_type, data_json FROM managed_agent_event WHERE session_id = ?", session),
                        modelRequests.size(), Files.readString(temporary.resolve("harness.log"))).isNotEqualTo("FAILED");
            }).untilAsserted(() -> {
                assertThat(modelFailure.get()).isNull();
                assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_turn WHERE session_id = ?",
                        String.class, session)).isEqualTo("COMPLETED");
            });
            assertThat(Files.readString(roots.get(index).resolve("child/proof.txt"))).isEqualTo("after");
            assertThat(decoy.resolve("proof.txt")).doesNotExist();
            assertThat(decoy.resolve("child/proof.txt")).doesNotExist();
            assertThat(jdbc.queryForObject("SELECT workspace_id FROM qwen_managed_session_journal_head"
                    + " WHERE tenant_id = ? AND session_id = ?", String.class, tenant, session)).isEqualTo(workspace);
            String durable = String.join("\n", jdbc.query("SELECT record_bytes FROM qwen_managed_session_journal_tx"
                    + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision",
                    (row, n) -> new String(row.getBytes(1), StandardCharsets.UTF_8), tenant, session));
            assertThat(durable).contains("tool_result");
            String messages = String.join("\n", jdbc.query("SELECT inline_bytes FROM qwen_managed_session_resource"
                    + " WHERE tenant_id = ? AND session_id = ? AND kind = 'managed-message'",
                    (row, n) -> new String(row.getBytes(1), StandardCharsets.UTF_8), tenant, session));
            assertThat(messages).contains("write_file", "read_file", "edit", "after");
            JsonNode events = request("GET", "/v1/agents/sessions/" + session + "/events", null, null, "actor", 200);
            assertThat(events.toString()).contains("G0_DONE");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event"
                    + " WHERE tenant_id = ? AND session_id = ? AND terminal = TRUE", Integer.class, tenant, session))
                    .isEqualTo(1);
            int requests = modelRequests.size();
            long executions = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session);
            assertThat(executions).isEqualTo(3);
            JsonNode replay = request("POST", route, body, workspace, "actor", 202);
            assertThat(replay.path(webShell ? "sessionId" : "id").asText()).isEqualTo(session);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_turn WHERE session_id = ?",
                    Integer.class, session)).isEqualTo(1);
            assertThat(modelRequests).hasSize(requests);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions);
            Map<String, Object> changed = new java.util.LinkedHashMap<>(body);
            changed.put("input", List.of(Map.of("type", "input_text", "text", "CHANGED")));
            assertThat(request("POST", route, changed, workspace, "actor", 409).path("error").path("code").asText())
                    .isEqualTo("idempotency_conflict");
            request("GET", "/v1/agents/sessions/" + session, null, null, "other", 404);
            // A later Turn runs under the creator's grants: another actor who can read the
            // Session keeps the refusal, and the creator's second Turn runs the file tools again.
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read,"
                    + " can_create) VALUES (?, ?, ?, TRUE, TRUE)", tenant, workspace,
                    "reader".getBytes(StandardCharsets.UTF_8));
            Map<String, Object> later = Map.of("type", "agent.session.input.message", "input",
                    List.of(Map.of("type", "input_text", "text", "G0_AGAIN")));
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", later,
                    "reader-later-" + workspace, "reader", 409).path("error").path("code").asText())
                    .isEqualTo("workspace_unavailable");
            // WebShell advertises the same rule, per caller.
            for (String caller : List.of("actor", "reader")) {
                assertThat(request("POST", "/api/agent/web-shell/v1/sessions/get", Map.of("sessionId", session),
                        null, caller, 200).path("capabilities").path("workspaceTurns").asBoolean())
                        .as(caller).isEqualTo("actor".equals(caller));
            }
            String laterTurn = request("POST", "/v1/agents/sessions/" + session + "/events", later,
                    "later-" + workspace, "actor", 202).path("turn_id").asText();
            assertThat(laterTurn).isNotBlank();
            await().atMost(Duration.ofSeconds(35)).failFast(() -> {
                String status = jdbc.queryForObject("SELECT status FROM managed_agent_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, laterTurn);
                if ("FAILED".equals(status)) {
                    throw new AssertionError("Later Turn failed. Harness: "
                            + Files.readString(temporary.resolve("harness.log")));
                }
            }).untilAsserted(() -> {
                assertThat(modelFailure.get()).isNull();
                assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, laterTurn))
                        .isEqualTo("COMPLETED");
            });
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 2);
            assertThat(modelRequests).hasSize(requests + 4);
            assertThat(Files.readString(roots.get(index).resolve("child/proof.txt"))).isEqualTo("after");
            assertThat(decoy.resolve("proof.txt")).doesNotExist();

            // The creator can cancel a running later Turn; the Hosted Harness aborts it before
            // any tool runs. Another reader keeps the refusal.
            int beforeCancel = modelRequests.size();
            Map<String, Object> hold = Map.of("type", "agent.session.input.message", "input",
                    List.of(Map.of("type", "input_text", "text", "G0_CANCEL")));
            String heldTurn = request("POST", "/v1/agents/sessions/" + session + "/events", hold,
                    "hold-" + workspace, "actor", 202).path("turn_id").asText();
            await().atMost(Duration.ofSeconds(35)).until(() -> modelRequests.size() > beforeCancel);
            Map<String, Object> cancel = Map.of("type", "agent.session.cancel", "turn_id", heldTurn);
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", cancel,
                    "reader-cancel-" + workspace, "reader", 409).path("error").path("code").asText())
                    .isEqualTo("workspace_unavailable");
            request("POST", "/v1/agents/sessions/" + session + "/events", cancel, "cancel-" + workspace,
                    "actor", 202);
            await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                    "SELECT status FROM managed_agent_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, heldTurn)).isEqualTo("CANCELLED"));
            heldReply.countDown();
            heldReply = new CountDownLatch(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 2);

            // Only the creator may rename the bound Session.
            Map<String, Object> rename = Map.of("title", "Renamed " + workspace);
            assertThat(request("PATCH", "/v1/agents/sessions/" + session, rename, "reader-rename-" + workspace,
                    "reader", 409).path("error").path("code").asText()).isEqualTo("workspace_unavailable");
            assertThat(request("PATCH", "/v1/agents/sessions/" + session, rename, "rename-" + workspace,
                    "actor", 200).path("metadata").path("title").asText()).isEqualTo("Renamed " + workspace);
        }
        assertThat(modelRequests).hasSize(18);
        assertThat(modelFailure.get()).isNull();
        Map<String, Object> denied = Map.of("agent_id", "qwen-code", "workspace", Map.of("workspace_id", "workspace-0"),
                "input", List.of(Map.of("type", "input_text", "text", "G0_FILES")));
        request("POST", "/v1/agents/sessions", denied, "missing-actor", null, 401);
        request("POST", "/v1/agents/sessions", denied, "wrong-actor", "other", 404);
        Map<String, Object> profileOverride = new java.util.LinkedHashMap<>(denied);
        profileOverride.put("metadata", Map.of("toolProfile", "hosted-workspace-shell/1"));
        assertThat(request("POST", "/v1/agents/sessions", profileOverride, "profile-override", "actor", 400)
                .path("error").path("code").asText()).isEqualTo("unsupported_feature");
        Map<String, Object> unsupportedAgent = new java.util.LinkedHashMap<>(denied);
        unsupportedAgent.put("agent_id", "another-agent");
        request("POST", "/v1/agents/sessions", unsupportedAgent, "unsupported-agent", "actor", 409);
        Map<String, Object> unknown = new java.util.LinkedHashMap<>(denied);
        unknown.put("workspace", Map.of("workspace_id", "unknown"));
        request("POST", "/v1/agents/sessions", unknown, "unknown", "actor", 404);
        jdbc.update("UPDATE managed_workspace_registry SET state = 'DRAINING' WHERE tenant_id = ?", tenant);
        request("POST", "/v1/agents/sessions", denied, "draining", "actor", 409);
        jdbc.update("UPDATE managed_workspace_registry SET state = 'ACTIVE' WHERE tenant_id = ?", tenant);
        register("unmounted", "unmounted-storage");
        unknown.put("workspace", Map.of("workspace_id", "unmounted"));
        request("POST", "/v1/agents/sessions", unknown, "unmounted", "actor", 409);
        var crossTenant = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/agents/sessions"))
                .timeout(Duration.ofSeconds(10)).header("X-Qwen-Tenant-Id", "other-tenant")
                .header("X-G0-Fixture-Actor", "actor").build(), HttpResponse.BodyHandlers.ofString());
        assertThat(crossTenant.statusCode()).isEqualTo(403);
        jdbc.update("UPDATE managed_workspace_access SET can_create = FALSE WHERE tenant_id = ?", tenant);
        request("POST", "/v1/agents/sessions", denied, "read-only", "actor", 403);
        jdbc.update("UPDATE managed_workspace_access SET can_create = TRUE WHERE tenant_id = ?", tenant);
        jdbc.update("UPDATE managed_workspace_registry SET config_ref = 'unsupported' WHERE tenant_id = ?", tenant);
        request("POST", "/v1/agents/sessions", denied, "unsupported", "actor", 409);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(2);
        assertThat(modelRequests).hasSize(18);
    }

    private void startSpring(Path cli, List<Path> roots, int harnessPort, int brokerPort) {
        boolean mysql = System.getProperty("mysql.url") != null;
        List<String> arguments = new ArrayList<>(List.of("--server.address=127.0.0.1", "--server.port=" + port,
                "--spring.datasource.url=" + System.getProperty("mysql.url",
                        "jdbc:h2:mem:" + tenant + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"),
                "--spring.datasource.driver-class-name=" + (mysql ? "com.mysql.cj.jdbc.Driver" : "org.h2.Driver"),
                "--spring.datasource.username=" + System.getProperty("mysql.user", "sa"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + port,
                "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.harness.base-url=http://127.0.0.1:" + harnessPort,
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + decoy,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("broker"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=g0-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        for (int i = 0; i < roots.size(); i++) {
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts[" + i + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + i);
            arguments.add(prefix + "root=" + roots.get(i));
        }
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .initializers(context -> context.getBeanFactory().registerSingleton("g0Authentication", authentication()))
                .run(arguments.toArray(String[]::new));
        jdbc = spring.getBean(JdbcTemplate.class);
    }

    private FilterRegistrationBean<Filter> authentication() {
        FilterRegistrationBean<Filter> filter = new FilterRegistrationBean<>((request, response, chain) ->
                chain.doFilter(new HttpServletRequestWrapper((HttpServletRequest) request) {
                    @Override
                    public Principal getUserPrincipal() {
                        String actor = getHeader("X-G0-Fixture-Actor");
                        return actor == null ? null : new AuthenticatedTenantActor() {
                            public String tenantId() { return tenant; }
                            public String actorId() { return actor; }
                            public String getName() { return actor; }
                        };
                    }
                }, response));
        filter.setOrder(Ordered.HIGHEST_PRECEDENCE);
        filter.setAsyncSupported(true);
        filter.addUrlPatterns("/v1/agents/*", "/api/agent/web-shell/v1/*");
        return filter;
    }

    private void register(String workspace, String storage) {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, ?, 1, ?, 'G0', ?, ?, 'ACTIVE')",
                tenant, workspace, storage, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)", tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));
    }

    private void startHarness(Path cli, int harnessPort, int brokerPort) throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home"));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
        Files.writeString(config.resolve("settings.json"), json.writeValueAsString(Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")), "model", Map.of("name", "g0-fixture"),
                "telemetry", Map.of("enabled", false), "modelProviders", Map.of("openai", List.of(Map.of(
                        "id", "g0-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl))))));
        Path log = temporary.resolve("harness.log");
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge", "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web", "--workspace", decoy.toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:" + brokerPort,
                "--managed-runtime-broker-token", TOKEN)
                .directory(decoy.toFile()).redirectErrorStream(true).redirectOutput(log.toFile());
        Map<String, String> environment = builder.environment();
        environment.clear();
        for (String name : List.of("PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")) {
            if (System.getenv(name) != null) environment.put(name, System.getenv(name));
        }
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE", home.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString(), "OPENAI_API_KEY", "fake-local-key",
                "OPENAI_BASE_URL", modelUrl, "QWEN_SERVER_TOKEN", TOKEN, "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) environment.put(name, temporary.resolve(name + ".json").toString());
        harness = builder.start();
        await().atMost(Duration.ofSeconds(30)).ignoreExceptions().untilAsserted(() -> {
            assertThat(harness.isAlive()).as(Files.readString(log)).isTrue();
            assertThat(http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + harnessPort + "/capabilities"))
                    .timeout(Duration.ofSeconds(2)).header("Authorization", "Bearer " + TOKEN).build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(200);
        });
    }

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode body = json.readTree(exchange.getRequestBody());
            modelRequests.add(body);
            List<String> tools = new ArrayList<>();
            body.path("tools").forEach(tool -> tools.add(tool.path("function").path("name").asText()));
            assertThat(tools).containsExactlyInAnyOrder("read_file", "write_file", "edit");
            // Count only this Turn's tool results, after the latest fixture prompt, so a later
            // Turn in the same Session runs the same write, edit and read sequence. Other user
            // messages the Harness may add do not restart the count.
            List<JsonNode> results = new ArrayList<>();
            AtomicReference<String> prompt = new AtomicReference<>("");
            body.path("messages").forEach(message -> {
                String role = message.path("role").asText();
                if ("user".equals(role) && message.path("content").toString().contains("G0_")) {
                    results.clear();
                    prompt.set(message.path("content").toString());
                } else if ("tool".equals(role)) {
                    results.add(message);
                }
            });
            if (prompt.get().contains("G0_CANCEL")) {
                // Reply with nothing until the test has cancelled the Turn; the Harness has
                // aborted this request by then, so there is no response to write.
                heldReply.await(60, TimeUnit.SECONDS);
                return;
            }
            int step = results.size();
            if (step == 3) assertThat(results.get(2).toString()).contains("after");
            var chunk = json.createObjectNode().put("id", "g0").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", "g0-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            if (step < 3) {
                String name = List.of("write_file", "edit", "read_file").get(step);
                Map<String, String> args = switch (step) {
                    case 0 -> Map.of("file_path", "proof.txt", "content", "before");
                    case 1 -> Map.of("file_path", "proof.txt", "old_string", "before", "new_string", "after");
                    default -> Map.of("file_path", "proof.txt");
                };
                delta.putArray("tool_calls").addObject().put("index", 0).put("id", "g0-tool-" + step)
                        .put("type", "function").putObject("function").put("name", name)
                        .put("arguments", json.writeValueAsString(args));
            } else delta.put("content", "G0_DONE");
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", step < 3 ? "tool_calls" : "stop");
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

    private JsonNode request(String method, String path, Object body, String key, String actor, int expected)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(10)).header("X-Qwen-Tenant-Id", tenant)
                .header("Accept", "application/json").header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (key != null) request.header("Idempotency-Key", key);
        if (actor != null) request.header("X-G0-Fixture-Actor", actor);
        var response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("%s %s: %s", method, path, response.body()).isEqualTo(expected);
        return json.readTree(response.body());
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); }
    }

    @AfterEach
    void stop() throws Exception {
        if (harness != null) {
            harness.descendants().forEach(ProcessHandle::destroyForcibly);
            harness.destroyForcibly();
            harness.waitFor(10, TimeUnit.SECONDS);
        }
        if (spring != null) spring.close();
        if (model != null) model.stop(0);
    }
}
