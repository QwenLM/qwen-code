package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
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
import java.util.LinkedHashMap;
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

// FG12f (issues #14054/#14447): result and catalog delivery on the Hosted
// MCP path. A settled result must replay from the committed record without
// a second Runtime call, an oversized result must settle at the output
// limit without leaving a hold, a catalog change announced while a call is
// in flight must not resend that call, and a late conclusive reply after an
// unknown outcome must settle from the receipt rather than call again. The
// fixture counts physical
// effects; the Broker-proxy wire counts controls.
// Real packaged Harness, durable worker, real stdio MCP server on MySQL.
class HostedMcpResultDeliveryIT {
    private static final String PROFILE = "hosted-workspace-mcp/1";
    private static final String TOKEN = "extension-process-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "mcp-delivery-" + UUID.randomUUID();
    private final List<ProxyCall> proxyCalls =
            java.util.Collections.synchronizedList(new java.util.ArrayList<>());
    private final List<Map<String, Object>> wire = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private Path cli;
    private Path workspace;
    private Path evidence;
    private String node;
    private String mcpDigest;
    private int port;
    private int harnessPort;
    private int brokerPort;
    private String bootId;
    private HttpServer model;
    private ExecutorService modelExecutor;
    private HttpServer brokerProxy;
    private ServletWebServerApplicationContext spring;
    private JdbcTemplate jdbc;
    private ManagedAgentStore store;
    private Process harness;

    @Test
    @Timeout(300)
    void committedResultReplaysWithoutTouchingTheRuntimeOnMySql()
            throws Exception {
        boot();
        SessionRef session = createSession();
        baseline(session);
        proxyCalls.clear();
        wire.clear();
        String operation = uuid();
        Map<String, Object> request = Map.of("operationId", operation,
                "serverId", "fixture", "request", Map.of("kind",
                        "resource_read", "uri", "ext://proof"));
        JsonNode first = privateRequest("POST", "/session/" + session.id()
                + "/mcp/operations", request, session, 202);
        assertThat(first.path("state").asText()).isEqualTo("settled");
        assertThat(controls("mcp-invoke")).hasSize(1);
        JsonNode committed = operations(session.id()).getLast();
        assertThat(committed.path("resultRef").isNull()).isFalse();
        JsonNode stored = published(session.id(), committed.path("resultRef"));
        int invokes = controls("mcp-invoke").size();
        int exchanges = wire.size();

        JsonNode replay = privateRequest("POST", "/session/" + session.id()
                + "/mcp/operations", request, session, 202);

        assertThat(replay.path("state").asText()).isEqualTo("settled");
        assertThat(replay.path("response")).isEqualTo(stored.path("response"));
        assertThat(controls("mcp-invoke"))
                .as("a settled id replays from the committed record")
                .hasSize(invokes);
        assertThat(wire).as("no Broker exchange for the replay")
                .hasSize(exchanges);
        assertThat(operations(session.id())).hasSize(1);
        assertThat(operations(session.id()).getLast().path("resultRef")
                .toString()).isEqualTo(committed.path("resultRef").toString());
    }

