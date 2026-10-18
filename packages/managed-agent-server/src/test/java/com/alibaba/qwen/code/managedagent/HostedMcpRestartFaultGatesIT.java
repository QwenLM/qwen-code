package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

// FG12c (issue #14447): the Hosted MCP restart matrix. Each case kills one
// process — the packaged Harness, the durable Runtime worker or the stdio MCP
// server — and proves that the surviving generation never mints a second
// owner, never resends a control and never fabricates a settled result. The
// control hold at the Broker proxy keeps the record at `dispatch_started`
// until the kill, so the injection is deterministic rather than a race
// against a fast Runtime. Real Harness, worker, fixtures and MySQL.
class HostedMcpRestartFaultGatesIT {
    private static final String PROFILE = "hosted-workspace-mcp/1";
    private static final String TOKEN = "extension-process-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "mcp-restart-" + UUID.randomUUID();
    private final List<ProxyCall> proxyCalls =
            java.util.Collections.synchronizedList(new java.util.ArrayList<>());
    private final List<Map<String, Object>> wire = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    private final ExecutorService caseExecutor =
            Executors.newVirtualThreadPerTaskExecutor();
    private volatile CountDownLatch controlHold;
    private volatile String controlHoldKind;
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private Path cli;
    private Path workspace;
    private Path evidence;
    private Path home;
    private Path configHome;
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

    @BeforeEach
    void boot() throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG12c requires a disposable MySQL")
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

