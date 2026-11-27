package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.channel.PrWatchOperations;
import com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.ImportMetadata;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Target;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceTestStorage;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
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
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.attachment;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.attachmentsOf;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.connectorOwning;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.quote;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.reservePort;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.AdditionalAnswers.delegatesTo;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class HostedPublicWorkspaceIT {
    private static final String TOKEN = "g0-local-fixture";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final String PARK_IMAGE =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRs8AAAAASUVORK5CYII=";
    private static final String PARK_INPUT = "G0_PARK_ACTION";
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final String tenant = UUID.randomUUID().toString();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    // Holds the model reply to a G0_CANCEL prompt so the test can cancel a running Turn.
    private volatile CountDownLatch heldReply = new CountDownLatch(1);
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private HttpServer model;
    private Process harness;
    private Process poolSuccessor;
    private int poolSuccessorPort;
    private IsolatedManagedSchemaMySqlTestDatabase poolDatabase;
    private JdbcTemplate jdbc;
    private int port;
    private Path decoy;
    private String node;
    private boolean approvals;
    private boolean shell;
    private String parkedShellOutcome;
    private String parkingSlice;
    private IsolatedManagedSchemaMySqlTestDatabase parkingDatabase;
    private Path hookRoot;
    private boolean definitionApproval;
    private String shellDecision = "allow";
    private boolean durableClose;
    private boolean confined;
    private boolean shellLifecycleV2;
    private boolean publicChildren;
    private boolean publicChildBackground;
    private boolean publicChildQuestions;
    private boolean restarted;
    private boolean publicChildFallback;
    private boolean personalMemory;
    private boolean holdRuntimeStartup;
    private boolean coldApprovalReplica;
    private final Map<String, Map<String, Object>> memoryEntries = new java.util.concurrent.ConcurrentHashMap<>();
    private final AtomicInteger memoryRequests = new AtomicInteger();
    private final AtomicInteger memoryWrites = new AtomicInteger();
    private final String memoryFact = "Personal preference " + UUID.randomUUID() + ": use concise Chinese answers.";
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
    @Timeout(180)
    void structuredQuestionSurvivesJavaAndHarnessRestart() throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        shell = true;
        approvals = true;
        definitionApproval = true;
        var roots = boot();
        register("workspace-0", "storage-0");
        String session = request("POST", "/api/agent/web-shell/v1/sessions/create",
                Map.of("agentId", "qwen-code", "idempotencyKey", "question-session", "input", List.of(),
                        "approvalMode", "yolo", "workspace", Map.of("workspaceId", "workspace-0", "cwdRelative", "child")),
                "question-session", "actor", 202).path("sessionId").asText();
        String turn = request("POST", "/api/agent/web-shell/v1/turns/submit",
                Map.of("sessionId", session, "idempotencyKey", "question-turn",
                        "input", List.of(Map.of("type", "input_text", "text", "G0_USER_QUESTION"))),
                "question-turn", "actor", 202).path("turnId").asText();
        JsonNode waiting = await().atMost(Duration.ofSeconds(45)).until(() -> {
            assertThat(modelFailure.get()).isNull();
            return request("GET", "/v1/agents/sessions/" + session + "/actions", null, null, "actor", 200).path("data").path(0);
        }, action -> "question".equals(action.path("kind").asText()));
        assertThat(waiting.path("tool_name").asText()).isEqualTo("ask_user_question");
        assertThat(waiting.at("/questions/0/options/1/id").asText()).isEqualTo("q1o2");
        assertThat(modelRequests).hasSize(1);
        var properties = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class);
        int harnessPort = URI.create(properties.getHarness().getBaseUrl()).getPort();
        int brokerPort = properties.getRuntimeBroker().getPort();
        harness.destroyForcibly();
        assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
        spring.close();
        restarted = true;
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
        startSpring(cli, roots, harnessPort, brokerPort);
        startHarness(cli, harnessPort, brokerPort);
        JsonNode refreshed = request("POST", "/api/agent/web-shell/v1/actions/query", Map.of("sessionId", session), null, "actor", 200)
                .path("data").get(0);
        assertThat(refreshed.path("actionId")).isEqualTo(waiting.path("id"));
        assertThat(refreshed.path("inputRevision")).isEqualTo(waiting.path("input_revision"));
        assertThat(refreshed.path("questions").get(0).path("prompt")).isEqualTo(waiting.path("questions").get(0).path("prompt"));
        Map<String, Object> response = Map.of("kind", "question", "inputRevision", refreshed.path("inputRevision").asLong(),
                "policyRevision", refreshed.path("policyRevision").asText(),
                "answers", List.of(Map.of("questionId", "q1", "optionIds", List.of("q1o2", "q1o1"), "text", "Custom 中😀")));
        Map<String, Object> body = Map.of("sessionId", session, "actionId", refreshed.path("actionId").asText(),
                "idempotencyKey", "question-answer", "response", response);
        String operation = request("POST", "/api/agent/web-shell/v1/actions/respond", body, "question-answer", "actor", 202)
                .path("operationId").asText();
        assertThat(request("POST", "/api/agent/web-shell/v1/actions/respond", body, "question-answer", "actor", 202)
                .path("operationId").asText()).isEqualTo(operation);
        await().atMost(Duration.ofSeconds(90)).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            assertThat(request("GET", "/v1/agents/sessions/" + session + "/operations/" + operation,
                    null, null, "actor", 200).path("status").asText()).isEqualTo("completed");
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                    String.class, tenant, session, turn)).isEqualTo("COMPLETED");
        });
        assertThat(modelRequests).hasSize(2);
        await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            assertThat(request("POST", "/api/agent/web-shell/v1/transcript/query", Map.of("sessionId", session), null, "actor", 200)
                    .toString()).contains("G0_USER_QUESTION_DONE");
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?", Long.class, session)).isZero();
    }

    @Test
    @Timeout(240)
    void publicChildQuestionsAllowTheSecondChildToAnswerFirst() throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        publicChildren = true;
        publicChildQuestions = true;
        approvals = true;
        shell = true;
        approvals = true;
        definitionApproval = true;
        shellLifecycleV2 = true;
        Path root = boot().getFirst().resolve("child");
        register("workspace-0", "storage-0");
        String parent = request("POST", "/api/agent/web-shell/v1/sessions/create",
                Map.of("agentId", "qwen-code", "idempotencyKey", "parallel-questions", "input", List.of(),
                        "approvalMode", "yolo", "workspace", Map.of("workspaceId", "workspace-0", "cwdRelative", "child")),
                "parallel-questions", "actor", 202).path("sessionId").asText();
        request("POST", "/api/agent/web-shell/v1/turns/submit",
                Map.of("sessionId", parent, "idempotencyKey", "parallel-questions-turn",
                        "input", List.of(Map.of("type", "input_text", "text", "G0_PUBLIC_QUESTIONS_PARENT"))),
                "parallel-questions-turn", "actor", 202);
        JsonNode page = await().atMost(Duration.ofSeconds(90)).until(() -> {
            assertThat(modelFailure.get()).isNull();
            return request("POST", "/api/agent/web-shell/v1/actions/query",
                    Map.of("sessionId", parent, "includeChildren", true), null, "actor", 200);
        }, result -> result.path("data").size() == 2);
        List<JsonNode> pending = new ArrayList<>();
        page.path("data").forEach(action -> {
            assertThat(action.path("kind").asText()).isEqualTo("question");
            assertThat(action.path("sessionId").asText()).isNotEqualTo(parent);
            pending.add(action);
        });
        JsonNode first = pending.stream().filter(action -> action.at("/questions/0/prompt").asText().equals("Which target for A?"))
                .findFirst().orElseThrow();
        JsonNode second = pending.stream().filter(action -> action.at("/questions/0/prompt").asText().equals("Which target for B?"))
                .findFirst().orElseThrow();
        assertThat(first.path("sessionId")).isNotEqualTo(second.path("sessionId"));
        Map<String, String> originalBindings = new java.util.HashMap<>();
        Map<String, String> runtimeSessions = new java.util.HashMap<>();
        for (JsonNode action : pending) {
            String child = action.path("sessionId").asText();
            String turn = action.path("turnId").asText();
            String runtimeSession = jdbc.queryForObject(
                    "SELECT prompt_id FROM ma_turn WHERE tenant_id=? AND session_id=? AND turn_id=?",
                    String.class, tenant, child, turn);
            assertThat(runtimeSession).isNotBlank();
            runtimeSessions.put(child, runtimeSession);
            await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                    "SELECT COUNT(*) FROM ma_runtime_session rs JOIN ma_runtime_binding rb ON rs.binding_id=rb.binding_id"
                            + " AND rs.runtime_generation=rb.runtime_generation WHERE rs.tenant_id=? AND rs.harness_session_id=?"
                            + " AND rs.runtime_session_id=? AND rs.session_state='READY' AND rs.execution_storage_id IS NULL"
                            + " AND rb.binding_state='READY' AND rb.provisioner_kind='local-process'",
                    Integer.class, tenant, child, runtimeSession)).isEqualTo(1));
            originalBindings.put(child, jdbc.queryForObject(
                    "SELECT binding_id FROM ma_runtime_session WHERE tenant_id=? AND harness_session_id=? AND runtime_session_id=?",
                    String.class, tenant, child, runtimeSession));
        }
        assertThat(request("POST", "/api/agent/web-shell/v1/tasks/query", Map.of("sessionId", parent), null, "actor", 200)
                .path("activeChildCount").asInt()).isEqualTo(2);
        assertThat(root.resolve("question-A.txt")).doesNotExist();
        assertThat(root.resolve("question-B.txt")).doesNotExist();
        for (JsonNode action : List.of(second, first)) {
            boolean answeringSecond = action == second;
            String label = answeringSecond ? "B" : "A";
            String child = action.path("sessionId").asText();
            String key = "question-answer-" + label;
            Map<String, Object> body = Map.of("sessionId", child, "actionId", action.path("actionId").asText(),
                    "idempotencyKey", key, "response", Map.of("kind", "question",
                            "inputRevision", action.path("inputRevision").asLong(),
                            "policyRevision", action.path("policyRevision").asText(),
                            "answers", List.of(Map.of("questionId", "q1", "optionIds", List.of(answeringSecond ? "q1o2" : "q1o1"),
                                    "text", label + "-only"))));
            String operation = request("POST", "/api/agent/web-shell/v1/actions/respond", body, key, "actor", 202)
                    .path("operationId").asText();
            assertThat(request("POST", "/api/agent/web-shell/v1/actions/respond", body, key, "actor", 202)
                    .path("operationId").asText()).isEqualTo(operation);
            await().atMost(Duration.ofSeconds(60)).untilAsserted(() -> {
                assertThat(modelFailure.get()).isNull();
                assertThat(request("GET", "/v1/agents/sessions/" + child + "/operations/" + operation,
                        null, null, "actor", 200).path("status").asText()).isEqualTo("completed");
                assertThat(root.resolve("question-" + label + ".txt")).hasContent(label + "-only");
                assertThat(request("POST", "/api/agent/web-shell/v1/transcript/query", Map.of("sessionId", child), null, "actor", 200)
                        .toString()).contains("G0_PUBLIC_QUESTION_" + label + "_DONE");
            });
            if (answeringSecond) {
                JsonNode remaining = request("POST", "/api/agent/web-shell/v1/actions/query",
                        Map.of("sessionId", parent, "includeChildren", true), null, "actor", 200).path("data");
                assertThat(remaining.size()).isEqualTo(1);
                assertThat(remaining.path(0).path("actionId")).isEqualTo(first.path("actionId"));
                assertThat(remaining.path(0).path("sessionId")).isEqualTo(first.path("sessionId"));
                assertThat(root.resolve("question-A.txt")).doesNotExist();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE tenant_id=? AND harness_session_id=?"
                        + " AND runtime_session_id=? AND binding_id=? AND session_state='READY' AND execution_storage_id IS NULL",
                        Integer.class, tenant, first.path("sessionId").asText(), runtimeSessions.get(first.path("sessionId").asText()),
                        originalBindings.get(first.path("sessionId").asText()))).isEqualTo(1);
            }
        }
        await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            JsonNode tasks = request("POST", "/api/agent/web-shell/v1/tasks/query", Map.of("sessionId", parent), null, "actor", 200);
            assertThat(tasks.path("data").size()).isEqualTo(2);
            tasks.path("data").forEach(task -> assertThat(task.path("state").asText()).isEqualTo("completed"));
            assertThat(tasks.path("activeChildCount").asInt()).isZero();
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=? AND parent_session_id=?",
                Integer.class, tenant, parent)).isEqualTo(2);
    }

    @Test
    @Timeout(240)
    void personalMemorySurvivesApprovalRecoveryAndRecallsAcrossWorkspaces() throws Exception {
        personalMemory = true;
        approvals = true;
        List<Path> roots = boot();
        register("workspace-0", "storage-0");
        register("workspace-1", "storage-1");
        String store = request("POST", "/v1/agents/memory-stores", Map.of(), null, "actor", 200).path("id").asText();
        assertThat(request("POST", "/v1/agents/memory-stores", Map.of(), null, "actor", 200).path("id").asText()).isEqualTo(store);
        String session = memorySession("workspace-0", store, "memory-save");
        request("GET", "/v1/agents/sessions/" + session, null, null, "operator2", 404);
        request("GET", "/v1/agents/sessions/" + session + "/events", null, null, "reader", 404);
        request("GET", "/v1/agents/sessions/" + session + "/artifacts", null, null, "reader", 404);
        request("POST", "/api/agent/web-shell/v1/transcript/query", Map.of("sessionId", session), null, "reader", 404);
        String turn = memoryTurn(session, "G0_MEMORY_SAVE Please remember exactly: " + memoryFact, "save");
        JsonNode pending = awaitMemoryAction(session);
        assertThat(memoryWrites).hasValue(0);
        request("POST", "/api/agent/web-shell/v1/actions/query", Map.of("sessionId", session), null, "operator2", 404);

        var properties = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class);
        int harnessPort = URI.create(properties.getHarness().getBaseUrl()).getPort();
        int brokerPort = properties.getRuntimeBroker().getPort();
        harness.destroyForcibly();
        assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
        spring.close();
        restarted = true;
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
        startSpring(cli, roots, harnessPort, brokerPort);
        startHarness(cli, harnessPort, brokerPort);
        JsonNode restored = awaitMemoryAction(session);
        assertThat(restored.path("actionId").asText()).isEqualTo(pending.path("actionId").asText());
        assertThat(memoryWrites).hasValue(0);
        assertThat(request("GET", "/v1/agents/sessions/" + session, null, null, "actor", 200)
                .path("memory_store_id").asText()).isEqualTo(store);
        String action = restored.path("actionId").asText();
        request("POST", "/api/agent/web-shell/v1/actions/respond", Map.of("sessionId", session,
                "actionId", action, "idempotencyKey", action, "response", Map.of("kind", "permission", "optionId", "allow",
                        "inputRevision", restored.path("inputRevision").asLong(), "policyRevision", restored.path("policyRevision").asText())),
                action, "actor", 202);
        awaitMemoryTurn(session, turn);
        assertThat(memoryWrites).hasValue(1);
        assertThat(memoryEntries).hasSize(1);

        String next = memorySession("workspace-1", store, "memory-recall");
        int beforeRecall = modelRequests.size();
        awaitMemoryTurn(next, memoryTurn(next, "G0_MEMORY_RECALL What is my preference?", "recall"));
        assertThat(modelRequests.subList(beforeRecall, modelRequests.size())).isNotEmpty().allSatisfy(body ->
                assertThat(body.path("messages").toString()).contains("untrusted_external_context", memoryFact));
        assertThat(memoryWrites).hasValue(1);
        request("GET", "/v1/agents/sessions/" + next, null, null, "operator2", 404);

        int beforeUnbound = memoryRequests.get();
        String unbound = memorySession("workspace-0", null, "memory-off");
        awaitMemoryTurn(unbound, memoryTurn(unbound, "G0_MEMORY_OFF No personal memory is selected.", "off"));
        assertThat(memoryRequests).hasValue(beforeUnbound);
        request("GET", "/v1/agents/sessions/" + unbound, null, null, "reader", 200);
        assertThat(modelFailure.get()).isNull();
    }

    private String memorySession(String workspace, String store, String key) throws Exception {
        Map<String, Object> body = new java.util.LinkedHashMap<>(Map.of("agent_id", "qwen-code", "input", List.of(),
                "workspace", Map.of("workspace_id", workspace, "cwd_relative", "child")));
        if (store != null) {
            body.put("memory_store_id", store);
        }
        return request("POST", "/v1/agents/sessions", body, key, "actor", 202).path("id").asText();
    }

    private String memoryTurn(String session, String prompt, String key) throws Exception {
        return request("POST", "/api/agent/web-shell/v1/turns/submit", Map.of("sessionId", session,
                "idempotencyKey", key, "input", List.of(Map.of("type", "input_text", "text", prompt))),
                key, "actor", 202).path("turnId").asText();
    }

    private JsonNode awaitMemoryAction(String session) {
        return await().atMost(Duration.ofSeconds(90)).until(() -> {
            assertThat(modelFailure.get()).isNull();
            if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id=? AND session_id=? AND status='FAILED'",
                    Integer.class, tenant, session) != 0) {
                throw new IllegalStateException("Memory Turn failed: " + Files.readString(temporary.resolve("harness.log")));
            }
            JsonNode actions = request("POST", "/api/agent/web-shell/v1/actions/query", Map.of("sessionId", session), null, "actor", 200);
            return actions.path("data").isEmpty() ? null : actions.path("data").get(0);
        }, Objects::nonNull);
    }

    private void awaitMemoryTurn(String session, String turn) {
        await().atMost(Duration.ofSeconds(90)).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id=? AND session_id=? AND turn_id=?",
                    String.class, tenant, session, turn)).as("%s", Files.readString(temporary.resolve("harness.log"))).isEqualTo("COMPLETED");
        });
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @Timeout(240)
    void publicChildAgentsRunWritableTasksWithAggregatedApprovals(boolean background) throws Exception {
        publicChildren = true;
        publicChildBackground = background;
        shell = true;
        approvals = true;
        definitionApproval = true;
        shellLifecycleV2 = true;
        Path root = boot().getFirst().resolve("child");
        register("workspace-0", "storage-0");
        boolean web = background;
        String created = web ? "/api/agent/web-shell/v1/sessions/create" : "/v1/agents/sessions";
        Map<String, Object> body = web
                ? Map.of("agentId", "qwen-code", "idempotencyKey", "public-child", "input", List.of(),
                        "workspace", Map.of("workspaceId", "workspace-0", "cwdRelative", "child"))
                : Map.of("agent_id", "qwen-code", "input", List.of(),
                        "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child"));
        String parent = request("POST", created, body, "public-child", "actor", 202).path(web ? "sessionId" : "id").asText();
        assertThat(request("GET", "/v1/agents/sessions/" + parent, null, null, "actor", 200)
                .at("/capabilities/child_agents").asBoolean()).isTrue();
        String turn = request("POST", "/api/agent/web-shell/v1/turns/submit",
                Map.of("sessionId", parent, "idempotencyKey", "public-child-turn",
                        "input", List.of(Map.of("type", "input_text", "text", "G0_PUBLIC_PARENT"))),
                "public-child-turn", "actor", 202).path("turnId").asText();
        await().atMost(Duration.ofSeconds(120)).untilAsserted(() -> {
            JsonNode page = request("POST", "/api/agent/web-shell/v1/actions/query",
                    Map.of("sessionId", parent, "includeChildren", true), null, "actor", 200);
            for (JsonNode action : page.path("data")) {
                String id = action.path("actionId").asText();
                if (answered.add(action.path("sessionId").asText() + ":" + id)) {
                    request("POST", "/api/agent/web-shell/v1/actions/respond",
                            Map.of("sessionId", action.path("sessionId").asText(), "actionId", id, "idempotencyKey", id,
                                    "response", Map.of("kind", "permission", "optionId", "allow",
                                            "inputRevision", action.path("inputRevision").asLong(), "policyRevision", action.path("policyRevision").asText())),
                            id, "actor", 202);
                }
            }
            assertThat(modelFailure.get()).isNull();
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id=? AND session_id=? AND turn_id=?",
                    String.class, tenant, parent, turn)).isEqualTo("COMPLETED");
            assertThat(root.resolve("public-child.txt")).hasContent("child-write");
            assertThat(root.resolve("public-child-shell.txt")).hasContent("child-shell");
            JsonNode tasks = request("POST", "/api/agent/web-shell/v1/tasks/query", Map.of("sessionId", parent), null, "actor", 200);
            assertThat(tasks.path("data").size()).isEqualTo(1);
            assertThat(tasks.at("/data/0/state").asText()).isEqualTo("completed");
            assertThat(tasks.at("/data/0/approvalMode").asText()).isEqualTo("default");
            assertThat(tasks.path("activeChildCount").asLong()).isZero();
        });
        String child = jdbc.queryForObject("SELECT session_id FROM ma_session WHERE tenant_id=? AND parent_session_id=?", String.class, tenant, parent);
        assertThat(answered).anyMatch(id -> id.startsWith(child + ":"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=? AND parent_session_id=? AND public_child_agents_version=1",
                Integer.class, tenant, parent)).isEqualTo(1);
        JsonNode transcript = request("POST", "/api/agent/web-shell/v1/transcript/query", Map.of("sessionId", child), null, "actor", 200);
        assertThat(transcript.toString()).contains("G0_PUBLIC_CHILD_DONE");
        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE tenant_id=? AND session_id=?"
                    + " AND domain='child_run' AND delivery_state='consumed'", Integer.class, tenant, parent)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id=? AND session_id=?", String.class, tenant, child))
                    .isEqualTo("CLOSED");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE tenant_id=? AND session_id=?"
                    + " AND operation_kind='CHILD_SESSION_CLOSE' AND state='close_debt'", Integer.class, tenant, parent)).isZero();
        });
        request("POST", "/api/agent/web-shell/v1/turns/submit",
                Map.of("sessionId", child, "idempotencyKey", "forbidden-child-turn", "input", List.of(Map.of("type", "input_text", "text", "new turn"))),
                "forbidden-child-turn", "actor", 409);
    }

    @Test
    @Timeout(240)
    void publicChildKeepsTheFallbackRuntimeModel() throws Exception {
        publicChildFallback = true;
        publicChildAgentsRunWritableTasksWithAggregatedApprovals(true);
        assertThat(modelRequests).anyMatch(body -> "g0-source".equals(body.path("model").asText()));
        assertThat(modelRequests.stream().filter(body -> "g0-fixture".equals(body.path("model").asText())).toList())
                .isNotEmpty().allSatisfy(body -> assertThat(body.path("temperature").asDouble()).isEqualTo(0.2));
    }

    @Test
    @Timeout(240)
    void publicChildApprovalAndParentStopSurviveJavaAndHarnessRestart() throws Exception {
        publicChildren = true;
        shell = true;
        approvals = true;
        definitionApproval = true;
        shellLifecycleV2 = true;
        var roots = boot();
        register("workspace-0", "storage-0");
        String parent = request("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code", "input", List.of(),
                        "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child")),
                "restart-child", "actor", 202).path("id").asText();
        String turn = request("POST", "/api/agent/web-shell/v1/turns/submit",
                Map.of("sessionId", parent, "idempotencyKey", "restart-child-turn",
                        "input", List.of(Map.of("type", "input_text", "text", "G0_PUBLIC_PARENT"))),
                "restart-child-turn", "actor", 202).path("turnId").asText();
        JsonNode waiting = await().atMost(Duration.ofSeconds(90)).until(() -> {
            JsonNode page = request("POST", "/api/agent/web-shell/v1/actions/query",
                    Map.of("sessionId", parent, "includeChildren", true), null, "actor", 200);
            for (JsonNode action : page.path("data")) {
                if (!parent.equals(action.path("sessionId").asText())) {
                    return action;
                }
                String id = action.path("actionId").asText();
                if (answered.add(id)) {
                    request("POST", "/api/agent/web-shell/v1/actions/respond",
                            Map.of("sessionId", parent, "actionId", id, "idempotencyKey", id,
                                    "response", Map.of("kind", "permission", "optionId", "allow",
                                            "inputRevision", action.path("inputRevision").asLong(),
                                            "policyRevision", action.path("policyRevision").asText())), id, "actor", 202);
                }
            }
            assertThat(modelFailure.get()).isNull();
            return null;
        }, Objects::nonNull);
        String child = waiting.path("sessionId").asText();
        var properties = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class);
        int harnessPort = URI.create(properties.getHarness().getBaseUrl()).getPort();
        int brokerPort = properties.getRuntimeBroker().getPort();
        harness.destroyForcibly();
        assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
        spring.close();
        restarted = true;
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
        startSpring(cli, roots, harnessPort, brokerPort);
        startHarness(cli, harnessPort, brokerPort);
        await().atMost(Duration.ofSeconds(45)).untilAsserted(() -> {
            JsonNode page = request("POST", "/api/agent/web-shell/v1/actions/query",
                    Map.of("sessionId", parent, "includeChildren", true), null, "actor", 200);
            assertThat(page.path("data")).anyMatch(action -> action.path("sessionId").asText().equals(child)
                    && action.path("actionId").equals(waiting.path("actionId"))
                    && action.path("inputRevision").equals(waiting.path("inputRevision")));
        });
        Map<String, Object> cancel = Map.of("type", "agent.session.cancel", "turn_id", turn);
        request("POST", "/v1/agents/sessions/" + parent + "/events", cancel, "stop-public-child", "actor", 202);
        request("POST", "/v1/agents/sessions/" + parent + "/events", cancel, "stop-public-child", "actor", 202);
        // Recovery may wait for the old writer lease and one full retry backoff.
        await().atMost(Duration.ofSeconds(150)).untilAsserted(() -> {
            assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id=? AND session_id=? AND turn_id=?",
                    String.class, tenant, parent, turn)).isEqualTo("CANCELLED");
            JsonNode tasks = request("POST", "/api/agent/web-shell/v1/tasks/query", Map.of("sessionId", parent), null, "actor", 200);
            assertThat(tasks.at("/data/0/stopRequested").asBoolean()).isTrue();
            assertThat(tasks.at("/data/0/state").asText()).isEqualTo("cancelled");
            assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id=? AND session_id=?", String.class, tenant, child))
                    .isEqualTo("CLOSED");
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=? AND parent_session_id=?", Integer.class, tenant, parent)).isEqualTo(1);
        assertThat(roots.getFirst().resolve("child/public-child.txt")).doesNotExist();
        assertThat(roots.getFirst().resolve("child/public-child-shell.txt")).doesNotExist();
        assertThat(modelFailure.get()).isNull();
    }

    @Test
    @Timeout(150)
    void publicCreationRunsFilesThroughProductionWorkspaceBinding() throws Exception {
        runFiles();
    }

    @Test
    @Timeout(90)
    void workspacePreparationOutlivesAdmissionBudgetOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        holdRuntimeStartup = true;
        List<Path> roots = boot();
        HarnessConnector observed = observePreparationHarness();
        String session = createPreparingWorkspaceSession();
        assertPreparationHeld(session, observed);

        Files.writeString(temporary.resolve("worker-release"), "release");
        awaitTurn(session, null, "child", roots.getFirst());

        String prompt = jdbc.queryForObject("SELECT prompt_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session);
        verify(observed).createOrLoad(tenant, session, false);
        verify(observed).submit(eq(tenant), eq(session), eq(prompt), any(), anyString());
        assertThat(modelRequests).hasSize(4);
        assertThat(modelFailure.get()).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND status = 'COMPLETED' AND retry_count = 0", Integer.class, tenant, session)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?"
                        + " AND execution_state = 'SETTLED'", Integer.class, session)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
                Integer.class, session)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE tenant_id = ? AND session_id = ?"
                        + " AND is_terminal = TRUE", Integer.class, tenant, session)).isEqualTo(1);
        Long ready = jdbc.queryForObject("SELECT MIN(sequence_id) FROM ma_public_event WHERE tenant_id = ?"
                        + " AND session_id = ? AND event_type = 'environment.ready'", Long.class, tenant, session);
        Long firstModel = jdbc.queryForObject("SELECT MIN(sequence_id) FROM ma_public_event WHERE tenant_id = ?"
                        + " AND session_id = ? AND event_type IN ('item.output_text.delta', 'item.reasoning.delta')",
                Long.class, tenant, session);
        assertThat(ready).isNotNull();
        assertThat(firstModel).isNotNull();
        assertThat(ready).isLessThan(firstModel);
    }

    @Test
    @Timeout(90)
    void cancelDuringWorkspacePreparationNeverAdmitsAfterLateReadyOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        holdRuntimeStartup = true;
        boot();
        HarnessConnector observed = observePreparationHarness();
        String session = createPreparingWorkspaceSession();
        assertPreparationHeld(session, observed);
        String turn = jdbc.queryForObject("SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session);
        request("POST", "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.cancel", "turn_id", turn), "cancel-preparation", "actor", 202);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(turnStatus(session, turn)).isEqualTo("CANCELLED"));

        Files.writeString(temporary.resolve("worker-release"), "release");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding WHERE tenant_id = ?"
                            + " AND binding_state = 'READY'", Integer.class, tenant)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE tenant_id = ?"
                            + " AND session_id = ? AND event_type = 'environment.ready'", Integer.class, tenant, session)).isEqualTo(1);
        });
        await().during(Duration.ofSeconds(1)).atMost(Duration.ofSeconds(3)).untilAsserted(() -> {
            assertThat(turnStatus(session, turn)).isEqualTo("CANCELLED");
            assertNoPreparationAdmission(session, observed);
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE tenant_id = ? AND session_id = ?"
                        + " AND is_terminal = TRUE", Integer.class, tenant, session)).isEqualTo(1);
    }

    private HarnessConnector observePreparationHarness() {
        HarnessConnector observed = mock(HarnessConnector.class, delegatesTo(spring.getBean(HarnessConnector.class)));
        ReflectionTestUtils.setField(spring.getBean(HarnessCoordinator.class), "harness", observed);
        return observed;
    }

    private String createPreparingWorkspaceSession() throws Exception {
        register("workspace-0", "storage-0");
        return request("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code", "input", List.of(Map.of("type", "input_text", "text", "G0_FILES")),
                        "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child")),
                "preparing-workspace", "actor", 202).path("id").asText();
    }

    private void assertPreparationHeld(String session, HarnessConnector observed) {
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(temporary.resolve("worker-started")).exists());
        long started = System.nanoTime();
        await().pollInterval(Duration.ofMillis(25)).during(Duration.ofSeconds(2)).atMost(Duration.ofSeconds(5))
                .untilAsserted(() -> {
                    assertThat(turnStatus(session, null)).isIn("ACCEPTED", "RUNNING");
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding WHERE tenant_id = ?"
                                    + " AND binding_state = 'PROVISIONING'", Integer.class, tenant)).isEqualTo(1);
                    assertNoPreparationAdmission(session, observed);
                });
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThan(Duration.ofMillis(30));
    }

    private void assertNoPreparationAdmission(String session, HarnessConnector observed) {
        verify(observed, never()).createOrLoad(eq(tenant), eq(session), anyBoolean());
        verify(observed, never()).recoverManagedRuntime(eq(tenant), eq(session), anyBoolean());
        verify(observed, never()).submit(eq(tenant), eq(session), anyString(), any(), anyString());
        assertThat(modelRequests).isEmpty();
        assertThat(modelFailure.get()).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND is_submission_attempted = 0 AND retry_count = 0 AND consecutive_failures = 0"
                        + " AND budget_exempt_failures = 0", Integer.class, tenant, session)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
                Integer.class, session)).isZero();
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
    void liveApprovalChangesReleaseOnlyThePermittedPendingToolsOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        shell = true;
        approvals = true;
        definitionApproval = true;
        Path root = boot().getFirst().resolve("child");
        register("workspace-0", "storage-0");
        String session = request("POST", "/api/agent/web-shell/v1/sessions/create",
                Map.of("agentId", "qwen-code", "idempotencyKey", "live-session", "input", List.of(),
                        "approvalMode", "default",
                        "workspace", Map.of("workspaceId", "workspace-0", "cwdRelative", "child")),
                "live-session", "actor", 202).path("sessionId").asText();
        assertThat(request("POST", "/api/agent/web-shell/v1/session-approval/query",
                Map.of("sessionId", session), null, "actor", 200).path("liveSupported").asBoolean()).isTrue();
        String marker = "G0_DEFINITION_APPROVAL_LIVE";
        String turn = request("POST", "/api/agent/web-shell/v1/turns/submit",
                Map.of("sessionId", session, "idempotencyKey", marker,
                        "input", List.of(Map.of("type", "input_text", "text", marker))),
                marker, "actor", 202).path("turnId").asText();
        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> {
            JsonNode actions = request("POST", "/api/agent/web-shell/v1/actions/query",
                    Map.of("sessionId", session), null, "actor", 200).path("data");
            assertThat(actions.size()).isEqualTo(1);
            assertThat(actions.get(0).path("toolName").asText()).isEqualTo("write_file");
        });
        assertThat(root.resolve(marker + ".write")).doesNotExist();
        request("POST", "/api/agent/web-shell/v1/session-approval/change",
                Map.of("sessionId", session, "idempotencyKey", "live-auto-edit",
                        "approvalMode", "auto-edit", "expectedRevision", 0), null, "actor", 200);
        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> {
            JsonNode actions = request("POST", "/api/agent/web-shell/v1/actions/query",
                    Map.of("sessionId", session), null, "actor", 200).path("data");
            assertThat(actions.size()).isEqualTo(1);
            assertThat(actions.get(0).path("toolName").asText()).isEqualTo("run_shell_command");
        });
        assertThat(Files.readString(root.resolve(marker + ".write"))).isEqualTo("BYTES_" + marker + "\n");
        assertThat(root.resolve(marker + ".shell")).doesNotExist();
        request("POST", "/api/agent/web-shell/v1/session-approval/change",
                Map.of("sessionId", session, "idempotencyKey", "live-yolo",
                        "approvalMode", "yolo", "expectedRevision", 1), null, "actor", 200);
        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                "SELECT status FROM ma_turn WHERE tenant_id=? AND session_id=? AND turn_id=?",
                String.class, tenant, session, turn)).isEqualTo("COMPLETED"));
        assertThat(Files.readString(root.resolve(marker + ".shell"))).isEqualTo("once\n");
        assertThat(jdbc.queryForMap("SELECT approval_mode, approval_revision FROM ma_turn"
                + " WHERE tenant_id=? AND session_id=? AND turn_id=?", tenant, session, turn))
                .containsEntry("approval_mode", "default").containsEntry("approval_revision", 0L);
        assertThat(jdbc.queryForList("SELECT state FROM ma_session_record WHERE tenant_id=? AND session_id=?"
                + " AND record_kind='ACTION'", String.class, tenant, session)).containsExactly("decided", "decided");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id=?"
                + " AND execution_state='SETTLED'", Integer.class, session)).isEqualTo(2);
        assertThat(modelRequests).hasSize(3);
        assertThat(modelFailure.get()).isNull();
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

    @Test
    @EnabledOnOs(OS.LINUX)
    @org.junit.jupiter.api.condition.EnabledIfSystemProperty(named = "qwen.test.private.rootfs", matches = ".+")
    @Timeout(120)
    void publicConfinedShellUsesTheSelectedRuntimeAndStopsItsOriginalCgroup() throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        confined = true;
        shell = true;
        approvals = true;
        durableClose = true;
        var root = boot().getFirst();
        Files.writeString(decoy.resolve("outside"), "protected");
        register("workspace-0", "storage-0");
        var input = List.of(Map.of("type", "input_text", "text", "G0_SHELL_CONFINED"));
        var invalid = Map.of("agent_id", "qwen-code", "input", input, "workspace",
                Map.of("workspace_id", "workspace-0", "cwd_relative", "child"));
        assertThat(request("POST", "/v1/agents/sessions", invalid, "confined-subdir", "actor", 409).toString())
                .contains(WorkspaceExecutionProfile.CONFINEMENT_DENIED);
        String session = request("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code", "input", input, "workspace", Map.of("workspace_id", "workspace-0")),
                "confined-root", "actor", 202).path("id").asText();
        assertThat(jdbc.queryForObject("SELECT tool_profile FROM ma_session WHERE session_id = ?", String.class, session))
                .isEqualTo("hosted-workspace-confined-shell/1");
        for (int turn = 1; turn <= 2; turn++) {
            int answeredBefore = answered.size();
            if (turn == 2) {
                request("POST", "/v1/agents/sessions/" + session + "/events",
                        Map.of("type", "agent.session.input.message", "input", input), "confined-second", "actor", 202);
            }
            int expected = turn;
            await().atMost(Duration.ofSeconds(30)).failFast(() -> {
                if (modelFailure.get() != null) {
                    throw new AssertionError(modelFailure.get());
                }
            }).untilAsserted(() -> {
                answerActions(session, false);
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE session_id = ? AND status = 'COMPLETED'",
                        Integer.class, session)).isEqualTo(expected);
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE harness_session_id = ?"
                        + " AND execution_storage_id IS NOT NULL", Integer.class, session)).isZero();
            });
            assertThat(answered.size() - answeredBefore).isEqualTo(1);
        }
        assertThat(Files.readString(root.resolve("shell-proof.txt"))).isEqualTo("once\nonce\n");
        assertThat(root.resolve("detached-started")).exists();
        await().during(Duration.ofSeconds(4)).atMost(Duration.ofSeconds(8))
                .untilAsserted(() -> assertThat(root.resolve("detached-survived")).doesNotExist());
        String binding = jdbc.queryForObject("SELECT binding_id FROM ma_runtime_binding WHERE tenant_id = ?"
                + " AND isolation_key = ?", String.class, tenant, session);
        assertThat(jdbc.queryForObject("SELECT capability_digest FROM ma_runtime_binding WHERE binding_id = ?",
                String.class, binding)).isEqualTo(WorkspaceExecutionProfile.PRIVATE_ROOT_CAPABILITY_DIGEST);
        JsonNode handle = json.readTree(jdbc.queryForObject("SELECT resource_handle_json FROM ma_runtime_binding"
                + " WHERE binding_id = ?", String.class, binding));
        Path group = Path.of(handle.path("cgroupRoot").asText()).resolve("qwen-runtime-" + handle.path("resourceId").asText());
        Path registration = temporary.resolve("broker").resolve(handle.path("resourceId").asText() + ".json");
        long pid = json.readTree(Files.readString(registration)).path("pid").asLong();
        var worker = ProcessHandle.of(pid).orElseThrow();
        assertThat(Files.readAllLines(group.resolve("cgroup.procs"))).containsExactly(Long.toString(pid));
        var broker = spring.getBean(EmbeddedRuntimeBroker.class).service();
        String runtimeSession = UUID.randomUUID().toString();
        String claim = UUID.randomUUID().toString();
        broker.acquire(session, runtimeSession, "bootstrap", null, claim).toCompletableFuture().get(10, TimeUnit.SECONDS);
        Process writer = new ProcessBuilder("/bin/sh", "-c", "echo $$ > \"$1\" && exec /bin/sleep 120",
                "fixture", group.resolve("cgroup.procs").toString()).start();
        try {
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                    assertThat(Files.readAllLines(group.resolve("cgroup.procs"))).contains(Long.toString(writer.pid())));
            worker.destroyForcibly();
            worker.onExit().get(5, TimeUnit.SECONDS);
            org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                    broker.releaseMount(session, runtimeSession, claim, null).toCompletableFuture().join())
                    .hasRootCauseInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
            assertThat(jdbc.queryForObject("SELECT execution_storage_id FROM ma_runtime_session WHERE runtime_session_id = ?",
                    String.class, runtimeSession)).isNotBlank();
            assertThat(writer.isAlive()).isTrue();
            String operation = request("POST", "/v1/agents/sessions/" + session + "/close",
                    null, "confined-close", "actor", 202).path("id").asText();
            await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> assertThat(request("GET",
                    "/v1/agents/sessions/" + session + "/operations/" + operation, null, null, "actor", 200)
                    .path("status").asText()).isEqualTo("completed"));
            assertThat(writer.waitFor(5, TimeUnit.SECONDS)).isTrue();
            assertThat(jdbc.queryForObject("SELECT execution_storage_id FROM ma_runtime_session WHERE runtime_session_id = ?",
                    String.class, runtimeSession)).isNull();
            assertThat(json.readTree(Files.readString(registration)).path("state").asText()).isEqualTo("RETIRED");
            assertThat(jdbc.queryForObject("SELECT drain_receipt_json FROM ma_runtime_binding WHERE binding_id = ?",
                    String.class, binding)).isNotBlank();
        } finally {
            writer.destroyForcibly();
            writer.waitFor(5, TimeUnit.SECONDS);
        }
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
        assertThat(modelRequests).hasSize(4);
    }

    @ParameterizedTest
    @ValueSource(strings = {"allow", "deny", "cancel", "mode-change", "expiry"})
    @Timeout(150)
    void publicChildrenShellApprovalSettlesAfterParkingAndHarnessReplacementOnMySql(String outcome) throws Exception {
        shellApprovalSettlesAfterParking(outcome, true, true);
    }

    @ParameterizedTest
    @ValueSource(strings = {"allow", "deny"})
    @Timeout(120)
    void coldControlPlaneDeliversActionOnTheOriginalActiveHarness(String decision) throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        approvals = true;
        shell = true;
        shellDecision = decision;
        definitionApproval = true;
        shellLifecycleV2 = true;
        publicChildren = true;
        coldApprovalReplica = true;
        List<Path> roots = boot();
        register("workspace-0", "storage-0");
        var settings = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class);
        int harnessPort = URI.create(settings.getHarness().getBaseUrl()).getPort();
        Path replicaBroker = Files.createDirectory(temporary.resolve("replica-broker"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Path cli = Path.of(System.getProperty("qwen.cli.entry")).toAbsolutePath();
        try (var replica = startControlPlane(cli, roots, harnessPort, reservePort(), 0, replicaBroker, "100ms")) {
            var cold = replica.getBean(HarnessConnector.class);
            int replicaPort = replica.getWebServer().getPort();
            String session = request("POST", "/v1/agents/sessions", Map.of(
                    "agent_id", "qwen-code",
                    "input", List.of(Map.of("type", "input_text", "text", "G0_SHELL")),
                    "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child")),
                    "start-action", "actor", 202).path("id").asText();
            String route = "/v1/agents/sessions/" + session;
            var action = new AtomicReference<JsonNode>();
            await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?", String.class, session))
                        .isEqualTo("RUNNING");
                JsonNode actions = request("GET", route + "/actions", null, null, "actor", 200).path("data");
                assertThat(actions).hasSize(1);
                action.set(actions.get(0));
            });
            assertThat(cold.attachedSessions()).isEmpty();
            assertThat(writerGeneration(session)).isEqualTo(1L);
            assertThat(modelRequests).hasSize(1);
            Path proof = roots.getFirst().resolve("child/shell-proof.txt");
            assertThat(proof).doesNotExist();

            JsonNode pending = action.get();
            String response = route + "/actions/" + pending.path("id").asText() + "/responses";
            var body = Map.of("kind", "permission", "option_id", decision,
                    "input_revision", pending.path("input_revision").asLong(),
                    "policy_revision", pending.path("policy_revision").asText());
            String operation = request(replicaPort, "POST", response, body, "cold-decision", "actor", 202)
                    .path("id").asText();
            assertThat(request(replicaPort, "POST", response, body, "cold-decision", "actor", 202)
                    .path("id").asText()).isEqualTo(operation);
            await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
                assertThat(request(replicaPort, "GET", route + "/operations/" + operation, null, null, "actor", 200)
                        .at("/action_resolution/outcome").asText()).isEqualTo("decided");
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?", String.class, session))
                        .isEqualTo("COMPLETED");
            });
            assertThat(cold.attachedSessions()).anyMatch(ref -> session.equals(ref.sessionId()));
            assertThat(writerGeneration(session)).isEqualTo(1L);
            assertThat(modelRequests).hasSize(2);
            if ("allow".equals(decision)) {
                assertThat(Files.readString(proof)).isEqualTo("once\n");
            } else {
                assertThat(proof).doesNotExist();
            }
            assertThat(modelFailure.get()).isNull();
        }
    }

    private long writerGeneration(String session) {
        return jdbc.queryForObject("SELECT writer_generation FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'", Long.class, tenant, session);
    }

    @ParameterizedTest(name = "publication={0}, outcome={1}")
    @CsvSource({"false, allow", "false, deny", "true, allow", "true, deny"})
    @Timeout(150)
    void versionZeroShellApprovalSettlesAfterParkingAndHarnessReplacementOnMySql(boolean publication, String outcome)
            throws Exception {
        shellApprovalSettlesAfterParking(outcome, false, publication);
    }

    @Test
    @Timeout(120)
    void imageOnlyApprovalSurvivesParkingAndHarnessReplacementOnMySql() throws Exception {
        Path workspace = bootParkingSlice("image");
        String session = createParkingSession();
        String turn = submitParkingInput(session,
                Map.of("type", "input_image", "data", PARK_IMAGE, "mime_type", "image/png"), "image-only");

        settleParkedShell(session, turn, workspace);

        String imageUrl = "data:image/png;base64," + PARK_IMAGE;
        assertThat(modelRequests).hasSize(2).allSatisfy(body ->
                assertThat(body.path("messages").findValuesAsText("url")).contains(imageUrl));
    }

    @Test
    @EnabledOnOs({OS.LINUX, OS.MAC})
    @Timeout(120)
    void extensionCommandApprovalSurvivesParkingAndHarnessReplacementOnMySql() throws Exception {
        Path workspace = bootParkingSlice("command-step");
        Pin extension = publishParkingExtension();
        String session = request("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code", "input", List.of(), "extensionPins", List.of(extension),
                        "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child")),
                "parking-session", "actor", 202).path("id").asText();
        String turn = submitParkingText(session, "G0_PARK_COMMAND");
        HostedParkedAction parked = awaitParkedTurn(session, turn);
        assertThat(parked.actionId()).startsWith("command_approval_");
        assertThat(workspace.resolve("park-proof.txt")).doesNotExist();

        replaceParkingHarness();
        allowParkedAction(session, parked, "run_shell_command");

        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> {
            assertParkingTurnCompleted(session, turn);
            assertParkedActionIdentity(session, parked);
            assertThat(Files.readString(workspace.resolve("park-proof.txt"))).isEqualTo("once\n");
            JsonNode stage = HostedGateTestSupport.extensionRecord(jdbc, tenant, session, "tool_stage");
            assertThat(stage.at("/run/state").asText()).isEqualTo("settled");
        });
    }

    private Pin publishParkingExtension() throws Exception {
        Path source = Files.createDirectory(temporary.resolve("extension-source"));
        Files.writeString(source.resolve("qwen-extension.json"), """
                {"name":"park-fixture","version":"1.0.0"}
                """);
        Path commands = Files.createDirectory(source.resolve("commands"));
        Files.writeString(commands.resolve("run.md"), """
                ---
                description: Run the parked fixture command
                ---
                !{printf 'once\\n' >> park-proof.txt}
                """);
        Path archive = temporary.resolve("parking-extension.tar.gz");
        ProcessBuilder archiveCommand = new ProcessBuilder("tar", "-czf", archive.toString(), "-C", source.toString(),
                "qwen-extension.json", "commands");
        archiveCommand.environment().put("COPYFILE_DISABLE", "1");
        Process tar = archiveCommand.start();
        try {
            assertThat(tar.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(tar.exitValue()).isZero();
        } finally {
            if (tar.isAlive()) {
                tar.destroyForcibly();
                assertThat(tar.waitFor(10, TimeUnit.SECONDS)).isTrue();
            }
        }
        String digest;
        try (var input = Files.newInputStream(archive)) {
            digest = DigestUtils.sha256Hex(input);
        }
        String platform = "Linux".equals(System.getProperty("os.name")) ? "linux" : "darwin";
        String metadata = json.writeValueAsString(new ImportMetadata(
                "extension", new Target(platform, "any"), digest, 1, null));
        try (var input = Files.newInputStream(archive)) {
            var published = spring.getBean(ManagedExtensionPackageService.class).importPackage(tenant, "actor",
                    "workspace-0", null, "parking-extension", metadata, input, Files.size(archive));
            assertThat(published.state()).isEqualTo("settled");
            return new Pin(published.extensionId(), published.revision(), published.packageDigest(), null);
        }
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    @Timeout(120)
    void backgroundHoldAndApprovalSurviveParkingAndHarnessReplacementOnMySql() throws Exception {
        Path workspace = bootParkingSlice("background");
        String session = createParkingSession();
        String background = submitParkingText(session, "G0_PARK_BACKGROUND");
        allowStartAction(session);
        await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> {
            assertThat(workspace.resolve("park-background-started")).as("%s", parkingToolResults()).exists();
            assertParkingTurnCompleted(session, background);
        });
        String turn = submitParkingText(session, PARK_INPUT);
        HostedParkedAction parked = awaitParkedTurn(session, turn);
        assertThat(jdbc.queryForObject("""
                SELECT wake_seal_background FROM ma_session_head
                WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'
                """, Integer.class, tenant, session)).isEqualTo(1);
        Path finished = workspace.resolve("park-background-finished");
        assertThat(finished).doesNotExist();

        decideParkedShellAfterReplacement(session, turn, workspace, parked);

        Files.createFile(workspace.resolve("park-background-release"));
        await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            assertThat(finished).exists();
            assertThat(Files.readString(finished)).isEqualTo("once\n");
            var run = HostedGateTestSupport.extensionRecord(jdbc, tenant, session, "child_run");
            assertThat(run.at("/run/state").asText()).isEqualTo("settled");
        });
    }

    @Test
    @Timeout(120)
    void childApprovalSurvivesParkingAndHarnessReplacementOnMySql() throws Exception {
        Path workspace = bootParkingSlice("child");
        String parent = createParkingSession();
        String parentTurn = submitParkingText(parent, "G0_PARK_PARENT");
        await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> {
            answerPendingStartAction(parent);
            assertParkingTurnCompleted(parent, parentTurn);
        });
        var childId = new AtomicReference<String>();
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() ->
                assertThat(jdbc.queryForList("""
                        SELECT session_id FROM ma_session WHERE tenant_id = ? AND parent_session_id = ?
                        """, String.class, tenant, parent)).as("%s", parkingToolResults())
                        .singleElement().satisfies(childId::set));
        String child = childId.get();
        String turn = await().atMost(Duration.ofSeconds(15)).until(() -> jdbc.queryForList("""
                SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?
                """, String.class, tenant, child), rows -> !rows.isEmpty()).getFirst();
        HostedParkedAction parked = awaitParkedTurn(child, turn);
        assertThat(jdbc.queryForMap("""
                SELECT wake_seal_parked_approval_revision FROM ma_session_head
                WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'
                """, tenant, child)).containsEntry("wake_seal_parked_approval_revision", null);

        decideParkedShellAfterReplacement(child, turn, workspace, parked);
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    @Timeout(120)
    void monitorApprovalSurvivesParkingAndHarnessReplacementOnMySql() throws Exception {
        wakeApprovalSurvivesParkingAndHarnessReplacementOnMySql("monitor");
    }

    @ParameterizedTest
    @ValueSource(strings = {"channel", "pr_event"})
    @Timeout(120)
    void wakeApprovalSurvivesParkingAndHarnessReplacementOnMySql(String source) throws Exception {
        Path workspace = bootParkingSlice(source);
        String session = createParkingSession();
        if ("monitor".equals(source)) {
            String start = submitParkingText(session, "G0_PARK_MONITOR");
            await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> {
                answerPendingStartAction(session);
                assertThat(workspace.resolve("park-monitor-started")).as("%s", parkingToolResults()).exists();
                assertParkingTurnCompleted(session, start);
            });
            Files.createFile(workspace.resolve("park-monitor-release"));
        } else {
            spring.getBean(HarnessConnector.class).runChannelOperation(tenant, session, parkingChannelInput(source));
        }

        AtomicReference<Map<String, Object>> parked = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            var heads = jdbc.queryForList("""
                    SELECT writer_generation, wake_seal_parked_prompt_id, state, activation_phase,
                           wake_seal_parked_owner, wake_seal_revision, journal_revision, is_wake_pending
                    FROM ma_session_head
                    WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'
                    """, tenant, session);
            assertThat(heads).hasSize(1);
            var head = heads.getFirst();
            assertThat(head).as("%s", parkingToolResults()).containsEntry("state", "SEALED")
                    .containsEntry("activation_phase", "released")
                    .containsEntry("wake_seal_parked_owner", "wake")
                    .containsEntry("is_wake_pending", true);
            assertThat(head.get("wake_seal_revision")).isEqualTo(head.get("journal_revision"));
            parked.set(head);
        });
        String prompt = parked.get().get("wake_seal_parked_prompt_id").toString();
        switch (source) {
            case "monitor" -> assertThat(prompt).contains(":notify:");
            case "channel", "pr_event" -> assertThat(prompt).isEqualTo(parkingWakeInputId(source));
            default -> throw new AssertionError(source);
        }
        assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND prompt_id = ?
                """, Integer.class, tenant, session, prompt)).isZero();
        String actionId = jdbc.queryForObject("""
                SELECT action_id FROM ma_session_record WHERE tenant_id = ? AND session_id = ?
                  AND prompt_id = ? AND record_kind = 'ACTION' AND state = 'requested'
                """, String.class, tenant, session, prompt);
        var action = new HostedParkedAction(prompt, actionId, ((Number) parked.get().get("writer_generation")).longValue());
        Path effect = workspace.resolve("park-proof.txt");
        assertThat(effect).doesNotExist();

        replaceParkingHarness();
        allowParkedAction(session, action, "run_shell_command");

        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            assertThat(effect).exists();
            assertThat(Files.readString(effect)).isEqualTo("once\n");
            assertParkedActionSettled(session, action);
            assertWakeTurnCompleted(session, prompt);
            if ("channel".equals(source)) {
                var delivery = HostedGateTestSupport.extensionRecord(jdbc, tenant, session, "channel_delivery");
                assertThat(delivery.path("sourceTurnId").asText()).isEqualTo(prompt);
            }
        });
    }

    private void assertWakeTurnCompleted(String session, String prompt) throws IOException {
        List<String> outcomes = new ArrayList<>();
        for (String records : jdbc.queryForList("""
                SELECT CONVERT(record_bytes USING utf8mb4) FROM ma_session_journal_tx
                WHERE tenant_id = ? AND session_id = ? AND record_bytes IS NOT NULL
                """, String.class, tenant, session)) {
            for (String line : records.lines().toList()) {
                JsonNode event = json.readTree(line).path("managedSession");
                if ("turn.settled".equals(event.path("kind").asText())
                        && prompt.equals(event.at("/payload/turnId").asText())) {
                    outcomes.add(event.at("/payload/outcome").asText());
                }
            }
        }
        assertThat(outcomes).containsExactly("completed");
    }

    private Path bootParkingSlice(String slice) throws Exception {
        parkingSlice = slice;
        parkingDatabase = new IsolatedManagedSchemaMySqlTestDatabase();
        parkedShellOutcome = "allow";
        shell = approvals = definitionApproval = shellLifecycleV2 = true;
        publicChildren = "child".equals(slice);
        if ("Linux".equals(System.getProperty("os.name"))
                && List.of("background", "monitor", "command-step").contains(slice)) {
            String delegated = System.getenv("QWEN_MANAGED_HOOK_CGROUP_ROOT");
            assertThat(delegated).as("Run Maven inside a delegated Linux cgroup v2 subtree").isNotBlank();
            hookRoot = Files.createDirectory(Path.of(delegated).resolve("parking-" + UUID.randomUUID()));
        }
        Path workspace = boot().getFirst().resolve("child");
        register("workspace-0", "storage-0");
        if ("background".equals(slice) || "monitor".equals(slice)) {
            Files.writeString(workspace.resolve("parking.cjs"), """
                    const fs = require('node:fs');
                    const source = process.argv[2];
                    fs.writeFileSync('park-' + source + '-started', '');
                    const timer = setInterval(() => {
                      if (!fs.existsSync('park-' + source + '-release')) return;
                      clearInterval(timer);
                      if (source === 'monitor') console.log('G0_PARK_ACTION');
                      else fs.appendFileSync('park-background-finished', 'once\\n');
                    }, 100);
                    """);
        }
        return workspace;
    }

    private String createParkingSession() throws Exception {
        return request("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code", "input", List.of(),
                        "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child")),
                "parking-session", "actor", 202).path("id").asText();
    }

    private String submitParkingText(String session, String text) throws Exception {
        return submitParkingInput(session, Map.of("type", "input_text", "text", text), text);
    }

    private String submitParkingInput(String session, Map<String, Object> input, String key) throws Exception {
        return request("POST", "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.input.message", "input", List.of(input)), key,
                "actor", 202).path("turn_id").asText();
    }

    private void assertParkingTurnCompleted(String session, String turn) {
        assertThat(modelFailure.get()).isNull();
        assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                String.class, tenant, session, turn)).isEqualTo("COMPLETED");
    }

    private void allowStartAction(String session) {
        await().atMost(Duration.ofSeconds(25)).untilAsserted(() ->
                assertThat(answerPendingStartAction(session)).isTrue());
    }

    private boolean answerPendingStartAction(String session) throws Exception {
        String route = "/v1/agents/sessions/" + session;
        for (JsonNode action : request("GET", route + "/actions", null, null, "actor", 200).path("data")) {
            String id = action.path("id").asText();
            if ("requested".equals(action.path("state").asText()) && answered.add(id)) {
                request("POST", route + "/actions/" + id + "/responses",
                        Map.of("kind", "permission", "option_id", "allow",
                                "input_revision", action.path("input_revision").asLong(),
                                "policy_revision", action.path("policy_revision").asText()), id, "actor", 202);
            }
        }
        return !answered.isEmpty();
    }

    private HostedParkedAction awaitParkedTurn(String session, String turn) {
        AtomicReference<HostedParkedAction> parked = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            parked.set(HostedParkedAction.read(jdbc, tenant, session, turn));
        });
        return parked.get();
    }

    private void settleParkedShell(String session, String turn, Path workspace) throws Exception {
        decideParkedShellAfterReplacement(session, turn, workspace, awaitParkedTurn(session, turn));
    }

    private void decideParkedShellAfterReplacement(String session, String turn, Path workspace,
            HostedParkedAction parked) throws Exception {
        assertThat(workspace.resolve("park-proof.txt")).doesNotExist();
        replaceParkingHarness();
        allowParkedAction(session, parked, "run_shell_command");
        await().atMost(Duration.ofSeconds(40)).untilAsserted(() -> {
            assertThat(modelFailure.get()).isNull();
            assertThat(jdbc.queryForList("""
                    SELECT turn_id, prompt_id, status FROM ma_turn
                    WHERE tenant_id = ? AND session_id = ? AND prompt_id = ?
                    """, tenant, session, parked.promptId())).singleElement().satisfies(row ->
                    assertThat(row).containsEntry("turn_id", turn).containsEntry("status", "COMPLETED"));
            assertThat(Files.readString(workspace.resolve("park-proof.txt"))).isEqualTo("once\n");
            assertParkedActionSettled(session, parked);
        });
    }

    private void assertParkedActionSettled(String session, HostedParkedAction parked) {
        assertParkedActionIdentity(session, parked);
        assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM ma_tool_execution
                WHERE harness_session_id = ? AND turn_id = ? AND execution_state = 'SETTLED'
                """, Integer.class, session, parked.promptId().getBytes(StandardCharsets.UTF_8))).isEqualTo(1);
    }

    private void assertParkedActionIdentity(String session, HostedParkedAction parked) {
        assertThat(jdbc.queryForObject("""
                SELECT writer_generation FROM ma_session_head
                WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'
                """, Long.class, tenant, session)).isGreaterThan(parked.writerGeneration());
        assertThat(jdbc.queryForList("""
                SELECT action_id, prompt_id, state FROM ma_session_record
                WHERE tenant_id = ? AND session_id = ? AND prompt_id = ? AND record_kind = 'ACTION'
                """, tenant, session, parked.promptId())).singleElement().satisfies(row -> {
                    assertThat(row).containsEntry("action_id", parked.actionId()).containsEntry("prompt_id", parked.promptId());
                    assertThat(row.get("state")).isNotNull().isNotEqualTo("requested");
                });
    }

    private void allowParkedAction(String session, HostedParkedAction parked, String toolName) throws Exception {
        String route = "/v1/agents/sessions/" + session;
        String actionRoute = route + "/actions/" + parked.actionId();
        JsonNode action = request("GET", actionRoute, null, null, "actor", 200);
        assertThat(action.path("tool_name").asText()).isEqualTo(toolName);
        var decision = parked.response(action, "allow");
        String operation = request("POST", actionRoute + "/responses", decision, "park-decision", "actor", 202)
                .path("id").asText();
        await().atMost(Duration.ofSeconds(40)).untilAsserted(() ->
                assertThat(request("GET", route + "/operations/" + operation, null, null, "actor", 200)
                        .at("/action_resolution/outcome").asText()).isEqualTo("decided"));
    }

    private void replaceParkingHarness() throws Exception {
        var settings = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class);
        long oldPid = harness.pid();
        harness.destroyForcibly();
        assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
        startHarness(Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath(),
                URI.create(settings.getHarness().getBaseUrl()).getPort(), settings.getRuntimeBroker().getPort());
        assertThat(harness.pid()).isNotEqualTo(oldPid);
    }

    private Map<String, Object> parkingChannelInput(String source) {
        var body = new java.util.LinkedHashMap<String, Object>();
        body.put("operationId", UUID.randomUUID().toString());
        body.put("text", PARK_INPUT);
        if ("pr_event".equals(source)) {
            body.put("kind", "submit_pr_event_input");
            body.put("inputId", parkingWakeInputId(source));
            body.put("owner", "Fixture");
            body.put("repo", "Fixture");
            body.put("prNumber", 7);
            body.put("transition", "ci_failure");
            body.put("headSha", "a".repeat(40));
            body.put("episode", 1);
            body.put("evidence", "The fixture build failed.");
        } else {
            body.put("kind", "submit_input");
            body.put("inputId", parkingWakeInputId(source));
            body.put("channelInstanceId", "mail-1");
            body.put("accountId", "agent@example.com");
            body.put("accountGeneration", 1);
            body.put("platformEventId", "1700:90");
            body.put("semanticRevision", 1);
            body.put("senderId", "alice@example.com");
            body.put("chatId", "alice@example.com");
            body.put("threadId", "thread-1");
            body.put("subject", "Notes");
            body.put("attachments", List.of());
            body.put("replyContext", Map.of("parent", "<a@example.com>", "references", List.of()));
            body.put("scope", Map.of("kind", "chat_thread", "chatId", "alice@example.com", "threadId", "thread-1"));
            body.put("policy", Map.of("adapter", "email", "senderPolicy", "allowlist",
                    "allowedSenders", List.of("alice@example.com"), "dispatchMode", "followup"));
        }
        return body;
    }

    private String parkingWakeInputId(String source) {
        if ("pr_event".equals(source)) {
            return PrWatchOperations.prWatchInputId(tenant, "mail-1", "Fixture", "Fixture",
                    7, "ci_failure", "a".repeat(40), 1);
        }
        return "chin-" + ChannelRouteRepository.routeKey(
                tenant, "mail-1", 1, "1700:90", 1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"allow", "deny"})
    @Timeout(120)
    void healthyPoolHandsParkedShellActionToSuccessorBeforeLeaseExpiryOnMySql(String outcome) throws Exception {
        poolDatabase = new IsolatedManagedSchemaMySqlTestDatabase();
        poolSuccessorPort = reservePort();
        shellApprovalSettlesAfterParking(outcome, true, true);
    }

    private void shellApprovalSettlesAfterParking(String outcome, boolean children, boolean publication) throws Exception {
        assertThat(System.getProperty("mysql.url")).startsWith("jdbc:mysql:");
        parkedShellOutcome = outcome;
        shell = true;
        approvals = true;
        definitionApproval = true;
        publicChildren = children;
        shellLifecycleV2 = publication;
        List<Path> roots = boot();
        register("workspace-0", "storage-0");
        String session = request("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code", "input", List.of(),
                        "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child")),
                "parked-shell", "actor", 202).path("id").asText();
        String route = "/v1/agents/sessions/" + session;
        assertThat(request("GET", route, null, null, "actor", 200)
                .at("/capabilities/child_agents").asBoolean()).isEqualTo(children);
        assertThat(jdbc.queryForObject("SELECT public_child_agents_version FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?", Integer.class, tenant, session))
                .isEqualTo(children ? 1 : 0);
        String turn = request("POST", route + "/events",
                Map.of("type", "agent.session.input.message",
                        "input", List.of(Map.of("type", "input_text", "text", "G0_SHELL"))),
                "parked-shell-turn", "actor", 202).path("turn_id").asText();
        var parkedAction = new AtomicReference<HostedParkedAction>();
        await().atMost(Duration.ofSeconds(35))
                .failFast(() -> {
                    if (modelFailure.get() != null) {
                        throw new AssertionError("Model fixture failed", modelFailure.get());
                    }
                }).untilAsserted(() -> parkedAction.set(HostedParkedAction.read(jdbc, tenant, session, turn)));
        HostedParkedAction parked = parkedAction.get();
        Path proof = roots.getFirst().resolve("child/shell-proof.txt");
        assertThat(proof).doesNotExist();
        assertThat(modelRequests).hasSize(1);

        var properties = spring.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class);
        int harnessPort = URI.create(properties.getHarness().getBaseUrl()).getPort();
        int brokerPort = properties.getRuntimeBroker().getPort();
        HarnessPlacementStore placements = poolDatabase == null ? null : spring.getBean(HarnessPlacementStore.class);
        HarnessPlacementStore.Placement original = placements == null ? null : placements.get(tenant, session);
        long oldLease = 0;
        if (placements != null) {
            assertThat(original).isNotNull();
            assertThat(original.instanceId()).isEqualTo("pool-a");
            await().atMost(Duration.ofSeconds(15)).untilAsserted(() ->
                    assertThat(placements.get(tenant, session).state()).isEqualTo("RELEASED"));
            oldLease = jdbc.queryForObject("""
                    SELECT writer_lease_until FROM ma_session_head
                    WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'
                    """, Long.class, tenant, session);
            assertThat(oldLease).isGreaterThan(System.currentTimeMillis());
            assertPoolMembersAccepting(harnessPort);
        } else {
            long oldPid = harness.pid();
            harness.destroyForcibly();
            assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
            Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
            if (children && "allow".equals(outcome)) {
                spring.close();
                restarted = true;
                startSpring(cli, roots, harnessPort, brokerPort);
                assertThat(HostedParkedAction.read(jdbc, tenant, session, turn)).isEqualTo(parked);
            }
            startHarness(cli, harnessPort, brokerPort);
            assertThat(harness.pid()).isNotEqualTo(oldPid);
        }

        String actionRoute = route + "/actions/" + parked.actionId();
        switch (outcome) {
            case "allow", "deny" -> {
                JsonNode action = request("GET", actionRoute, null, null, "actor", 200);
                assertThat(action.path("tool_name").asText()).isEqualTo("run_shell_command");
                var decision = parked.response(action, outcome);
                String operation = request("POST", actionRoute + "/responses", decision, "decision", "actor", 202)
                        .path("id").asText();
                if (placements != null) {
                    await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
                        var successor = placements.get(tenant, session);
                        assertThat(successor.instanceId()).isEqualTo("pool-b");
                        assertThat(successor.epoch()).isEqualTo(original.epoch() + 1);
                    });
                    assertThat(oldLease).isGreaterThan(System.currentTimeMillis());
                }
                assertThat(request("POST", actionRoute + "/responses", decision, "decision", "actor", 202)
                        .path("id").asText()).isEqualTo(operation);
                await().atMost(Duration.ofSeconds(40)).untilAsserted(() ->
                        assertThat(request("GET", route + "/operations/" + operation, null, null, "actor", 200)
                                .at("/action_resolution/outcome").asText()).isEqualTo("decided"));
            }
            case "mode-change" -> request("POST", "/api/agent/web-shell/v1/session-approval/change",
                    Map.of("sessionId", session, "idempotencyKey", "parked-yolo",
                            "approvalMode", "yolo", "expectedRevision", 0), null, "actor", 200);
            case "cancel" -> request("POST", route + "/events",
                    Map.of("type", "agent.session.cancel", "turn_id", turn), "cancel", "actor", 202);
            case "expiry" -> {
                // The dispatch scan picks up the sealed Turn when the Action expires.
            }
            default -> throw new AssertionError(outcome);
        }
        boolean cancelled = List.of("cancel", "expiry").contains(outcome);
        await().atMost(Duration.ofSeconds(55)).untilAsserted(() ->
                parked.assertSettled(jdbc, tenant, session, turn,
                        cancelled ? "CANCELLED" : "COMPLETED", cancelled ? "turn.cancelled" : "turn.completed"));
        if (List.of("allow", "mode-change").contains(outcome)) {
            assertThat(Files.readString(proof)).isEqualTo("once\n");
            assertThat(jdbc.queryForObject("""
                    SELECT COUNT(*) FROM ma_tool_execution
                    WHERE harness_session_id = ? AND turn_id = ? AND execution_state = 'SETTLED'
                    """, Integer.class, session, parked.promptId().getBytes(StandardCharsets.UTF_8))).isEqualTo(1);
        } else {
            assertThat(proof).doesNotExist();
            if ("deny".equals(outcome)) {
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution"
                        + " WHERE harness_session_id = ? AND turn_id = ?", Integer.class,
                        session, parked.promptId().getBytes(StandardCharsets.UTF_8))).isZero();
            }
        }
        if ("expiry".equals(outcome)) {
            assertThat(jdbc.queryForObject("SELECT state FROM ma_session_record WHERE tenant_id = ?"
                    + " AND session_id = ? AND action_id = ?", String.class, tenant, session, parked.actionId()))
                    .isEqualTo("expired");
        }
        assertThat(modelFailure.get()).isNull();
        assertThat(modelRequests).hasSize(cancelled ? 1 : 2);
        if (placements != null) {
            assertPoolMembersAccepting(harnessPort);
        }
    }

    private void assertPoolMembersAccepting(int harnessPort) {
        assertThat(harness.isAlive()).isTrue();
        assertThat(poolSuccessor.isAlive()).isTrue();
        assertThat(harness.pid()).isNotEqualTo(poolSuccessor.pid());
        assertPoolMemberAccepting(harnessPort, "pool-a");
        assertPoolMemberAccepting(poolSuccessorPort, "pool-b");
    }

    private void assertPoolMemberAccepting(int memberPort, String instanceId) {
        try (var client = HostedHarnessClient.builder().baseUri(URI.create("http://127.0.0.1:" + memberPort))
                .bearerToken(TOKEN).capabilityDigest(DIGEST).heartbeatInterval(Duration.ZERO).build()) {
            assertThat(client.capabilities().getInstanceId()).isEqualTo(instanceId);
            assertThat(client.readInstance().get("state")).isEqualTo("ACCEPTING");
        }
    }

    private void deleteShellAndAwaitCollection(String session, String workspace, boolean web, Path marker) throws Exception {
        var publications = jdbc.queryForList("SELECT publication_id FROM ma_output_capture"
                + " WHERE tenant_id = ? AND session_id = ? AND capture_bytes = 1048576", String.class, tenant, session);
        assertThat(publications).hasSize(1);
        var output = jdbc.queryForList("SELECT o.capture_object_key AS object_key, o.byte_length, o.sha256,"
                + " o.capture_state AS state, o.slot_key FROM ma_resource o JOIN ma_output_capture p"
                + " ON p.scope_ref = o.scope_ref AND p.publication_id = o.publication_id"
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
            assertThat(tenant).matches("[0-9a-f-]{36}");
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
            var attached = attachment(connector, session);
            assertThat(attached).as("Spring's attachment to %s", session).isNotNull();
            var client = (HostedHarnessClient) ReflectionTestUtils.getField(
                    connectorOwning(connector), "client");
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
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE binding_id = ?"
                    + " AND execution_storage_id IS NOT NULL", Integer.class, binding)).isZero();
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

    @Test
    @Timeout(480)
    void legacyWorkspaceCwdOperationsSettleAndPivotLaterTurns() throws Exception {
        List<Path> roots = boot();
        Files.createDirectory(roots.get(0).resolve("child2"));
        register("workspace-0", "storage-0");
        Map<String, Object> creation = Map.of("agent_id", "qwen-code",
                "input", List.of(Map.of("type", "input_text", "text", "G0_FILES")),
                "workspace", Map.of("workspace_id", "workspace-0", "cwd_relative", "child"));
        String session = request("POST", "/v1/agents/sessions", creation,
                "legacy-cwd-create", "actor", 202).path("id").asText();
        awaitTurn(session, null, "child", roots.get(0));
        // A durable Turn result can precede the Runtime's confirmed release.
        await().atMost(Duration.ofSeconds(35)).untilAsserted(() ->
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session"
                        + " WHERE tenant_id = ? AND harness_session_id = ?"
                        + " AND session_state <> 'RELEASED'", Integer.class, tenant, session)).isZero());
        var store = spring.getBean(com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore.class);
        String operation = LegacyCwdOperations.seed(jdbc, store, tenant, session, "actor", "actor-digest",
                "legacy-cwd", "digest", "child2", 1).operation().operationId();
        await().atMost(Duration.ofSeconds(35)).untilAsserted(() -> {
            JsonNode polled = request("GET", "/v1/agents/sessions/" + session + "/operations/" + operation,
                    null, null, "actor", 200);
            assertThat(polled.path("status").asText()).isEqualTo("completed");
            assertThat(polled.path("result_context_revision").asLong()).isEqualTo(2);
        });
        JsonNode web = request("POST", "/api/agent/web-shell/v1/operations/query",
                Map.of("sessionId", session, "operationId", operation), null, "actor", 200);
        assertThat(web.path("status").asText()).isEqualTo("completed");
        assertThat(web.path("resultContextRevision").asLong()).isEqualTo(2);
        JsonNode events = request("GET", "/v1/agents/sessions/" + session + "/events",
                null, null, "actor", 200);
        long changed = 0;
        for (JsonNode event : events.path("data")) {
            if ("session.context.changed".equals(event.path("type").asText())) {
                changed++;
            }
        }
        assertThat(changed).isEqualTo(1);
        Files.writeString(roots.get(0).resolve("child/proof.txt"), "sentinel");
        String laterTurn = request("POST", "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.input.message", "input",
                        List.of(Map.of("type", "input_text", "text", "G0_FILES"))),
                "legacy-cwd-later-turn", "actor", 202).path("turn_id").asText();
        awaitTurn(session, laterTurn, "child2", roots.get(0));
        assertThat(Files.readString(roots.get(0).resolve("child2/proof.txt"))).isEqualTo("after");
        assertThat(Files.readString(roots.get(0).resolve("child/proof.txt"))).isEqualTo("sentinel");
        assertThat(roots.get(0).resolve("proof.txt")).doesNotExist();
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
    private List<Path> boot() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the CLI first").isRegularFile();
        node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        if (holdRuntimeStartup) {
            Path launcher = temporary.resolve("worker-barrier-node");
            Files.writeString(launcher, "#!/bin/sh\n: > " + quote(temporary.resolve("worker-started").toString())
                    + "\nwhile [ ! -f " + quote(temporary.resolve("worker-release").toString())
                    + " ]; do /bin/sleep 0.05; done\nexec " + quote(node) + " \"$@\"\n");
            Files.setPosixFilePermissions(launcher, PosixFilePermissions.fromString("rwx------"));
        }
        decoy = Files.createDirectory(temporary.resolve("harness-decoy"));
        if (durableClose || definitionApproval || personalMemory) {
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
        try (var springSocket = new ServerSocket(reservePort(), 1, java.net.InetAddress.getByName("127.0.0.1"));
                var harnessSocket = new ServerSocket(reservePort(), 1, java.net.InetAddress.getByName("127.0.0.1"));
                var brokerSocket = new ServerSocket(reservePort(), 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            port = springSocket.getLocalPort();
            harnessPort = harnessSocket.getLocalPort();
            brokerPort = brokerSocket.getLocalPort();
            model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            model.createContext("/v1/chat/completions", this::modelReply);
            if (personalMemory) {
                model.createContext("/v1/memories/", this::memoryReply);
                model.createContext("/v2/memories/search/", this::memoryReply);
            }
            model.start();
            if (shellFault != null) {
                storeRelay = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                relayExecutor = Executors.newVirtualThreadPerTaskExecutor();
                storeRelay.setExecutor(relayExecutor);
                storeRelay.createContext("/internal/managed-session-store/", this::relayStore);
                storeRelay.start();
            }
        }
        startSpring(cli, roots, harnessPort, brokerPort);
        startHarness(cli, harnessPort, brokerPort);
        if (poolDatabase != null) {
            startHarness(cli, poolSuccessorPort, brokerPort, "pool-b");
            assertPoolMembersAccepting(harnessPort);
            ReflectionTestUtils.invokeMethod(connectorOwning(spring.getBean(HarnessConnector.class)), "refresh");
        }
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
                    + " WHERE tenant_id = ? AND session_id = ? AND is_terminal = TRUE", Integer.class, tenant, session))
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

    private void startSpring(Path cli, List<Path> roots, int harnessPort, int brokerPort) throws IOException {
        spring = startControlPlane(cli, roots, harnessPort, brokerPort, port, temporary.resolve("broker"),
                coldApprovalReplica ? "120s" : null);
        jdbc = spring.getBean("managedJdbcTemplate", JdbcTemplate.class);
        if (!restarted && (holdRuntimeStartup || definitionApproval || personalMemory || "Linux".equals(System.getProperty("os.name")))) {
            var guard = spring.getBean(com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard.class);
            for (int index = 0; index < roots.size(); index++) {
                WorkspaceTestStorage.prepareNativeRoot(roots.get(index));
                guard.register(tenant, "storage-" + index, UUID.randomUUID().toString());
            }
        }
    }

    private ServletWebServerApplicationContext startControlPlane(Path cli, List<Path> roots, int harnessPort,
            int brokerPort, int httpPort, Path brokerDirectory, String scanDelay) throws IOException {
        boolean mysql = System.getProperty("mysql.url") != null;
        var isolatedDatabase = parkingDatabase == null ? poolDatabase : parkingDatabase;
        String databaseUrl = isolatedDatabase != null ? isolatedDatabase.url() : System.getProperty("mysql.url",
                "jdbc:h2:mem:" + tenant + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        boolean detachedParking = "background".equals(parkingSlice) || "monitor".equals(parkingSlice);
        Path worker = cli;
        if (detachedParking) {
            worker = temporary.resolve("parking-worker.mjs");
            Files.writeString(worker, "process.env.QWEN_MANAGED_RUNTIME_OBSERVATION='1'; "
                    + "process.env.QWEN_MANAGED_HOOK_CGROUP_ROOT="
                    + json.writeValueAsString(hookRoot.toString())
                    + "; process.argv[1]=" + json.writeValueAsString(cli.toString())
                    + "; await import(" + json.writeValueAsString(cli.toUri().toString()) + ");\n");
        }
        List<String> arguments = new ArrayList<>(List.of("--server.address=127.0.0.1", "--server.port=" + httpPort,
                "--spring.datasource.url=" + databaseUrl,
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
                "--qwen.managed-agent.runtime-broker.state-directory=" + brokerDirectory,
                "--qwen.managed-agent.runtime-broker.credential-key-id=g0-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable="
                        + (holdRuntimeStartup ? temporary.resolve("worker-barrier-node") : node),
                "--qwen.managed-agent.runtime-broker.worker-entry=" + worker));
        if (poolDatabase != null) {
            arguments.addAll(List.of(
                    "--qwen.managed-agent.session-store.binding-key=pool-binding-key-0123456789abcdef0123456789abcdef",
                    "--qwen.managed-agent.harness.heartbeat-interval=PT0S",
                    "--qwen.managed-agent.harness.pool.enabled=true",
                    "--qwen.managed-agent.harness.pool.instances[0].instance-id=pool-a",
                    "--qwen.managed-agent.harness.pool.instances[0].base-url=http://127.0.0.1:" + harnessPort,
                    "--qwen.managed-agent.harness.pool.instances[1].instance-id=pool-b",
                    "--qwen.managed-agent.harness.pool.instances[1].base-url=http://127.0.0.1:" + poolSuccessorPort));
        }
        if (holdRuntimeStartup) {
            arguments.addAll(List.of("--qwen.managed-agent.dispatch.scan-delay=10ms",
                    "--qwen.managed-agent.dispatch.retry-initial-delay=10ms",
                    "--qwen.managed-agent.dispatch.max-pre-admission-retries=2",
                    "--qwen.managed-agent.harness.load-timeout=20s"));
        }
        if (scanDelay != null) {
            arguments.add("--qwen.managed-agent.dispatch.scan-delay=" + scanDelay);
        }
        if (approvals) {
            arguments.add("--qwen.managed-agent.harness.approval-mode="
                    + (shell && "deny".equals(shellDecision) ? "auto-edit" : "default"));
        }
        if (personalMemory) {
            arguments.add("--qwen.managed-agent.memory.enabled=true");
            arguments.add("--qwen.managed-agent.memory.endpoint=http://127.0.0.1:" + model.getAddress().getPort());
            arguments.add("--qwen.managed-agent.memory.api-key=synthetic-memory-key");
        }
        if (shell) {
            arguments.add("--qwen.managed-agent.harness.workspace-shell-enabled=true");
        }
        if (definitionApproval) {
            arguments.add("--qwen.managed-agent.definition-tool-profiles=hosted-workspace-shell/1");
        }
        if (!publicChildren) {
            arguments.add("--qwen.managed-agent.harness.workspace-child-agents-enabled=false");
        }
        if (confined) {
            arguments.add("--qwen.managed-agent.runtime-broker.provider-options.private-rootfs="
                    + System.getProperty("qwen.test.private.rootfs"));
            arguments.add("--qwen.managed-agent.runtime-broker.provider-options.cgroup-root="
                    + System.getProperty("qwen.test.cgroup.root"));
        }
        if (shellLifecycleV2) {
            arguments.addAll(HostedGateTestSupport.toolPublicationArgs(port,
                    "private-test-bucket", 1048576));
        }
        if (parkedShellOutcome != null) {
            arguments.addAll(List.of("--qwen.managed-agent.action-parking.enabled=true",
                    "--qwen.managed-agent.wake-dispatch.enabled=true"));
            if ("expiry".equals(parkedShellOutcome)) {
                arguments.add("--qwen.managed-agent.harness.approval-timeout=15s");
            }
        }
        if (detachedParking) {
            arguments.add("--qwen.managed-agent.runtime-observation.enabled=true");
        }
        if ("command-step".equals(parkingSlice)) {
            arguments.addAll(List.of("--qwen.managed-agent.extensions.enabled=true",
                    "--qwen.managed-agent.extensions.self-service-enabled=true",
                    "--qwen.managed-agent.extensions.allowed-actors[0]=actor",
                    "--qwen.managed-agent.extensions.artifact-directory=" + temporary.resolve("extension-artifacts"),
                    "--qwen.managed-agent.managed-extensions.enabled=true",
                    "--qwen.managed-agent.managed-extensions.cache-directory=" + temporary.resolve("extension-cache")));
            if (hookRoot != null) {
                arguments.add("--qwen.managed-agent.managed-extensions.cgroup-root=" + hookRoot);
            } else {
                arguments.add("--qwen.managed-agent.managed-extensions.mode=developer-process-group");
            }
        }
        arguments.add("--qwen.managed-agent.runtime-broker.durable-local-process=" + (durableClose || definitionApproval || personalMemory));
        arguments.add("--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled="
                + (holdRuntimeStartup || definitionApproval || personalMemory || "Linux".equals(System.getProperty("os.name"))));
        for (int i = 0; i < roots.size(); i++) {
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts[" + i + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + i);
            arguments.add(prefix + "root=" + roots.get(i));
        }
        return (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .initializers(context -> {
                    context.getBeanFactory().registerSingleton("g0Authentication", authentication());
                    if (shellLifecycleV2) {
                        if (publicationObjects == null) {
                            publicationObjects = new java.util.concurrent.ConcurrentHashMap<>();
                        }
                        HostedGateTestSupport.stubPublicationOss(context,
                                publicationObjects, "publication-oss-fixture");
                    }
                })
                .run(arguments.toArray(String[]::new));
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
            attachmentsOf(spring.getBean(HarnessConnector.class)).clear();
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
        startHarness(cli, harnessPort, brokerPort, poolDatabase == null ? null : "pool-a");
    }

    private void startHarness(Path cli, int harnessPort, int brokerPort, String instanceId) throws Exception {
        boolean successor = "pool-b".equals(instanceId);
        Path home = Files.createDirectories(temporary.resolve(successor ? "pool-b-home" : "home"));
        Path config = Files.createDirectories(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
        List<Map<String, Object>> models = new ArrayList<>(List.of(Map.of(
                "id", "g0-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl)));
        if ("image".equals(parkingSlice)) {
            models.set(0, Map.of("id", "g0-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl,
                    "generationConfig", Map.of("modalities", Map.of("image", true))));
        }
        Map<String, Object> settings = new java.util.LinkedHashMap<>(Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")), "model", Map.of("name", publicChildFallback ? "g0-source" : "g0-fixture"),
                "telemetry", Map.of("enabled", false), "modelProviders", Map.of("openai", models)));
        if (publicChildFallback) {
            settings.put("modelFallbacks", "g0-fixture");
            models.add(Map.of("id", "g0-source", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl,
                    "generationConfig", Map.of("contextWindowSize", 100000, "samplingParams", Map.of("temperature", 0.2),
                            "maxRetries", 0, "retryInitialDelayMs", 1, "retryMaxDelayMs", 1)));
        }
        Files.writeString(config.resolve("settings.json"), json.writeValueAsString(settings));
        Path log = temporary.resolve(successor ? "pool-b.log" : "harness.log");
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge", "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web", "--workspace", decoy.toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:" + brokerPort,
                "--managed-runtime-broker-token", TOKEN)
                .directory(decoy.toFile()).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()));
        Map<String, String> environment = builder.environment();
        environment.clear();
        for (String name : List.of("PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")) {
            if (System.getenv(name) != null) {
                environment.put(name, System.getenv(name));
            }
        }
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE", home.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", temporary.resolve(successor ? "pool-b-runtime" : "runtime").toString(),
                "OPENAI_API_KEY", "fake-local-key",
                "OPENAI_BASE_URL", modelUrl, "QWEN_SERVER_TOKEN", TOKEN, "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        if (instanceId != null) {
            environment.put("QWEN_HOSTED_HARNESS_INSTANCE_ID", instanceId);
        }
        if (parkedShellOutcome != null) {
            environment.put("QWEN_E2E_IDLE_SUSPEND_MS", successor ? "60000" : "3000");
        }
        if (shellLifecycleV2 || confined) {
            environment.remove("QWEN_HOSTED_LIFECYCLE_V2_PROFILES");
        } else {
            environment.put("QWEN_HOSTED_LIFECYCLE_V2_PROFILES", "");
        }
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            environment.put(name, temporary.resolve(name + ".json").toString());
        }
        Process process = builder.start();
        if (successor) {
            poolSuccessor = process;
        } else {
            harness = process;
        }
        await().atMost(Duration.ofSeconds(30)).ignoreExceptions().untilAsserted(() -> {
            if (!process.isAlive()) {
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
            if (parkingSlice != null) {
                parkingModelReply(exchange, body);
                return;
            }
            if (holdRuntimeStartup) {
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE tenant_id = ?"
                                + " AND event_type = 'environment.ready'", Integer.class, tenant)).isEqualTo(1);
            }
            if (personalMemory) {
                memoryModelReply(exchange, body);
                return;
            }
            if (publicChildFallback && "g0-source".equals(body.path("model").asText())) {
                byte[] response = "{\"error\":{\"message\":\"model overloaded\",\"type\":\"server_error\",\"code\":\"overloaded\"}}"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.getResponseHeaders().set("retry-after-ms", "1");
                exchange.sendResponseHeaders(503, response.length);
                exchange.getResponseBody().write(response);
                return;
            }
            List<String> tools = new ArrayList<>();
            body.path("tools").forEach(tool -> tools.add(tool.path("function").path("name").asText()));
            if (publicChildren) {
                assertThat(tools).contains("read_file", "write_file", "edit", "run_shell_command");
                assertThat(tools).doesNotContain("team_create", "workflow", "send_message");
            } else if (confined) {
                assertThat(tools).containsExactly("run_shell_command");
            } else if (shell) {
                var expectedTools = new ArrayList<>(List.of("read_file", "write_file", "edit", "web_fetch", "run_shell_command", "glob", "todo_write", "ask_user_question"));
                if (shellLifecycleV2) {
                    expectedTools.add("monitor");
                }
                assertThat(tools).containsExactlyInAnyOrderElementsOf(expectedTools);
                body.path("tools").forEach(tool -> {
                    if ("run_shell_command".equals(tool.at("/function/name").asText())) {
                        assertThat(tool.at("/function/parameters/properties").has("is_background")).isEqualTo(shellLifecycleV2);
                    }
                });
            } else {
                assertThat(tools).containsExactlyInAnyOrder("read_file", "write_file", "edit", "web_fetch", "glob", "ask_user_question");
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
            boolean questionTurn = prompt.get().contains("G0_USER_QUESTION");
            if (questionTurn && step > 0) {
                assertThat(results).hasSize(1);
                assertThat(results.getFirst().toString()).contains("q1o1", "q1o2", "Custom 中😀");
            }
            boolean definitionTurn = prompt.get().contains("G0_DEFINITION_APPROVAL_");
            boolean runShell = shell && prompt.get().contains("G0_SHELL");
            if (!runShell && step == 3) {
                assertThat(results.get(2).toString()).contains("after");
            }
            if (runShell && shellFault == null && step >= 1 && "allow".equals(shellDecision)
                    && !"deny".equals(parkedShellOutcome)) {
                assertThat(results.getFirst().toString()).contains("G0_SHELL_STDOUT");
            }
            var chunk = json.createObjectNode().put("id", "g0").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", "g0-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            boolean publicParent = publicChildren && tools.contains("agent");
            String questionChild = prompt.get().contains("G0_PUBLIC_QUESTION_A") ? "A" : "B";
            if (publicChildQuestions && !publicParent && step > 0) {
                assertThat(tools).contains("ask_user_question");
                assertThat(results.getFirst().toString()).contains(questionChild + "-only")
                        .doesNotContain(("A".equals(questionChild) ? "B" : "A") + "-only");
            }
            boolean toolCall = publicChildren && !runShell ? publicParent ? step == 0 && prompt.get().contains("G0_PUBLIC_PARENT") : step < 2
                    : step < (questionTurn ? 1 : definitionTurn ? 2 : runShell ? 1 : 3);
            if (publicChildQuestions) {
                toolCall = step < 2 && (!publicParent || prompt.get().contains("G0_PUBLIC_QUESTIONS_PARENT"));
            }
            if (toolCall) {
                String name = runShell ? "run_shell_command"
                        : List.of("write_file", "edit", "read_file").get(step);
                Map<String, Object> args = runShell
                        ? Map.of("command", "printf 'once\\n' >> shell-proof.txt; pwd; printf 'G0_SHELL_STDOUT\\n'", "description", "Write a Shell proof")
                        : switch (step) {
                    case 0 -> Map.of("file_path", "proof.txt", "content", "before");
                    case 1 -> Map.of("file_path", "proof.txt", "old_string", "before", "new_string", "after");
                    default -> Map.of("file_path", "proof.txt");
                };
                if (confined) {
                    args = Map.of("command", "test \"$(pwd)\" = /workspace && test ! -e "
                            + quote(decoy.resolve("outside").toString())
                            + " && test ! -e /proc/self && test \"$HOME\" = /tmp || exit 9; "
                            + "/bin/busybox rm -f detached-started; "
                            + "(printf started > detached-started; /bin/busybox sleep 3;"
                            + " printf leaked > detached-survived) </dev/null >/dev/null 2>&1 & "
                            + "while [ ! -e detached-started ]; do :; done; "
                            + "printf 'once\\n' >> shell-proof.txt; printf 'G0_SHELL_STDOUT\\n'",
                            "description", "Check private root and write a proof");
                }
                if (definitionTurn) {
                    String marker = prompt.get().split("[^A-Z0-9_]", 2)[0];
                    name = step == 0 ? "write_file" : "run_shell_command";
                    args = step == 0 ? Map.of("file_path", marker + ".write", "content", "BYTES_" + marker + "\n")
                            : Map.of("command", "printf 'once\\n' >> " + marker + ".shell",
                                    "description", "Append the definition approval proof");
                }
                if (publicChildren && !runShell) {
                    name = publicParent ? "agent" : step == 0 ? "write_file" : "run_shell_command";
                    args = publicParent ? Map.of("description", "write two proofs", "prompt", "G0_PUBLIC_CHILD", "run_in_background", publicChildBackground)
                            : step == 0 ? Map.of("file_path", "public-child.txt", "content", "child-write")
                            : Map.of("command", "printf child-shell > public-child-shell.txt");
                    if (!publicParent) {
                        assertThat(body.path("messages").toString()).doesNotContain("G0_PUBLIC_PARENT");
                    }
                }
                if (publicChildQuestions) {
                    if (publicParent) {
                        name = "agent";
                        args = Map.of("description", "ask child " + (step == 0 ? "A" : "B"),
                                "prompt", "G0_PUBLIC_QUESTION_" + (step == 0 ? "A" : "B"), "run_in_background", true);
                    } else if (step == 0) {
                        name = "ask_user_question";
                        args = Map.of("questions", List.of(Map.of("question", "Which target for " + questionChild + "?",
                                "header", "Target", "multiSelect", true,
                                "options", List.of(Map.of("label", "A", "description", "First"), Map.of("label", "B", "description", "Second")))));
                    } else {
                        name = "write_file";
                        args = Map.of("file_path", "question-" + questionChild + ".txt", "content", questionChild + "-only");
                    }
                }
                if (shellFault != null) {
                    String producer = "const fs = require('fs'); fs.appendFileSync('proof.txt', 'x');"
                            + " process.stdout.write(Buffer.alloc(1024 * 1024, 0x61), () => {"
                            + " process.stdout.write('stdout-tail\\n'); process.stderr.write('stderr-tail\\n'); });";
                    args = Map.of("command", quote(node) + " -e " + quote(producer), "timeout", 60000);
                }
                if (questionTurn) {
                    name = "ask_user_question";
                    args = Map.of("questions", List.of(Map.of("question", "Which targets?", "header", "Targets", "multiSelect", true,
                            "options", List.of(Map.of("label", "Same", "description", "First"), Map.of("label", "Same", "description", "Second")))));
                }
                delta.putArray("tool_calls").addObject().put("index", 0).put("id", "g0-tool-" + step)
                        .put("type", "function").putObject("function").put("name", name)
                        .put("arguments", json.writeValueAsString(args));
            } else {
                delta.put("content", publicChildQuestions && !publicParent ? "G0_PUBLIC_QUESTION_" + questionChild + "_DONE"
                        : questionTurn ? "G0_USER_QUESTION_DONE" : publicChildren && !publicParent ? "G0_PUBLIC_CHILD_DONE" : "G0_DONE");
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

    private void parkingModelReply(HttpExchange exchange, JsonNode request) throws IOException {
        String prompt = "";
        boolean toolResult = false;
        for (JsonNode message : request.path("messages")) {
            if ("user".equals(message.path("role").asText())) {
                String content = message.path("content").toString();
                if (content.contains("G0_PARK_") || content.contains(PARK_IMAGE)) {
                    prompt = content;
                    toolResult = false;
                }
            } else if ("tool".equals(message.path("role").asText())) {
                toolResult = true;
            }
        }
        String tool = null;
        Map<String, Object> arguments = Map.of();
        String marker = "action";
        if (!toolResult && !prompt.isEmpty()) {
            if (prompt.contains("G0_PARK_BACKGROUND")) {
                marker = "background";
                tool = "run_shell_command";
                arguments = Map.of("command", quote(node) + " parking.cjs background",
                        "is_background", true, "timeout", 90000);
            } else if (prompt.contains("G0_PARK_MONITOR")) {
                marker = "monitor";
                tool = "monitor";
                arguments = Map.of("command", quote(node) + " parking.cjs monitor",
                        "max_events", 1, "idle_timeout_ms", 90000);
            } else if (prompt.contains("G0_PARK_PARENT")) {
                marker = "parent";
                tool = "agent";
                arguments = Map.of("description", "Start the fixture child", "prompt", "G0_PARK_CHILD",
                        "run_in_background", true);
            } else if (prompt.contains("G0_PARK_COMMAND")) {
                tool = "skill";
                arguments = Map.of("skill", "park-fixture:run");
            } else {
                tool = "run_shell_command";
                arguments = Map.of("command", "printf 'once\\n' >> park-proof.txt");
            }
        }
        var chunk = json.createObjectNode().put("id", "parking-fixture").put("object", "chat.completion.chunk")
                .put("created", 0).put("model", "g0-fixture");
        var choice = chunk.putArray("choices").addObject().put("index", 0);
        var delta = choice.putObject("delta").put("role", "assistant");
        if (tool == null) {
            delta.put("content", "Parking fixture finished");
        } else {
            assertThat(request.path("tools").findValuesAsText("name")).contains(tool);
            delta.putArray("tool_calls").addObject().put("index", 0).put("id", "park-" + marker).put("type", "function")
                    .putObject("function").put("name", tool).put("arguments", json.writeValueAsString(arguments));
        }
        choice.putNull("finish_reason");
        String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
        choice.putObject("delta");
        choice.put("finish_reason", tool == null ? "stop" : "tool_calls");
        byte[] response = (first + "data: " + json.writeValueAsString(chunk) + "\n\ndata: [DONE]\n\n")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, response.length);
        exchange.getResponseBody().write(response);
    }

    private List<String> parkingToolResults() {
        return modelRequests.stream().flatMap(body -> body.path("messages").valueStream())
                .filter(message -> "tool".equals(message.path("role").asText()))
                .map(message -> message.path("content").toString()).distinct().toList();
    }

    private void memoryModelReply(HttpExchange exchange, JsonNode body) throws IOException {
        List<String> tools = new ArrayList<>();
        body.path("tools").forEach(tool -> tools.add(tool.at("/function/name").asText()));
        String prompt = "";
        List<JsonNode> results = new ArrayList<>();
        for (JsonNode message : body.path("messages")) {
            String content = message.path("content").toString();
            if ("user".equals(message.path("role").asText()) && content.contains("G0_MEMORY_")) {
                prompt = content;
                results.clear();
            } else if ("tool".equals(message.path("role").asText())) {
                results.add(message);
            }
        }
        assertThat(prompt).contains("G0_MEMORY_");
        if (prompt.contains("G0_MEMORY_OFF")) {
            assertThat(tools).doesNotContain("context_search", "context_remember", "context_get", "context_forget");
            assertThat(body.path("messages").toString()).doesNotContain(memoryFact);
        } else {
            assertThat(tools).contains("context_search", "context_remember", "context_get", "context_forget");
            body.path("tools").forEach(tool -> {
                if (tool.at("/function/name").asText().startsWith("context_")) {
                    assertThat(tool.at("/function/parameters/properties").toString())
                            .doesNotContain("tenantId", "userId", "user_id", "memoryStoreId", "endpoint", "apiKey");
                }
            });
        }
        if (prompt.contains("G0_MEMORY_RECALL")) {
            assertThat(body.path("messages").toString()).contains("untrusted_external_context", memoryFact);
        }
        if (!results.isEmpty()) {
            assertThat(results.getFirst().toString()).contains("stored");
        }
        boolean remember = prompt.contains("G0_MEMORY_SAVE") && results.isEmpty();
        var chunk = json.createObjectNode().put("id", "g0-memory").put("object", "chat.completion.chunk")
                .put("created", 0).put("model", "g0-fixture");
        var choice = chunk.putArray("choices").addObject().put("index", 0);
        var delta = choice.putObject("delta").put("role", "assistant");
        if (remember) {
            delta.putArray("tool_calls").addObject().put("index", 0).put("id", "g0-memory-remember")
                    .put("type", "function").putObject("function").put("name", "context_remember")
                    .put("arguments", json.writeValueAsString(Map.of("content", memoryFact)));
        } else {
            delta.put("content", "G0_MEMORY_DONE");
        }
        choice.putNull("finish_reason");
        String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
        choice.putObject("delta");
        choice.put("finish_reason", remember ? "tool_calls" : "stop");
        byte[] response = (first + "data: " + json.writeValueAsString(chunk) + "\n\ndata: [DONE]\n\n")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, response.length);
        exchange.getResponseBody().write(response);
    }

    private void memoryReply(HttpExchange exchange) throws IOException {
        try {
            memoryRequests.incrementAndGet();
            assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Token synthetic-memory-key");
            String path = exchange.getRequestURI().getPath();
            Object response;
            int status = 200;
            if ("/v1/memories/".equals(path) && "POST".equals(exchange.getRequestMethod())) {
                JsonNode body = json.readTree(exchange.getRequestBody());
                assertThat(body.path("infer").asBoolean(true)).isFalse();
                assertThat(body.path("user_id").asText()).startsWith("managed_");
                String id = UUID.randomUUID().toString();
                Map<String, Object> record = Map.of("id", id, "user_id", body.path("user_id").asText(),
                        "memory", body.at("/messages/0/content").asText());
                memoryEntries.put(id, record);
                memoryWrites.incrementAndGet();
                response = Map.of("results", List.of(record));
            } else if ("/v2/memories/search/".equals(path)) {
                JsonNode body = json.readTree(exchange.getRequestBody());
                assertThat(body.path("limit").asInt()).isEqualTo(5);
                String scope = body.at("/filters/user_id").asText();
                assertThat(scope).startsWith("managed_");
                response = Map.of("results", memoryEntries.values().stream().filter(entry -> scope.equals(entry.get("user_id"))).toList());
            } else {
                String id = path.substring("/v1/memories/".length(), path.length() - 1);
                Map<String, Object> record = memoryEntries.get(id);
                if (record == null) {
                    status = 404;
                    response = Map.of("error", "not_found");
                } else if ("DELETE".equals(exchange.getRequestMethod())) {
                    memoryEntries.remove(id);
                    response = Map.of("message", "deleted");
                } else {
                    response = record;
                }
            }
            byte[] bytes = json.writeValueAsBytes(response);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
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

    private HttpResponse<String> rawRequest(String method, String path, Object body, String key, String actor)
            throws Exception {
        return rawRequest(port, method, path, body, key, actor);
    }

    private HttpResponse<String> rawRequest(int httpPort, String method, String path, Object body, String key, String actor)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + httpPort + path))
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
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private JsonNode request(String method, String path, Object body, String key, String actor, int expected)
            throws Exception {
        return request(port, method, path, body, key, actor, expected);
    }

    private JsonNode request(int httpPort, String method, String path, Object body, String key, String actor, int expected)
            throws Exception {
        HttpResponse<String> response = rawRequest(httpPort, method, path, body, key, actor);
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
                    if (holdRuntimeStartup && temporary != null && Files.isDirectory(temporary)) {
                        Files.writeString(temporary.resolve("worker-release"), "cleanup");
                    }
                },
                () -> {
                    if (harness != null) {
                        harness.descendants().forEach(ProcessHandle::destroyForcibly);
                        harness.destroyForcibly();
                        harness.waitFor(10, TimeUnit.SECONDS);
                    }
                },
                () -> {
                    if (poolSuccessor != null) {
                        poolSuccessor.descendants().forEach(ProcessHandle::destroyForcibly);
                        poolSuccessor.destroyForcibly();
                        assertThat(poolSuccessor.waitFor(10, TimeUnit.SECONDS)).isTrue();
                    }
                },
                () -> { if (shellProbe != null) {
                    shellProbe.close();
                } },
                () -> { if (spring != null) {
                    spring.close();
                } },
                () -> { if (storeRelay != null) {
                    storeRelay.stop(0);
                } },
                () -> { if (relayExecutor != null) {
                    relayExecutor.close();
                } },
                () -> { if (durableClose || definitionApproval || personalMemory) {
                    HostedDurableWorkers.stop(temporary.resolve("broker"), json);
                } },
                () -> { if (hookRoot != null) {
                    Files.writeString(hookRoot.resolve("cgroup.kill"), "1");
                    try (var entries = Files.walk(hookRoot)) {
                        for (Path entry : entries.filter(Files::isDirectory).sorted(Comparator.reverseOrder()).toList()) {
                            Files.delete(entry);
                        }
                    }
                } },
                () -> { if (model != null) {
                    model.stop(0);
                } },
                () -> { if (parkingDatabase != null) {
                    parkingDatabase.close();
                } },
                () -> { if (poolDatabase != null) {
                    poolDatabase.close();
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
