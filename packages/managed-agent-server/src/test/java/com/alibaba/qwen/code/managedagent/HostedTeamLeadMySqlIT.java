package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.awaitility.core.ConditionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.AfterTestExecutionCallback;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.net.BindException;
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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * H4e-b1: the lead-side team runtime end to end. A real Spring server on
 * MySQL drives the packaged Hosted Harness through its own HarnessConnector,
 * with the embedded Runtime Broker and the child result relay; only the
 * model is scripted. The lead is created through the store and moved to
 * the Shell profile in the same transaction, because no public route
 * creates a Shell-laned Session; everything after that goes through the
 * public Session, Action and operation routes.
 */
class HostedTeamLeadMySqlIT {
    private static final String TOKEN = "h4eb1-fixture";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final List<String> TEAM_TOOLS =
            List.of("team_create", "team_delete", "task_create", "task_update", "task_list");
    private static final Pattern LEAD = Pattern.compile("H4EB1_LEAD_([A-Z]+)");
    private static final Pattern MEMBER = Pattern.compile("H4EB1_MEMBER_([a-z]+)_(WAIT|HOLD|DONE)");
    private static final Pattern TEAMMATE = Pattern.compile("<teammate>([^<]+)</teammate>");

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final String tenant = "h4eb1-" + UUID.randomUUID();
    private final List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    // WAIT replies after release; HOLD ends after cancellation without replying.
    private final Map<String, CountDownLatch> releases = new ConcurrentHashMap<>();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private HttpServer model;
    private ExecutorService modelThreads;
    private volatile String leadSession;
    // The team_state revision the lead saw when its first team_delete was refused.
    private volatile long revisionAtRefusal = -1;
    private Process harness;
    private volatile JdbcTemplate jdbc;
    private int port;
    private boolean approvals;

    // Wake Turns leave no ma_turn row, so the Harness log is the
    // only place a failed one shows; CI keeps a failed case's output.
    @RegisterExtension
    final AfterTestExecutionCallback harnessLogOnFailure = context -> {
        Path log = temporary == null ? null : temporary.resolve("harness.log");
        if (context.getExecutionException().isPresent() && log != null && Files.exists(log)) {
            String text = Files.readString(log);
            System.out.println("--- harness.log (tail) ---\n" + text.substring(Math.max(0, text.length() - 20_000)));
        }
    };

