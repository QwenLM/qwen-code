package com.alibaba.qwen.code.managedagent;

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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

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
import java.nio.file.attribute.FileTime;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

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
    private boolean definitionApproval;
    private String shellDecision = "allow";
    private boolean durableClose;
    private boolean resident;
    private boolean residentRestart;
    private com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.Placement retainedPlacement;
    private boolean shellLifecycleV2;
    private Map<String, byte[]> publicationObjects;
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

    @Test
    @Timeout(240)
    void storedDefinitionApprovalSelectionRoundTripsThroughRealWorkspaceToolsOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).as("Definition approval acceptance requires real MySQL")
                .startsWith("jdbc:mysql:");
        shell = true;
        approvals = true;
        definitionApproval = true;
        Path root = boot().getFirst().resolve("child");
        register("workspace-0", "storage-0");
        JsonNode definition = request("POST", "/v1/agents", Map.of("model", Map.of(),
                "instructions", "Execute only the deterministic fixture tools requested by the user.",
                "tools", List.of(Map.of("type", "hosted_profile", "profile", "hosted-workspace-shell/1")),
                "permission_policy", Map.of("approval_mode", "default")), "definition", "actor", 202);
        String agent = definition.path("id").asText();
        String session = request("POST", "/api/agent/web-shell/v1/sessions/create",
                Map.of("agentId", agent, "idempotencyKey", "definition-session", "input", List.of(),
                        "workspace", Map.of("workspaceId", "workspace-0", "cwdRelative", "child")),
                "definition-session", "actor", 202).path("sessionId").asText();
        String identitySql = "SELECT CAST(agent_id AS CHAR) AS agent_id, agent_revision, agent_definition_digest,"
                + " approval_mode, CAST(workspace_id AS CHAR) AS workspace_id, workspace_generation,"
                + " CAST(workspace_storage_id AS CHAR) AS workspace_storage_id, cwd_relative, tool_profile,"
                + " CAST(model_id AS CHAR) AS model_id, model_revision FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?";
        Map<String, Object> identity = jdbc.queryForMap(identitySql, tenant, session);
        assertThat(identity).containsEntry("agent_id", agent)
                .containsEntry("agent_revision", definition.path("revision").asText())
                .containsEntry("agent_definition_digest", definition.path("digest").asText().replace("sha256:", ""))
                .containsEntry("approval_mode", "default").containsEntry("workspace_id", "workspace-0")
                .containsEntry("cwd_relative", "child").containsEntry("tool_profile", "hosted-workspace-shell/1");
        String definitionSql = "SELECT inline_bytes FROM ma_resource WHERE tenant_id = ? AND session_id = ?"
                + " AND kind = 'managed-definition'";
        await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                "SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isEqualTo("ACTIVE"));
        String initialDefinition = null;
        List<String> modes = List.of("default", "yolo", "auto-edit", "default");
        List<Integer> approvalCounts = List.of(2, 0, 1, 2);
        for (int index = 0; index < modes.size(); index++) {
            String mode = modes.get(index);
            if (index > 0) {
                JsonNode changed = request("POST", "/api/agent/web-shell/v1/session-approval/change",
                        Map.of("sessionId", session, "idempotencyKey", "approval-" + index,
                                "approvalMode", mode, "expectedRevision", index - 1), null, "actor", 200);
                assertThat(changed.path("approvalMode").asText()).isEqualTo(mode);
                assertThat(changed.path("approvalRevision").asLong()).isEqualTo(index);
            }
            JsonNode selection = request("POST", "/api/agent/web-shell/v1/session-approval/query",
                    Map.of("sessionId", session), null, "actor", 200);
            assertThat(selection.path("supported").asBoolean()).isTrue();
            assertThat(selection.path("approvalMode").asText()).isEqualTo(mode);
            assertThat(selection.path("approvalRevision").asLong()).isEqualTo(index);
            JsonNode options = request("POST", "/api/agent/web-shell/v1/session-options/query",
                    Map.of("agentId", agent), null, "actor", 200);
            assertThat(options.path("availableApprovalModes")).isEqualTo(json.valueToTree(List.of("default")));
            String marker = "G0_DEFINITION_APPROVAL_" + index;
            Map<String, Object> submit = Map.of("sessionId", session, "idempotencyKey", marker,
                    "input", List.of(Map.of("type", "input_text", "text", marker)));
            String turn = request("POST", "/api/agent/web-shell/v1/turns/submit", submit,
                    marker, "actor", 202).path("turnId").asText();
            int answeredBefore = answered.size();
            await().atMost(Duration.ofSeconds(40)).failFast(() -> {
                if (modelFailure.get() != null) {
                    throw new AssertionError("Model fixture failed", modelFailure.get());
                }
                String status = jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ?", String.class, tenant, session, turn);
                if (List.of("FAILED", "CANCELLED").contains(status)) {
                    throw new AssertionError("Definition Turn failed: " + jdbc.queryForList(
                            "SELECT status, error_code FROM ma_turn WHERE session_id = ? AND turn_id = ?", session, turn)
                            + "; Harness: " + Files.readString(temporary.resolve("harness.log")));
                }
            }).untilAsserted(() -> {
                answerActions(session, true);
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ?", String.class, tenant, session, turn))
                        .isEqualTo("COMPLETED");
            });
            assertThat(answered.size() - answeredBefore).as(mode).isEqualTo(approvalCounts.get(index));
            assertThat(jdbc.queryForMap("SELECT approval_mode, approval_revision FROM ma_turn"
                    + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?", tenant, session, turn))
                    .containsEntry("approval_mode", mode).containsEntry("approval_revision", (long) index);
            assertThat(Files.readString(root.resolve(marker + ".write"))).isEqualTo("BYTES_" + marker + "\n");
            assertThat(Files.readString(root.resolve(marker + ".shell"))).isEqualTo("once\n");
            assertThat(decoy.resolve(marker + ".write")).doesNotExist();
            assertThat(decoy.resolve(marker + ".shell")).doesNotExist();
            assertThat(jdbc.queryForMap(identitySql, tenant, session)).isEqualTo(identity);
            if (index == 0) {
                initialDefinition = jdbc.queryForObject(definitionSql,
                        (row, unused) -> new String(row.getBytes(1), StandardCharsets.UTF_8), tenant, session);
            }
            assertThat(jdbc.<String>queryForObject(definitionSql,
                    (row, unused) -> new String(row.getBytes(1), StandardCharsets.UTF_8), tenant, session))
                    .isEqualTo(initialDefinition);
            int requestsBeforeReplay = modelRequests.size();
            JsonNode replay = request("POST", "/api/agent/web-shell/v1/turns/submit", submit,
                    marker, "actor", 202);
            assertThat(replay.path("turnId").asText()).isEqualTo(turn);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(modelRequests).hasSize(requestsBeforeReplay);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                    Integer.class, tenant, session)).isEqualTo(index + 1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?"
                    + " AND execution_state = 'SETTLED'", Integer.class, session)).isEqualTo(2 * (index + 1));
            assertThat(Files.readString(root.resolve(marker + ".shell"))).isEqualTo("once\n");
        }
        assertThat(jdbc.queryForList("SELECT approval_mode FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY approval_revision", String.class, tenant, session)).containsExactlyElementsOf(modes);
        assertThat(jdbc.queryForList("SELECT approval_revision FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY approval_revision", Long.class, tenant, session)).containsExactly(0L, 1L, 2L, 3L);
        assertThat(answered).hasSize(5);
        assertThat(modelRequests).hasSize(12).allSatisfy(request ->
                assertThat(request.path("model").asText()).isEqualTo("g0-fixture"));
        assertThat(modelFailure.get()).isNull();
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    @Timeout(360)
    void publicShellV2DeletionTriggersCollectionWithoutRetirementSeams() throws Exception {
        assertThat(System.getProperty("mysql.url")).as("L4 public collection requires real MySQL").startsWith("jdbc:mysql:");
        durableClose = true;
        shellLifecycleV2 = true;
        publicForegroundShellUsesMandatoryApprovalOnBothSurfaces("allow");
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
            assertThat(jdbc.queryForObject("SELECT tool_profile FROM ma_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("hosted-workspace-shell/1");
            assertThat(jdbc.queryForObject("SELECT approval_mode FROM ma_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("deny".equals(decision) ? "auto-edit" : "default");
            if (web) {
                request("POST", "/api/agent/web-shell/v1/turns/submit",
                        Map.of("sessionId", session, "idempotencyKey", "shell-turn", "input", List.of(input)),
                        "shell-turn", "actor", 202);
            }
            await().atMost(Duration.ofSeconds(35)).failFast(() -> {
                if (modelFailure.get() != null) {
                    throw new AssertionError("Model fixture failed", modelFailure.get());
                }
            }).untilAsserted(() -> {
                answerActions(session, web);
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?",
                                String.class, session)).isEqualTo("COMPLETED");
            });
            Path marker = roots.get(index).resolve("child/shell-proof.txt");
            if ("allow".equals(decision)) {
                assertThat(Files.readString(marker)).isEqualTo("once\n");
            } else {
                assertThat(marker).doesNotExist();
            }
            assertThat(decoy.resolve("shell-proof.txt")).doesNotExist();
            assertThat(roots.get(index).resolve("child/monitor-proof.txt")).doesNotExist();
            assertThat(roots.get(index).resolve("child/background-proof.txt")).doesNotExist();
            assertThat(request("POST", route, body, workspace, "actor", 202)
                    .path(web ? "sessionId" : "id").asText()).isEqualTo(session);
            if (shellLifecycleV2) {
                deleteShellAndAwaitCollection(session, workspace, web, marker);
            } else {
                for (String kind : List.of("close", "archive", "delete")) {
                    boolean restDelete = !web && "delete".equals(kind);
                    String lifecycle = web ? "/api/agent/web-shell/v1/sessions/" + kind
                            : "/v1/agents/sessions/" + session + (restDelete ? "" : "/" + kind);
                    Object command = web ? Map.of("sessionId", session, "idempotencyKey", kind) : null;
                    assertUnavailable(request(restDelete ? "DELETE" : "POST", lifecycle, command, kind, "actor", 409));
                }
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE session_id = ?"
                        + " AND operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')", Integer.class, session)).isZero();
            }
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE session_id = ?",
                    Integer.class, session)).isEqualTo(1);
            if ("allow".equals(decision)) {
                assertThat(Files.readString(marker)).isEqualTo("once\n");
            } else {
                assertThat(marker).doesNotExist();
            }
        }
        assertThat(answered).hasSize(2);
        assertThat(modelFailure.get()).isNull();
        assertThat(modelRequests).hasSize(shellLifecycleV2 ? 4 : 8);
    }

    private void deleteShellAndAwaitCollection(String session, String workspace, boolean web, Path marker) throws Exception {
        var publications = jdbc.queryForList("SELECT publication_id FROM ma_output_capture"
                + " WHERE tenant_id = ? AND session_id = ? AND capture_bytes = 1048576", String.class, tenant, session);
        assertThat(publications).hasSize(1);
        var output = jdbc.queryForList("SELECT o.capture_object_key AS object_key, o.byte_length, o.sha256,"
                + " o.capture_state AS state, o.slot_key FROM ma_resource o JOIN ma_output_capture p"
                + " ON p.scope_key = o.scope_key AND p.publication_id = o.publication_id"
                + " WHERE p.tenant_id = ? AND p.session_id = ? AND o.capture_object_key IS NOT NULL", tenant, session);
        assertThat(output).as("the public Shell captured real stdout before deletion").isNotEmpty();
        boolean stdout = false;
        for (var object : output) {
            assertThat(object.get("state")).isEqualTo("VERIFIED");
            byte[] bytes = publicationObjects.get(object.get("object_key").toString());
            assertThat(bytes).hasSize(((Number) object.get("byte_length")).intValue());
            assertThat(java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)))
                    .isEqualTo(object.get("sha256"));
            stdout |= object.get("slot_key").toString().startsWith("segment:stdout:")
                    && new String(bytes, StandardCharsets.UTF_8).contains("G0_SHELL_STDOUT");
        }
        assertThat(stdout).isTrue();
        String companion = request("POST", "/v1/agents/sessions", Map.of("agent_id", "qwen-code", "input", List.of(),
                "workspace", Map.of("workspace_id", workspace, "cwd_relative", "child")),
                "companion-" + workspace, "actor", 202).path("id").asText();
        await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                "SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, companion)).isEqualTo("ACTIVE"));
        JsonNode admitted = web ? request("POST", "/api/agent/web-shell/v1/sessions/delete",
                Map.of("sessionId", session, "idempotencyKey", "l4-delete"), "l4-delete", "actor", 202)
                : request("DELETE", "/v1/agents/sessions/" + session, null, "l4-delete", "actor", 202);
        String operation = admitted.path(web ? "operationId" : "id").asText();
        await().atMost(Duration.ofSeconds(45)).untilAsserted(() -> assertThat(request("GET",
                "/v1/agents/sessions/" + session + "/operations/" + operation, null, null, "actor", 200)
                .path("status").asText()).isEqualTo("completed"));
        assertThat(jdbc.queryForObject("SELECT lifecycle_protocol_version FROM ma_operation"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ?", Integer.class, tenant, session, operation)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL AND session_kind = 'PUBLIC' AND tenant_id = ? AND session_id = ?",
                Integer.class, tenant, session)).isEqualTo(1);
        await().atMost(Duration.ofSeconds(90)).untilAsserted(() -> {
            var ledgers = jdbc.queryForList("SELECT completed_at AS collected_at, CAST(JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.collectedBytes')) AS UNSIGNED) AS collected_bytes FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC'"
                    + " AND tenant_id = ? AND session_id = ?", tenant, session);
            assertThat(ledgers).hasSize(1);
            var collected = ledgers.getFirst();
            assertThat(collected.get("collected_at")).isNotNull();
            var publication = jdbc.queryForMap("SELECT retention_state, collected_at FROM ma_output_capture"
                    + " WHERE tenant_id = ? AND session_id = ? AND publication_id = ?", tenant, session, publications.getFirst());
            assertThat(publication.get("retention_state")).isEqualTo("COLLECTED");
            assertThat(publication.get("collected_at")).isNotNull();
            for (var object : output) {
                assertThat(jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE capture_object_key = ?",
                        String.class, object.get("object_key"))).isEqualTo("COLLECTED");
                assertThat(publicationObjects).doesNotContainKey(object.get("object_key").toString());
            }
        });
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, companion)).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL AND session_kind = 'PUBLIC' AND tenant_id = ? AND session_id = ?",
                Integer.class, tenant, companion)).isZero();
        assertThat(Files.readString(marker)).isEqualTo("once\n");
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
            jdbc.execute("CREATE TRIGGER " + trigger + " BEFORE INSERT ON ma_session_journal_tx FOR EACH ROW BEGIN IF"
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
                if (modelFailure.get() != null) {
                    throw new AssertionError("Fault fixture failed", modelFailure.get());
                }
            }).untilAsserted(() -> {
                answerActions(session, false);
                assertThat(receiptRequests).hasSize(3);
                assertThat(jdbc.queryForList("SELECT execution_state FROM ma_tool_execution WHERE harness_session_id = ?",
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
                if (modelFailure.get() != null) {
                    throw new AssertionError("Fault fixture failed", modelFailure.get());
                }
            }).untilAsserted(() -> {
                var status = client.getStatus(attached);
                assertThat(status.hasActivePrompt()).isFalse();
                assertThat(status.getRaw().get("recoveryBlocked")).isEqualTo(true);
                assertThat(receiptResponses.get()).isEqualTo(3);
            });
            assertThat(receiptRequests).hasSize(3);
            assertThat(answered).hasSize(1);
            assertThat(modelRequests).hasSize(1);
            assertThat(jdbc.queryForObject("SELECT tool_profile FROM ma_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("hosted-workspace-shell/1");
            assertThat(jdbc.queryForObject("SELECT approval_mode FROM ma_session WHERE session_id = ?",
                    String.class, session)).isEqualTo("default");
            var original = json.readTree(receiptRequests.getFirst());
            for (byte[] retry : receiptRequests) {
                assertThat(retry).isEqualTo(receiptRequests.getFirst());
            }
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ?"
                    + " AND session_id = ? AND transaction_id = ?", Integer.class, tenant, session,
                    original.path("transactionId").asText())).isEqualTo("receipt-reply".equals(fault) ? 1 : 0);
            assertThat(jdbc.queryForObject("SELECT prompt_id FROM ma_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, turn)).isEqualTo(jdbc.queryForObject(
                            "SELECT turn_id FROM ma_tool_execution WHERE harness_session_id = ?", String.class, session));
            assertThat(request("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type", "agent.session.input.message", "input", input),
                    "fault-turn", "actor", 202).path("turn_id").asText()).isEqualTo(turn);
            shellProbe.assertPublicFault(faultSession);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE session_id = ?", Integer.class, session)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?", String.class, session)).isNotEqualTo("COMPLETED");
            assertThat(decoy.resolve("proof.txt")).doesNotExist();
            assertThat(modelFailure.get()).isNull();
            assertThat(receiptRequests).hasSize(3);
            System.out.println("PUBLIC_FG6F " + fault + " session=" + session + " turn=" + turn
                    + " receiptAttempts=" + receiptRequests.size() + " effect=once");
        } finally {
            if ("receipt-failure".equals(fault)) {
                jdbc.execute("DROP TRIGGER " + trigger);
            }
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @EnabledOnOs(OS.LINUX)
    @Timeout(150)
    void durableCloseStopsOriginalWorkersAndRetainsHistoryAndFiles(boolean crash) throws Exception {
        runDurableClose(crash);
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    @Timeout(150)
    void shellProfileClosesAfterNativeFileToolsOnBothSurfaces() throws Exception {
        shell = true;
        approvals = true;
        shellLifecycleV2 = true;
        runDurableClose(false);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?"
                + " AND tool_profile = 'hosted-workspace-shell/1' AND status = 'CLOSED'", Integer.class, tenant)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND tenant_id = ?",
                Integer.class, tenant)).isZero();
    }

    private void runDurableClose(boolean crash) throws Exception {
        durableClose = true;
        runFiles();
        List<String> sessions = jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ?"
                + " ORDER BY workspace_id", String.class, tenant);
        for (int index = 0; index < sessions.size(); index++) {
            String session = sessions.get(index);
            String binding = jdbc.queryForObject("SELECT binding_id FROM ma_runtime_binding WHERE tenant_id = ?"
                    + " AND isolation_key = ?", String.class, tenant, session);
            JsonNode handle = json.readTree(jdbc.queryForObject("SELECT resource_handle_json FROM ma_runtime_binding"
                    + " WHERE binding_id = ?", String.class, binding));
            Path registration = temporary.resolve("broker").resolve(handle.path("resourceId").asText() + ".json");
            long pid = json.readTree(Files.readString(registration)).path("pid").asLong();
            var worker = ProcessHandle.of(pid).orElseThrow();
            assertThat(worker.isAlive()).isTrue();
            if (crash) {
                worker.destroyForcibly();
                worker.onExit().get(5, TimeUnit.SECONDS);
                if (index == 1) {
                    jdbc.update("UPDATE ma_workspace SET config_ref = ? WHERE tenant_id = ?"
                            + " AND workspace_id = ?", WorkspaceExecutionProfile.CONFIG_REF, tenant, "workspace-" + index);
                    String failedTurn = request("POST", "/v1/agents/sessions/" + session + "/events",
                            Map.of("type", "agent.session.input.message", "input",
                                    List.of(Map.of("type", "input_text", "text", "G0_AGAIN"))),
                            "after-crash", "actor", 202).path("turn_id").asText();
                    await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                            "SELECT status FROM ma_turn WHERE session_id = ? AND turn_id = ?",
                            String.class, session, failedTurn)).isEqualTo("FAILED"));
                }
                assertThat(jdbc.queryForObject("SELECT binding_state FROM ma_runtime_binding WHERE binding_id = ?",
                        String.class, binding)).isEqualTo(index == 0 ? "READY" : "LOST");
            }
            var retained = jdbc.queryForList("SELECT resource_id, sha256 FROM ma_resource"
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
            assertThat(jdbc.queryForObject("SELECT drain_receipt_json FROM ma_runtime_binding WHERE binding_id = ?",
                    String.class, binding)).isNotBlank();
            assertThat(jdbc.queryForObject("SELECT binding_state FROM ma_runtime_binding WHERE binding_id = ?",
                    String.class, binding)).isEqualTo("RELEASED");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE binding_id = ?"
                    + " AND session_state NOT IN ('RELEASED', 'FAILED')", Integer.class, binding)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE binding_id = ?"
                    + " AND holder_key IS NOT NULL", Integer.class, binding)).isZero();
            assertThat(jdbc.queryForList("SELECT resource_id, sha256 FROM ma_resource WHERE tenant_id = ?"
                    + " AND session_id = ? ORDER BY resource_id", tenant, session)).containsAll(retained);
            assertThat(request("GET", "/v1/agents/sessions/" + session + "/events", null, null, "actor", 200).toString())
                    .contains("G0_DONE");
            assertThat(Files.readString(temporary.resolve(index == 0 ? "workspace-a" : "workspace-b")
                    .resolve("child/proof.txt"))).isEqualTo("after");
            assertThat(request("POST", route, body, "close", "actor", 202)
                    .path(webShell ? "operationId" : "id").asText()).isEqualTo(operation);
            if (crash) {
                jdbc.update("UPDATE ma_workspace SET config_ref = ? WHERE tenant_id = ?"
                        + " AND workspace_id = ?", WorkspaceExecutionProfile.CONFIG_REF, tenant, "workspace-" + index);
                String nextSession = request("POST", "/v1/agents/sessions",
                        Map.of("agent_id", "qwen-code", "input", List.of(Map.of("type", "input_text", "text", "G0_FILES")),
                                "workspace", Map.of("workspace_id", "workspace-" + index, "cwd_relative", "child")),
                        "after-close-" + index, "actor", 202).path("id").asText();
                await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                        "SELECT status FROM ma_turn WHERE session_id = ?", String.class, nextSession))
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
                                + " ma_turn WHERE session_id = ?",
                                session),
                        jdbc.queryForList("SELECT event_type, data_json FROM"
                                + " ma_public_event WHERE session_id = ?",
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
                    + " ma_turn WHERE session_id = ?",
                    String.class, session);
        }
        return jdbc.queryForObject("SELECT status FROM ma_turn"
                + " WHERE session_id = ? AND turn_id = ?", String.class,
                session, turnId);
    }
    @Test
    @EnabledOnOs(OS.MAC)
    @Timeout(180)
    void residentPublicCloseHandsRetainedFilesToTheNextSession() throws Exception {
        residentPublicHandoff(false);
    }

    @Test
    @EnabledOnOs(OS.MAC)
    @Timeout(180)
    void residentPublicHandoffReconstructsTheApplicationAndBroker() throws Exception {
        residentPublicHandoff(true);
    }

    private void residentPublicHandoff(boolean reconstruct) throws Exception {
        assertThat(System.getProperty("mysql.url")).as("ordinary H2 scope only").isNull();
        resident = true;
        residentRestart = reconstruct;
        var roots = boot();
        register("workspace-0", "storage-0");
        var fixture = spring.getBean(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.class);
        var bindingRepository = spring.getBean(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
        var runtimeSessions = spring.getBean(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class);
        var state = spring.getBean(com.alibaba.qwen.code.managedagent.store.AgentStateStore.class);
        String first = residentSession("G0_RESIDENT_FIRST", "resident-first");
        saveResidentOwnership("after-first-turn");
        assertThat(Files.readString(roots.getFirst().resolve("child/proof.txt"))).isEqualTo("after-first-" + tenant);
        var context = state.requireSession(tenant, first).workspace();
        var residentMapping = new com.alibaba.qwen.code.managedagent.store.ResidentWorkspaces(
                spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class)
                        .getRuntimeBroker().getResidentWorkspaces());
        var original = bindingRepository.findActive(residentMapping.request(context));
        var oldContexts = runtimeSessions.findByBinding(original.getBindingId(), original.getGeneration(), null, 100);
        assertThat(oldContexts).isNotEmpty();
        assertThat(oldContexts).allSatisfy(row -> assertThat(row.getSession().getHarnessSessionId()).isEqualTo(first));
        JsonNode bindingBefore = com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc, "SELECT * FROM ma_runtime_binding WHERE binding_id = ?", original.getBindingId());
        JsonNode slotBefore = com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc, "SELECT * FROM ma_runtime_slot WHERE request_key = ?", original.getRequest().requestKey());
        JsonNode storageBefore = com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc, "SELECT * FROM ma_storage WHERE alias_key = ?",
                spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class)
                        .getRuntimeBroker().getResidentWorkspaces().getFirst().registration().aliasKey());
        var registration = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class)
                .getRuntimeBroker().getResidentWorkspaces().getFirst().registration();
        var expectedOwner = (com.fasterxml.jackson.databind.node.ObjectNode) com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc,
                "SELECT * FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'CSI'", registration.physicalKey()).get(0);
        assertThat(expectedOwner.path("holder_key").isNull()).isTrue();
        assertThat(expectedOwner.path("runtime_session_id").isNull()).isTrue();
        Map<String, Object> nextBody = Map.of("agent_id", "qwen-code", "input", List.of(),
                "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child"));
        assertThat(request("POST", "/v1/agents/sessions", nextBody, "busy-before-close", "actor", 409)
                .path("error").path("code").asText()).isEqualTo("workspace_busy");
        String operation = closeResidentSession(first, "resident-close");
        saveResidentOwnership("after-first-close");
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?", String.class, tenant, first)).isEqualTo("CLOSED");
        assertThat(jdbc.queryForObject("SELECT lifecycle_protocol_version FROM ma_operation WHERE tenant_id = ? AND session_id = ? AND operation_id = ?",
                Integer.class, tenant, first, operation)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                String.class, tenant, first)).isEqualTo("SEALED");
        assertThat(runtimeSessions.findByBinding(original.getBindingId(), original.getGeneration(), null, 100))
                .allSatisfy(row -> assertThat(row.getState()).isEqualTo(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord.State.RELEASED));
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc, "SELECT * FROM ma_runtime_binding WHERE binding_id = ?", original.getBindingId())).isEqualTo(bindingBefore);
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc, "SELECT * FROM ma_runtime_slot WHERE request_key = ?", original.getRequest().requestKey())).isEqualTo(slotBefore);
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc, "SELECT * FROM ma_storage WHERE alias_key = ?", registration.aliasKey())).isEqualTo(storageBefore);
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc, "SELECT * FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'CSI'", registration.physicalKey()).get(0)).isEqualTo(expectedOwner);
        assertThat(bindingRepository.findById(original.getBindingId()).getState()).isEqualTo(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY);
        assertThat(bindingRepository.findById(original.getBindingId()).isDrainRequested()).isFalse();
        assertThat(fixture.workerAlive()).isTrue();
        assertThat(fixture.physicalReleases).hasValue(0);
        assertThat(request("POST", "/v1/agents/sessions/" + first + "/close", null,
                "resident-close", "actor", 202).path("id").asText()).isEqualTo(operation);
        com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.assertConflict(() -> new com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport()
                .activateWorkspace(original, oldContexts.getFirst(), context, true).toCompletableFuture().join());
        com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.assertConflict(() -> spring.getBean(EmbeddedRuntimeBroker.class).service()
                .acquire(first, oldContexts.getFirst().getRuntimeSessionId(), oldContexts.getFirst().getSession().getTurnKind())
                .toCompletableFuture().join());
        if (reconstruct) {
            var previousApplication = spring;
            var previousBroker = spring.getBean(EmbeddedRuntimeBroker.class);
            var previousSource = jdbc.getDataSource();
            var properties = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class);
            int harnessPort = URI.create(properties.getHarness().getBaseUrl()).getPort();
            int brokerPort = properties.getRuntimeBroker().getPort();
            spring.close();
            assertThat(previousApplication.isActive()).isFalse();
            assertThat(fixture.workerAlive()).isTrue();
            startSpring(Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath(),
                    roots, harnessPort, brokerPort);
            assertThat(spring).isNotSameAs(previousApplication);
            assertThat(spring.getBean(EmbeddedRuntimeBroker.class)).isNotSameAs(previousBroker);
            assertThat(jdbc.getDataSource()).isNotSameAs(previousSource);
            fixture = spring.getBean(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.class);
            bindingRepository = spring.getBean(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
            runtimeSessions = spring.getBean(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class);
            state = spring.getBean(com.alibaba.qwen.code.managedagent.store.AgentStateStore.class);
            assertThat(fixture.workerAlive()).isTrue();
            assertThat(fixture.starts).hasValue(1);
            saveResidentOwnership("after-application-reconstruction");
        }
        String second = residentSession("G0_RESIDENT_SECOND", "resident-second");
        saveResidentOwnership("after-second-turn");
        assertThat(second).isNotEqualTo(first);
        var retained = bindingRepository.findActive(residentMapping.request(state.requireSession(tenant, second).workspace()));
        assertThat(retained.getBindingId()).isEqualTo(original.getBindingId());
        assertThat(retained.getGeneration()).isEqualTo(original.getGeneration());
        assertThat(retained.getRequest()).isEqualTo(original.getRequest());
        assertThat(retained.getProvisionSeed()).isEqualTo(original.getProvisionSeed());
        assertThat(retained.hasSameLease(original.getLease())).isTrue();
        assertThat(retained.getResourceHandle()).isEqualTo(original.getResourceHandle());
        assertThat(Files.readString(roots.getFirst().resolve("child/proof.txt"))).isEqualTo("after-second-" + tenant);
        assertThat(decoy.resolve("child/proof.txt")).doesNotExist();
        assertThat(fixture.starts).hasValue(1);
        assertThat(fixture.physicalReleases).hasValue(0);
        assertThat(fixture.workerAlive()).isTrue();
        JsonNode bindingBeforeSecondClose = com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc,
                "SELECT * FROM ma_runtime_binding WHERE binding_id = ?", original.getBindingId());
        closeResidentSession(second, "resident-second-close");
        saveResidentOwnership("after-second-close");
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, second)).isEqualTo("CLOSED");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                String.class, tenant, second)).isEqualTo("SEALED");
        assertThat(runtimeSessions.findByBinding(original.getBindingId(), original.getGeneration(), null, 100))
                .allSatisfy(row -> assertThat(row.getState()).isEqualTo(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord.State.RELEASED));
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc,
                "SELECT * FROM ma_runtime_binding WHERE binding_id = ?", original.getBindingId())).isEqualTo(bindingBeforeSecondClose);
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc,
                "SELECT * FROM ma_runtime_slot WHERE request_key = ?", original.getRequest().requestKey())).isEqualTo(slotBefore);
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc,
                "SELECT * FROM ma_storage WHERE alias_key = ?", registration.aliasKey())).isEqualTo(storageBefore);
        assertThat(com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.snapshot(jdbc,
                "SELECT * FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'CSI'", registration.physicalKey()).get(0)).isEqualTo(expectedOwner);
        assertThat(bindingRepository.findById(original.getBindingId()).getState()).isEqualTo(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY);
        assertThat(bindingRepository.findById(original.getBindingId()).isDrainRequested()).isFalse();
        assertThat(fixture.starts).hasValue(1);
        assertThat(fixture.physicalReleases).hasValue(0);
        assertThat(fixture.workerAlive()).isTrue();
        assertThat(modelFailure.get()).isNull();
    }

    private void saveResidentOwnership(String stage) throws IOException {
        var mapping = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class)
                .getRuntimeBroker().getResidentWorkspaces().getFirst();
        var reader = new com.alibaba.qwen.code.managedagent.service.ResidentAcceptanceSnapshot(jdbc,
                spring.getBean(org.springframework.transaction.PlatformTransactionManager.class), mapping, json);
        var snapshot = reader.capture();
        assertThat(snapshot.path("tables").path("ma_runtime_binding")).hasSize(1);
        assertThat(snapshot.path("tables").path("ma_runtime_slot")).hasSize(1);
        assertThat(snapshot.path("tables").path("ma_storage_owner")).hasSize(1);
        Files.writeString(temporary.resolve(stage + "-ownership.json"), json.writeValueAsString(snapshot) + "\n",
                java.nio.file.StandardOpenOption.CREATE_NEW);
    }

    private String closeResidentSession(String session, String key) throws Exception {
        String operation = request("POST", "/v1/agents/sessions/" + session + "/close", null,
                key, "actor", 202).path("id").asText();
        try {
            await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> assertThat(request("GET",
                    "/v1/agents/sessions/" + session + "/operations/" + operation, null, null, "actor", 200)
                    .path("status").asText()).isEqualTo("completed"));
        } catch (RuntimeException | AssertionError cause) {
            throw new AssertionError("Resident close failed: " + Files.readString(temporary.resolve("harness.log")), cause);
        }
        return operation;
    }

    private String residentSession(String prompt, String key) throws Exception {
        String session = request("POST", "/v1/agents/sessions", Map.of("agent_id", "qwen-code",
                "input", List.of(Map.of("type", "input_text", "text", prompt)),
                "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child")), key, "actor", 202).path("id").asText();
        await().atMost(Duration.ofSeconds(35)).failFast(() -> {
            if ("FAILED".equals(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?", String.class, session))) {
                throw new AssertionError("Resident turn failed: " + Files.readString(temporary.resolve("harness.log")));
            }
        }).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?", String.class, session)).isEqualTo("COMPLETED");
        });
        String journal = String.join("\n", jdbc.query("SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision",
                (row, n) -> new String(row.getBytes(1), StandardCharsets.UTF_8), tenant, session));
        assertThat(journal).contains("tool_result");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution e JOIN ma_runtime_binding b"
                + " ON b.binding_id = e.binding_id WHERE b.tenant_id = ? AND e.harness_session_id = ?"
                + " AND e.execution_state = 'SETTLED'", Long.class, tenant, session)).isEqualTo(3);
        assertThat(request("GET", "/v1/agents/sessions/" + session + "/events", null, null, "actor", 200).toString()).contains("G0_DONE");
        return session;
    }

    private List<Path> boot() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the CLI first").isRegularFile();
        node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        decoy = Files.createDirectory(temporary.resolve("harness-decoy"));
        if (durableClose || definitionApproval) {
            Files.createDirectory(temporary.resolve("broker"), PosixFilePermissions.asFileAttribute(
                    PosixFilePermissions.fromString("rwx------")));
        } else {
            Files.createDirectory(temporary.resolve("broker"));
        }
        List<Path> roots = List.of(Files.createDirectory(temporary.resolve("workspace-a")),
                Files.createDirectory(temporary.resolve("workspace-b")));
        for (Path root : roots) {
            Files.createDirectory(root.resolve("child"));
            // Keep initialized-root mtime distinct from birth time without relying on sleeps.
            Files.setLastModifiedTime(root, FileTime.fromMillis(1));
        }
        int harnessPort;
        int brokerPort;
        try (var springSocket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
                var harnessSocket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
                var brokerSocket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            port = springSocket.getLocalPort();
            harnessPort = harnessSocket.getLocalPort();
            brokerPort = brokerSocket.getLocalPort();
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
        }
        if (residentRestart) {
            retainedPlacement = new com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.Placement(
                    List.of(node, cli.toString(), "managed-runtime-worker"), temporary.resolve("broker"));
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
                String status = jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?",
                        String.class, session);
                // Diagnostics are built only when the Turn has failed, not on every poll.
                if ("FAILED".equals(status)) {
                    throw new AssertionError(String.format("Turn failed. Turn: %s; events: %s; model requests: %s;"
                                    + " Harness: %s",
                            jdbc.queryForList("SELECT status, error_code FROM ma_turn WHERE session_id = ?",
                                    session),
                            jdbc.queryForList("SELECT event_type, data_json FROM ma_public_event"
                                    + " WHERE session_id = ?", session),
                            modelRequests.size(), Files.readString(temporary.resolve("harness.log"))));
                }
            }).untilAsserted(() -> {
                if (approvals) {
                    answerActions(session, webShell);
                }
                assertThat(modelFailure.get()).isNull();
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?",
                        String.class, session)).isEqualTo("COMPLETED");
            });
            assertThat(Files.readString(roots.get(index).resolve("child/proof.txt"))).isEqualTo("after");
            assertThat(decoy.resolve("proof.txt")).doesNotExist();
            assertThat(decoy.resolve("child/proof.txt")).doesNotExist();
            assertThat(jdbc.queryForObject("SELECT workspace_id FROM ma_session_head"
                    + " WHERE tenant_id = ? AND session_id = ?", String.class, tenant, session)).isEqualTo(workspace);
            String durable = String.join("\n", jdbc.query("SELECT record_bytes FROM ma_session_journal_tx"
                    + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision",
                    (row, n) -> new String(row.getBytes(1), StandardCharsets.UTF_8), tenant, session));
            assertThat(durable).contains("tool_result");
            String messages = String.join("\n", jdbc.query("SELECT inline_bytes FROM ma_resource"
                    + " WHERE tenant_id = ? AND session_id = ? AND kind = 'managed-message'",
                    (row, n) -> new String(row.getBytes(1), StandardCharsets.UTF_8), tenant, session));
            assertThat(messages).contains("write_file", "read_file", "edit", "after");
            JsonNode events = request("GET", "/v1/agents/sessions/" + session + "/events", null, null, "actor", 200);
            assertThat(events.toString()).contains("G0_DONE");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event"
                    + " WHERE tenant_id = ? AND session_id = ? AND terminal = TRUE", Integer.class, tenant, session))
                    .isEqualTo(1);
            int requests = modelRequests.size();
            long executions = jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
                    Long.class, session);
            assertThat(executions).isEqualTo(3);
            JsonNode replay = request("POST", route, body, workspace, "actor", 202);
            assertThat(replay.path(webShell ? "sessionId" : "id").asText()).isEqualTo(session);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE session_id = ?",
                    Integer.class, session)).isEqualTo(1);
            assertThat(modelRequests).hasSize(requests);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
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
                String status = jdbc.queryForObject("SELECT status FROM ma_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, laterTurn);
                if ("FAILED".equals(status)) {
                    throw new AssertionError("Later Turn failed. Harness: "
                            + Files.readString(temporary.resolve("harness.log")));
                }
            }).untilAsserted(() -> {
                if (approvals) {
                    answerActions(session, webShell);
                }
                assertThat(modelFailure.get()).isNull();
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, laterTurn))
                        .isEqualTo("COMPLETED");
            });
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 2);
            assertThat(modelRequests).hasSize(requests + 4);
            assertThat(Files.readString(roots.get(index).resolve("child/proof.txt"))).isEqualTo("after");
            assertThat(decoy.resolve("proof.txt")).doesNotExist();
            // The cancel and rename probes below keep a held model reply, so they stay in
            // the files run to fit the method timeout; the approvals run has already pinned
            // that a later Turn under approval-mode=default is admitted and completes.
            if (approvals) {
                continue;
            }

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
                    "SELECT status FROM ma_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, heldTurn)).isEqualTo("CANCELLED"));
            heldReply.countDown();
            heldReply = new CountDownLatch(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
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
            jdbc.update("UPDATE ma_workspace_access SET role = 'READER'"
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
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(executions * 2);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt"
                    + " WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ? AND state = 'PENDING'", Integer.class, tenant)).isZero();
            jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'"
                    + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));

            // With the running Turn settled, revoking the creator's grant hides the
            // bound Session from every later-Turn path: submit, cancel and rename all fall
            // through to the legacy gate and answer session_not_found.
            jdbc.update("DELETE FROM ma_workspace_access"
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
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
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
                String status = jdbc.queryForObject("SELECT status FROM ma_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, operatorTurn);
                if ("FAILED".equals(status)) {
                    throw new AssertionError("Operator later Turn failed. Harness: "
                            + Files.readString(temporary.resolve("harness.log")));
                }
            }).untilAsserted(() -> {
                assertThat(modelFailure.get()).isNull();
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn"
                        + " WHERE session_id = ? AND turn_id = ?", String.class, session, operatorTurn))
                        .isEqualTo("COMPLETED");
            });
            assertThat(modelRequests).hasSize(beforeOperator + 4);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
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
                    "SELECT status FROM ma_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, heldByOperator)).isEqualTo("CANCELLED"));
            heldReply.countDown();
            heldReply = new CountDownLatch(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
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
            long pendingBefore = jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt"
                    + " WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ? AND state = 'PENDING'", Long.class, tenant);
            long execBefore = jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution"
                    + " WHERE harness_session_id = ?", Long.class, session);
            int modelsBefore = modelRequests.size();
            // A held Turn started while the creator was OPERATOR; after the
            // demotion it is what the cancel exemption must abort.
            int beforeExemptHold = modelRequests.size();
            String exemptHeld = request("POST", "/v1/agents/sessions/" + session + "/events", hold,
                    "operator2-exempt-hold-" + workspace, "operator2", 202).path("turn_id").asText();
            await().atMost(Duration.ofSeconds(35)).until(() -> modelRequests.size() > beforeExemptHold);
            jdbc.update("UPDATE ma_workspace_access SET role = 'READER'"
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
                    "SELECT status FROM ma_turn WHERE session_id = ? AND turn_id = ?",
                    String.class, session, exemptHeld)).isEqualTo("CANCELLED"));
            heldReply.countDown();
            heldReply = new CountDownLatch(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt"
                    + " WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ? AND state = 'PENDING'", Long.class, tenant))
                    .isEqualTo(pendingBefore);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
                    Long.class, session)).isEqualTo(execBefore);
            // The held Turn accounts for the one request after the
            // snapshot; the refused submit must have added none itself.
            assertThat(modelRequests).hasSize(modelsBefore + 1);
            jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'"
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
        // D8b: only qwen-code or a stored definition's agent may be admitted.
        assertThat(request("POST", "/v1/agents/sessions", unsupportedAgent, "unsupported-agent", "actor", 404)
                .path("error").path("code").asText()).isEqualTo("agent_not_found");
        Map<String, Object> unknown = new java.util.LinkedHashMap<>(denied);
        unknown.put("workspace", Map.of("workspace_id", "unknown"));
        request("POST", "/v1/agents/sessions", unknown, "unknown", "actor", 404);
        jdbc.update("UPDATE ma_workspace SET state = 'DRAINING' WHERE tenant_id = ?", tenant);
        assertUnavailable(request("POST", "/v1/agents/sessions", denied, "draining", "actor", 409));
        jdbc.update("UPDATE ma_workspace SET state = 'ACTIVE' WHERE tenant_id = ?", tenant);
        register("unmounted", "unmounted-storage");
        unknown.put("workspace", Map.of("workspace_id", "unmounted"));
        assertUnavailable(request("POST", "/v1/agents/sessions", unknown, "unmounted", "actor", 409));
        var crossTenant = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/agents/sessions"))
                .timeout(Duration.ofSeconds(10)).header("X-Qwen-Tenant-Id", "other-tenant")
                .header("X-G0-Fixture-Actor", "actor").build(), HttpResponse.BodyHandlers.ofString());
        assertThat(crossTenant.statusCode()).isEqualTo(403);
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE tenant_id = ?", tenant);
        request("POST", "/v1/agents/sessions", denied, "read-only", "actor", 403);
        jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR' WHERE tenant_id = ?", tenant);
        jdbc.update("UPDATE ma_workspace SET config_ref = 'unsupported' WHERE tenant_id = ?", tenant);
        assertUnavailable(request("POST", "/v1/agents/sessions", denied, "unsupported", "actor", 409));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?",
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
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli));
        if (approvals) {
            arguments.add("--qwen.managed-agent.harness.approval-mode="
                    + (shell && "deny".equals(shellDecision) ? "auto-edit" : "default"));
        }
        if (shell) {
            arguments.add("--qwen.managed-agent.harness.workspace-shell-enabled=true");
        }
        if (definitionApproval) {
            arguments.add("--qwen.managed-agent.definition-tool-profiles=hosted-workspace-shell/1");
        }
        if (shellLifecycleV2) {
            arguments.addAll(HostedGateTestSupport.toolPublicationArgs(port,
                    "private-test-bucket", 1048576));
        }
        arguments.add("--qwen.managed-agent.runtime-broker.durable-local-process=" + (durableClose || definitionApproval));
        arguments.add("--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled="
                + (definitionApproval || "Linux".equals(System.getProperty("os.name"))));
        if (resident) {
            com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.arguments(arguments, tenant, roots.getFirst());
        }
        for (int i = 0; !resident && i < roots.size(); i++) {
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts[" + i + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + i);
            arguments.add(prefix + "root=" + roots.get(i));
        }
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .initializers(context -> {
                    context.getBeanFactory().registerSingleton("g0Authentication", authentication());
                    if (resident) {
                        com.alibaba.qwen.code.managedagent.service.ResidentHostedRuntimeFixture.install(context,
                                List.of(node, cli.toString(), "managed-runtime-worker"), temporary.resolve("broker"),
                                retainedPlacement);
                    }
                    if (shellLifecycleV2) {
                        publicationObjects = new java.util.concurrent.ConcurrentHashMap<>();
                        HostedGateTestSupport.stubPublicationOss(context,
                                publicationObjects, "publication-oss-fixture");
                    }
                })
                .run(arguments.toArray(String[]::new));
        jdbc = spring.getBean(JdbcTemplate.class);
        if (definitionApproval || "Linux".equals(System.getProperty("os.name"))) {
            var guard = spring.getBean(com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard.class);
            for (int index = 0; index < roots.size(); index++) {
                guard.register(tenant, "storage-" + index, UUID.randomUUID().toString());
            }
        }
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
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, ?, 1, ?, 'G0', ?, ?, 'ACTIVE')",
                tenant, workspace, storage, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')", tenant, workspace, "actor".getBytes(StandardCharsets.UTF_8));
        // The reader grant exists in both runs so the later-Turn block can also run under
        // approval-mode=default without colliding with the access table's primary key.
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'READER')", tenant, workspace, "reader".getBytes(StandardCharsets.UTF_8));
        // R1's second operator, in both runs: in the approvals run they answer
        // a pending approval; in the files run they drive a later Turn, a
        // cancel and a rename, and their widened then re-blocked submits
        // pin the creator-keyed execution facts.
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
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
            if (!answered.add(id)) {
                continue;
            }
            String route = web ? "/api/agent/web-shell/v1/actions/respond"
                    : "/v1/agents/sessions/" + session + "/actions/" + id + "/responses";
            Map<String, Object> response = web ? Map.of("kind", "permission", "optionId", shellDecision,
                    "inputRevision", action.path("inputRevision").asLong(), "policyRevision", action.path("policyRevision").asText())
                    : Map.of("kind", "permission", "option_id", shellDecision, "input_revision", action.path("input_revision").asLong(),
                            "policy_revision", action.path("policy_revision").asText());
            Map<String, Object> body = web ? Map.of("sessionId", session, "actionId", id, "idempotencyKey", id,
                    "requestId", "d6b-action", "response", response) : response;
            assertThat(request("POST", route, body, id, "reader", 403).at("/error/code").asText()).isEqualTo("action_forbidden");
            // The live Harness retains this approval while the dispatcher's attachment cache is cold.
            ((Map<?, ?>) ReflectionTestUtils.getField(spring.getBean(HarnessConnector.class), "attachments")).clear();
            // Files sessions answer the first approval as a second OPERATOR
            // (R1's handoff) and the rest as the owner. A Shell answer runs
            // a command, so only the recorded owner may answer it.
            String responder = !shell && fixedAnswered.add(session) ? "operator2" : "actor";
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
            if (System.getenv(name) != null) {
                environment.put(name, System.getenv(name));
            }
        }
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE", home.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString(), "OPENAI_API_KEY", "fake-local-key",
                "OPENAI_BASE_URL", modelUrl, "QWEN_SERVER_TOKEN", TOKEN, "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        if (shellLifecycleV2) {
            environment.put("QWEN_HOSTED_LIFECYCLE_V2_PROFILES", "hosted-workspace-shell/1");
        }
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            environment.put(name, temporary.resolve(name + ".json").toString());
        }
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
            if (shell) {
                assertThat(tools).containsExactlyInAnyOrder("read_file", "write_file", "edit", "run_shell_command", "monitor");
            } else {
                assertThat(tools).containsExactlyInAnyOrder("read_file", "write_file", "edit");
            }
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
            boolean definitionTurn = prompt.get().contains("G0_DEFINITION_APPROVAL_");
            boolean runShell = shell && prompt.get().contains("G0_SHELL");
            boolean foregroundOnly = runShell && shellLifecycleV2;
            if (!runShell && step == 3) {
                assertThat(results.get(2).toString()).contains("after");
            }
            boolean residentSecond = resident && prompt.get().contains("G0_RESIDENT_SECOND");
            if (residentSecond && step >= 1) {
                assertThat(results.getFirst().toString()).contains("after-first-" + tenant);
            }
            if (runShell && shellFault == null && !foregroundOnly && step >= 1) {
                assertThat(results.get(0).toString()).contains("Hosted Monitor is unavailable");
            }
            if (runShell && shellFault == null && !foregroundOnly && step >= 2) {
                assertThat(results.get(1).toString()).contains("Hosted Shell requires a foreground command");
            }
            if (runShell && shellFault == null && step >= (foregroundOnly ? 1 : 3) && "allow".equals(shellDecision)) {
                assertThat(results.get(foregroundOnly ? 0 : 2).toString()).contains("G0_SHELL_STDOUT");
            }
            var chunk = json.createObjectNode().put("id", "g0").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", "g0-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            boolean toolCall = step < (definitionTurn ? 2 : shellFault != null || foregroundOnly ? 1 : 3);
            if (toolCall) {
                String name = runShell ? (!foregroundOnly && shellFault == null && step == 0 ? "monitor" : "run_shell_command")
                        : (residentSecond ? List.of("read_file", "edit", "read_file")
                                : List.of("write_file", "edit", "read_file")).get(step);
                Map<String, Object> args = runShell ? switch (foregroundOnly ? 2 : step) {
                    case 0 -> Map.of("command", "printf 'monitor\\n' >> monitor-proof.txt");
                    case 1 -> Map.of("command", "printf 'background\\n' >> background-proof.txt", "is_background", true);
                    default -> Map.of("command", "printf 'once\\n' >> shell-proof.txt; pwd; printf 'G0_SHELL_STDOUT\\n'", "description", "Write a Shell proof");
                } : switch (step) {
                    case 0 -> Map.of("file_path", "proof.txt", "content", "before");
                    case 1 -> Map.of("file_path", "proof.txt", "old_string", "before", "new_string", resident ? "after-first-" + tenant : "after");
                    default -> Map.of("file_path", "proof.txt");
                };
                if (residentSecond) {
                    args = step == 1
                            ? Map.of("file_path", "proof.txt", "old_string", "after-first-" + tenant, "new_string", "after-second-" + tenant)
                            : Map.of("file_path", "proof.txt");
                }
                if (definitionTurn) {
                    String marker = prompt.get().split("[^A-Z0-9_]", 2)[0];
                    name = step == 0 ? "write_file" : "run_shell_command";
                    args = step == 0 ? Map.of("file_path", marker + ".write", "content", "BYTES_" + marker + "\n")
                            : Map.of("command", "printf 'once\\n' >> " + marker + ".shell",
                                    "description", "Append the definition approval proof");
                }
                if (shellFault != null) {
                    String producer = "const fs = require('fs'); fs.appendFileSync('proof.txt', 'x');"
                            + " process.stdout.write(Buffer.alloc(1024 * 1024, 0x61), () => {"
                            + " process.stdout.write('stdout-tail\\n'); process.stderr.write('stderr-tail\\n'); });";
                    args = Map.of("command", shellQuote(node) + " -e " + shellQuote(producer), "timeout", 60000);
                }
                delta.putArray("tool_calls").addObject().put("index", 0).put("id", "g0-tool-" + step)
                        .put("type", "function").putObject("function").put("name", name)
                        .put("arguments", json.writeValueAsString(args));
            } else {
                delta.put("content", "G0_DONE");
            }
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
                try {
                    return "tool.receipt".equals(json.readTree(line).path("managedSession").path("kind").asText());
                } catch (IOException error) {
                    throw new IllegalStateException(error);
                }
            });
            if (receipt) {
                receiptRequests.add(body);
                assertThat(receiptRequests).as("Harness receipt retry budget").hasSizeLessThanOrEqualTo(3);
            }
            HttpRequest.Builder forwarded = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + exchange.getRequestURI()))
                    .timeout(Duration.ofSeconds(15)).method(exchange.getRequestMethod(), body.length == 0
                            ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
            exchange.getRequestHeaders().forEach((name, values) -> {
                if (!List.of("host", "connection", "content-length", "upgrade", "expect").contains(name.toLowerCase(java.util.Locale.ROOT))) {
                    values.forEach(value -> forwarded.header(name, value));
                }
            });
            var response = http.send(forwarded.build(), HttpResponse.BodyHandlers.ofByteArray());
            if (receipt) {
                assertThat(response.statusCode()).isEqualTo("receipt-failure".equals(shellFault) ? 500 : 200);
                if ("receipt-reply".equals(shellFault)) {
                    return;
                }
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
            if (receipt) {
                receiptResponses.incrementAndGet();
            }
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
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        if (actor != null) {
            request.header("X-G0-Fixture-Actor", actor);
        }
        var response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("%s %s: %s", method, path, response.body()).isEqualTo(expected);
        return json.readTree(response.body());
    }

    // Every creation refusal here shares one declared code; the fixture, not the code, selects the branch.
    private static void assertUnavailable(JsonNode refusal) {
        assertThat(refusal.path("error").path("code").asText()).isEqualTo("workspace_unavailable");
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
                () -> { if (shellProbe != null) {
                    shellProbe.close();
                } },
                () -> { if (spring != null) {
                    spring.close();
                } },
                () -> { if (retainedPlacement != null) {
                    retainedPlacement.close();
                } },
                () -> { if (storeRelay != null) {
                    storeRelay.stop(0);
                } },
                () -> { if (relayExecutor != null) {
                    relayExecutor.close();
                } },
                () -> { if (durableClose || definitionApproval) {
                    HostedDurableWorkers.stop(temporary.resolve("broker"), json);
                } },
                () -> { if (model != null) {
                    model.stop(0);
                } });
        for (var step : cleanup) {
            try {
                step.execute();
            } catch (Throwable error) {
                if (failure == null) {
                    failure = error;
                } else {
                    failure.addSuppressed(error);
                }
            }
        }
        if (failure instanceof Exception error) {
            throw error;
        }
        if (failure instanceof Error error) {
            throw error;
        }
    }
}