    @Test
    @Timeout(600)
    void harnessKillDuringConfigureResolvesThroughStatusOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String configuration = uuid();
        holdNextControl("mcp-configure");
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/configurations", Map.of("operationId",
                        configuration, "expectedRevision", 1, "server",
                        mcpPin(2)), session, 202));
        waitFor(() -> assertThat(configuration(session.id())
                .path("configRevision").asInt()).isEqualTo(2));
        assertThat(configuration(session.id()).path("run").path("execution")
                .asText()).as("configure must be in dispatch_started")
                .isEqualTo("dispatch_started");
        killHarness();
        releaseControl();
        await().atMost(Duration.ofSeconds(60))
                .ignoreExceptions()
                .until(() -> control("mcp-configure").status() != 0);
        SessionRef reloaded = reload(session);
        pending.cancel(true);
        triggerTurn(reloaded);
        await().atMost(Duration.ofSeconds(60)).ignoreExceptions()
                .until(() -> controls("mcp-status").stream().anyMatch(
                        call -> configuration.equals(call.operationId())));
        assertThat(controls("mcp-configure")).hasSize(1);
        assertThat(controls("mcp-status")).anyMatch(call -> configuration
                .equals(call.operationId()));
        assertThat(configuration(session.id()).path("configRevision").asInt())
                .isEqualTo(2);
        assertThat(configuration(session.id()).path("run").path("state")
                .asText()).isIn("settled", "outcome_unknown");
        assertThat(fixtureEvents("mcp.start"))
                .as("baseline rev 1 plus this case's rev 2; no third server")
                .hasSize(2);
    }

    @Test
    @Timeout(600)
    void harnessKillDuringOperationLooksUpTheOriginalInvokeOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String operation = uuid();
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", Map.of("operationId", operation,
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://hold")),
                        session, 202));
        waitFor(() -> assertThat(fixtureEvents("mcp.hold")).hasSize(1));
        assertThat(operations(session.id()).getLast().path("run")
                .path("execution").asText()).isEqualTo("dispatch_started");
        killHarness();
        SessionRef reloaded = reload(session);
        pending.cancel(true);
        lookup(reloaded, operation);
        assertThat(controls("mcp-invoke")).hasSize(1);
        assertThat(controls("mcp-status")).anyMatch(call -> operation
                .equals(call.operationId()));
        assertThat(effects("resource_read")).doesNotContain("ext://hold");
        writeRelease();
        waitFor(() -> assertThat(effects("resource_read"))
                .containsExactly("ext://hold"));
    }

    @Test
    @Timeout(600)
    void workerKillWhileIdleNeverMintsAFreshOwnerOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        long worker = workerPid();
        kill(worker);
        waitFor(() -> assertThat(fixtureEvents("mcp.exit"))
                .as("the stdio fixture exits on worker stdin EOF")
                .hasSize(1));
        assertThat(ProcessHandle.of(fixturePid()).map(
                ProcessHandle::isAlive).orElse(false)).isFalse();
        assertThat(fixtureEvents("mcp.start"))
                .as("no fresh Runtime generation starts a second server")
                .hasSize(1);
        assertThat(configuration(session.id()).path("run").path("state")
                .asText()).isEqualTo("settled");
    }

    @Test
    @Timeout(600)
    void workerKillDuringOperationSettlesOutcomeUnknownOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String operation = uuid();
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", Map.of("operationId", operation,
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://hold")),
                        session, 202));
        waitFor(() -> assertThat(fixtureEvents("mcp.hold")).hasSize(1));
        kill(workerPid());
        waitFor(() -> assertThat(fixtureEvents("mcp.exit")).hasSize(1));
        waitFor(() -> assertThat(operations(session.id()).getLast()
                .path("run").path("execution").asText())
                .isEqualTo("outcome_unknown"));
        assertThat(operations(session.id()).getLast().path("run").path("state")
                .asText()).isEqualTo("recovery_blocked");
        assertThat(effects("resource_read")).doesNotContain("ext://hold");
        pending.cancel(true);
    }

    @Test
    @Timeout(600)
    void stdioKillDuringRequestSettlesOutcomeUnknownOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String operation = uuid();
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", Map.of("operationId", operation,
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://hold")),
                        session, 202));
        waitFor(() -> assertThat(fixtureEvents("mcp.hold")).hasSize(1));
        kill(fixturePid());
        waitFor(() -> assertThat(operations(session.id()).getLast()
                .path("run").path("execution").asText())
                .isEqualTo("outcome_unknown"));
        assertThat(operations(session.id()).getLast().path("run").path("state")
                .asText()).isEqualTo("recovery_blocked");
        assertThat(effects("resource_read")).doesNotContain("ext://hold");
        pending.cancel(true);
    }

    private long fixturePid() {
        return fixtureEvents("mcp.start").getFirst().path("pid").asLong();
    }

    private long workerPid() throws IOException {
        try (var files = Files.list(temporary.resolve("broker"))) {
            for (Path file : files.filter(path -> path.getFileName()
                    .toString().endsWith(".json")).toList()) {
                long pid = json.readTree(Files.readString(file))
                        .path("pid").asLong();
                if (pid > 0 && ProcessHandle.of(pid)
                        .map(ProcessHandle::isAlive).orElse(false)) {
                    return pid;
                }
            }
        }
        throw new AssertionError("No durable Runtime worker registered");
    }

    private void kill(long pid) throws Exception {
        ProcessHandle handle = ProcessHandle.of(pid)
                .orElseThrow(() -> new AssertionError("pid " + pid));
        handle.destroyForcibly();
        handle.onExit().get(10, TimeUnit.SECONDS);
    }

    private void killHarness() throws Exception {
        Process dead = harness;
        dead.destroyForcibly();
        assertThat(dead.waitFor(10, TimeUnit.SECONDS))
                .as("the Harness must die before the replacement starts")
                .isTrue();
    }

    private void holdNextControl(String kind) {
        controlHoldKind = kind;
        controlHold = new CountDownLatch(1);
    }

    private void releaseControl() {
        CountDownLatch latch = controlHold;
        controlHold = null;
        controlHoldKind = null;
        if (latch != null) {
            latch.countDown();
        }
    }

    private String writeRelease() throws IOException {
        Path release = Path.of(evidence + ".release");
        Files.createFile(release);
        return release.toString();
    }

    private Map<String, Object> mcpPin(int revision) {
        return Map.of("serverId", "fixture", "serverRevision", revision,
                "definitionDigest", DigestUtils.sha256Hex(mcpDigest + revision));
    }

    private void baseline(SessionRef session) throws Exception {
        List<Map<String, Object>> prompt = List.of(
                Map.of("type", "text", "text", "FG12C_BASE"));
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
        // The baseline's own configure is not part of the case under test.
        proxyCalls.clear();
        wire.clear();
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

    private List<String> effects(String kind) {
        return fixtureEvents("mcp.effect").stream()
                .filter(event -> kind.equals(event.path("kind").asText()))
                .map(event -> event.path("value").asText()).toList();
    }

    private List<ProxyCall> controls(String kind) {
        return proxyCalls.stream().filter(call -> kind.equals(call.kind()))
                .toList();
    }

    private ProxyCall control(String kind) {
        List<ProxyCall> found = controls(kind);
        assertThat(found).isNotEmpty();
        return found.getLast();
    }

    private void lookup(SessionRef session, String operationId) {
        try {
            harnessRequest("GET", "/session/" + session.id()
                    + "/mcp/operations/" + operationId, null,
                    session.clientId(), 200);
        } catch (AssertionError refused) {
            // A recovery-blocked lookup may answer 503; the wire sequence
            // still carries the status control this case asserts on.
        } catch (Exception failed) {
            throw new IllegalStateException(failed);
        }
    }

    private void triggerTurn(SessionRef session) {
        List<Map<String, Object>> prompt = List.of(
                Map.of("type", "text", "text", "FG12C_RECOVER"));
        try {
            String payload = json.writeValueAsString(prompt);
            harnessRequest("POST", "/session/" + session.id() + "/prompt",
                    Map.of("promptId", uuid(), "prompt", prompt,
                            "payloadDigest",
                            "sha256:" + DigestUtils.sha256Hex(payload)),
                    session.clientId(), 202);
        } catch (AssertionError refused) {
            // The replacement may refuse the turn while the configuration
            // is still recovering; initialize has already issued the lookup.
        } catch (Exception failed) {
            throw new IllegalStateException(failed);
        }
    }

    private String uuid() {
        return UUID.randomUUID().toString();
    }

    private record SessionRef(String id, String clientId) {
    }

    private Map<String, Object> storeDescriptor() {
        Map<String, Object> store = new LinkedHashMap<>();
        store.put("baseUrl", "http://127.0.0.1:" + port);
        store.put("tenantId", tenant);
        store.put("workspaceId", "workspace");
        store.put("writerId", bootId);
        // A killed Harness cannot release its writer lease, so the
        // replacement waits out a short lease rather than the 60 s default.
        store.put("leaseDurationMs", 3_000);
        return store;
    }

    private SessionRef createSession() throws Exception {
        String key = uuid();
        String session = store.insertWorkspaceSessionCommand(tenant, "actor",
                "create-" + key, "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null,
                new WorkspaceSelection("workspace", "child")).sessionId();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", session);
        body.put("sessionScope", "thread");
        body.put("toolProfile", PROFILE);
        body.put("approvalMode", "yolo");
        body.put("mcpServers", List.of(mcpPin(1)));
        body.put("managedSessionStore", storeDescriptor());
        JsonNode created = harnessRequest("POST", "/session", body, null, 200);
        assertThat(created.path("sessionId").asText()).isEqualTo(session);
        String clientId = created.path("clientId").asText();
        assertThat(clientId).isNotBlank();
        return new SessionRef(session, clientId);
    }

    private SessionRef reload(SessionRef session) throws Exception {
        startHarness();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionScope", "thread");
        body.put("toolProfile", PROFILE);
        body.put("approvalMode", "yolo");
        body.put("mcpServers", List.of(mcpPin(1)));
        body.put("managedSessionStore", storeDescriptor());
        String payload = json.writeValueAsString(body);
        JsonNode loaded = null;
        for (int attempt = 0; attempt < 60 && loaded == null; attempt++) {
            HttpResponse<String> response = rawRequest("POST",
                    "/session/" + session.id() + "/load", payload);
            if (response.statusCode() == 200) {
                loaded = json.readTree(response.body());
                break;
            }
            // The killed Harness still holds the writer lease; wait for it
            // to lapse instead of treating the conflict as a failed load.
            assertThat(response.statusCode()).as("load: %s",
                    response.body()).isEqualTo(409);
            Thread.sleep(1_000);
        }
        assertThat(loaded).as("the replacement Harness must load the Session")
                .isNotNull();
        String clientId = loaded.path("clientId").asText("");
        return new SessionRef(session.id(), clientId.isBlank()
                ? session.clientId() : clientId);
    }

    private HttpResponse<String> rawRequest(String method, String path,
            String payload) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + harnessPort + path))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + TOKEN)
                .header("X-Qwen-Harness-Protocol-Version", "1")
                .header("X-Qwen-Harness-Boot-Id", bootId)
                .header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(payload))
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofString());
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
                        "--qwen.managed-agent.runtime-broker.credential-key-id=restart",
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
                + " 1, 'storage', 'Restart', ?, ?, 'ACTIVE')", tenant,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'workspace',"
                + " ?, 'OPERATOR')", tenant,
                "actor".getBytes(StandardCharsets.UTF_8));
    }

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            json.readTree(exchange.getRequestBody());
            var chunk = json.createObjectNode().put("id", "fg12c")
                    .put("object", "chat.completion.chunk").put("created", 0)
                    .put("model", "restart-fixture");
            var choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "FG12C_DONE");
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
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
                0, operationId);
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
        CountDownLatch hold = controlHold;
        if (hold != null && controlHoldKind != null
                && controlHoldKind.equals(kind)) {
            try {
                hold.await(120, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
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
        if (home == null) {
            home = Files.createDirectory(temporary.resolve("home"));
            configHome = Files.createDirectory(home.resolve(".qwen"));
            String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort()
                    + "/v1";
            json.writeValue(configHome.resolve("settings.json").toFile(), Map.of(
                    "security", Map.of("auth", Map.of("selectedType", "openai")),
                    "telemetry", Map.of("enabled", false),
                    "model", Map.of("name", "restart-fixture"),
                    "modelProviders", Map.of("openai",
                            List.of(Map.of("id", "restart-fixture", "envKey",
                                    "OPENAI_API_KEY", "baseUrl", modelUrl)))));
        }
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort()
                + "/v1";
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
                configHome.toString(), "QWEN_RUNTIME_DIR",
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
            caseExecutor.close();
        } catch (Exception ignored) {
            // The case's own failure is the meaningful one.
        }
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
                HostedDurableWorkers.stop(temporary.resolve("broker"), json);
            } catch (Exception ignored) {
                // Best-effort teardown.
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
                    "target/fg12-cases/fg12c", tenant));
            System.out
                    .println("FG12C_EVIDENCE " + destination.toAbsolutePath());
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
            int status, String operationId) {
        ProxyCall complete(int value) {
            return new ProxyCall(method, path, kind, value, operationId);
        }
    }
}
