package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
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
import java.util.stream.LongStream;

import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.camel;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.quote;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

// FG13e (issue #14449): the Hosted Hook stream-gap gate. One tool call is
// parked inside a PreToolUse command Hook while both clients read the Session
// stream, both are cut mid-call, and each resumed client must continue the
// same ledger exactly once. The public route resumes with Last-Event-ID, the
// WebShell route with afterSequence; a cursor that is ignored replays and
// reddens the union, it does not time out.
@EnabledOnOs(OS.LINUX)
class HostedHookStreamGapIT {
    private static final String PROFILE = "hosted-workspace-files/1";
    private static final String TOKEN = "hook-stream-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private static final String PROOF = "FG13E_TOOL_PROOF";
    // The Hook is released by the test only after both clients are cut, so
    // the deny cannot land before the cut the way a fixed sleep could.
    private static final String HOOK_HOLD_MS = "0";
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "hook-stream-" + UUID.randomUUID();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure =
            new AtomicReference<>();
    private final List<Observer> observers = new CopyOnWriteArrayList<>();
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
                .as("FG13e requires a disposable MySQL")
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
        Files.writeString(workspace.resolve("proof.txt"), PROOF);
        evidence = temporary.resolve("processes.jsonl");
        String delegated = System.getenv("QWEN_MANAGED_HOOK_CGROUP_ROOT");
        assertThat(delegated)
                .as("Run Maven inside a delegated Linux cgroup v2 subtree")
                .isNotBlank();
        hookRoot = Files.createDirectory(
                Path.of(delegated).resolve("hook-stream-" + UUID.randomUUID()));
        Path program = temporary.resolve("hook-stream-process.mjs");
        try (var resource = getClass().getResourceAsStream(
                "/hosted-hook-fault-process.mjs")) {
            assertThat(resource).isNotNull();
            Files.copy(resource, program);
        }
        hookDigest = DigestUtils.sha256Hex("hook:"
                + Files.readString(program));
        Map<String, Object> hook = new java.util.LinkedHashMap<>();
        hook.put("hookId", "pre");
        hook.put("eventName", "PreToolUse");
        hook.put("sequential", false);
        hook.put("failClosed", true);
        hook.put("async", false);
        hook.put("config", Map.of("type", "command", "command",
                quote(node) + " " + quote(program.toString()) + " hook "
                        + quote(evidence.toString()) + " "
                        + quote(HOOK_HOLD_MS) + " " + quote("hook-release"),
                // The release runs only after both readers stop, a path the
                // awaits above budget past 60 s; a shorter timeout would
                // fail-closed before the release and read as a lost deny.
                "timeout", 240000));
        hook.put("onceKey", null);
        json.writeValue(temporary.resolve("hooks.json").toFile(),
                Map.of("version", 1, "catalogs", List.of(Map.of("tenantId",
                        tenant, "workspaceId", "workspace", "catalogId",
                        "fg13e-hooks", "catalogRevision", 1,
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
        startSpring();
        startHarness();
    }

    // The awaits total 480 s (5 x 60 for the Hook call, both first frames,
    // the deny and the completion, plus 2 x 90 for the two resumes), so 600
    // leaves 120 s for a hung wait to report its own description first.
    @Test
    @Timeout(600)
    void bothStreamsResumeTheHeldHookTurnOnMySql() throws Exception {
        String agent = api("POST", "/v1/agents", definition(), "definition",
                202).path("id").asText();
        String session = createSession(agent, "gap");
        Observer publicCut = new Observer("public", session, 0);
        Observer webShellCut = new Observer("webshell", session, 0);
        String turn = submit(session, "FG13E_HOLD");
        // The Hook is holding inside the worker. The tool-call frame is only
        // emitted once the call leaves the Hook, so both clients are cut on
        // the frames they already read, and the deny lands while neither is
        // connected.
        awaitHookCalled();
        publicCut.awaitFirstFrame();
        webShellCut.awaitFirstFrame();
        publicCut.abort();
        webShellCut.abort();
        // Read the cursors only after the readers stopped: a frame appended
        // between the read and the abort would otherwise be replayed on
        // resume and redden the union as a duplicate.
        long publicCutAt = publicCut.lastSequence();
        long webShellCutAt = webShellCut.lastSequence();
        // Release only now, so the deny cannot land before the cut.
        releaseHook();
        awaitDenied();
        awaitCompleted(session, turn);
        List<JsonNode> publicView = new Observer("public", session,
                publicCutAt).continueFrom(publicCut, session);
        List<JsonNode> webShellView = new Observer("webshell", session,
                webShellCutAt).continueFrom(webShellCut, session);
        assertResumedView(publicView, publicCutAt);
        assertResumedView(webShellView, webShellCutAt);
        assertThat(events("hook.call")).as("one physical Hook call")
                .hasSize(1);
        assertThat(events("hook.deny")).as("the Hook answered once")
                .hasSize(1);
        assertThat(denialResults()).as("the model sees the denial once")
                .isEqualTo(1);
        assertThat(modelRequests.toString()).doesNotContain(PROOF);
        assertThat(modelFailure.get()).isNull();
    }

    /**
     * The denial reaches the model as one tool result for the emitted call.
     * A duplicated delivery, or a second physical call, would add another.
     */
    private long denialResults() {
        long count = 0;
        for (JsonNode message : modelRequests.getLast().path("messages")) {
            if ("tool".equals(message.path("role").asText())
                    && "call_FG13E_HOLD".equals(
                            message.path("tool_call_id").asText())
                    && message.toString().contains("FG13_DENIED")) {
                count++;
            }
        }
        return count;
    }

    private void awaitHookCalled() throws Exception {
        waitFor(() -> assertThat(events("hook.call"))
                .as("the Hook is holding inside the worker")
                .hasSize(1));
    }

    private void awaitDenied() throws Exception {
        waitFor(() -> assertThat(events("hook.deny"))
                .as("the Hook's deny landed while both clients were cut")
                .hasSize(1));
    }

    /**
     * The resumed view closed the gap the cut opened and carries one
     * completion. The byte-for-byte ledger check lives in {@code
     * continueFrom}; this names what the Hook-held turn put there: the
     * denied call's single failed terminal, after the cut, and one
     * completion, so a ledger that lost the deny or duplicated it reddens
     * even when transport matches it.
     */
    private void assertResumedView(List<JsonNode> union, long cutAt) {
        assertThat(union.size())
                .as("frames landed after the cut and the resume served them")
                .isGreaterThan((int) cutAt);
        List<JsonNode> denied = union.stream()
                .filter(frame -> "item.tool_call.updated".equals(
                        frame.path("type").asText()))
                .filter(frame -> "call_FG13E_HOLD".equals(frame.path("data")
                        .path("toolCallId").asText()))
                .filter(frame -> "failed".equals(frame.path("data")
                        .path("status").asText()))
                .toList();
        assertThat(denied).as("one failed terminal for the denied call: %s",
                union).hasSize(1);
        assertThat(denied.getFirst().path("sequence").asLong())
                .as("the deny landed after the cut, not before it")
                .isGreaterThan(cutAt);
        assertThat(union.stream().filter(frame -> "turn.completed".equals(
                frame.path("type").asText())).toList())
                .as("one completion, not one per reconnect: %s", union)
                .hasSize(1);
    }

    private void releaseHook() throws IOException {
        Files.writeString(Path.of(evidence + ".release"), "release");
    }

    private void awaitCompleted(String session, String turn) {
        waitFor(() -> assertThat(turnStatus(session, turn)).isEqualTo(
                "COMPLETED"));
    }

    private Map<String, Object> definition() {
        return Map.of("model", Map.of(), "instructions",
                "Read the workspace proof file.",
                "tools", List.of(Map.of("type", "hosted_profile", "profile",
                        PROFILE)),
                "permission_policy", Map.of("approval_mode", "yolo"),
                "hook_catalog", Map.of("catalog_id", "fg13e-hooks",
                        "catalog_revision", 1, "definition_digest",
                        catalogDigest()));
    }

    private String catalogDigest() {
        return DigestUtils.sha256Hex(hookDigest + 1);
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

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode request = json.readTree(exchange.getRequestBody());
            modelRequests.add(request);
            String prompt = "";
            List<JsonNode> results = new ArrayList<>();
            for (JsonNode message : request.path("messages")) {
                if ("user".equals(message.path("role").asText())
                        && message.path("content").toString().contains(
                                "FG13E_")) {
                    String text = message.path("content").toString();
                    prompt = text.substring(text.lastIndexOf("FG13E_"))
                            .replaceAll("[^A-Z0-9_].*", "");
                    results.clear();
                } else if ("tool".equals(message.path("role").asText())) {
                    results.add(message);
                }
            }
            assertThat(prompt).isNotBlank();
            List<String> names = new ArrayList<>();
            request.path("tools").forEach(tool -> names.add(
                    tool.at("/function/name").asText()));
            assertThat(names).contains("read_file");
            boolean call = results.isEmpty();
            var chunk = json.createObjectNode().put("id", "hook-stream-gap")
                    .put("object", "chat.completion.chunk").put("created", 0)
                    .put("model", "hook-stream-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            if (call) {
                delta.putArray("tool_calls").addObject().put("index", 0)
                        .put("id", "call_" + prompt).put("type", "function")
                        .putObject("function").put("name", "read_file")
                        .put("arguments", json.writeValueAsString(
                                Map.of("file_path", "proof.txt")));
            } else {
                delta.put("content", "FG13E_DONE_" + prompt);
            }
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", call ? "tool_calls" : "stop");
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

    private void startSpring() {
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
                        "--qwen.managed-agent.runtime-broker.credential-key-id=extensions",
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
        spring.getBean(WorkspaceStorageGuard.class).register(tenant, "storage",
                UUID.randomUUID().toString());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref,"
                + " policy_ref, state) VALUES (?, 'workspace', 1, 'storage',"
                + " 'Stream gap', ?, ?, 'ACTIVE')", tenant,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'workspace', ?,"
                + " 'OPERATOR')", tenant,
                "actor".getBytes(StandardCharsets.UTF_8));
    }

    private void startHarness() throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home-" + ++boots));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:"
                + model.getAddress().getPort() + "/v1";
        json.writeValue(config.resolve("settings.json").toFile(),
                Map.of("security", Map.of("auth", Map.of("selectedType",
                        "openai")), "telemetry", Map.of("enabled", false),
                        "model", Map.of("name", "extension-fixture"),
                        "modelProviders", Map.of("openai", List.of(Map.of(
                                "id", "extension-fixture", "envKey",
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

    /** The Session stream's committed public events, in sequence. */
    private List<Map<String, Object>> ledger(String session) {
        return jdbc.queryForList("SELECT schema_version, projection_version,"
                + " sequence_id, CAST(event_id AS CHAR) AS event_id,"
                + " CAST(session_id AS CHAR) AS session_id,"
                + " CAST(turn_id AS CHAR) AS turn_id,"
                + " CAST(item_id AS CHAR) AS item_id,"
                + " CAST(content_part_id AS CHAR) AS content_part_id,"
                + " event_type, gmt_create, data_json, terminal"
                + " FROM ma_public_event WHERE tenant_id = ? AND"
                + " session_id = ? AND stream_kind = 'SESSION' AND"
                + " stream_id = X'' ORDER BY sequence_id", tenant, session);
    }

    /** One ledger row exactly as the surface serves it. */
    private JsonNode served(Map<String, Object> row, String surface)
            throws IOException {
        boolean web = "webshell".equals(surface);
        Object created = row.get("gmt_create");
        long millis = created instanceof java.sql.Timestamp stamp
                ? stamp.getTime()
                : ((Number) created).longValue();
        Map<String, Object> fields = new java.util.LinkedHashMap<>();
        fields.put("schema_version", row.get("schema_version"));
        fields.put("projection_version", row.get("projection_version"));
        fields.put("sequence", row.get("sequence_id"));
        fields.put("event_id", row.get("event_id"));
        fields.put("session_id", row.get("session_id"));
        fields.put("turn_id", row.get("turn_id"));
        fields.put("item_id", row.get("item_id"));
        fields.put("content_part_id", row.get("content_part_id"));
        fields.put("type", row.get("event_type"));
        fields.put("created_at", web ? millis : millis / 1000);
        fields.put("data", json.readTree(row.get("data_json").toString()));
        Object terminal = row.get("terminal");
        fields.put("terminal", terminal instanceof Boolean flag ? flag
                : ((Number) terminal).intValue() != 0);
        ObjectNode node = json.createObjectNode();
        fields.forEach((key, value) -> {
            if (value != null) {
                node.set(web ? camel(key) : key, json.valueToTree(value));
            }
        });
        return json.readTree(json.writeValueAsString(node));
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

    /**
     * One client of a Session's public or WebShell event stream. It owns its
     * HttpClient, so {@link #abort} cuts the connection mid-stream the way a
     * lost client does; {@link #frames} is everything it read.
     */
    private final class Observer {
        private final List<JsonNode> frames = new CopyOnWriteArrayList<>();
        private final AtomicReference<Throwable> failure =
                new AtomicReference<>();
        private final HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1).build();
        private final String surface;
        private final Thread reader;
        private volatile boolean aborted;

        Observer(String surface, String session, long after) throws Exception {
            this.surface = surface;
            HttpRequest.Builder request;
            if ("public".equals(surface)) {
                request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                        + port + "/v1/agents/sessions/" + session
                        + "/events?stream=true")).GET();
                if (after > 0) {
                    request.header("Last-Event-ID", Long.toString(after));
                }
            } else {
                request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                        + port + "/api/agent/web-shell/v1/events/stream"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(
                                json.writeValueAsString(Map.of("sessionId",
                                        session, "afterSequence", after))));
            }
            HttpResponse<InputStream> response = client.send(request
                    .header("X-Qwen-Tenant-Id", tenant)
                    .header("X-Qwen-Actor-Id", "actor")
                    .header("Accept", "text/event-stream").build(),
                    HttpResponse.BodyHandlers.ofInputStream());
            assertThat(response.statusCode()).as("%s stream of %s", surface,
                    session).isEqualTo(200);
            assertThat(response.headers().firstValue("content-type")
                    .orElse("")).contains("text/event-stream");
            reader = new Thread(() -> read(response.body()),
                    "fg13e-" + surface + "-" + session);
            reader.setDaemon(true);
            reader.start();
            observers.add(this);
        }

        private void read(InputStream body) {
            try (BufferedReader lines = new BufferedReader(
                    new InputStreamReader(body, StandardCharsets.UTF_8))) {
                String id = null;
                String event = null;
                StringBuilder data = new StringBuilder();
                for (String line = lines.readLine(); line != null;
                        line = lines.readLine()) {
                    if (line.startsWith("id:")) {
                        id = line.substring(3).trim();
                    } else if (line.startsWith("event:")) {
                        event = line.substring(6).trim();
                    } else if (line.startsWith("data:")) {
                        data.append(data.length() == 0 ? "" : "\n")
                                .append(line.substring(5).stripLeading());
                    } else if (line.isEmpty() && data.length() > 0) {
                        JsonNode frame = json.readTree(data.toString());
                        if (!frame.path("sequence").asText().equals(id)
                                || !frame.path("type").asText()
                                        .equals(event)) {
                            throw new IllegalStateException("SSE id/event "
                                    + id + "/" + event + " do not name "
                                    + frame);
                        }
                        frames.add(frame);
                        id = null;
                        event = null;
                        data.setLength(0);
                    }
                }
            } catch (IOException | RuntimeException error) {
                if (!aborted) {
                    failure.compareAndSet(null, error);
                }
            }
        }

        long lastSequence() {
            return frames.isEmpty() ? 0
                    : frames.get(frames.size() - 1).path("sequence").asLong();
        }

        /** The server has served this client at least its first frame. */
        void awaitFirstFrame() {
            await().atMost(Duration.ofSeconds(60))
                    .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                        assertThat(failure.get()).isNull();
                        assertThat(frames).isNotEmpty();
                    });
        }

        void abort() throws InterruptedException {
            aborted = true;
            client.shutdownNow();
            reader.join(10_000);
            assertThat(reader.isAlive()).as("the cut stream stopped").isFalse();
        }

        /**
         * The resumed client's frames after the cut one's, once it read the
         * ledger's tail: one contiguous sequence from 1 with no gap and no
         * duplicate, each frame exactly its committed row. A cursor the
         * server ignores replays the cut client's frames and reddens this on
         * the duplicate, not on a timeout.
         */
        List<JsonNode> continueFrom(Observer cut, String session)
                throws Exception {
            long tail = ledger(session).size();
            await().atMost(Duration.ofSeconds(90))
                    .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                        assertThat(failure.get()).isNull();
                        assertThat(lastSequence()).isGreaterThanOrEqualTo(tail);
                    });
            abort();
            List<JsonNode> view = new ArrayList<>(cut.frames);
            view.addAll(frames);
            List<Long> sequences = view.stream()
                    .map(frame -> frame.path("sequence").asLong()).toList();
            assertThat(sequences).as("%s view of %s: no gap, no duplicate",
                    surface, session).isEqualTo(LongStream
                            .rangeClosed(1, sequences.size()).boxed().toList());
            List<JsonNode> expected = new ArrayList<>();
            for (Map<String, Object> row : ledger(session)
                    .subList(0, view.size())) {
                expected.add(served(row, surface));
            }
            assertThat(view).as("%s frames of %s are the ledger", surface,
                    session).isEqualTo(expected);
            return view;
        }
    }

    @AfterEach
    void stop() {
        for (Observer observer : observers) {
            try {
                observer.client.shutdownNow();
            } catch (RuntimeException ignored) {
                // The client is already closed.
            }
        }
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
                    Path.of("target/fg13-cases", "fg13e", tenant));
            System.out.println("HOSTED_HOOK_STREAM_GAP_EVIDENCE "
                    + destination.toAbsolutePath());
            json.writeValue(destination.resolve("frames.json").toFile(),
                    observers.stream().map(observer -> Map.of("surface",
                            observer.surface, "frames", observer.frames))
                            .toList());
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