    @Test
    @Timeout(300)
    void oversizedResultSettlesAtTheOutputLimitWithoutAHoldOnMySql()
            throws Exception {
        boot();
        SessionRef session = createSession();
        baseline(session);
        proxyCalls.clear();
        wire.clear();
        JsonNode answer = privateRequest("POST", "/session/" + session.id()
                + "/mcp/operations", Map.of("operationId", uuid(),
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://big")),
                session, 202);
        assertThat(answer.at("/error/code").asText())
                .isEqualTo("managed_mcp_output_limit");
        assertThat(operations(session.id()).getLast().at("/run/state").asText())
                .isEqualTo("failed");
        assertThat(operations(session.id()).getLast()
                .at("/run/execution").asText())
                .isEqualTo("settled");
        assertThat(effects("resource_read")).containsExactly("ext://big");
        assertThat(operations(session.id())).hasSize(1);
        int invokes = controls("mcp-invoke").size();
        harnessRequest("DELETE", "/session/" + session.id(), null,
                session.clientId(), 204);
        assertThat(configuration(session.id()).path("releaseState").asText())
                .isEqualTo("released");
        assertThat(controls("mcp-invoke"))
                .as("the oversized result leaves no call to resume")
                .hasSize(invokes);
    }

    @Test
    @Timeout(300)
    void listChangeDuringTheCallDoesNotResendItOnMySql() throws Exception {
        boot();
        SessionRef session = createSession();
        baseline(session);
        proxyCalls.clear();
        wire.clear();
        int catalog = configuration(session.id()).path("catalogRevision")
                .asInt();
        long discoversBefore = fixtureEvents("mcp.request").stream()
                .filter(event -> "tools/list".equals(
                        event.path("method").asText()))
                .count();
        JsonNode answer = privateRequest("POST", "/session/" + session.id()
                + "/mcp/operations", Map.of("operationId", uuid(),
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://notify")),
                session, 202);
        assertThat(answer.path("state").asText()).isEqualTo("settled");
        assertThat(answer.at("/response/contents/0/text").asText())
                .isEqualTo("EXT_RESOURCE_1");
        assertThat(controls("mcp-invoke"))
                .as("the in-flight call is never resent")
                .hasSize(1);
        assertThat(effects("resource_read")).containsExactly("ext://notify");
        assertThat(operations(session.id()).getLast().path("catalogRevision")
                .asInt()).as("the call keeps the catalog it started on")
                .isEqualTo(catalog);
        // The next operation reads through the session's refreshed catalog, so
        // its committed revision proves the notification was processed rather
        // than merely ignored.
        JsonNode follower = privateRequest("POST", "/session/" + session.id()
                + "/mcp/operations", Map.of("operationId", uuid(),
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://proof")),
                session, 202);
        assertThat(follower.path("state").asText()).isEqualTo("settled");
        long discoversAfter = fixtureEvents("mcp.request").stream()
                .filter(event -> "tools/list".equals(
                        event.path("method").asText()))
                .count();
        assertThat(discoversAfter).as("the notification forced a re-discovery")
                .isGreaterThan(discoversBefore);
    }

    @Test
    @Timeout(300)
    void lateConclusiveReplySettlesTheUnknownOperationOnceOnMySql()
            throws Exception {
        boot();
        SessionRef session = createSession();
        baseline(session);
        proxyCalls.clear();
        wire.clear();
        String operation = uuid();
        JsonNode answer = privateRequest("POST", "/session/" + session.id()
                + "/mcp/operations", Map.of("operationId", operation,
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://late")),
                session, 202);
        assertThat(answer.path("state").asText())
                .as("the unparseable answer leaves the operation unknown")
                .isEqualTo("outcome_unknown");
        JsonNode settled = null;
        for (int attempt = 0; attempt < 40; attempt++) {
            JsonNode view = privateRequest("GET", "/session/" + session.id()
                    + "/mcp/operations/" + operation, null, session, 200);
            if ("settled".equals(view.path("state").asText())) {
                settled = view;
                break;
            }
            Thread.sleep(100);
        }
        assertThat(settled).as("the late reply settles the original")
                .isNotNull();
        assertThat(settled.at("/response/contents/0/text").asText())
                .isEqualTo("EXT_RESOURCE_1");
        assertThat(effects("resource_read")).containsExactly("ext://late");
        assertThat(controls("mcp-invoke"))
                .as("the late reply is not a second invoke")
                .hasSize(1);
        assertThat(operations(session.id())).hasSize(1);
        assertThat(operations(session.id()).getLast().at("/run/state").asText())
                .as("the committed record settles")
                .isEqualTo("settled");
    }

    private Map<String, Object> mcpPin(int revision) {
        return Map.of("serverId", "fixture", "serverRevision", revision,
                "definitionDigest", DigestUtils.sha256Hex(mcpDigest + revision));
    }

    private void baseline(SessionRef session) throws Exception {
        List<Map<String, Object>> prompt = List.of(
                Map.of("type", "text", "text", "FG12_BASE"));
        String payload = json.writeValueAsString(prompt);
        harnessRequest("POST", "/session/" + session.id() + "/prompt",
                Map.of("promptId", uuid(), "prompt", prompt, "payloadDigest",
                        "sha256:" + DigestUtils.sha256Hex(payload)),
                session.clientId(), 202);
        waitFor(() -> assertThat(HostedGateTestSupport.extensionRecords(jdbc,
                tenant, session.id(), "mcp_configuration")).hasSize(1));
        waitFor(() -> assertThat(harnessRequest("GET", "/session/"
                + session.id() + "/status", null, session.clientId(), 200)
                        .path("hasActivePrompt").asBoolean()).isFalse());
    }

    private JsonNode configuration(String session) {
        List<JsonNode> records = HostedGateTestSupport.extensionRecords(jdbc,
                tenant, session, "mcp_configuration");
        assertThat(records).isNotEmpty();
        return records.getLast();
    }

    private List<JsonNode> operations(String session) {
        return HostedGateTestSupport.extensionRecords(jdbc, tenant, session,
                "mcp_operation");
    }

    private List<JsonNode> fixtureEvents(String kind) {
        if (evidence == null || !Files.exists(evidence)) {
            return List.of();
        }
        try {
            return Files.readAllLines(evidence).stream().map(line -> {
                try {
                    return json.readTree(line);
                } catch (IOException error) {
                    throw new IllegalStateException(error);
                }
            }).filter(event -> kind.equals(event.path("event").asText()))
                    .toList();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private JsonNode published(String session, JsonNode ref) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String body = jdbc.queryForObject(
                "SELECT CONVERT(inline_bytes USING utf8mb4) FROM ma_resource"
                        + " WHERE session_scope_key = ? AND resource_id = ?"
                        + " AND tenant_id = ? AND session_id = ?",
                String.class, scope, ref.path("resourceId").asText(), tenant,
                session);
        assertThat(body).as("published response body").isNotBlank();
        try {
            return json.readTree(body);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private List<String> effects(String kind) {
        if (!Files.exists(evidence)) {
            return List.of();
        }
        try {
            return Files.readAllLines(evidence).stream()
                    .map(line -> {
                        try {
                            return json.readTree(line);
                        } catch (IOException error) {
                            throw new IllegalStateException(error);
                        }
                    })
                    .filter(event -> "mcp.effect"
                            .equals(event.path("event").asText()))
                    .filter(event -> kind.equals(event.path("kind").asText()))
                    .map(event -> event.path("value").asText())
                    .toList();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private List<ProxyCall> controls(String kind) {
        return proxyCalls.stream().filter(call -> kind.equals(call.kind()))
                .toList();
    }

    private String uuid() {
        return UUID.randomUUID().toString();
    }

    private record SessionRef(String id, String clientId) {
    }

    private SessionRef createSession() throws Exception {
        String key = uuid();
        String session = store.insertWorkspaceSessionCommand(tenant, "actor",
                "create-" + key, "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null,
                new WorkspaceSelection("workspace", "child")).sessionId();
        Map<String, Object> store = new LinkedHashMap<>();
        store.put("baseUrl", "http://127.0.0.1:" + port);
        store.put("tenantId", tenant);
        store.put("workspaceId", "workspace");
        store.put("writerId", bootId);
        store.put("leaseDurationMs", 60_000);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", session);
        body.put("sessionScope", "thread");
        body.put("toolProfile", PROFILE);
        body.put("approvalMode", "yolo");
        body.put("mcpServers", List.of(mcpPin(1)));
        body.put("managedSessionStore", store);
        JsonNode created = harnessRequest("POST", "/session", body, null, 200);
        assertThat(created.path("sessionId").asText()).isEqualTo(session);
        String clientId = created.path("clientId").asText();
        assertThat(clientId).isNotBlank();
        return new SessionRef(session, clientId);
    }

    private JsonNode privateRequest(String method, String path, Object body,
            SessionRef session, int expected) throws Exception {
        return harnessRequest(method, path, body, session.clientId(), expected);
    }

    private JsonNode harnessRequest(String method, String path, Object body,
            String clientId, int expected) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + harnessPort + path))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + TOKEN)
                .header("X-Qwen-Harness-Protocol-Version", "1")
                .header("X-Qwen-Harness-Boot-Id", bootId)
                .header("Content-Type", "application/json")
                .method(method, body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers
                                .ofString(json.writeValueAsString(body)));
        if (clientId != null) {
            builder.header("X-Qwen-Client-Id", clientId);
        }
        HttpResponse<String> response = http.send(builder.build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("%s %s: %s", method, path,
                response.body()).isEqualTo(expected);
        return response.body().isEmpty() ? json.createObjectNode()
                : json.readTree(response.body());
    }

    private void boot() throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG12 requires a disposable MySQL")
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
        Path program = temporary.resolve("mcp-fault.mjs");
        try (var resource = getClass().getResourceAsStream(
                "/hosted-mcp-fault-process.mjs")) {
            assertThat(resource).isNotNull();
            Files.copy(resource, program);
        }
        mcpDigest = DigestUtils.sha256Hex("mcp:" + Files.readString(program));
        List<Map<String, Object>> servers = new java.util.ArrayList<>();
        for (int revision = 1; revision <= 2; revision++) {
            servers.add(Map.of("tenantId", tenant, "workspaceId",
                    "workspace", "serverId", "fixture", "serverRevision",
                    revision, "definitionDigest",
                    DigestUtils.sha256Hex(mcpDigest + revision), "transport",
                    "stdio", "command", node, "args",
                    List.of(program.toString(), "mcp", evidence.toString(),
                            Integer.toString(revision))));
        }
        json.writeValue(temporary.resolve("mcp.json").toFile(),
                Map.of("version", 1, "servers", servers));
        Path worker = temporary.resolve("worker.mjs");
        Files.writeString(worker, "process.env.QWEN_MANAGED_MCP_CONFIG="
                + json.writeValueAsString(
                        temporary.resolve("mcp.json").toString())
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
        startSpring();
        startBrokerProxy();
        startHarness();
    }

    private void startSpring() {
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class)
                .run("--server.address=127.0.0.1", "--server.port=" + port,
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
                        "--qwen.managed-agent.harness.enabled=false",
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
                        "--qwen.managed-agent.runtime-broker.credential-key-id=loss",
                        "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                        "--qwen.managed-agent.runtime-broker.node-executable="
                                + node,
                        "--qwen.managed-agent.runtime-broker.worker-entry="
                                + temporary.resolve("worker.mjs"),
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id="
                                + tenant,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root="
                                + workspace.getParent());
        jdbc = spring.getBean(JdbcTemplate.class);
        store = spring.getBean(ManagedAgentStore.class);
        WorkspaceStorageGuard guard = spring
                .getBean(WorkspaceStorageGuard.class);
        guard.register(tenant, "storage", UUID.randomUUID().toString());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES (?, 'workspace',"
                + " 1, 'storage', 'Loss', ?, ?, 'ACTIVE')", tenant,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'workspace',"
                + " ?, 'OPERATOR')", tenant,
                "actor".getBytes(StandardCharsets.UTF_8));
    }

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode request = json.readTree(exchange.getRequestBody());
            boolean toolResult = false;
            String toolValue = null;
            for (JsonNode message : request.path("messages")) {
                if ("tool".equals(message.path("role").asText())) {
                    toolResult = true;
                }
                if ("user".equals(message.path("role").asText())) {
                    String text = message.path("content").toString();
                    int marker = text.indexOf("FG12_TOOL");
                    if (marker >= 0) {
                        String tail = text.substring(marker);
                        int end = 0;
                        while (end < tail.length()
                                && (Character.isLetterOrDigit(tail.charAt(end))
                                        || tail.charAt(end) == '_')) {
                            end++;
                        }
                        toolValue = tail.substring(0, end);
                        toolResult = false;
                    }
                }
            }
            String mcpName = null;
            for (JsonNode tool : request.path("tools")) {
                String name = tool.at("/function/name").asText();
                if (name.startsWith("mcp_")) {
                    mcpName = name;
                }
            }
            boolean call = toolValue != null && !toolResult && mcpName != null;
            var chunk = json.createObjectNode().put("id", "fg12f")
                    .put("object", "chat.completion.chunk").put("created", 0)
                    .put("model", "loss-fixture");
            var choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            if (call) {
                delta.putArray("tool_calls").addObject().put("index", 0)
                        .put("id", "call_fg12_tool").put("type", "function")
                        .putObject("function").put("name", mcpName)
                        .put("arguments", json.writeValueAsString(
                                Map.of("value", toolValue)));
            } else {
                delta.put("content", "FG12_DONE");
            }
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", call ? "tool_calls" : "stop");
            byte[] response = (first + "data: "
                    + json.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n")
                    .getBytes(StandardCharsets.UTF_8);
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

    private void startBrokerProxy() throws IOException {
        brokerProxy = HttpServer.create(new InetSocketAddress("127.0.0.1", 0),
                0);
        brokerProxy.createContext("/", this::relay);
        brokerProxy.start();
    }

    private void relay(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readAllBytes();
        String path = exchange.getRequestURI().getPath();
        String query = exchange.getRequestURI().getQuery();
        JsonNode parsed = null;
        if (body.length > 0) {
            try {
                parsed = json.readTree(body);
            } catch (IOException ignored) {
                parsed = null;
            }
        }
        String kind = parsed == null ? null
                : parsed.at("/operation/kind").isTextual()
                        ? parsed.at("/operation/kind").asText()
                        : null;
        String operationId = parsed == null ? null
                : parsed.at("/operation/operationId").isTextual()
                        ? parsed.at("/operation/operationId").asText()
                        : null;
        ProxyCall call = new ProxyCall(exchange.getRequestMethod(), path, kind,
                0, false, operationId);
        int index;
        synchronized (proxyCalls) {
            index = proxyCalls.size();
            proxyCalls.add(call);
        }
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("method", exchange.getRequestMethod());
        entry.put("path", path);
        if (parsed != null) {
            entry.put("request", parsed);
        }
        URI upstream = URI.create("http://127.0.0.1:" + brokerPort + path
                + (query == null ? "" : "?" + query));
        HttpRequest.Builder builder = HttpRequest.newBuilder(upstream)
                .timeout(Duration.ofSeconds(120));
        for (var header : exchange.getRequestHeaders().entrySet()) {
            String name = header.getKey();
            if (List.of("host", "connection", "content-length",
                    "transfer-encoding", "upgrade", "expect", "keep-alive",
                    "proxy-connection").contains(name.toLowerCase(
                            java.util.Locale.ROOT))) {
                continue;
            }
            for (String value : header.getValue()) {
                builder.header(name, value);
            }
        }
        HttpRequest request = builder.method(exchange.getRequestMethod(),
                body.length == 0 ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        try {
            HttpResponse<byte[]> response = http.send(request,
                    HttpResponse.BodyHandlers.ofByteArray());
            proxyCalls.set(index, call.complete(response.statusCode()));
            entry.put("status", response.statusCode());
            try {
                entry.put("answer", json.readTree(response.body()));
            } catch (IOException unparsable) {
                entry.put("answer", new String(response.body(),
                        StandardCharsets.UTF_8));
            }
            wire.add(entry);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(response.statusCode(),
                    response.body().length);
            exchange.getResponseBody().write(response.body());
        } catch (IOException failure) {
            proxyCalls.set(index, call.complete(502));
            exchange.sendResponseHeaders(502, -1);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            exchange.sendResponseHeaders(502, -1);
        } finally {
            exchange.close();
        }
    }

    private void startHarness() throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home"));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort()
                + "/v1";
        json.writeValue(config.resolve("settings.json").toFile(), Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")),
                "telemetry", Map.of("enabled", false),
                "model", Map.of("name", "loss-fixture"),
                "modelProviders", Map.of("openai",
                        List.of(Map.of("id", "loss-fixture", "envKey",
                                "OPENAI_API_KEY", "baseUrl", modelUrl)))));
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web",
                "--workspace", temporary.resolve("decoy").toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:"
                        + brokerProxy.getAddress().getPort(),
                "--managed-runtime-broker-token", TOKEN)
                .directory(temporary.resolve("decoy").toFile())
                .redirectErrorStream(true)
                .redirectOutput(temporary.resolve("harness.log").toFile());
        var env = builder.environment();
        env.clear();
        env.put("PATH", System.getenv("PATH"));
        env.putAll(Map.of("HOME", home.toString(), "QWEN_HOME",
                config.toString(), "QWEN_RUNTIME_DIR",
                home.resolve("runtime").toString(), "OPENAI_API_KEY",
                "fixture-only", "OPENAI_BASE_URL", modelUrl,
                "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", CAPABILITY,
                "QWEN_HOSTED_LIFECYCLE_V2_PROFILES", PROFILE,
                "QWEN_CODE_MODELS_DEV_REFRESH", "off"));
        for (String key : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            env.put(key, home.resolve(key + ".json").toString());
        }
        harness = builder.start();
        waitFor(() -> {
            assertThat(harness.isAlive())
                    .as("Harness log: %s", temporary.resolve("harness.log"))
                    .isTrue();
            JsonNode capabilities = json.readTree(http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                            + harnessPort + "/capabilities"))
                            .timeout(Duration.ofSeconds(2))
                            .header("Authorization", "Bearer " + TOKEN)
                            .build(),
                    HttpResponse.BodyHandlers.ofString()).body());
            bootId = capabilities.at("/hostedHarness/bootId").asText();
            assertThat(bootId).isNotBlank();
        });
    }

    private void waitFor(org.junit.jupiter.api.function.Executable assertion) {
        await().atMost(Duration.ofSeconds(120)).ignoreException(
                java.net.ConnectException.class).failFast(() -> {
                    if (modelFailure.get() != null) {
                        throw new AssertionError("Model fixture: "
                                + modelFailure.get(), modelFailure.get());
                    }
                }).untilAsserted(assertion::execute);
    }

    @AfterEach
    void stop() {
        try {
            if (spring != null) {
                spring.close();
            }
        } finally {
            if (brokerProxy != null) {
                brokerProxy.stop(0);
            }
            if (model != null) {
                model.stop(0);
            }
            if (modelExecutor != null) {
                modelExecutor.close();
            }
            if (harness != null) {
                harness.destroyForcibly();
                try {
                    harness.waitFor(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            http.close();
            try {
                HostedDurableWorkers.stop(
                        temporary.resolve("broker"), json);
            } catch (Exception ignored) {
                // Best-effort teardown: a worker that refuses to stop must
                // not mask the case's own failure.
            }
            try {
                for (JsonNode event : fixtureEvents("mcp.start")) {
                    ProcessHandle.of(event.path("pid").asLong())
                            .filter(handle -> handle.info().commandLine()
                                    .map(command -> command
                                            .contains("mcp-fault.mjs"))
                                    .orElse(false))
                            .ifPresent(handle -> {
                                handle.destroyForcibly();
                                try {
                                    handle.onExit().get(10, TimeUnit.SECONDS);
                                } catch (Exception ignored) {
                                    // Best-effort teardown.
                                }
                            });
                }
            } catch (Exception ignored) {
                // Best-effort teardown for the stdio fixture.
            }
            saveEvidence();
        }
    }

    private void saveEvidence() {
        try {
            Path destination = Files.createDirectories(Path.of(
                    "target/fg12-cases/fg12f", tenant));
            System.out
                    .println("FG12F_EVIDENCE " + destination.toAbsolutePath());
            json.writeValue(destination.resolve("proxy.json").toFile(),
                    proxyCalls);
            json.writeValue(destination.resolve("wire.json").toFile(), wire);
            for (String name : List.of("harness.log", "processes.jsonl")) {
                Path source = temporary.resolve(name);
                if (Files.exists(source)) {
                    Files.copy(source, destination.resolve(source.getFileName()));
                }
            }
        } catch (Exception ignored) {
            // Evidence collection must not hide the case's own failure.
        }
    }

    private record ProxyCall(String method, String path, String kind,
            int status, boolean dropped, String operationId) {
        ProxyCall complete(int value) {
            return new ProxyCall(method, path, kind, value, dropped,
                    operationId);
        }
    }
}
