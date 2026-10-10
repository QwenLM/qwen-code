package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
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
import java.nio.file.attribute.PosixFilePermissions;
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

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
    private boolean approvals;
    private boolean shell;
    private String shellDecision = "allow";
    private boolean durableClose;
    private String shellFault;
    private HttpServer storeRelay;
    private ExecutorService relayExecutor;
    private HostedShellOutputProbe shellProbe;
    private Map<String, Object> faultSession;
    private final List<byte[]> receiptRequests = new CopyOnWriteArrayList<>();
    private final AtomicInteger receiptResponses = new AtomicInteger();
    private final java.util.Set<String> answered = new java.util.HashSet<>();
    // Sessions whose first approval was answered by the operator who is not
    // the Session owner, proving R1's second-operator handoff.
    private final java.util.Set<String> operatorAnswered = new java.util.HashSet<>();
    private final java.util.Set<String> fixedAnswered = new java.util.HashSet<>();

    @Test
    @Timeout(150)
    void publicCreationRunsFilesThroughProductionWorkspaceBinding() throws Exception {
        runFiles();
    }

    @Test
    @Timeout(150)
    void ownerAnswersHostedApprovalsThroughBothSurfaces() throws Exception {
        approvals = true;
        runFiles();
        assertThat(answered).hasSize(8);
        // Two sessions (one per mounted workspace) each had their first
        // approval answered by the non-owner OPERATOR — pin the handoff,
        // or the responder ternary can collapse to the owner unnoticed.
        assertThat(operatorAnswered).hasSize(2);
    }

    @ParameterizedTest
    @ValueSource(strings = {"allow", "deny"})
    @Timeout(150)
    void publicForegroundShellUsesMandatoryApprovalOnBothSurfaces(String decision) throws Exception {
        shell = true;
        approvals = true;
        shellDecision = decision;
        List<Path> roots = boot();
        for (int index = 0; index < roots.size(); index++) {
            boolean web = index == 1;
            String workspace = "workspace-" + index;
            register(workspace, "storage-" + index);
            Map<String, Object> input = Map.of("type", "input_text", "text", "G0_SHELL");
            String route = web ? "/api/agent/web-shell/v1/sessions/create" : "/v1/agents/sessions";
            Map<String, Object> body = web
                    ? Map.of("agentId", "qwen-code", "idempotencyKey", workspace, "input", List.of(),
                            "workspace", Map.of("workspaceId", workspace, "cwdRelative", "child"))
                    : Map.of("agent_id", "qwen-code", "input", List.of(input), "workspace",
                            Map.of("workspace_id", workspace, "cwd_relative", "child"));
            JsonNode created = request("POST", route, body, workspace, "actor", 202);
            String session = created.path(web ? "sessionId" : "id").asText();
            JsonNode supported = web ? request("POST", "/api/agent/web-shell/v1/sessions/get",
                    Map.of("sessionId", session), null, "actor", 200) : created;
            assertThat(supported.at(web ? "/capabilities/foregroundShell" : "/capabilities/foreground_shell").asBoolean()).isTrue();
            assertThat(jdbc.queryForObject("SELECT tool_profile FROM managed_agent_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("hosted-workspace-shell/1");
            assertThat(jdbc.queryForObject("SELECT approval_mode FROM managed_agent_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("deny".equals(decision) ? "auto-edit" : "default");
            if (web) request("POST", "/api/agent/web-shell/v1/turns/submit",
                    Map.of("sessionId", session, "idempotencyKey", "shell-turn", "input", List.of(input)),
                    "shell-turn", "actor", 202);
            await().atMost(Duration.ofSeconds(35)).failFast(() -> {
                        if (modelFailure.get() != null) throw new AssertionError("Model fixture failed", modelFailure.get());
                    }).untilAsserted(() -> {
                        answerActions(session, web);
                        assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_turn WHERE session_id = ?",
                                String.class, session)).isEqualTo("COMPLETED");
                    });
            Path marker = roots.get(index).resolve("child/shell-proof.txt");
            if ("allow".equals(decision)) assertThat(Files.readString(marker)).isEqualTo("once\n");
            else assertThat(marker).doesNotExist();
            assertThat(decoy.resolve("shell-proof.txt")).doesNotExist();
            assertThat(roots.get(index).resolve("child/monitor-proof.txt")).doesNotExist();
            assertThat(roots.get(index).resolve("child/background-proof.txt")).doesNotExist();
            assertThat(request("POST", route, body, workspace, "actor", 202)
                    .path(web ? "sessionId" : "id").asText()).isEqualTo(session);
            for (String kind : List.of("close", "archive", "delete")) {
                boolean restDelete = !web && "delete".equals(kind);
                String lifecycle = web ? "/api/agent/web-shell/v1/sessions/" + kind
                        : "/v1/agents/sessions/" + session + (restDelete ? "" : "/" + kind);
                Object command = web ? Map.of("sessionId", session, "idempotencyKey", kind) : null;
                assertUnavailable(request(restDelete ? "DELETE" : "POST", lifecycle, command, kind, "actor", 409));
            }
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_operation WHERE session_id = ?"
                    + " AND operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')", Integer.class, session)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_turn WHERE session_id = ?",
                    Integer.class, session)).isEqualTo(1);
            if ("allow".equals(decision)) assertThat(Files.readString(marker)).isEqualTo("once\n");
            else assertThat(marker).doesNotExist();
        }
        assertThat(answered).hasSize(2);
        assertThat(modelFailure.get()).isNull();
        assertThat(modelRequests).hasSize(8);
    }

    @ParameterizedTest
    @ValueSource(strings = {"receipt-failure", "receipt-reply"})
    @Timeout(150)
    void publicShellReceiptFaultsNeverRepeatEffects(String fault) throws Exception {
        assertThat(System.getProperty("mysql.url")).as("Public FG6f requires real MySQL").startsWith("jdbc:mysql:");
        shell = true;
        approvals = true;
        shellFault = fault;
        Path directory = boot().getFirst().resolve("child");
        register("workspace-0", "storage-0");
        Files.writeString(directory.resolve("proof.txt"), "x");
        var body = Map.of("agent_id", "qwen-code", "input", List.of(), "workspace",
                Map.of("workspace_id", "workspace-0", "cwd_relative", "child"));
        String session = request("POST", "/v1/agents/sessions", body, "fault-create", "actor", 202).path("id").asText();
        faultSession = Map.of("sessionId", session, "workspaceId", "workspace-0", "directory", directory.toString(), "fault", fault);
        shellProbe = new HostedShellOutputProbe(jdbc, tenant, List.of(faultSession),
                spring.getBean(EmbeddedRuntimeBroker.class), storeRelay);
        String trigger = "public_shell_" + UUID.randomUUID().toString().replace("-", "");
        if ("receipt-failure".equals(fault)) {
            assertThat(tenant).matches("g0-[0-9a-f-]{36}");
            assertThat(session).matches("[0-9a-f-]{36}");
            jdbc.execute("CREATE TRIGGER " + trigger + " BEFORE INSERT ON qwen_managed_session_journal_tx FOR EACH ROW BEGIN IF"
                    + " NEW.tenant_id = '" + tenant + "' AND NEW.session_id = '" + session + "'"
                    + " AND NEW.operation = 'recordToolResult'"
                    + " AND LOCATE('\"kind\":\"tool.receipt\"', CONVERT(NEW.record_bytes USING utf8mb4)) > 0"
                    + " THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PUBLIC_FG6F_receipt-failure'; END IF; END");
        }
        try {
            var input = List.of(Map.of("type", "input_text", "text", "G0_SHELL_FAULT"));
            String turn = request("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type", "agent.session.input.message", "input", input),
                    "fault-turn", "actor", 202).path("turn_id").asText();
            await().atMost(Duration.ofSeconds(60)).failFast(() -> {
                if (modelFailure.get() != null) throw new AssertionError("Fault fixture failed", modelFailure.get());
            }).untilAsserted(() -> {
                answerActions(session, false);
                assertThat(receiptRequests).hasSize(3);
                assertThat(jdbc.queryForList("SELECT execution_state FROM qwen_tool_execution WHERE harness_session_id = ?",
                        String.class, session)).containsExactly("UNKNOWN");
            });
            var connector = spring.getBean(HarnessConnector.class);
            var attachments = (Map<?, ?>) ReflectionTestUtils.getField(connector, "attachments");
            var attached = attachments.values().stream().map(HarnessSessionRef.class::cast)
                    .filter(ref -> session.equals(ref.getHarnessSessionId())).findFirst().orElseThrow();
            var client = (HostedHarnessClient) ReflectionTestUtils.getField(connector, "client");
            // The third request is counted before its handler finishes; wait for the
            // producer's prompt and all receipt handlers before taking final evidence.
            await().atMost(Duration.ofSeconds(15)).failFast(() -> {
                if (modelFailure.get() != null) throw new AssertionError("Fault fixture failed", modelFailure.get());
            }).untilAsserted(() -> {
                var status = client.getStatus(attached);
                assertThat(status.hasActivePrompt()).isFalse();
                assertThat(status.getRaw().get("recoveryBlocked")).isEqualTo(true);
                assertThat(receiptResponses.get()).isEqualTo(3);
            });
            assertThat(receiptRequests).hasSize(3);
            assertThat(answered).hasSize(1);
            assertThat(modelRequests).hasSize(1);
            assertThat(jdbc.queryForObject("SELECT tool_profile FROM managed_agent_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("hosted-workspace-shell/1");
            assertThat(jdbc.queryForObject("SELECT approval_mode FROM managed_agent_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("default");
            var original = json.readTree(receiptRequests.getFirst());
            for (byte[] retry : receiptRequests) assertThat(retry).isEqualTo(receiptRequests.getFirst());
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx WHERE tenant_id = ?"
                    + " AND session_id = ? AND transaction_id = ?", Integer.class, tenant, session,
                    original.path("transactionId").asText())).isEqualTo("receipt-reply".equals(fault) ? 1 : 0);
            assertThat(jdbc.queryForObject("SELECT prompt_id FROM managed_agent_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, turn)).isEqualTo(jdbc.queryForObject(
                            "SELECT turn_id FROM qwen_tool_execution WHERE harness_session_id = ?", String.class, session));
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type", "agent.session.input.message", "input", input),
                    "fault-turn", "actor", 202).path("turn_id").asText()).isEqualTo(turn);
            shellProbe.assertPublicFault(faultSession);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_turn WHERE session_id = ?", Integer.class, session)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_turn WHERE session_id = ?", String.class, session)).isNotEqualTo("COMPLETED");
            assertThat(decoy.resolve("proof.txt")).doesNotExist();
            assertThat(modelFailure.get()).isNull();
            assertThat(receiptRequests).hasSize(3);
            System.out.println("PUBLIC_FG6F " + fault + " session=" + session + " turn=" + turn
                    + " receiptAttempts=" + receiptRequests.size() + " effect=once");
        } finally {
            if ("receipt-failure".equals(fault)) jdbc.execute("DROP TRIGGER " + trigger);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @EnabledOnOs(OS.LINUX)
    @Timeout(150)
    void durableCloseStopsOriginalWorkersAndRetainsHistoryAndFiles(boolean crash) throws Exception {
        durableClose = true;
        runFiles();
        List<String> sessions = jdbc.queryForList("SELECT session_id FROM managed_agent_session WHERE tenant_id = ?"
                + " ORDER BY workspace_id", String.class, tenant);
        for (int index = 0; index < sessions.size(); index++) {
            String session = sessions.get(index);
            String binding = jdbc.queryForObject("SELECT binding_id FROM qwen_runtime_binding WHERE tenant_id = ?"
                    + " AND isolation_key = ?", String.class, tenant, session);
            JsonNode handle = json.readTree(jdbc.queryForObject("SELECT resource_handle_json FROM qwen_runtime_binding"
                    + " WHERE binding_id = ?", String.class, binding));
            Path registration = temporary.resolve("broker").resolve(handle.path("resourceId").asText() + ".json");
            long pid = json.readTree(Files.readString(registration)).path("pid").asLong();
            var worker = ProcessHandle.of(pid).orElseThrow();
            assertThat(worker.isAlive()).isTrue();
            if (crash) {
                worker.destroyForcibly();
                worker.onExit().get(5, TimeUnit.SECONDS);
                if (index == 1) {
                    jdbc.update("UPDATE managed_workspace_registry SET config_ref = ? WHERE tenant_id = ?"
                            + " AND workspace_id = ?", WorkspaceExecutionProfile.CONFIG_REF, tenant, "workspace-" + index);
                    String failedTurn = request("POST", "/v1/agents/sessions/" + session + "/events",
                            Map.of("type", "agent.session.input.message", "input",
                                    List.of(Map.of("type", "input_text", "text", "G0_AGAIN"))),
                            "after-crash", "actor", 202).path("turn_id").asText();
                    await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                            "SELECT status FROM managed_agent_turn WHERE session_id = ? AND turn_id = ?",
                            String.class, session, failedTurn)).isEqualTo("FAILED"));
                }
                assertThat(jdbc.queryForObject("SELECT binding_state FROM qwen_runtime_binding WHERE binding_id = ?",
                        String.class, binding)).isEqualTo(index == 0 ? "READY" : "LOST");
            }
            var retained = jdbc.queryForList("SELECT resource_id, sha256 FROM qwen_managed_session_resource"
                    + " WHERE tenant_id = ? AND session_id = ? ORDER BY resource_id", tenant, session);
            assertThat(retained).isNotEmpty();
            assertThat(request("GET", "/v1/agents/sessions/" + session, null, null, "actor", 200)
                    .path("capabilities").path("session_close").asBoolean()).isTrue();
            boolean webShell = index == 1;
            String route = webShell ? "/api/agent/web-shell/v1/sessions/close" : "/v1/agents/sessions/" + session + "/close";
            Map<String, Object> body = webShell ? Map.of("sessionId", session, "idempotencyKey", "close") : null;
            JsonNode admitted = request("POST", route, body, "close", "actor", 202);
            String operation = admitted.path(webShell ? "operationId" : "id").asText();
            await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                    assertThat(request("GET", "/v1/agents/sessions/" + session + "/operations/" + operation,
                            null, null, "actor", 200).path("status").asText()).isEqualTo("completed"));
            assertThat(worker.isAlive()).isFalse();
            assertThat(json.readTree(Files.readString(registration)).path("state").asText()).isEqualTo("RETIRED");
            assertThat(jdbc.queryForObject("SELECT drain_receipt_json FROM qwen_runtime_binding WHERE binding_id = ?",
                    String.class, binding)).isNotBlank();
            assertThat(jdbc.queryForObject("SELECT binding_state FROM qwen_runtime_binding WHERE binding_id = ?",
                    String.class, binding)).isEqualTo("RELEASED");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_session WHERE binding_id = ?"
                    + " AND session_state NOT IN ('RELEASED', 'FAILED')", Integer.class, binding)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease WHERE binding_id = ?"
                    + " AND holder_key IS NOT NULL", Integer.class, binding)).isZero();
            assertThat(jdbc.queryForList("SELECT resource_id, sha256 FROM qwen_managed_session_resource WHERE tenant_id = ?"
                    + " AND session_id = ? ORDER BY resource_id", tenant, session)).containsAll(retained);
            assertThat(request("GET", "/v1/agents/sessions/" + session + "/events", null, null, "actor", 200).toString())
                    .contains("G0_DONE");
            assertThat(Files.readString(temporary.resolve(index == 0 ? "workspace-a" : "workspace-b")
                    .resolve("child/proof.txt"))).isEqualTo("after");
            assertThat(request("POST", route, body, "close", "actor", 202)
                    .path(webShell ? "operationId" : "id").asText()).isEqualTo(operation);
            if (crash) {
                jdbc.update("UPDATE managed_workspace_registry SET config_ref = ? WHERE tenant_id = ?"
                        + " AND workspace_id = ?", WorkspaceExecutionProfile.CONFIG_REF, tenant, "workspace-" + index);
                String nextSession = request("POST", "/v1/agents/sessions",
                        Map.of("agent_id", "qwen-code", "input", List.of(Map.of("type", "input_text", "text", "G0_FILES")),
                                "workspace", Map.of("workspace_id", "workspace-" + index, "cwd_relative", "child")),
                        "after-close-" + index, "actor", 202).path("id").asText();
                await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                        "SELECT status FROM managed_agent_turn WHERE session_id = ?", String.class, nextSession))
                        .isEqualTo("COMPLETED"));
                assertThat(Files.readString(temporary.resolve(index == 0 ? "workspace-a" : "workspace-b")
                        .resolve("child/proof.txt"))).isEqualTo("after");
            }
        }
    }

    // W2: a controlled cwd change settles through the production server and
    // the deployment's real Workspace probe, on both API surfaces.
    @Test
    @Timeout(150)
    void workspaceCwdChangeSettlesThroughBothSurfaces() throws Exception {
        List<Path> roots = boot();
        Files.createDirectory(roots.get(0).resolve("child2"));
        register("workspace-0", "storage-0");
        register("workspace-1", "storage-1");
        Map<String, Object> creation = Map.of("agent_id", "qwen-code",
                "input", List.of(Map.of("type", "input_text", "text",
                        "G0_FILES")), "workspace",
                Map.of("workspace_id", "workspace-0", "cwd_relative", "child"));
        String session = request("POST", "/v1/agents/sessions", creation,
                "w2-create", "actor", 202).path("id").asText();
        // The Session first runs a real tool Turn in the original
        // directory, so the later Turn has something to escape from.
        awaitTurn(session, null, "child", roots.get(0));

        Map<String, Object> change = Map.of("cwd_relative", "child2//",
                "expected_context_revision", 1);
        JsonNode operation = request("POST",
                "/v1/agents/sessions/" + session + "/cwd", change, "w2-cwd-1",
                "actor", 202);
        assertThat(operation.path("type").asText()).isEqualTo("cwd_change");
        assertThat(operation.path("target_cwd_relative").asText())
                .isEqualTo("child2");
        assertThat(operation.path("expected_context_revision").asLong())
                .isEqualTo(1);
        assertThat(operation.path("status").asText())
                .isIn("pending", "installing");
        assertThat(operation.path("replayed").asBoolean()).isFalse();
        String operationId = operation.path("id").asText();

        // The same key replays even spelled differently once normalized.
        JsonNode replay = request("POST",
                "/v1/agents/sessions/" + session + "/cwd",
                Map.of("cwd_relative", "child2/./",
                        "expected_context_revision", 1),
                "w2-cwd-1", "actor", 202);
        assertThat(replay.path("id").asText()).isEqualTo(operationId);
        assertThat(replay.path("replayed").asBoolean()).isTrue();

        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            JsonNode polled = request("GET", "/v1/agents/sessions/" + session
                    + "/operations/" + operationId, null, null, "actor", 200);
            assertThat(polled.path("status").asText()).isEqualTo("completed");
            assertThat(polled.path("result_context_revision").asLong())
                    .isEqualTo(2);
            assertThat(polled.path("replayed").asBoolean()).isFalse();
        });
        JsonNode read = request("GET", "/v1/agents/sessions/" + session,
                null, null, "actor", 200);
        assertThat(read.at("/workspace/cwd_relative").asText())
                .isEqualTo("child2");
        assertThat(read.at("/workspace/context_revision").asLong())
                .isEqualTo(2);
        assertThat(read.at("/workspace/state").asText()).isEqualTo("ready");
        JsonNode events = request("GET", "/v1/agents/sessions/" + session
                + "/events", null, null, "actor", 200);
        JsonNode changed = null;
        for (JsonNode event : events.path("data")) {
            if ("session.context.changed"
                    .equals(event.path("type").asText())) {
                changed = event;
            }
        }
        assertThat(changed).as("session.context.changed in %s", events)
                .isNotNull();
        assertThat(changed.path("data").path("cwdRelative").asText())
                .isEqualTo("child2");
        assertThat(changed.path("data").path("contextRevision").asLong())
                .isEqualTo(2);
        assertThat(changed.path("data").path("workspaceId").asText())
                .isEqualTo("workspace-0");

        Map<String, Object> webChange = Map.of("sessionId", session,
                "idempotencyKey", "w2-cwd-web-1", "cwdRelative", ".",
                "expectedContextRevision", 2);
        JsonNode webOperation = request("POST",
                "/api/agent/web-shell/v1/sessions/cwd/change", webChange,
                null, "actor", 202);
        assertThat(webOperation.path("type").asText())
                .isEqualTo("cwd_change");
        String webOperationId = webOperation.path("operationId").asText();
        JsonNode webReplay = request("POST",
                "/api/agent/web-shell/v1/sessions/cwd/change", webChange,
                null, "actor", 202);
        assertThat(webReplay.path("operationId").asText())
                .isEqualTo(webOperationId);
        assertThat(webReplay.path("replayed").asBoolean()).isTrue();
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            JsonNode polled = request("POST",
                    "/api/agent/web-shell/v1/operations/query",
                    Map.of("sessionId", session,
                            "operationId", webOperationId),
                    null, "actor", 200);
            assertThat(polled.path("status").asText()).isEqualTo("completed");
            assertThat(polled.path("resultContextRevision").asLong())
                    .isEqualTo(3);
        });

        assertRefusal(request("POST",
                "/v1/agents/sessions/" + session + "/cwd",
                Map.of("cwd_relative", "..", "expected_context_revision",
                        3), "w2-bad-lexical", "actor", 400), "invalid_cwd");
        assertRefusal(request("POST",
                "/v1/agents/sessions/" + session + "/cwd",
                Map.of("cwd_relative", "child",
                        "expected_context_revision", 1),
                "w2-stale-revision", "actor", 409), "context_revision_conflict");
        String legacy = request("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code"), "w2-legacy", null, 202)
                .path("id").asText();
        assertRefusal(request("POST",
                "/v1/agents/sessions/" + legacy + "/cwd",
                Map.of("cwd_relative", ".", "expected_context_revision",
                        1), "w2-legacy-cwd", "actor", 400),
                "unsupported_feature");
        request("POST", "/v1/agents/sessions/" + session + "/cwd",
                Map.of("cwd_relative", "child",
                        "expected_context_revision", 3),
                "w2-stranger", "stranger", 404);

        // A missing target fails the operation, never the Session.
        JsonNode missing = request("POST",
                "/v1/agents/sessions/" + session + "/cwd",
                Map.of("cwd_relative", "missing",
                        "expected_context_revision", 3),
                "w2-missing-dir", "actor", 202);
        String missingOperation = missing.path("id").asText();
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            JsonNode polled = request("GET", "/v1/agents/sessions/" + session
                    + "/operations/" + missingOperation, null, null,
                    "actor", 200);
            assertThat(polled.path("status").asText()).isEqualTo("failed");
            assertThat(polled.path("failure_code").asText())
                    .isEqualTo("workspace_unavailable");
            assertThat(polled.path("result_context_revision")
                    .isMissingNode()).isTrue();
        });
        read = request("GET", "/v1/agents/sessions/" + session, null, null,
                "actor", 200);
        assertThat(read.at("/workspace/cwd_relative").asText())
                .isEqualTo(".");
        assertThat(read.at("/workspace/context_revision").asLong())
                .isEqualTo(3);

        // The WebShell twin's failed projection must carry failureCode too —
        // the contract condition requires it, and generated clients read it.
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            JsonNode polled = request("POST",
                    "/api/agent/web-shell/v1/operations/query",
                    Map.of("sessionId", session,
                            "operationId", missingOperation),
                    null, "actor", 200);
            assertThat(polled.path("status").asText()).isEqualTo("failed");
            assertThat(polled.path("failureCode").asText())
                    .isEqualTo("workspace_unavailable");
        });

        // The Session is not wedged: the next admitted change completes.
        String recovered = request("POST",
                "/v1/agents/sessions/" + session + "/cwd",
                Map.of("cwd_relative", "child2",
                        "expected_context_revision", 3),
                "w2-recovered", "actor", 202).path("id").asText();
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            JsonNode polled = request("GET", "/v1/agents/sessions/" + session
                    + "/operations/" + recovered, null, null, "actor", 200);
            assertThat(polled.path("status").asText()).isEqualTo("completed");
            assertThat(polled.path("result_context_revision").asLong())
                    .isEqualTo(4);
        });

        events = request("GET", "/v1/agents/sessions/" + session + "/events",
                null, null, "actor", 200);
        long changedEvents = 0;
        for (JsonNode event : events.path("data")) {
            if ("session.context.changed"
                    .equals(event.path("type").asText())) {
                changedEvents++;
            }
        }
        // Each completed change emitted once; the refused one emitted none.
        assertThat(changedEvents).isEqualTo(3);

        // #13112 landed the missing half of the pivot: a bound later Turn
        // installs the committed binding on its fresh Runtime Session, so
        // the turn's file writes land only in the changed directory — a
        // stale-runtime reuse would land them back in the original one.
        // The sentinel makes the direction discriminating: identical bytes
        // flowed through both Turns of the fixture model otherwise.
        Files.writeString(roots.get(0).resolve("child")
                .resolve("proof.txt"), "sentinel");
        String laterTurn = request("POST",
                "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.input.message", "input",
                        List.of(Map.of("type", "input_text", "text",
                                "G0_FILES"))),
                "w2-later-turn", "actor", 202).path("turn_id").asText();
        awaitTurn(session, laterTurn, "child2", roots.get(0));
        assertThat(Files.readString(roots.get(0).resolve("child2")
                .resolve("proof.txt"))).isEqualTo("after");
        assertThat(roots.get(0).resolve("proof.txt")).doesNotExist();
        // The sentinel survives: a reused pre-change installation would
        // have overwritten it with the fixture's "before"->"after".
        assertThat(Files.readString(roots.get(0).resolve("child")
                .resolve("proof.txt"))).isEqualTo("sentinel");
    }

    private static void assertRefusal(JsonNode refusal, String code) {
        assertThat(refusal.path("error").path("code").asText())
                .isEqualTo(code);
    }

    // Waits a Turn out to COMPLETED with the same diagnostics the sibling
    // flows dump on failure, and pins the directory it was supposed to
    // write in — the pivot evidence for the later Turn.
    private void awaitTurn(String session, String turnId, String cwd,
            Path workspaceRoot) throws Exception {
        await().atMost(Duration.ofSeconds(35)).failFast(() -> {
            if ("FAILED".equals(turnStatus(session, turnId))) {
                throw new AssertionError(String.format("Turn failed. Turn:"
                        + " %s; events: %s; model requests: %s; Harness: %s",
                        jdbc.queryForList("SELECT status, error_code FROM"
                                + " managed_agent_turn WHERE session_id = ?",
                                session),
                        jdbc.queryForList("SELECT event_type, data_json FROM"
                                + " managed_agent_event WHERE session_id = ?",
                                session), modelRequests.size(),
                        Files.readString(
                                temporary.resolve("harness.log"))));
            }
        }).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            assertThat(turnStatus(session, turnId))
                    .isEqualTo("COMPLETED");
        });
        assertThat(workspaceRoot.resolve(cwd).resolve("proof.txt"))
                .exists();
    }

    private String turnStatus(String session, String turnId) {
        if (turnId == null) {
            return jdbc.queryForObject("SELECT status FROM"
                    + " managed_agent_turn WHERE session_id = ?",
                    String.class, session);
        }
        return jdbc.queryForObject("SELECT status FROM managed_agent_turn"
                + " WHERE session_id = ? AND turn_id = ?", String.class,
                session, turnId);
    }

    private List<Path> boot() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the CLI first").isRegularFile();
        node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        decoy = Files.createDirectory(temporary.resolve("harness-decoy"));
        if (durableClose) {
            Files.createDirectory(temporary.resolve("broker"), PosixFilePermissions.asFileAttribute(
                    PosixFilePermissions.fromString("rwx------")));
        } else {
            Files.createDirectory(temporary.resolve("broker"));
        }
        List<Path> roots = List.of(Files.createDirectory(temporary.resolve("workspace-a")),
                Files.createDirectory(temporary.resolve("workspace-b")));
        for (Path root : roots) Files.createDirectory(root.resolve("child"));
        port = freePort();
        int harnessPort = freePort();
        int brokerPort = freePort();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        if (shellFault != null) {
            storeRelay = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            relayExecutor = Executors.newVirtualThreadPerTaskExecutor();
            storeRelay.setExecutor(relayExecutor);
            storeRelay.createContext("/internal/managed-session-store/", this::relayStore);
            storeRelay.start();
        }
        startSpring(cli, roots, harnessPort, brokerPort);
        startHarness(cli, harnessPort, brokerPort);
        return roots;
    }

    private void runFiles() throws Exception {
        List<Path> roots = boot();

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
                // Diagnostics are built only when the Turn has failed, not on every poll.
                if ("FAILED".equals(status)) {
                    throw new AssertionError(String.format("Turn failed. Turn: %s; events: %s; model requests: %s;"
                                    + " Harness: %s",
                            jdbc.queryForList("SELECT status, error_code FROM managed_agent_turn WHERE session_id = ?",
                                    session),
                            jdbc.queryForList("SELECT event_type, data_json FROM managed_agent_event"
                                    + " WHERE session_id = ?", session),
                            modelRequests.size(), Files.readString(temporary.resolve("harness.log"))));
                }
            }).untilAsserted(() -> {
                if (approvals) answerActions(session, webShell);
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
            // A later Turn needs the OPERATOR role while the Session's
            // creator-keyed execution facts hold: a READER keeps the 403
            // refusal, and the owner's second Turn runs the file tools
            // again because the owner also holds OPERATOR.
            Map<String, Object> later = Map.of("type", "agent.session.input.message", "input",
                    List.of(Map.of("type", "input_text", "text", "G0_AGAIN")));
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", later,
                    "reader-later-" + workspace, "reader", 403).path("error").path("code").asText())
                    .isEqualTo("session_operation_forbidden");
            // WebShell advertises the same rule, per caller.
            for (String caller : List.of("actor", "reader")) {
                assertThat(request("POST", "/api/agent/web-shell/v1/sessions/get", Map.of("sessionId", session),
                        null, caller, 200).path("capabilities").path("workspaceTurns").asBoolean())
                        .as(caller).isEqualTo("actor".equals(caller));
            }
            // Only the later Turn can restore this; the initial Turn asserted "after" above.
            Files.writeString(roots.get(index).resolve("child/proof.txt"), "x");
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
                if (approvals) answerActions(session, webShell);
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
            // The cancel and rename probes below keep a held model reply, so they stay in
            // the files run to fit the method timeout; the approvals run has already pinned
            // that a later Turn under approval-mode=default is admitted and completes.
            if (approvals) continue;

            // An OPERATOR can cancel a running later Turn; the Hosted Harness aborts it before
            // any tool runs. The READER keeps the refusal.
            int beforeCancel = modelRequests.size();
            Map<String, Object> hold = Map.of("type", "agent.session.input.message", "input",
                    List.of(Map.of("type", "input_text", "text", "G0_CANCEL")));
            String heldTurn = request("POST", "/v1/agents/sessions/" + session + "/events", hold,
                    "hold-" + workspace, "actor", 202).path("turn_id").asText();
            await().atMost(Duration.ofSeconds(35)).until(() -> modelRequests.size() > beforeCancel);
            Map<String, Object> cancel = Map.of("type", "agent.session.cancel", "turn_id", heldTurn);
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", cancel,
                    "reader-cancel-" + workspace, "reader", 403).path("error").path("code").asText())
                    .isEqualTo("session_operation_forbidden");
            request("POST", "/v1/agents/sessions/" + session + "/events", cancel, "cancel-" + workspace,
                    "actor", 202);
            await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                    "SELECT status FROM managed_agent_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, heldTurn)).isEqualTo("CANCELLED"));
            heldReply.countDown();
            heldReply = new CountDownLatch(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 2);

            // Any OPERATOR may rename the bound Session; the READER keeps the refusal.
            Map<String, Object> rename = Map.of("title", "Renamed " + workspace);
            assertThat(request("PATCH", "/v1/agents/sessions/" + session, rename, "reader-rename-" + workspace,
                    "reader", 403).path("error").path("code").asText()).isEqualTo("session_operation_forbidden");
            assertThat(request("PATCH", "/v1/agents/sessions/" + session, rename, "rename-" + workspace,
                    "actor", 200).path("metadata").path("title").asText()).isEqualTo("Renamed " + workspace);

            // An owner whose role drops to READER keeps read access but loses
            // submitter admission: submit, cancel and rename all answer
            // session_operation_forbidden, nothing new executes, and no
            // PENDING command row is left behind.
            jdbc.update("UPDATE managed_workspace_access SET role = 'READER'"
                    + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", later,
                    "nocreate-later-" + workspace, "actor", 403).path("error").path("code").asText())
                    .isEqualTo("session_operation_forbidden");
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", cancel,
                    "nocreate-cancel-" + workspace, "actor", 403).path("error").path("code").asText())
                    .isEqualTo("session_operation_forbidden");
            assertThat(request("PATCH", "/v1/agents/sessions/" + session, rename,
                    "nocreate-rename-" + workspace, "actor", 403).path("error").path("code").asText())
                    .isEqualTo("session_operation_forbidden");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 2);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_command"
                    + " WHERE tenant_id = ? AND command_status = 'PENDING'", Integer.class, tenant)).isZero();
            jdbc.update("UPDATE managed_workspace_access SET role = 'OPERATOR'"
                    + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));

            // With the running Turn settled, revoking the creator's grant hides the
            // bound Session from every later-Turn path: submit, cancel and rename all fall
            // through to the legacy gate and answer session_not_found.
            jdbc.update("DELETE FROM managed_workspace_access"
                    + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", later,
                    "revoked-later-" + workspace, "actor", 404).path("error").path("code").asText())
                    .isEqualTo("session_not_found");
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", cancel,
                    "revoked-cancel-" + workspace, "actor", 404).path("error").path("code").asText())
                    .isEqualTo("session_not_found");
            assertThat(request("PATCH", "/v1/agents/sessions/" + session, rename,
                    "revoked-rename-" + workspace, "actor", 404).path("error").path("code").asText())
                    .isEqualTo("session_not_found");
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES (?, ?, ?, 'OPERATOR')",
                    tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));

            // The headline widening end to end: a Workspace OPERATOR who is
            // not the Session creator submits a later Turn and it actually
            // executes, then cancels and renames — while the creator keeps
            // OPERATOR, so the creator-keyed execution facts hold. The pivot
            // reset makes the bound directory the only place this Turn can
            // write, or the decoy's default would pass unnoticed.
            Files.writeString(roots.get(index).resolve("child/proof.txt"), "x");
            int beforeOperator = modelRequests.size();
            String operatorTurn = request("POST", "/v1/agents/sessions/" + session + "/events", later,
                    "operator2-later-" + workspace, "operator2", 202).path("turn_id").asText();
            assertThat(operatorTurn).isNotBlank();
            await().atMost(Duration.ofSeconds(35)).failFast(() -> {
                String status = jdbc.queryForObject("SELECT status FROM managed_agent_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, operatorTurn);
                if ("FAILED".equals(status)) {
                    throw new AssertionError("Operator later Turn failed. Harness: "
                            + Files.readString(temporary.resolve("harness.log")));
                }
            }).untilAsserted(() -> {
                assertThat(modelFailure.get()).isNull();
                assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, operatorTurn))
                        .isEqualTo("COMPLETED");
            });
            assertThat(modelRequests).hasSize(beforeOperator + 4);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 3);
            assertThat(Files.readString(roots.get(index).resolve("child/proof.txt"))).isEqualTo("after");
            assertThat(decoy.resolve("child/proof.txt")).doesNotExist();

            int beforeHold = modelRequests.size();
            String heldByOperator = request("POST", "/v1/agents/sessions/" + session + "/events", hold,
                    "operator2-hold-" + workspace, "operator2", 202).path("turn_id").asText();
            await().atMost(Duration.ofSeconds(35)).until(() -> modelRequests.size() > beforeHold);
            request("POST", "/v1/agents/sessions/" + session + "/events",
                    Map.of("type", "agent.session.cancel", "turn_id", heldByOperator),
                    "operator2-cancel-" + workspace, "operator2", 202);
            await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                    "SELECT status FROM managed_agent_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, heldByOperator)).isEqualTo("CANCELLED"));
            heldReply.countDown();
            heldReply = new CountDownLatch(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 3);

            Map<String, Object> operatorRename = Map.of("title", "Operator renamed " + workspace);
            assertThat(request("PATCH", "/v1/agents/sessions/" + session, operatorRename,
                    "operator2-rename-" + workspace, "operator2", 200).path("metadata").path("title").asText())
                    .isEqualTo("Operator renamed " + workspace);

            // Admission also certifies the creator-keyed execution facts:
            // demote only the creator, and the second OPERATOR's submit is
            // refused synchronously with the family's domain 409 — no
            // command row, no model request, no tool execution, instead of
            // a 202 that could only fail asynchronously.
            long pendingBefore = jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_command"
                    + " WHERE tenant_id = ? AND command_status = 'PENDING'", Long.class, tenant);
            long execBefore = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution"
                    + " WHERE harness_session_id = ?", Long.class, session);
            int modelsBefore = modelRequests.size();
            // A held Turn started while the creator was OPERATOR; after the
            // demotion it is what the cancel exemption must abort.
            int beforeExemptHold = modelRequests.size();
            String exemptHeld = request("POST", "/v1/agents/sessions/" + session + "/events", hold,
                    "operator2-exempt-hold-" + workspace, "operator2", 202).path("turn_id").asText();
            await().atMost(Duration.ofSeconds(35)).until(() -> modelRequests.size() > beforeExemptHold);
            jdbc.update("UPDATE managed_workspace_access SET role = 'READER'"
                    + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", later,
                    "operator2-blocked-" + workspace, "operator2", 409).path("error").path("code").asText())
                    .isEqualTo("workspace_unavailable");
            // Cancellation needs role and shape alone: even with the
            // creator-keyed facts failed, the operator still aborts the
            // running Turn.
            request("POST", "/v1/agents/sessions/" + session + "/events",
                    Map.of("type", "agent.session.cancel", "turn_id", exemptHeld),
                    "operator2-exempt-cancel-" + workspace, "operator2", 202);
            await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                    "SELECT status FROM managed_agent_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, exemptHeld)).isEqualTo("CANCELLED"));
            heldReply.countDown();
            heldReply = new CountDownLatch(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_command"
                    + " WHERE tenant_id = ? AND command_status = 'PENDING'", Long.class, tenant))
                    .isEqualTo(pendingBefore);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(execBefore);
            // The held Turn accounts for the one request after the
            // snapshot; the refused submit must have added none itself.
            assertThat(modelRequests).hasSize(modelsBefore + 1);
            jdbc.update("UPDATE managed_workspace_access SET role = 'OPERATOR'"
                    + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));
        }
        assertThat(modelRequests).hasSize(approvals ? 16 : 30);
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
        assertUnavailable(request("POST", "/v1/agents/sessions", unsupportedAgent, "unsupported-agent", "actor", 409));
        Map<String, Object> unknown = new java.util.LinkedHashMap<>(denied);
        unknown.put("workspace", Map.of("workspace_id", "unknown"));
        request("POST", "/v1/agents/sessions", unknown, "unknown", "actor", 404);
        jdbc.update("UPDATE managed_workspace_registry SET state = 'DRAINING' WHERE tenant_id = ?", tenant);
        assertUnavailable(request("POST", "/v1/agents/sessions", denied, "draining", "actor", 409));
        jdbc.update("UPDATE managed_workspace_registry SET state = 'ACTIVE' WHERE tenant_id = ?", tenant);
        register("unmounted", "unmounted-storage");
        unknown.put("workspace", Map.of("workspace_id", "unmounted"));
        assertUnavailable(request("POST", "/v1/agents/sessions", unknown, "unmounted", "actor", 409));
        var crossTenant = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/agents/sessions"))
                .timeout(Duration.ofSeconds(10)).header("X-Qwen-Tenant-Id", "other-tenant")
                .header("X-G0-Fixture-Actor", "actor").build(), HttpResponse.BodyHandlers.ofString());
        assertThat(crossTenant.statusCode()).isEqualTo(403);
        jdbc.update("UPDATE managed_workspace_access SET role = 'READER' WHERE tenant_id = ?", tenant);
        request("POST", "/v1/agents/sessions", denied, "read-only", "actor", 403);
        jdbc.update("UPDATE managed_workspace_access SET role = 'OPERATOR' WHERE tenant_id = ?", tenant);
        jdbc.update("UPDATE managed_workspace_registry SET config_ref = 'unsupported' WHERE tenant_id = ?", tenant);
        assertUnavailable(request("POST", "/v1/agents/sessions", denied, "unsupported", "actor", 409));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(2);
        assertThat(modelRequests).hasSize(approvals ? 16 : 30);
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
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:"
                        + (storeRelay == null ? port : storeRelay.getAddress().getPort()),
                "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.harness.base-url=http://127.0.0.1:" + harnessPort,
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + decoy,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("broker"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=g0-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        if (approvals) arguments.add("--qwen.managed-agent.harness.approval-mode="
                + (shell && "deny".equals(shellDecision) ? "auto-edit" : "default"));
        if (shell) arguments.add("--qwen.managed-agent.harness.workspace-shell-enabled=true");
        arguments.add("--qwen.managed-agent.runtime-broker.durable-local-process=" + durableClose);
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
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')", tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));
        // The reader grant exists in both runs so the later-Turn block can also run under
        // approval-mode=default without colliding with the access table's primary key.
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'READER')", tenant, workspace, "reader".getBytes(StandardCharsets.UTF_8));
        // R1's second operator, in both runs: in the approvals run they answer
        // a pending approval; in the files run they drive a later Turn, a
        // cancel and a rename, and their widened then re-blocked submits
        // pin the creator-keyed execution facts.
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')", tenant, workspace,
                "operator2".getBytes(StandardCharsets.UTF_8));
    }

    private void answerActions(String session, boolean web) throws Exception {
        try {
            doAnswerActions(session, web);
        } catch (AssertionError error) {
            // untilAsserted must not retry a one-shot response after its ID is deduped.
            throw new IllegalStateException("Action response fixture failed", error);
        }
    }

    private void doAnswerActions(String session, boolean web) throws Exception {
        JsonNode capability = request("GET", "/v1/agents/sessions/" + session, null, null, "actor", 200);
        assertThat(capability.at("/capabilities/actions").asBoolean()).isTrue();
        JsonNode page = web ? request("POST", "/api/agent/web-shell/v1/actions/query",
                Map.of("sessionId", session), null, "actor", 200)
                : request("GET", "/v1/agents/sessions/" + session + "/actions", null, null, "actor", 200);
        assertThat(page.path("data").size()).isLessThanOrEqualTo(1);
        for (JsonNode action : page.path("data")) {
            String id = action.path(web ? "actionId" : "id").asText();
            if (!answered.add(id)) continue;
            String route = web ? "/api/agent/web-shell/v1/actions/respond"
                    : "/v1/agents/sessions/" + session + "/actions/" + id + "/responses";
            Map<String, Object> response = web ? Map.of("kind", "permission", "optionId", shellDecision,
                    "inputRevision", action.path("inputRevision").asLong(), "policyRevision", action.path("policyRevision").asText())
                    : Map.of("kind", "permission", "option_id", shellDecision, "input_revision", action.path("input_revision").asLong(),
                            "policy_revision", action.path("policy_revision").asText());
            Map<String, Object> body = web ? Map.of("sessionId", session, "actionId", id, "idempotencyKey", id,
                    "requestId", "d6b-action", "response", response) : response;
            assertThat(request("POST", route, body, id, "reader", 403).at("/error/code").asText()).isEqualTo("action_forbidden");
            // The first approval of each session is answered by a second
            // OPERATOR who is not the Session owner (R1's handoff); the
            // rest by the owner, so both responder paths stay covered. The
            // set records ONLY the chosen responder, so collapsing the
            // ternary to the owner empties it instead of staying full.
            String responder = fixedAnswered.add(session) ? "operator2" : "actor";
            if ("operator2".equals(responder)) {
                operatorAnswered.add(session);
            }
            JsonNode operation = request("POST", route, body, id, responder, 202);
            String op = operation.path(web ? "operationId" : "id").asText();
            JsonNode replay = request("POST", route, body, id, responder, 202);
            assertThat(replay.path(web ? "operationId" : "id").asText()).isEqualTo(op);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
                JsonNode settled = request("GET", "/v1/agents/sessions/" + session + "/operations/" + op,
                        null, null, "actor", 200);
                assertThat(settled.path("status").asText()).isEqualTo("completed");
                assertThat(settled.at("/action_resolution/outcome").asText()).isEqualTo("decided");
            });
        }
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
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) environment.put(name, temporary.resolve(name + ".json").toString());
        harness = builder.start();
        await().atMost(Duration.ofSeconds(30)).ignoreExceptions().untilAsserted(() -> {
            if (!harness.isAlive()) {
                throw new AssertionError("Hosted Harness exited: " + Files.readString(log));
            }
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
            if (shell) assertThat(tools).containsExactlyInAnyOrder("read_file", "write_file", "edit", "run_shell_command", "monitor");
            else assertThat(tools).containsExactlyInAnyOrder("read_file", "write_file", "edit");
            // Count only this Turn's tool results, after the latest fixture prompt, so a later
            // Turn in the same Session runs the same write, edit and read sequence. Other user
            // messages the Harness may add do not restart the count.
            List<JsonNode> results = new ArrayList<>();
            AtomicReference<String> prompt = new AtomicReference<>("");
            body.path("messages").forEach(message -> {
                String role = message.path("role").asText();
                if ("user".equals(role) && message.path("content").toString().contains("G0_")) {
                    results.clear();
                    String content = message.path("content").toString();
                    prompt.set(content.substring(content.lastIndexOf("G0_")));
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
            if (!shell && step == 3) assertThat(results.get(2).toString()).contains("after");
            if (shell && shellFault == null && step >= 1) assertThat(results.get(0).toString()).contains("Hosted Monitor is unavailable");
            if (shell && shellFault == null && step >= 2) assertThat(results.get(1).toString()).contains("Hosted Shell requires a foreground command");
            if (shell && shellFault == null && step >= 3 && "allow".equals(shellDecision)) {
                assertThat(results.get(2).toString()).contains("G0_SHELL_STDOUT");
            }
            var chunk = json.createObjectNode().put("id", "g0").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", "g0-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            boolean toolCall = step < (shellFault == null ? 3 : 1);
            if (toolCall) {
                String name = shell ? (shellFault == null && step == 0 ? "monitor" : "run_shell_command")
                        : List.of("write_file", "edit", "read_file").get(step);
                Map<String, Object> args = shell ? switch (step) {
                    case 0 -> Map.of("command", "printf 'monitor\\n' >> monitor-proof.txt");
                    case 1 -> Map.of("command", "printf 'background\\n' >> background-proof.txt", "is_background", true);
                    default -> Map.of("command", "printf 'once\\n' >> shell-proof.txt; pwd; printf 'G0_SHELL_STDOUT\\n'", "description", "Write a Shell proof");
                } : switch (step) {
                    case 0 -> Map.of("file_path", "proof.txt", "content", "before");
                    case 1 -> Map.of("file_path", "proof.txt", "old_string", "before", "new_string", "after");
                    default -> Map.of("file_path", "proof.txt");
                };
                if (shellFault != null) {
                    String producer = "const fs = require('fs'); fs.appendFileSync('proof.txt', 'x');"
                            + " process.stdout.write(Buffer.alloc(1024 * 1024, 0x61), () => {"
                            + " process.stdout.write('stdout-tail\\n'); process.stderr.write('stderr-tail\\n'); });";
                    args = Map.of("command", shellQuote(node) + " -e " + shellQuote(producer), "timeout", 60000);
                }
                delta.putArray("tool_calls").addObject().put("index", 0).put("id", "g0-tool-" + step)
                        .put("type", "function").putObject("function").put("name", name)
                        .put("arguments", json.writeValueAsString(args));
            } else delta.put("content", "G0_DONE");
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", toolCall ? "tool_calls" : "stop");
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

    private void relayStore(HttpExchange exchange) throws IOException {
        boolean receipt = false;
        try {
            byte[] body = exchange.getRequestBody().readAllBytes();
            JsonNode fields = body.length == 0 ? json.createObjectNode() : json.readTree(body);
            String records = fields.has("recordBytesBase64")
                    ? new String(Base64.getDecoder().decode(fields.path("recordBytesBase64").asText()), StandardCharsets.UTF_8) : "";
            receipt = records.lines().anyMatch(line -> {
                try { return "tool.receipt".equals(json.readTree(line).path("managedSession").path("kind").asText()); }
                catch (IOException error) { throw new IllegalStateException(error); }
            });
            if (receipt) {
                receiptRequests.add(body);
                assertThat(receiptRequests).as("Harness receipt retry budget").hasSizeLessThanOrEqualTo(3);
            }
            HttpRequest.Builder forwarded = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + exchange.getRequestURI()))
                    .timeout(Duration.ofSeconds(15)).method(exchange.getRequestMethod(), body.length == 0
                            ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
            exchange.getRequestHeaders().forEach((name, values) -> {
                if (!List.of("host", "connection", "content-length", "upgrade", "expect").contains(name.toLowerCase(java.util.Locale.ROOT)))
                    values.forEach(value -> forwarded.header(name, value));
            });
            var response = http.send(forwarded.build(), HttpResponse.BodyHandlers.ofByteArray());
            if (receipt) {
                assertThat(response.statusCode()).isEqualTo("receipt-failure".equals(shellFault) ? 500 : 200);
                if ("receipt-reply".equals(shellFault)) return;
            } else if ("managed-tool-result-content".equals(fields.path("kind").asText()) && fields.path("byteLength").asInt() == 1024 * 1024) {
                assertThat(response.statusCode()).as("%s: %s", exchange.getRequestURI(), new String(response.body(), StandardCharsets.UTF_8)).isEqualTo(200);
                shellProbe.observePublicPrefix(faultSession);
            }
            response.headers().map().forEach((name, values) -> {
                if (!List.of("connection", "content-length", "transfer-encoding").contains(name.toLowerCase(java.util.Locale.ROOT))) {
                    exchange.getResponseHeaders().put(name, values);
                }
            });
            exchange.sendResponseHeaders(response.statusCode(), response.body().length);
            exchange.getResponseBody().write(response.body());
        } catch (Exception | AssertionError error) {
            modelFailure.compareAndSet(null, error);
        } finally {
            exchange.close();
            if (receipt) receiptResponses.incrementAndGet();
        }
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\"'\"'") + "'";
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

    // Every creation refusal here shares one declared code; the fixture, not the code, selects the branch.
    private static void assertUnavailable(JsonNode refusal) {
        assertThat(refusal.path("error").path("code").asText()).isEqualTo("workspace_unavailable");
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); }
    }

    @AfterEach
    void stop() throws Exception {
        Throwable failure = null;
        List<org.junit.jupiter.api.function.Executable> cleanup = List.of(
                () -> {
                    if (harness != null) {
                        harness.descendants().forEach(ProcessHandle::destroyForcibly);
                        harness.destroyForcibly();
                        harness.waitFor(10, TimeUnit.SECONDS);
                    }
                },
                () -> { if (shellProbe != null) shellProbe.close(); },
                () -> { if (spring != null) spring.close(); },
                () -> { if (storeRelay != null) storeRelay.stop(0); },
                () -> { if (relayExecutor != null) relayExecutor.close(); },
                () -> { if (durableClose) stopDurableWorkers(); },
                () -> { if (model != null) model.stop(0); });
        for (var step : cleanup) {
            try {
                step.execute();
            } catch (Throwable error) {
                if (failure == null) failure = error;
                else failure.addSuppressed(error);
            }
        }
        if (failure instanceof Exception error) throw error;
        if (failure instanceof Error error) throw error;
    }

    private void stopDurableWorkers() throws Exception {
        Path broker = temporary.resolve("broker");
        if (!Files.isDirectory(broker)) return;
        try (var registrations = Files.list(broker)) {
            for (Path file : registrations.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                JsonNode saved = json.readTree(Files.readString(file));
                long pid = saved.path("pid").asLong();
                if (pid <= 0) continue;
                JsonNode handle = json.readTree(saved.path("handle").asText());
                if (!file.getFileName().toString().equals(handle.path("resourceId").asText() + ".json")
                        || !handle.path("hostId").asText().equals(Files.readString(Path.of("/etc/machine-id")).strip())
                        || !handle.path("bootId").asText().equals(Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).strip())) continue;
                var worker = ProcessHandle.of(pid).orElse(null);
                if (worker == null || !worker.isAlive()) continue;
                try {
                    Path process = Path.of("/proc", Long.toString(pid));
                    String stat = Files.readString(process.resolve("stat"));
                    String start = "ticks:" + stat.substring(stat.lastIndexOf(')') + 2).split(" ")[19];
                    if (!start.equals(saved.path("started").asText())
                            || !handle.path("pidNamespace").asText().equals(Files.readSymbolicLink(process.resolve("ns/pid")).toString())
                            || !handle.path("timeNamespace").asText().equals(Files.readSymbolicLink(process.resolve("ns/time")).toString())) continue;
                } catch (java.nio.file.NoSuchFileException exited) {
                    continue;
                }
                worker.destroyForcibly();
                worker.onExit().get(10, TimeUnit.SECONDS);
            }
        }
    }
}
