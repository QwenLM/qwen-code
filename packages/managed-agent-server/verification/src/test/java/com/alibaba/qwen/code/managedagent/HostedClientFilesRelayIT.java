package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.reservePort;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

// Slice 4 joint qualification: the client-files registration loop across all
// three processes — scripted browser peer, real control plane on MySQL and
// real packaged Harness. Register dispatches Java -> Harness, the Harness
// MCP leg queues initialize/tools/list back in Java, and the browser drains
// them over SSE and answers. A refused discovery fails the registration
// closed, unregister fences the credential, and only the token digest is
// persisted. Turn-level read/write/approval joint evidence is the follow-up
// increment; the in-process tool-turn suite pins that conversion already.
class HostedClientFilesRelayIT {
    private static final String TOKEN = "client-files-relay-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "client-files-" + UUID.randomUUID();
    private final List<String> browserMethods = new CopyOnWriteArrayList<>();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private Path workspace;
    private int port;
    private int harnessPort;
    private int brokerPort;
    private String bootId;
    private ServletWebServerApplicationContext spring;
    private JdbcTemplate jdbc;
    private Process harness;
    private com.sun.net.httpserver.HttpServer model;
    private ExecutorService modelExecutor;
    private final List<Drain> drains = new CopyOnWriteArrayList<>();
    private final List<String> callArgs = new CopyOnWriteArrayList<>();
    private final List<String> modelToolMessages = new CopyOnWriteArrayList<>();