    /**
     * A lead creates a team, launches two named members, keeps a board,
     * reads the roster, is refused team_delete while the members run, takes
     * both labeled reports, completes the tasks (one owner kept, one set
     * only once its member finished) and deletes the team.
     */
    @Test
    @Timeout(80)
    void leadRunsATeamThroughTwoNamedMembers() throws Exception {
        boot();
        releases.put("alice", new CountDownLatch(1));
        releases.put("bob", new CountDownLatch(1));
        String lead = createLead("H4EB1_LEAD_LIFECYCLE");
        assertLeadDeclaresTeamTools("H4EB1_LEAD_LIFECYCLE", lead);
        // The model reads the final delete's answer once the Harness has
        // committed it, after the team_state revision lands.
        waiting().atMost(Duration.ofSeconds(60)).pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
            assertNoModelFailure();
            assertNoFailedTurn(lead);
            assertNoFailedChild(lead);
            assertThat(toolAnswerOrNull("lead-delete-final")).isNotNull();
        });
        assertThat(team(lead).path("lifecycle").asText()).isEqualTo("deleted");

        for (String member : List.of("alice", "bob")) {
            List<String> tools = toolNames(requestsOf(
                    "H4EB1_MEMBER_" + member + "_WAIT").get(0));
            // H4e-b3: members now read and write the same board the lead
            // does; the three board verbs ride the lineage lane, while
            // the team-level creational names stay lead-only.
            assertThat(tools).contains("read_file")
                    .containsAll(List.of("task_create", "task_list",
                            "task_update"))
                    .doesNotContain("agent")
                    .doesNotContainAnyElementsOf(
                            List.of("team_create", "team_delete"));
        }
        assertThat(toolAnswer("lead-alice")).contains("It joined team \"review\" as \"alice\"");
        assertThat(toolAnswer("lead-list-running")).contains("#1 [in_progress] @alice — Audit A")
                .contains("#2 [pending] — Audit B").contains("alice: running").contains("bob: running");
        assertThat(toolAnswer("lead-delete-running")).contains("Team \"review\" still has running members:")
                .contains("alice").contains("bob");
        assertThat(toolAnswer("lead-own-bob-open")).contains("Member \"bob\" has finished. If it already did this task's work");
        assertThat(toolAnswer("lead-list-final")).contains("#1 [completed] @alice — Audit A")
                .contains("#2 [completed] @bob — Audit B").contains("alice: completed").contains("bob: completed");
        assertThat(toolAnswer("lead-delete-final")).contains("Team \"review\" deleted.");
        // Each report arrives as its own input, labeled with its member's name.
        List<String> reports = leadUserMessages("H4EB1_LEAD_LIFECYCLE").stream()
                .filter(text -> !teammates(text).isEmpty()).toList();
        assertThat(reports).hasSize(2);
        for (String report : reports) {
            String mate = teammates(report).iterator().next();
            assertThat(teammates(report)).containsExactly(mate);
            assertThat(report).contains(mate.toUpperCase() + "_REPORT all clean");
        }
        assertThat(reports.stream().flatMap(text -> teammates(text).stream())).containsExactlyInAnyOrder("alice", "bob");

        // The refused delete wrote nothing: the opening and two joins, then
        // the final delete's closing and deleted.
        assertThat(revisionAtRefusal).isEqualTo(3);
        assertThat(revision(lead, "team_state")).isEqualTo(5);
        assertThat(team(lead).path("members")).hasSize(2);
        List<Map<String, Object>> tasks = rows(lead, "team_task");
        assertThat(tasks).hasSize(2);
        assertThat(body(tasks.get(0)).path("owner").asText()).isEqualTo("alice");
        assertThat(body(tasks.get(1)).path("owner").asText()).isEqualTo("bob");
        assertThat(tasks).allSatisfy(row -> assertThat(body(row).path("status").asText()).isEqualTo("completed"));
        // Task #1: opened, assigned, completed. Task #2: opened, then owned
        // as completed; the refused open ownership wrote nothing.
        assertThat(((Number) tasks.get(0).get("revision")).longValue()).isEqualTo(3);
        assertThat(((Number) tasks.get(1).get("revision")).longValue()).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?"
                + " AND parent_session_id = ?", Integer.class, tenant, lead)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record"
                + " WHERE tenant_id = ? AND session_id <> ? AND domain IN ('team_state', 'team_task',"
                + " 'team_message', 'team_plan')", Integer.class, tenant, lead)).isZero();
        closeAndSettle(lead);
    }

    /**
     * Closing the lead cancels its running member through the H4b cascade.
     * The close cancels the member's Turn while its model response is held,
     * leaves the team's records as they were and never revives the lead.
     */
    @Test
    @Timeout(80)
    void leadCloseCancelsItsRunningMember() throws Exception {
        boot();
        releases.put("carol", new CountDownLatch(1));
        String lead = createLead("H4EB1_LEAD_CLOSE");
        assertLeadDeclaresTeamTools("H4EB1_LEAD_CLOSE", lead);
        waiting().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            assertNoModelFailure();
            assertNoFailedTurn(lead);
            assertNoFailedChild(lead);
            assertThat(requestsOf("H4EB1_MEMBER_carol_HOLD")).isNotEmpty();
        });
        awaitIdle(lead);
        String child = jdbc.queryForObject("SELECT session_id FROM ma_session WHERE tenant_id = ?"
                + " AND parent_session_id = ?", String.class, tenant, lead);
        long stateRevision = revision(lead, "team_state");
        int leadRequests = requestsOf("H4EB1_LEAD_CLOSE").size();

        String operation = null;
        try {
            operation = request("POST", "/v1/agents/sessions/" + lead + "/close", null, "close-lead", 202)
                    .path("id").asText();
        } catch (AssertionError failure) {
            // Without workspace execution no close operation can bind, and
            // the cascade this case watches lives behind it — abort there.
            org.junit.jupiter.api.Assumptions.assumeTrue(
                    !String.valueOf(failure.getMessage()).contains("workspace_unavailable"),
                    "workspace execution unavailable under the runtime broker's opt-out");
            throw failure;
        }
        String closeOperation = operation;
        waiting().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(200)).untilAsserted(() ->
                assertThat(body(rows(lead, "child_run").get(0)).path("stopRequested").asBoolean()).isTrue());
        // The close must cancel the in-flight Turn without waiting for the
        // model's held response to finish naturally.
        waiting().atMost(Duration.ofSeconds(45)).pollInterval(Duration.ofMillis(500)).untilAsserted(() -> {
            assertNoModelFailure();
            String status = operationStatus(lead, closeOperation);
            if (List.of("failed", "recovery_blocked").contains(status)) {
                throw new IllegalStateException("The lead's close ended " + status);
            }
            assertThat(status).isEqualTo("completed");
        });
        waiting().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(500)).untilAsserted(() -> {
            JsonNode run = body(rows(lead, "child_run").get(0));
            assertThat(run.at("/run/state").asText()).isEqualTo("cancelled");
            assertThat(run.path("stopReason").asText()).isEqualTo("stop_requested");
            assertThat(sessionStatus(child)).isEqualTo("CLOSED");
        });
        assertThat(childTurnStatus(child)).isEqualTo("CANCELLED");
        assertThat(releases.get("carol").getCount()).as("member response is still held").isEqualTo(1);
        releases.get("carol").countDown();
        assertThat(revision(lead, "team_state")).isEqualTo(stateRevision);
        assertThat(team(lead).path("lifecycle").asText()).isEqualTo("active");
        awaitTenantSettled();
        // Never revived: once the relay has finished with the member, the
        // lead holds no acceptance of its result and made no request since
        // its own Turn ended.
        assertThat(rows(lead, "child_acceptance")).isEmpty();
        assertThat(requestsOf("H4EB1_LEAD_CLOSE")).hasSize(leadRequests);
        assertThat(leadUserMessages("H4EB1_LEAD_CLOSE"))
                .noneMatch(text -> text.contains("CAROL_REPORT") || text.contains("task-notification"));
        assertNoModelFailure();
    }

    /**
     * In default approval mode the team writes and a named launch ask with
     * their input on the card, and task_list runs without asking.
     */
    @Test
    @Timeout(80)
    void teamCallsAskWithTheirInputInDefaultMode() throws Exception {
        approvals = true;
        boot();
        String lead = createLead("H4EB1_LEAD_APPROVAL");
        assertLeadDeclaresTeamTools("H4EB1_LEAD_APPROVAL", lead);
        Set<String> answered = new LinkedHashSet<>();
        List<JsonNode> cards = new ArrayList<>();
        waiting().atMost(Duration.ofSeconds(50)).pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
            assertNoModelFailure();
            assertNoFailedTurn(lead);
            assertNoFailedChild(lead);
            for (JsonNode action : request("GET", "/v1/agents/sessions/" + lead + "/actions", null, null, 200)
                    .path("data")) {
                String id = action.path("id").asText();
                if (answered.contains(id)) {
                    continue;
                }
                // The id is the idempotency key, so a response retried after
                // a failed attempt is the same response.
                request("POST", "/v1/agents/sessions/" + lead + "/actions/" + id + "/responses", Map.of(
                        "kind", "permission", "option_id", "allow",
                        "input_revision", action.path("input_revision").asLong(),
                        "policy_revision", action.path("policy_revision").asText()), id, 202);
                answered.add(id);
                cards.add(action);
            }
            assertThat(toolAnswerOrNull("appr-agent")).isNotNull();
            // The member's report has reached the lead.
            assertThat(leadUserMessages("H4EB1_LEAD_APPROVAL")).anyMatch(text -> text.contains("DANA_REPORT"));
        });
        // One card per asking tool, each previewing its own input; task_list asks nothing.
        Map<String, String> previews = new LinkedHashMap<>();
        for (JsonNode card : cards) {
            previews.put(card.path("tool_name").asText(), card.at("/input_preview/text").asText());
        }
        assertThat(cards).hasSize(4);
        assertThat(previews).containsOnlyKeys("team_create", "task_create", "task_update", "agent");
        assertThat(previews.get("team_create")).contains("\"team_name\":\"review\"");
        assertThat(previews.get("task_create")).contains("\"subject\":\"Audit the auth module\"");
        assertThat(previews.get("task_update")).contains("\"owner\":\"leader\"").contains("\"status\":\"in_progress\"");
        assertThat(previews.get("agent")).contains("\"name\":\"dana\"");
        assertThat(toolAnswer("appr-list")).contains("No active team");
        assertThat(toolAnswer("appr-agent")).contains("It joined team \"review\" as \"dana\"");
        closeAndSettle(lead);
    }

    // ------------------------------------------------------------ the model

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode body = json.readTree(exchange.getRequestBody());
            modelRequests.add(body);
            String first = firstUserText(body);
            Matcher member = MEMBER.matcher(first);
            if (member.find()) {
                String name = member.group(1);
                if (!member.group(2).equals("DONE")
                        && !releases.computeIfAbsent(name, key -> new CountDownLatch(1)).await(80, TimeUnit.SECONDS)) {
                    throw new AssertionError("Member " + name + " was never released");
                }
                if (!member.group(2).equals("HOLD")) {
                    reply(exchange, List.of(), name.toUpperCase() + "_REPORT all clean");
                }
                return;
            }
            Matcher lead = LEAD.matcher(first);
            if (!lead.find()) {
                throw new AssertionError("Unknown model request: " + first);
            }
            Step step = leadStep(lead.group(1), body);
            reply(exchange, step.calls(), step.text());
        } catch (Exception | AssertionError failure) {
            modelFailure.compareAndSet(null, failure);
            try {
                reply(exchange, List.of(), "MODEL_FIXTURE_FAILURE");
            } catch (Exception ignored) {
                // the request may already be gone
            }
        } finally {
            exchange.close();
        }
    }

    private record Step(List<Map<String, Object>> calls, String text) {
        @SafeVarargs
        static Step calls(Map<String, Object>... calls) {
            return new Step(List.of(calls), null);
        }

        static Step text(String text) {
            return new Step(List.of(), text);
        }
    }

    private static Map<String, Object> call(String id, String name, Map<String, Object> args) {
        return Map.of("id", id, "name", name, "args", args);
    }

    /** The lead's next move, from the tool results of its current Turn. */
    private Step leadStep(String kind, JsonNode body) {
        List<JsonNode> messages = new ArrayList<>();
        body.path("messages").forEach(messages::add);
        // The current Turn starts after the last assistant reply that called no tool.
        int start = 0;
        for (int index = 0; index < messages.size(); index++) {
            JsonNode message = messages.get(index);
            if ("assistant".equals(message.path("role").asText())
                    && (message.path("tool_calls").isMissingNode() || message.path("tool_calls").isEmpty())) {
                start = index + 1;
            }
        }
        List<JsonNode> turn = messages.subList(start, messages.size());
        long results = turn.stream().filter(message -> "tool".equals(message.path("role").asText())).count();
        Set<String> reportedNow = new LinkedHashSet<>();
        Set<String> reportedEver = new LinkedHashSet<>();
        for (int index = 0; index < messages.size(); index++) {
            JsonNode message = messages.get(index);
            if (!"user".equals(message.path("role").asText())) {
                continue;
            }
            Set<String> names = teammates(message.toString());
            reportedEver.addAll(names);
            if (index >= start) {
                reportedNow.addAll(names);
            }
        }
        boolean wake = turn.stream().anyMatch(message -> "user".equals(message.path("role").asText())
                && message.toString().contains("task-notification"));
        // Every report here is a member's, so a wake without a label is a
        // lost label, not a plan to wait out.
        if (wake && reportedNow.isEmpty()) {
            throw new AssertionError("A member's report arrived without its label");
        }
        List<Step> plan = new ArrayList<>();
        switch (kind) {
            case "LIFECYCLE" -> {
                if (!wake) {
                    plan.add(Step.calls(call("lead-create", "team_create", Map.of("team_name", "review"))));
                    plan.add(Step.calls(
                            call("lead-alice", "agent", Map.of("description", "alice review",
                                    "prompt", "H4EB1_MEMBER_alice_WAIT review part A", "name", "alice")),
                            call("lead-bob", "agent", Map.of("description", "bob review",
                                    "prompt", "H4EB1_MEMBER_bob_WAIT review part B", "name", "bob"))));
                    plan.add(Step.calls(
                            call("lead-task-a", "task_create", Map.of("subject", "Audit A", "description", "part A")),
                            call("lead-task-b", "task_create", Map.of("subject", "Audit B", "description", "part B"))));
                    plan.add(Step.calls(call("lead-assign-a", "task_update",
                            Map.of("taskId", "1", "owner", "alice", "status", "in_progress"))));
                    plan.add(Step.calls(call("lead-list-running", "task_list", Map.of())));
                    plan.add(Step.calls(call("lead-delete-running", "team_delete", Map.of())));
                } else {
                    for (String mate : reportedNow) {
                        if (mate.equals("alice")) {
                            // The owner it already has stays when its task completes.
                            plan.add(Step.calls(call("lead-done-alice", "task_update",
                                    Map.of("taskId", "1", "status", "completed"))));
                        } else {
                            // A member that finished, and was given no work in this
                            // turn, may own its task only as completed (H4e-b2).
                            plan.add(Step.calls(call("lead-own-bob-open", "task_update",
                                    Map.of("taskId", "2", "owner", "bob", "status", "in_progress"))));
                            plan.add(Step.calls(call("lead-own-bob-done", "task_update",
                                    Map.of("taskId", "2", "owner", "bob", "status", "completed"))));
                        }
                    }
                    if (reportedEver.containsAll(List.of("alice", "bob"))) {
                        plan.add(Step.calls(call("lead-list-final", "task_list", Map.of())));
                        plan.add(Step.calls(call("lead-delete-final", "team_delete", Map.of())));
                    }
                }
            }
            case "CLOSE" -> {
                if (!wake) {
                    plan.add(Step.calls(call("close-create", "team_create", Map.of("team_name", "review"))));
                    plan.add(Step.calls(call("close-carol", "agent", Map.of("description", "carol review",
                            "prompt", "H4EB1_MEMBER_carol_HOLD long review", "name", "carol"))));
                }
            }
            case "APPROVAL" -> {
                if (!wake) {
                    plan.add(Step.calls(call("appr-list", "task_list", Map.of())));
                    plan.add(Step.calls(call("appr-create", "team_create", Map.of("team_name", "review"))));
                    plan.add(Step.calls(call("appr-task", "task_create",
                            Map.of("subject", "Audit the auth module", "description", "full audit"))));
                    plan.add(Step.calls(call("appr-update", "task_update",
                            Map.of("taskId", "1", "owner", "leader", "status", "in_progress"))));
                    plan.add(Step.calls(call("appr-agent", "agent", Map.of("description", "dana review",
                            "prompt", "H4EB1_MEMBER_dana_DONE quick review", "name", "dana"))));
                }
            }
            default -> throw new AssertionError("Unknown lead scenario " + kind);
        }
        long seen = 0;
        for (Step step : plan) {
            if (results == seen) {
                return step;
            }
            seen += step.calls().size();
        }
        if (kind.equals("LIFECYCLE") && !wake) {
            // The first Turn's last call was the refused team_delete.
            revisionAtRefusal = revision(leadSession, "team_state");
            releases.get("alice").countDown();
            releases.get("bob").countDown();
        }
        return Step.text("LEAD_" + kind + (wake ? "_WAKE" : "") + "_DONE");
    }

    private void reply(HttpExchange exchange, List<Map<String, Object>> calls, String text) throws IOException {
        ObjectNode chunk = json.createObjectNode().put("id", "h4eb1").put("object", "chat.completion.chunk")
                .put("created", 0).put("model", "h4eb1-fixture");
        ObjectNode choice = chunk.putArray("choices").addObject().put("index", 0);
        ObjectNode delta = choice.putObject("delta").put("role", "assistant");
        if (calls.isEmpty()) {
            delta.put("content", text);
        } else {
            ArrayNode toolCalls = delta.putArray("tool_calls");
            for (int index = 0; index < calls.size(); index++) {
                Map<String, Object> call = calls.get(index);
                toolCalls.addObject().put("index", index).put("id", call.get("id").toString()).put("type", "function")
                        .putObject("function").put("name", call.get("name").toString())
                        .put("arguments", json.writeValueAsString(call.get("args")));
            }
        }
        choice.putNull("finish_reason");
        String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
        choice.putObject("delta");
        choice.put("finish_reason", calls.isEmpty() ? "stop" : "tool_calls");
        byte[] response = (first + "data: " + json.writeValueAsString(chunk) + "\n\ndata: [DONE]\n\n")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, response.length);
        exchange.getResponseBody().write(response);
    }

    // ------------------------------------------------------------- queries

    private static Set<String> teammates(String text) {
        Set<String> names = new LinkedHashSet<>();
        Matcher matcher = TEAMMATE.matcher(text.replace("\\u003c", "<").replace("\\u003e", ">"));
        while (matcher.find()) {
            names.add(matcher.group(1));
        }
        return names;
    }

    private static String firstUserText(JsonNode body) {
        for (JsonNode message : body.path("messages")) {
            if (!"user".equals(message.path("role").asText())) {
                continue;
            }
            String text = message.path("content").isTextual() ? message.path("content").asText()
                    : message.path("content").toString();
            if (text.contains("H4EB1_")) {
                return text;
            }
        }
        return "";
    }

    private List<JsonNode> requestsOf(String marker) {
        return modelRequests.stream().filter(body -> firstUserText(body).contains(marker)).toList();
    }

    private static List<String> toolNames(JsonNode body) {
        List<String> names = new ArrayList<>();
        body.path("tools").forEach(tool -> names.add(tool.path("function").path("name").asText()));
        return names;
    }

    private static List<String> agentProperties(JsonNode body) {
        List<String> names = new ArrayList<>();
        body.path("tools").forEach(tool -> {
            if ("agent".equals(tool.path("function").path("name").asText())) {
                tool.path("function").path("parameters").path("properties").fieldNames().forEachRemaining(names::add);
            }
        });
        return names;
    }

    private List<String> leadUserMessages(String marker) {
        List<JsonNode> requests = requestsOf(marker);
        List<String> texts = new ArrayList<>();
        if (requests.isEmpty()) {
            return texts;
        }
        for (JsonNode message : requests.get(requests.size() - 1).path("messages")) {
            if ("user".equals(message.path("role").asText())) {
                texts.add(message.path("content").toString());
            }
        }
        return texts;
    }

    /** What the model read as the answer to one tool call, in the latest request carrying it. */
    private String toolAnswerOrNull(String callId) {
        for (int index = modelRequests.size() - 1; index >= 0; index--) {
            for (JsonNode message : modelRequests.get(index).path("messages")) {
                if ("tool".equals(message.path("role").asText())
                        && callId.equals(message.path("tool_call_id").asText())) {
                    return plain(message.path("content").toString());
                }
            }
        }
        return null;
    }

    private String toolAnswer(String callId) {
        String answer = toolAnswerOrNull(callId);
        assertThat(answer).as("answer to %s", callId).isNotNull();
        return answer;
    }

    /** A tool answer as plain text, whatever JSON escaping carried it. */
    private static String plain(String text) {
        String out = text;
        for (int pass = 0; pass < 4; pass++) {
            out = out.replace("\\\\", "\\").replace("\\\"", "\"").replace("\\n", "\n");
        }
        return out;
    }

    private List<Map<String, Object>> rows(String session, String domain) {
        return jdbc.queryForList("SELECT r.record_id, r.revision, CAST(res.inline_bytes AS CHAR) AS body"
                + " FROM ma_session_record r JOIN ma_resource res"
                + " ON res.session_scope_key = r.session_scope_key AND res.resource_id = r.record_resource_id"
                + " WHERE r.tenant_id = ? AND r.session_id = ? AND r.domain = ? ORDER BY r.record_id",
                tenant, session, domain);
    }

    private JsonNode body(Map<String, Object> row) {
        try {
            return json.readTree(row.get("body").toString());
        } catch (IOException failure) {
            throw new AssertionError(failure);
        }
    }

    private JsonNode team(String session) {
        List<Map<String, Object>> rows = rows(session, "team_state");
        return rows.isEmpty() ? null : body(rows.get(0));
    }

    private long revision(String session, String domain) {
        List<Map<String, Object>> rows = rows(session, domain);
        return rows.isEmpty() ? 0 : ((Number) rows.get(0).get("revision")).longValue();
    }

    private String sessionStatus(String session) {
        return jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session);
    }

    private String childTurnStatus(String child) {
        return jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, child);
    }

    private String operationStatus(String session, String operation) throws Exception {
        return request("GET", "/v1/agents/sessions/" + session + "/operations/" + operation, null, null, 200)
                .path("status").asText();
    }

    // Not AssertionErrors: an await retries those until it times out, and
    // a few stalled awaits would outlast the Hosted fork's shared timeout.
    private void assertNoModelFailure() {
        Throwable failure = modelFailure.get();
        if (failure != null) {
            throw new IllegalStateException("The model fixture failed", failure);
        }
    }

    private void assertNoFailedChild(String lead) {
        for (Map<String, Object> row : rows(lead, "child_run")) {
            JsonNode run = body(row);
            if ("failed".equals(run.at("/run/state").asText())) {
                throw new IllegalStateException("A member failed: " + run);
            }
        }
    }

    private void assertNoFailedTurn(String session) {
        List<Map<String, Object>> failed = jdbc.queryForList("SELECT turn_id, error_code FROM ma_turn"
                + " WHERE tenant_id = ? AND session_id = ? AND status = 'FAILED'", tenant, session);
        if (!failed.isEmpty()) {
            throw new IllegalStateException("Turns failed: " + failed);
        }
    }

    /** The lead's first request must declare the team tools; nothing later can pass without them. */
    private void assertLeadDeclaresTeamTools(String marker, String lead) {
        waiting().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(200)).untilAsserted(() -> {
            assertNoModelFailure();
            assertNoFailedTurn(lead);
            assertThat(requestsOf(marker)).isNotEmpty();
        });
        JsonNode first = requestsOf(marker).get(0);
        assertThat(toolNames(first)).containsAll(TEAM_TOOLS).contains("agent");
        assertThat(agentProperties(first)).contains("name");
    }

    // ------------------------------------------------------------ the stack

    private String createLead(String marker) throws Exception {
        TransactionTemplate transaction = new TransactionTemplate(spring.getBean(PlatformTransactionManager.class));
        ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
        String session = transaction.execute(status -> store.insertInternalTeamLeadSessionCommand(
                tenant, "actor", "create-" + marker, DIGEST, null,
                new WorkspaceSelection("workspace-0", "child")).sessionId());
        leadSession = session;
        waiting().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofSeconds(1)).ignoreExceptions().untilAsserted(() ->
                request("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type",
                        "agent.session.input.message", "input", List.of(Map.of("type", "input_text", "text", marker))),
                        "input-" + marker, 202));
        return session;
    }

    /** The Session's API Turns have ended; wake Turns leave no row to wait on. */
    private void awaitIdle(String session) {
        waiting().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
            assertNoModelFailure();
            assertNoFailedTurn(session);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ?"
                    + " AND session_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')",
                    Integer.class, tenant, session)).isZero();
        });
    }

    /**
     * Closes the lead and waits until the tenant owes no operation and no
     * child result: the relay and the operation recovery scan every tenant,
     * so work left behind would be picked up by the next Spring context.
     * A workspace Session's close operation needs the runtime broker's
     * workspace execution, unavailable under this fixture's opt-out —
     * tolerate the 202 only when it binds an operation to wait on.
     */
    private void closeAndSettle(String lead) throws Exception {
        String operation = null;
        try {
            operation = request("POST", "/v1/agents/sessions/" + lead + "/close", null, "close-" + lead, 202)
                    .path("id").asText();
        } catch (AssertionError failure) {
            if (!String.valueOf(failure.getMessage()).contains("workspace_unavailable")) {
                throw failure;
            }
        }
        if (operation != null) {
            String op = operation;
            waiting().atMost(Duration.ofSeconds(20)).pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                    assertThat(operationStatus(lead, op)).isEqualTo("completed"));
        }
        awaitTenantSettled();
    }

    private void awaitTenantSettled() {
        waiting().atMost(Duration.ofSeconds(20)).pollInterval(Duration.ofMillis(500)).untilAsserted(() -> {
            assertThat(jdbc.queryForList("SELECT operation_kind, state, delivery_state FROM ma_operation"
                    + " WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE', 'ACTION_RESPONSE', 'TASK_CANCEL') AND tenant_id = ? AND delivery_state IN ('PENDING', 'LEASED', 'BLOCKED')", tenant)).isEmpty();
            assertThat(jdbc.queryForList("SELECT operation_id AS child_run_id, state FROM ma_operation WHERE operation_kind IN ('CHILD_SESSION_START', 'CHILD_SESSION_CLOSE')"
                    + " AND tenant_id = ? AND state NOT IN ('done', 'orphaned', 'unknown', 'close_debt')",
                    tenant)).isEmpty();
            // A child run the relay has not yet picked up has no ledger row.
            assertThat(jdbc.queryForList("SELECT r.record_id FROM ma_session_record r"
                    + " LEFT JOIN ma_operation l ON l.session_id = r.session_id AND l.tenant_id = r.tenant_id"
                    + " AND l.operation_kind = 'CHILD_SESSION_START' AND l.operation_id = r.record_id WHERE r.tenant_id = ? AND r.domain = 'child_run'"
                    + " AND r.delivery_state IN ('planned', 'accepting', 'unknown') AND l.state IS NULL", tenant))
                    .isEmpty();
            assertThat(jdbc.queryForList("SELECT session_id, status FROM ma_turn WHERE tenant_id = ?"
                    + " AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')", tenant)).isEmpty();
        });
    }

    /**
     * Every wait goes through here: Awaitility ignores the interrupt a
     * case's @Timeout sends, so without this a stalled case would run on to
     * the sum of its waits instead of stopping at its ceiling.
     */
    private static ConditionFactory waiting() {
        return await().failFast("The case's @Timeout interrupted it", () -> Thread.currentThread().isInterrupted());
    }

    private void boot() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the CLI first").isRegularFile();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        assertThat(System.getProperty("mysql.url")).as("Pass -Dmysql.url for a disposable MySQL schema").isNotBlank();
        temporary = temporary.toRealPath();
        Path decoy = Files.createDirectory(temporary.resolve("harness-decoy"));
        // The production default: durable local-process mode, owner-private.
        Files.createDirectory(temporary.resolve("broker"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Path workspace = Files.createDirectory(temporary.resolve("workspace-a"));
        Files.createDirectory(workspace.resolve("child"));
        // Keep initialized-root mtime distinct from birth time without relying on sleeps.
        Files.setLastModifiedTime(workspace, FileTime.fromMillis(1));
        int harnessPort = freePort();
        int brokerPort = freePort();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        // Held member replies must not block the lead's requests.
        modelThreads = Executors.newCachedThreadPool();
        model.setExecutor(modelThreads);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        // freePort() lets the port go before the Spring server and the embedded
        // broker bind to it, and a contended CI runner can hand the port out
        // again in that gap: boot with fresh ports when the bind loses the race.
        for (int attempt = 0; ; attempt++) {
            port = freePort();
            try {
                startSpring(cli, node, decoy, workspace, harnessPort, brokerPort);
                break;
            } catch (RuntimeException error) {
                if (attempt >= 2 || !bindConflict(error)) {
                    throw error;
                }
                harnessPort = freePort();
                brokerPort = freePort();
            }
        }
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'workspace-0', 1,"
                + " 'storage-0', 'H4e-b1', ?, ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, 'workspace-0', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        startHarness(cli, node, decoy, harnessPort, brokerPort);
    }

    private void startSpring(Path cli, String node, Path decoy, Path workspace, int harnessPort, int brokerPort) {
        List<String> arguments = new ArrayList<>(List.of("--server.address=127.0.0.1", "--server.port=" + port,
                "--spring.datasource.url=" + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getProperty("mysql.user"),
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
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + decoy,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("broker"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=h4eb1-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage-0",
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + workspace));
        if (approvals) {
            arguments.add("--qwen.managed-agent.harness.approval-mode=default");
        }
        arguments.add("--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled="
                + "Linux".equals(System.getProperty("os.name")));
        // The broker's durable local-process mode only exists on Linux;
        // elsewhere it must be opted out, which starts the broker without
        // workspace execution (workspace closes then keep answering the
        // tolerated 409). Linux CI keeps the mode and its workspace.
        if (!System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("linux")) {
            arguments.add("--qwen.managed-agent.runtime-broker.durable-local-process=false");
        }
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .initializers(context -> context.getBeanFactory().registerSingleton("h4eb1Authentication",
                        authentication()))
        .run(arguments.toArray(String[]::new));
        jdbc = spring.getBean(JdbcTemplate.class);
        if ("Linux".equals(System.getProperty("os.name"))) {
            spring.getBean(com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard.class)
                    .register(tenant, "storage-0", UUID.randomUUID().toString());
        }
    }

    private void startHarness(Path cli, String node, Path decoy, int harnessPort, int brokerPort) throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home"));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
        Files.writeString(config.resolve("settings.json"), json.writeValueAsString(Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")), "model", Map.of("name", "h4eb1-fixture"),
                "telemetry", Map.of("enabled", false), "modelProviders", Map.of("openai", List.of(Map.of(
                        "id", "h4eb1-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl))))));
        Path log = temporary.resolve("harness.log");
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge", "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web", "--workspace", decoy.toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:" + brokerPort,
                "--managed-runtime-broker-token", TOKEN)
                .directory(decoy.toFile()).redirectErrorStream(true).redirectOutput(log.toFile());
        Map<String, String> environment = builder.environment();
        environment.clear();
        if (System.getenv("PATH") != null) {
            environment.put("PATH", System.getenv("PATH"));
        }
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE", home.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString(), "OPENAI_API_KEY", "fake-local-key",
                "OPENAI_BASE_URL", modelUrl, "QWEN_SERVER_TOKEN", TOKEN, "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            environment.put(name, temporary.resolve(name + ".json").toString());
        }
        harness = builder.start();
        waiting().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            if (!harness.isAlive()) {
                throw new IllegalStateException("Hosted Harness exited: " + Files.readString(log));
            }
            int status;
            try {
                status = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + harnessPort
                        + "/capabilities")).timeout(Duration.ofSeconds(2)).header("Authorization", "Bearer " + TOKEN)
                        .build(), HttpResponse.BodyHandlers.discarding()).statusCode();
            } catch (IOException notListening) {
                status = -1;
            }
            assertThat(status).isEqualTo(200);
        });
    }

    private FilterRegistrationBean<Filter> authentication() {
        FilterRegistrationBean<Filter> filter = new FilterRegistrationBean<>((request, response, chain) ->
                chain.doFilter(new HttpServletRequestWrapper((HttpServletRequest) request) {
                    @Override
                    public Principal getUserPrincipal() {
                        String actor = getHeader("X-H4eb1-Fixture-Actor");
                        return actor == null ? null : new AuthenticatedTenantActor() {
                            public String tenantId() { return tenant; }
                            public String actorId() { return actor; }
                            public String getName() { return actor; }
                        };
                    }
                }, response));
        filter.setOrder(Ordered.HIGHEST_PRECEDENCE);
        filter.setAsyncSupported(true);
        filter.addUrlPatterns("/v1/agents/*");
        return filter;
    }

    private JsonNode request(String method, String path, Object body, String key, int expected) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(15)).header("X-Qwen-Tenant-Id", tenant)
                .header("Accept", "application/json").header("Content-Type", "application/json")
                .header("X-H4eb1-Fixture-Actor", "actor")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        var response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("%s %s: %s", method, path, response.body()).isEqualTo(expected);
        return json.readTree(response.body());
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static boolean bindConflict(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof BindException
                    || String.valueOf(cause.getMessage()).contains("Address already in use")) {
                return true;
            }
        }
        return false;
    }

    @AfterEach
    void stop() throws Exception {
        releases.values().forEach(CountDownLatch::countDown);
        try {
            if (harness != null) {
                harness.descendants().forEach(ProcessHandle::destroyForcibly);
                harness.destroyForcibly();
                harness.waitFor(10, TimeUnit.SECONDS);
            }
        } finally {
            try {
                if (jdbc != null) {
                    // A failed case leaves its tenant's work owed, and the
                    // next Spring context in the fork scans every tenant;
                    // end that work here (a settled case matches nothing).
                    jdbc.update("UPDATE ma_operation SET delivery_state = 'CONFIRMED' WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE', 'ACTION_RESPONSE', 'TASK_CANCEL') AND tenant_id = ?"
                            + " AND delivery_state IN ('PENDING', 'LEASED', 'BLOCKED')", tenant);
                    jdbc.update("UPDATE ma_operation SET state = 'orphaned' WHERE operation_kind IN ('CHILD_SESSION_START', 'CHILD_SESSION_CLOSE') AND tenant_id = ?"
                            + " AND state NOT IN ('done', 'orphaned', 'unknown')", tenant);
                    jdbc.update("UPDATE ma_turn SET status = 'FAILED' WHERE tenant_id = ?"
                            + " AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')", tenant);
                }
            } finally {
                try {
                    if (spring != null) {
                        spring.close();
                    }
                } finally {
                    try {
                        // Each Session's Broker worker is durable and outlives Spring.
                        HostedDurableWorkers.stop(temporary.resolve("broker"), json);
                    } finally {
                        if (model != null) {
                            model.stop(0);
                        }
                        if (modelThreads != null) {
                            modelThreads.shutdownNow();
                        }
                        http.close();
                    }
                }
            }
        }
    }
}