    @Test
    @Timeout(300)
    void registrationLoopCrossesBrowserControlPlaneAndHarnessOnMySql()
            throws Exception {
        boot();
        String session = createSession("yolo");

        // The registration dispatch is synchronous: the Harness MCP leg
        // queues initialize/tools/list while register blocks. The stream
        // route requires an existing binding, so the browser flow is
        // concurrent: fire register, wait for the binding to appear in
        // status, then drain. A fresh binding is generation 1.
        var registering = startRegister(session);
        awaitBinding(session, 1);
        Drain drain = startDrain(session, 1, false);
        var draining = beginAsync(drain);
        JsonNode registration = settled(registering, 200);
        draining.get(30, java.util.concurrent.TimeUnit.SECONDS);
        String token = registration.path("token").asText();
        assertThat(registration.path("serverId").asText())
                .isEqualTo("local-files");
        assertThat(registration.path("generation").asLong()).isEqualTo(1L);
        assertThat(registration.path("toolCount").asInt()).isEqualTo(1);
        assertThat(token).isNotBlank();
        // The Harness presented the registered credential on its MCP leg:
        // a wrong token would have 403'd the leg and failed the register.
        assertThat(browserMethods).contains("initialize", "tools/list");
        assertThat(webShell("POST", "/status",
                Map.of("sessionId", session), 200).path("state").asText())
                .isEqualTo("active");
        assertThat(jdbc.queryForObject(
                "SELECT token_hash FROM ma_client_files_binding"
                        + " WHERE session_scope_key = ?",
                String.class, scope(session)))
                .isEqualTo(DigestUtils.sha256Hex(token))
                .isNotEqualTo(token);

        // Re-registration advances the generation and rotates the credential.
        drain.stop();
        var replacing = startRegister(session);
        awaitBinding(session, 2);
        Drain second = startDrain(session, 2, false);
        var drainingSecond = beginAsync(second);
        JsonNode replaced = settled(replacing, 200);
        drainingSecond.get(30, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(replaced.path("generation").asLong()).isEqualTo(2L);
        assertThat(replaced.path("token").asText()).isNotEqualTo(token);
        assertThat(browserMethods.stream().filter("tools/list"::equals).count())
                .isGreaterThanOrEqualTo(2L);
        second.stop();

        // Unregister closes the binding; the CURRENT credential no longer opens
        // the Runtime MCP leg. Probe with the gen-2 token (not the gen-1 token,
        // which re-registration already rotated away): only the unregister
        // fence can invalidate the credential that was live immediately before
        // it, so a regression that skips the fence turns this red.
        assertThat(webShell("POST", "/unregister",
                Map.of("sessionId", session), 200).path("state").asText())
                .isEqualTo("closed");
        HttpResponse<String> fenced = http.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port
                        + "/internal/managed-client-files/v1/sessions/"
                        + session + "/mcp"))
                        .timeout(Duration.ofSeconds(10))
                        .header("Authorization", "Bearer " + replaced.path("token").asText())
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(
                                "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/list\"}"))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(fenced.statusCode()).isEqualTo(403);
        assertThat(json.readTree(fenced.body()).at("/error/code").asText())
                .isEqualTo("client_files_credential_invalid");

        // A browser that refuses discovery fails the registration closed:
        // the Harness cannot list tools, so Java answers 503.
        String refused = createSession("yolo");
        var refusing = startRegister(refused);
        awaitBinding(refused, 1);
        Drain offline = startDrain(refused, 1, true);
        // Join the drain BEFORE waiting on register so it answers the discovery
        // refusal while register is still pending. Joining only after register
        // settles would let the queued initialize expire at the request-TTL and
        // prove nothing about a refused tools/list.
        var offlineDraining = beginAsync(offline);
        HttpResponse<String> unavailable = refusing.get(60,
                java.util.concurrent.TimeUnit.SECONDS);
        assertThat(unavailable.statusCode()).isEqualTo(503);
        assertThat(json.readTree(unavailable.body()).at("/error/code").asText())
                .isEqualTo("client_files_relay_unavailable");
        // The browser actually refused tools/list during the pending register,
        // so a regression treating a refusal as an empty catalog turns this red.
        assertThat(offline.refusedMethods).contains("tools/list");
        offline.stop();
        offlineDraining.cancel(true);

        System.out.println("CLIENT_FILES_RELAY_EVIDENCE tenant=" + tenant
                + " registrationLoop=true generationRotate=true"
                + " credentialFence=true discoveryRefusalClosed=true"
                + " tokenDigestOnly=true");
    }

    @Test
    @Timeout(300)
    void turnExecutesBrowserToolThroughTheRelayOnMySql() throws Exception {
        boot();
        String session = createSession("yolo");
        Drain drain = registerBinding(session);
        submitTurn(session, "CF_TOOL read the client file");
        JsonNode transcript = awaitTranscriptContaining(session, "turn.completed");
        // The browser's answer reached the model through the relay: the
        // tool message content is the end-to-end proof; the transcript
        // keeps the tool call completed and the turn settled.
        assertThat(modelToolMessages)
                .anySatisfy(message -> assertThat(message).contains("client file content"));
        assertThat(transcript.toString()).contains("turn.completed");
        // durableResult: the client-files tool call is durably recorded as
        // completed in the journal-backed transcript projection, not merely
        // streamed to the model. (The result content follows the normal durable
        // tool-result policy and is witnessed reaching the model above; the
        // projection references it rather than inlining it in the tool_call.)
        JsonNode toolCallItem = null;
        for (JsonNode item : transcript.path("items")) {
            if ("tool_call".equals(item.path("type").asText())) {
                toolCallItem = item;
                break;
            }
        }
        assertThat(toolCallItem).isNotNull();
        assertThat(toolCallItem.path("status").asText()).isEqualTo("completed");
        assertThat(toolCallItem.path("attributes").path("name").asText())
                .startsWith("mcp_");
        assertThat(browserMethods).contains("tools/call");
        assertThat(callArgs).anySatisfy(args -> assertThat(args).contains("a.txt"));
        drain.stop();

        // A default-mode Session must ask before the browser tool runs.
        String approved = createSession("default");
        Drain approvalDrain = registerBinding(approved);
        submitTurn(approved, "CF_TOOL read the client file");
        approveNextAction(approved);
        JsonNode approvedTranscript = awaitTranscriptContaining(approved, "turn.completed");
        assertThat(approvedTranscript.toString()).contains("turn.completed");
        assertThat(modelToolMessages.stream()
                .filter(message -> message.contains("client file content")).count())
                .isGreaterThanOrEqualTo(2L);
        approvalDrain.stop();

        System.out.println("CLIENT_FILES_TURN_EVIDENCE yoloTurn=true approvedTurn=true"
                + " toolCallArgs=true durableResult=true");
    }

    private String scope(String session) {
        return com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore
                .sessionScopeKey(tenant, session);
    }

    private Drain registerBinding(String session) throws Exception {
        var registering = startRegister(session);
        awaitBinding(session, 1);
        Drain drain = startDrain(session, 1, false);
        var draining = beginAsync(drain);
        settled(registering, 200);
        draining.get(30, java.util.concurrent.TimeUnit.SECONDS);
        return drain;
    }

    private void submitTurn(String session, String text) throws Exception {
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port
                        + "/api/agent/web-shell/v1/turns/submit"))
                        .timeout(Duration.ofSeconds(60))
                        .header("X-Qwen-Tenant-Id", tenant)
                        .header("X-Qwen-Actor-Id", "actor")
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(
                                json.writeValueAsString(Map.of(
                                        "requestId", UUID.randomUUID().toString(),
                                        "idempotencyKey", "submit-" + UUID.randomUUID(),
                                        "sessionId", session,
                                        "input", List.of(Map.of(
                                                "type", "text", "text", text))))))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode())
                .as("turns/submit: %s", response.body())
                .isBetween(200, 299);
    }

    private JsonNode awaitTranscriptContaining(String session, String needle) {
        var result = new java.util.concurrent.atomic.AtomicReference<JsonNode>();
        await().atMost(Duration.ofSeconds(120)).untilAsserted(() -> {
            JsonNode transcript = webShellApi("/transcript/query",
                    Map.of("sessionId", session), 200);
            assertThat(transcript.toString()).contains(needle);
            result.set(transcript);
        });
        return result.get();
    }

    private void approveNextAction(String session) throws Exception {
        var found = new java.util.concurrent.atomic.AtomicReference<JsonNode>();
        await().atMost(Duration.ofSeconds(60)).untilAsserted(() -> {
            JsonNode page = webShellApi("/actions/query",
                    Map.of("sessionId", session), 200);
            for (JsonNode action : page.path("data")) {
                if ("requested".equals(action.path("state").asText())) {
                    found.set(action);
                    return;
                }
            }
            throw new AssertionError("no requested action yet: " + page);
        });
        JsonNode action = found.get();
        assertThat(action.path("toolName").asText()).startsWith("mcp_");
        webShellApi("/actions/respond", Map.of(
                "requestId", UUID.randomUUID().toString(),
                "sessionId", session,
                "actionId", action.path("actionId").asText(),
                "idempotencyKey", "approve-" + UUID.randomUUID(),
                "response", Map.of(
                        "kind", "permission",
                        "inputRevision", action.path("inputRevision"),
                        "policyRevision", action.path("policyRevision").asText(),
                        "optionId", "allow")), 202);
    }

    private java.util.concurrent.CompletableFuture<HttpResponse<String>> startRegister(
            String session) {
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try {
                return webShellRaw("POST", "/register",
                        Map.of("sessionId", session, "connectionId", "conn-it"));
            } catch (Exception failure) {
                throw new java.util.concurrent.CompletionException(failure);
            }
        });
    }

    private void awaitBinding(String session, long generation) {
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            JsonNode status = webShell("POST", "/status",
                    Map.of("sessionId", session), 200);
            assertThat(status.path("state").asText()).isEqualTo("active");
            assertThat(status.path("generation").asLong()).isEqualTo(generation);
        });
    }

    private java.util.concurrent.CompletableFuture<Void> beginAsync(Drain drain) {
        return java.util.concurrent.CompletableFuture.runAsync(() -> {
            try {
                drain.begin();
            } catch (Exception failure) {
                throw new java.util.concurrent.CompletionException(failure);
            }
        });
    }

    private JsonNode settled(
            java.util.concurrent.CompletableFuture<HttpResponse<String>> future,
            int expected) throws Exception {
        HttpResponse<String> response = future.get(60,
                java.util.concurrent.TimeUnit.SECONDS);
        assertThat(response.statusCode()).as("register: %s", response.body())
                .isEqualTo(expected);
        return json.readTree(response.body());
    }

    private void boot() throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("the joint relay loop requires a disposable MySQL")
                .startsWith("jdbc:mysql:");
        String node = System.getProperty("node.executable");
        assertThat(node).isNotBlank();
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        temporary = temporary.toRealPath();
        workspace = Files.createDirectories(temporary.resolve("workspace/child"));
        Files.createDirectory(temporary.resolve("decoy"));
        Files.createDirectory(temporary.resolve("broker"),
                java.nio.file.attribute.PosixFilePermissions.asFileAttribute(
                        java.nio.file.attribute.PosixFilePermissions.fromString("rwx------")));
        Path worker = temporary.resolve("worker.mjs");
        Files.writeString(worker, "process.argv[1]="
                + json.writeValueAsString(cli.toString()) + "; await import("
                + json.writeValueAsString(cli.toUri().toString()) + ");\n");
        port = reservePort();
        harnessPort = reservePort();
        brokerPort = reservePort();
        model = com.sun.net.httpserver.HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        modelExecutor = Executors.newVirtualThreadPerTaskExecutor();
        model.setExecutor(modelExecutor);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        startHarness(node, cli, "http://127.0.0.1:" + model.getAddress().getPort() + "/v1");
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class)
                .run("--server.address=127.0.0.1", "--server.port=" + port,
                        "--spring.datasource.url=" + System.getProperty("mysql.url"),
                        "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                        "--spring.datasource.username=" + System.getProperty("mysql.user"),
                        "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                        "--qwen.managed-agent.trusted-actor-header=X-Qwen-Actor-Id",
                        "--qwen.managed-agent.session-store.enabled=true",
                        "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + port,
                        "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                        "--qwen.managed-agent.session-store.writer-lease-duration=3s",
                        "--qwen.managed-agent.harness.enabled=true",
                        "--qwen.managed-agent.harness.base-url=http://127.0.0.1:" + harnessPort,
                        "--qwen.managed-agent.harness.token=" + TOKEN,
                        "--qwen.managed-agent.harness.capability-digest=" + CAPABILITY,
                        "--qwen.managed-agent.harness.workspace-files-enabled=true",
                        "--qwen.managed-agent.runtime-broker.enabled=true",
                        "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
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
                        "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                        "--qwen.managed-agent.runtime-broker.worker-entry=" + worker,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root="
                                + workspace.getParent(),
                        "--qwen.managed-agent.client-files.enabled=true",
                        "--qwen.managed-agent.client-files.relay-url=http://127.0.0.1:" + port,
                        "--qwen.managed-agent.client-files.request-ttl=5s");
        jdbc = spring.getBean(JdbcTemplate.class);
        spring.getBean(WorkspaceStorageGuard.class)
                .register(tenant, "storage", UUID.randomUUID().toString());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES (?, 'workspace',"
                + " 1, 'storage', 'ClientFiles', ?, ?, 'ACTIVE')", tenant,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'workspace',"
                + " ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
    }

    private void startHarness(String node, Path cli, String modelUrl) throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home"));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        json.writeValue(config.resolve("settings.json").toFile(), Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")),
                "telemetry", Map.of("enabled", false),
                "model", Map.of("name", "cf-fixture"),
                "modelProviders", Map.of("openai", List.of(Map.of(
                        "id", "cf-fixture", "envKey", "OPENAI_API_KEY",
                        "baseUrl", modelUrl)))));
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--hostname", "127.0.0.1", "--port", Integer.toString(harnessPort),
                "--require-auth", "--no-web",
                "--workspace", temporary.resolve("decoy").toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:" + brokerPort,
                "--managed-runtime-broker-token", TOKEN)
                .directory(temporary.resolve("decoy").toFile())
                .redirectErrorStream(true)
                .redirectOutput(temporary.resolve("harness.log").toFile());
        var env = builder.environment();
        env.clear();
        env.put("PATH", System.getenv("PATH"));
        env.putAll(Map.of("HOME", home.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", home.resolve("runtime").toString(),
                "OPENAI_API_KEY", "fixture-only", "OPENAI_BASE_URL", modelUrl,
                "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", CAPABILITY,
                "QWEN_CODE_MODELS_DEV_REFRESH", "off"));
        for (String key : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            env.put(key, home.resolve(key + ".json").toString());
        }
        harness = builder.start();
        await().atMost(Duration.ofSeconds(120))
                .ignoreException(java.net.ConnectException.class)
                .untilAsserted(() -> {
                    assertThat(harness.isAlive())
                            .as("Harness log: %s", Files.readString(
                                    temporary.resolve("harness.log")))
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

    private String createSession(String approvalMode) throws Exception {
        // The real deployment path: Java admits the Session, warms the
        // Workspace and attaches the Harness, so the relay dispatch finds
        // a fully authorized execution binding.
        HttpResponse<String> created = http.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port
                        + "/api/agent/web-shell/v1/sessions/create"))
                        .timeout(Duration.ofSeconds(60))
                        .header("X-Qwen-Tenant-Id", tenant)
                        .header("X-Qwen-Actor-Id", "actor")
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(
                                json.writeValueAsString(Map.of(
                                        "requestId", UUID.randomUUID().toString(),
                                        "idempotencyKey", "create-" + UUID.randomUUID(),
                                        "agentId", "qwen-code",
                                        "workspace", Map.of(
                                                "workspaceId", "workspace",
                                                "cwdRelative", "child"),
                                        "approvalMode", approvalMode))))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(created.statusCode())
                .as("sessions/create: %s", created.body()).isEqualTo(202);
        String session = json.readTree(created.body()).path("sessionId").asText();
        assertThat(session).isNotBlank();
        return session;
    }

    private JsonNode webShell(String method, String route, Object body,
            int expected) throws Exception {
        HttpResponse<String> response = webShellRaw(method, route, body);
        assertThat(response.statusCode()).as("%s %s: %s", method, route,
                response.body()).isEqualTo(expected);
        return json.readTree(response.body());
    }

    private JsonNode webShellApi(String route, Object body, int expected)
            throws Exception {
        HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + port + "/api/agent/web-shell/v1" + route))
                .timeout(Duration.ofSeconds(60))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("X-Qwen-Actor-Id", "actor")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("POST %s: %s", route,
                response.body()).isEqualTo(expected);
        return json.readTree(response.body());
    }

    private HttpResponse<String> webShellRaw(String method, String route,
            Object body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + port + "/api/agent/web-shell/v1/client-files" + route))
                .timeout(Duration.ofSeconds(60))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("X-Qwen-Actor-Id", "actor")
                .header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(
                        json.writeValueAsString(body)))
                .build(), HttpResponse.BodyHandlers.ofString());
    }

    /** The scripted browser: drains the SSE request stream and answers. */
    private Drain startDrain(String session, long generation, boolean refuseList)
            throws Exception {
        Drain drain = new Drain(session, generation, refuseList);
        drains.add(drain);
        // No request timeout: the SSE exchange stays open for the whole
        // binding lifetime. The response headers only commit on the first
        // event, so the join happens in begin() after register settles.
        drain.stream = http.sendAsync(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port
                        + "/api/agent/web-shell/v1/client-files/requests/stream"))
                        .header("X-Qwen-Tenant-Id", tenant)
                        .header("X-Qwen-Actor-Id", "actor")
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(
                                json.writeValueAsString(Map.of(
                                        "sessionId", session,
                                        "generation", generation,
                                        "connectionId", "conn-it"))))
                        .build(),
                HttpResponse.BodyHandlers.ofInputStream());
        return drain;
    }

    private final class Drain {
        private final String session;
        private final long generation;
        private final boolean refuseList;
        private final List<String> refusedMethods = new CopyOnWriteArrayList<>();
        private final AtomicBoolean open = new AtomicBoolean(true);
        private InputStream body;
        private java.util.concurrent.CompletableFuture<HttpResponse<InputStream>> stream;

        private Drain(String session, long generation, boolean refuseList) {
            this.session = session;
            this.generation = generation;
            this.refuseList = refuseList;
        }

        private void begin() throws Exception {
            HttpResponse<InputStream> response = stream.get(30,
                    java.util.concurrent.TimeUnit.SECONDS);
            assertThat(response.statusCode()).isEqualTo(200);
            body = response.body();
            Thread.startVirtualThread(() -> run(body));
        }

        private void run(InputStream stream) {
            try (var reader = new BufferedReader(
                    new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String event = null;
                String line;
                while (open.get() && (line = reader.readLine()) != null) {
                    if (line.startsWith("event:")) {
                        event = line.substring("event:".length()).trim();
                    } else if (line.startsWith("data:") && "request".equals(event)) {
                        answer(json.readTree(line.substring("data:".length()).trim()));
                        event = null;
                    }
                }
            } catch (IOException ended) {
                // The stream ends when the binding closes or the test stops.
            }
        }

        private void answer(JsonNode request) {
            try {
                JsonNode payload = json.readTree(request.path("payloadJson").asText());
                String method = payload.path("method").asText();
                browserMethods.add(method);
                if ("tools/call".equals(method)) {
                    callArgs.add(payload.at("/params/arguments").toString());
                }
                if (!payload.has("id") || payload.path("id").isNull()) {
                    return;
                }
                String id = payload.path("id").asText();
                Object result;
                if (refuseList && "tools/list".equals(method)) {
                    refusedMethods.add(method);
                    result = Map.of("error", Map.of("code", -32000,
                            "message", "client_files_offline"));
                } else if ("initialize".equals(method)) {
                    result = Map.of("result", Map.of(
                            "protocolVersion", "2024-11-05",
                            "capabilities", Map.of("tools", Map.of()),
                            "serverInfo", Map.of("name", "scripted-browser",
                                    "version", "1.0.0")));
                } else if ("tools/list".equals(method)) {
                    result = Map.of("result", Map.of("tools", List.of(Map.of(
                            "name", "read_file",
                            "description", "Read a client file",
                            "inputSchema", Map.of("type", "object")))));
                } else {
                    result = Map.of("result", Map.of("content", List.of(
                            Map.of("type", "text", "text", "client file content"))));
                }
                var response = json.createObjectNode();
                response.put("jsonrpc", "2.0");
                response.put("id", id);
                response.setAll((com.fasterxml.jackson.databind.node.ObjectNode)
                        json.valueToTree(result));
                webShell("POST", "/responses", Map.of(
                        "sessionId", session,
                        "generation", generation,
                        "connectionId", "conn-it",
                        "rpcRequestId", id,
                        "responseJson", json.writeValueAsString(response)), 200);
            } catch (Exception failure) {
                throw new IllegalStateException("Browser fixture failed", failure);
            }
        }

        private void stop() {
            open.set(false);
            try {
                if (body != null) {
                    body.close();
                }
            } catch (IOException ignored) {
                // Best-effort teardown.
            }
        }
    }

    /**
     * The scripted model: calls the advertised mcp_* tool while the prompt
     * marker is unanswered, then completes once the tool result arrives.
     */
    private void modelReply(com.sun.net.httpserver.HttpExchange exchange)
            throws IOException {
        try {
            JsonNode request = json.readTree(exchange.getRequestBody());
            boolean toolResult = false;
            boolean marker = false;
            for (JsonNode message : request.path("messages")) {
                if ("tool".equals(message.path("role").asText())) {
                    toolResult = true;
                    modelToolMessages.add(message.path("content").toString());
                }
                if ("user".equals(message.path("role").asText())
                        && message.path("content").toString().contains("CF_TOOL")) {
                    marker = true;
                }
            }
            String mcpName = null;
            for (JsonNode tool : request.path("tools")) {
                String name = tool.at("/function/name").asText();
                if (name.startsWith("mcp_")) {
                    mcpName = name;
                }
            }
            boolean call = marker && !toolResult && mcpName != null;
            var chunk = json.createObjectNode().put("id", "cf-fixture")
                    .put("object", "chat.completion.chunk").put("created", 0)
                    .put("model", "cf-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            if (call) {
                delta.putArray("tool_calls").addObject().put("index", 0)
                        .put("id", "call_cf_tool").put("type", "function")
                        .putObject("function").put("name", mcpName)
                        .put("arguments", json.writeValueAsString(
                                Map.of("path", "a.txt")));
            } else {
                delta.put("content", "CF_DONE");
            }
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", call ? "tool_calls" : "stop");
            byte[] response = (first + "data: " + json.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
        } finally {
            exchange.close();
        }
    }

    @AfterEach
    void stop() {
        for (Drain drain : drains) {
            drain.stop();
        }
        try {
            if (spring != null) {
                spring.close();
            }
        } finally {
            if (model != null) {
                model.stop(0);
            }
            if (modelExecutor != null) {
                modelExecutor.shutdownNow();
            }
            if (harness != null) {
                harness.destroyForcibly();
                try {
                    harness.waitFor(10, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            // shutdownNow, not close: a drained SSE exchange can keep the
            // selector alive forever after its body stream is closed.
            http.shutdownNow();
        }
    }
}
