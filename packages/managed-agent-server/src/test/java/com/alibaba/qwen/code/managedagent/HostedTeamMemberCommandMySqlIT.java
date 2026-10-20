/**
 * Copyright 2026 Alibaba Group
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
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
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * H4e-b3: the member board commands end to end. A real Spring server on
 * MySQL drives the packaged Hosted Harness through its own
 * HarnessConnector, with the embedded Runtime Broker behind the relay's
 * command pass; only the model is scripted. The lead creates a team and
 * launches two named members. Each member's scripted answers carry the
 * board tools as commands, so each member writes the board and then
 * reads it back through the relay (`planned` on the member, a H4e-b3
 * receipt on the lead, `accepted` and `consumed` back on the member);
 * the lead's own board read shows both writes. One after another:
 * alice's in-progress auto-claim and bob's plain create. A third member
 * commits a command and parks, her Harness dies, the new worker wakes
 * her wait, and the relay's answer after that lands her report anyway.
 */
class HostedTeamMemberCommandMySqlIT {
    private static final String TOKEN = "h4eb3-fixture";
    private static final String DIGEST = "sha256:" + "b".repeat(64);
    private static final Pattern MEMBER = Pattern.compile(
            "H4EB3_CMD_MEMBER_([a-z]+)_([A-Z]+)");
    private static final Pattern TEAMMATE = Pattern.compile(
            "<teammate>([^<]+)</teammate>");

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final String tenant = "h4eb3-" + UUID.randomUUID();
    private final AtomicReference<Throwable> modelFailure =
            new AtomicReference<>();
    // Member reports seen by the scripted lead across her wake turns. A
    // wake turn's request names only the report that woke it — the tags
    // never accumulate across turns, so the record of "every report has
    // arrived" is a cross-request accumulation, not a per-request parse.
    private final Set<String> seenReports = new CopyOnWriteArraySet<>();
    private final AtomicBoolean bobLaunched = new AtomicBoolean();
    private final AtomicBoolean boardReadFired = new AtomicBoolean();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private HttpServer model;
    private ExecutorService modelThreads;
    private volatile String leadSession;
    private volatile Process harness;
    private volatile JdbcTemplate jdbc;
    private int harnessPort;
    private int brokerPort;
    private int port;

    @RegisterExtension
    final AfterTestExecutionCallback harnessLogOnFailure = context -> {
        Path log = temporary.resolve("harness.log");
        if (context.getExecutionException().isPresent()
                && Files.exists(log)) {
            String text = Files.readString(log);
            System.out.println("--- harness.log (tail) ---\n"
                    + text.substring(Math.max(0, text.length() - 20_000)));
        }
    };

    @AfterEach
    void tearDown() throws Exception {
        if (harness != null) {
            harness.destroy();
            harness.waitFor(20, TimeUnit.SECONDS);
        }
        if (spring != null) {
            spring.close();
        }
        if (model != null) {
            model.stop(0);
        }
        if (modelThreads != null) {
            modelThreads.shutdownNow();
        }
    }

    /**
     * Two members write the board with member commands and read it back:
     * alice's task opens pending and turns in-progress with her as its
     * owner when she claims it, bob's second task stays pending; the
     * lead's own board read shows both. The members' outbox entries all
     * settle consumed on their journals, and the lead never sees a
     * session_command it did not receipt.
     */
    @Test
    // Kept below the ~295 s its waits add up to: every Hosted*IT class
    // runs in one failsafe fork, and this class's ceilings together must
    // leave that fork its budget (scripts/tests/hosted-process-ci.test.js).
    // A case cut here still reports the wait it was in: every Awaitility
    // wait goes through waiting(), which fails on the @Timeout's
    // interrupt, and the raw waits left (Process.waitFor, the relay
    // hold's latch, HttpClient.send) throw on that interrupt too.
    @Timeout(240)
    void membersReadAndWriteTheBoardTheirLeadReads() throws Exception {
        boot();
        String lead = createLead("H4EB3_CMD_LIFECYCLE");
        waiting().atMost(Duration.ofSeconds(180))
                .pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertNoFailedTurn(lead);
                    assertNoFailedChild(lead);
                    assertThat(seenReports)
                            .containsAll(List.of("alice", "bob"));
                });

        List<Map<String, Object>> board = rows(lead, "team_task");
        assertThat(board).hasSize(2);
        JsonNode aliceTask = board.stream()
                .filter(row -> "Audit one".equals(
                        body(row).path("subject").asText()))
                .findFirst().map(this::body).orElse(null);
        JsonNode bobTask = board.stream()
                .filter(row -> "Doc sync".equals(
                        body(row).path("subject").asText()))
                .findFirst().map(this::body).orElse(null);
        assertThat(aliceTask).isNotNull();
        assertThat(aliceTask.path("status").asText())
                .isEqualTo("in_progress");
        assertThat(aliceTask.path("owner").asText()).isEqualTo("alice");
        assertThat(bobTask).isNotNull();
        assertThat(bobTask.path("status").asText()).isEqualTo("pending");
        assertThat(bobTask.path("owner").asText()).isEqualTo("null");

        // Every member's command did the full pass: handover → execute →
        // answered → consumed, never left pending.
        int stalled = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_session_record"
                        + " WHERE tenant_id = ? AND domain = 'session_command'"
                        + " AND delivery_state IN ('planned', 'accepting')",
                Integer.class, tenant);
        assertThat(stalled).isZero();
        closeAndSettle(lead);
    }

    /**
     * carol commits her command and parks; the Harness dies while her
     * command is still planned, the new worker takes her Session over and
     * resumes the parked wait, the relay hands the command over and
     * executes it, and her report still lands — the relay's answer never
     * asked the dead process anything. The relay is held from the start,
     * so the kill always lands mid-wait (without the hold carol finishes
     * long before the lead's Turn settles, and the restart interrupts
     * nothing), and it is released only after a new writer generation
     * holds her Session, so the reply folds into the wait the dead
     * generation parked.
     */
    @Test
    // Kept below the ~465 s its waits add up to, for the fork budget
    // described on the board case.
    @Timeout(180)
    void memberHarnessRestartDuringCommandWait() throws Exception {
        boot();
        CountDownLatch releaseRelay = holdMessageRelay();
        try {
            String lead = createLead("H4EB3_CMD_RESTART");
            // The lead's own Turn must have settled before the kill: a
            // Harness dying mid-model-round loses that Turn for good (its
            // input re-drives as a fresh one), and a FAILED row would
            // break the acceptance below. carol's command cannot move
            // while the relay is held, so it is still planned.
            waiting().atMost(Duration.ofSeconds(60))
                    .pollInterval(Duration.ofMillis(200)).untilAsserted(() -> {
                        assertNoModelFailure();
                        assertNoFailedTurn(lead);
                        assertNoFailedChild(lead);
                        assertThat(openTurns(lead)).isEmpty();
                        assertThat(parkedOnCommand(onlyChildOf(lead))).isTrue();
                        List<JsonNode> commands = commandsOf(lead, "carol");
                        assertThat(commands).hasSize(1);
                        assertThat(commands.get(0).path("run").path("delivery")
                                .path("state").asText()).isEqualTo("planned");
                    });
            String carol = onlyChildOf(lead);
            long parkedGeneration = writerGeneration(carol);

            harness.descendants().forEach(ProcessHandle::destroyForcibly);
            harness.destroyForcibly();
            harness.waitFor(20, TimeUnit.SECONDS);
            startHarness();
            // The relay goes on only once the takeover holds carol's
            // Session: while it is held, nothing but the coordinator's
            // takeover load can fence the dead generation. A relay attach
            // that wins the load race instead gets the takeover's load
            // refused (409 hosted_session_already_attached) and deferred a
            // full backoff step — a separate race this case does not pin.
            waiting().atMost(Duration.ofSeconds(100))
                    .pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                            assertThat(writerGeneration(carol))
                                    .isGreaterThan(parkedGeneration));
            releaseRelay.countDown();

            waiting().atMost(Duration.ofSeconds(110))
                    .pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
                        assertNoModelFailure();
                        assertNoFailedTurn(lead);
                        assertNoFailedChild(lead);
                        // Her report after the dead generation is durable on
                        // the lead's journal: the result was accepted, never
                        // asked of the dead process.
                        assertThat(childResultAccepted(lead)).isTrue();
                        List<JsonNode> commands = commandsOf(lead, "carol");
                        assertThat(commands).hasSize(1);
                        assertThat(commands.get(0).path("run").path("delivery")
                                .path("state").asText()).isEqualTo("consumed");
                    });
            closeAndSettle(lead);
        } finally {
            releaseRelay.countDown();
        }
    }

    /**
     * Holds the session message relay: its scheduler runs one thread, so a
     * task parked on it keeps every scan, and with it every command
     * handover, from running until the latch is released.
     */
    private CountDownLatch holdMessageRelay() throws InterruptedException {
        return SchedulerHold.hold(spring.getBean(
                "messageRelayScheduler", ThreadPoolTaskScheduler.class),
                Duration.ofSeconds(30));
    }

    /** The writer generation of a Session's journal head. */
    private long writerGeneration(String session) {
        Long generation = jdbc.queryForObject(
                "SELECT writer_generation FROM ma_session_head"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session);
        return generation == null ? 0 : generation;
    }

    // ------------------------------------------------------------ scenario plumbing

    private String createLead(String marker) throws Exception {
        TransactionTemplate transaction = new TransactionTemplate(
                spring.getBean(PlatformTransactionManager.class));
        ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
        transaction.execute(status -> {
            // The trusted internal TeamLead lane: no public Shell gate,
            // the internal team-lead profile ships with its own line
            // (#13674's public Shell gate admits only externally created
            // Shell Session lanes).
            var created = store.insertInternalTeamLeadSessionCommand(tenant,
                    "actor", "create-" + marker, DIGEST, null,
                    new WorkspaceSelection("workspace-0", "child"));
            leadSession = created.sessionId();
            return created.sessionId();
        });
        waiting().atMost(Duration.ofSeconds(30))
                .pollInterval(Duration.ofSeconds(1)).ignoreExceptions()
                .untilAsserted(() -> request("POST",
                        "/v1/agents/sessions/" + leadSession + "/events",
                        Map.of("type", "agent.session.input.message",
                                "input",
                                List.of(Map.of("type", "input_text", "text",
                                        marker))),
                        "input-" + marker, 202));
        return leadSession;
    }

    private void closeAndSettle(String lead) throws Exception {
        // A workspace Session's close operation needs the runtime
        // broker's workspace execution, unavailable under this suite's
        // macOS opt-out (durable-local-process=false); Linux CI answers
        // 202 and runs the operation through.
        JsonNode closed = null;
        try {
            closed = request("POST", "/v1/agents/sessions/" + lead
                    + "/close", null, "close-" + lead, 202);
        } catch (AssertionError failure) {
            if (!String.valueOf(failure.getMessage())
                    .contains("workspace_unavailable")) {
                throw failure;
            }
        }
        if (closed != null) {
            String operation = closed.path("id").asText();
            waiting().atMost(Duration.ofSeconds(20))
                    .pollInterval(Duration.ofMillis(500))
                    .untilAsserted(() ->
                            assertThat(operationStatus(lead, operation))
                                    .isEqualTo("completed"));
        }
        waiting().atMost(Duration.ofSeconds(20))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() -> {
                    assertThat(jdbc.queryForList(
                            "SELECT operation_kind, state, delivery_state FROM"
                                    + " ma_operation WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'CWD_CHANGE', 'ACTION_RESPONSE', 'TASK_CANCEL') AND tenant_id"
                                    + " = ? AND delivery_state IN ('PENDING',"
                                    + " 'LEASED', 'BLOCKED')", tenant))
                            .isEmpty();
                    // close_debt means the member's result was delivered
                    // and only her Workspace close is owed — the only
                    // terminal shape that path can take anywhere this
                    // fixture's runtime broker keeps workspace execution
                    // off, macOS and CI alike.
                    assertThat(jdbc.queryForList(
                            "SELECT operation_id AS child_run_id, state FROM"
                                    + " ma_operation WHERE operation_kind IN ('CHILD_SESSION_START', 'CHILD_SESSION_CLOSE') AND"
                                    + " tenant_id = ? AND state NOT IN"
                                    + " ('done','orphaned','unknown',"
                                    + " 'close_debt')", tenant)).isEmpty();
                    assertThat(jdbc.queryForList(
                            "SELECT session_id, status FROM ma_turn"
                                    + " WHERE tenant_id = ? AND status NOT IN"
                                    + " ('COMPLETED', 'FAILED', 'CANCELLED')",
                            tenant)).isEmpty();
                });
    }

    // ------------------------------------------------------------ the model

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode body = json.readTree(exchange.getRequestBody());
            String first = firstUserText(body);
            Matcher member = MEMBER.matcher(first);
            if (member.find()) {
                String name = member.group(1);
                reply(exchange, memberPlan(name, body));
                return;
            }
            if (first.contains("H4EB3_CMD_LIFECYCLE")) {
                reply(exchange, leadPlan("LIFECYCLE", body));
                return;
            }
            if (first.contains("H4EB3_CMD_RESTART")) {
                reply(exchange, leadPlan("RESTART", body));
                return;
            }
            throw new AssertionError("Unknown model request: " + first);
        } catch (Exception | AssertionError failure) {
            modelFailure.compareAndSet(null, failure);
            try {
                // Never synthesize a tool call on the way out: a fixture
                // failure ends the Turn quietly while the latch reports it.
                reply(exchange, List.of());
            } catch (Exception ignored) {
            }
        } finally {
            exchange.close();
        }
    }

    /**
     * The lead's next move: create the team, launch the members as their
     * rule says (a member launch beside a team create is its batch
     * refusal), read the board once every report has arrived, then end.
     * bob launches only after alice's own report has landed: a wake that
     * arrives beside a busy Turn rides its followUp and settles tagged
     * but unrendered, so every member wake must find the lead idle for
     * its tag to reach a model request (and the lead-list that reads the
     * board after both).
     */
    private Step leadPlan(String kind, JsonNode body) {
        long rounds = countRoleTool(body);
        seenReports.addAll(reportedIn(body));
        Set<String> reported = new LinkedHashSet<>(seenReports);
        boolean wake = List.of("alice", "bob", "carol").stream()
                .anyMatch(reported::contains);
        if (!wake) {
            if (rounds == 0) {
                return new Step(List.of(call("lead-create", "team_create",
                        Map.of("team_name", "review"))), null);
            }
            if (rounds == 1) {
                return new Step(List.of("LIFECYCLE".equals(kind)
                        ? call("lead-alice", "agent",
                                Map.of("description", "alice review",
                                        "prompt",
                                        "H4EB3_CMD_MEMBER_alice_DONE audit one",
                                        "name", "alice"))
                        : call("lead-carol", "agent",
                                Map.of("description", "carol review",
                                        "prompt",
                                        "H4EB3_CMD_MEMBER_carol_DONE slow audit",
                                        "name", "carol"))), null);
            }
            return new Step(List.of(), null);
        }
        if ("LIFECYCLE".equals(kind)) {
            if (reported.containsAll(List.of("alice", "bob"))
                    && boardReadFired.compareAndSet(false, true)) {
                return new Step(
                        List.of(call("lead-list", "task_list", Map.of())),
                        null);
            }
            if (reported.contains("alice")
                    && bobLaunched.compareAndSet(false, true)) {
                return new Step(List.of(call("lead-bob", "agent",
                        Map.of("description", "bob review", "prompt",
                                "H4EB3_CMD_MEMBER_bob_DONE doc sync",
                                "name", "bob"))), null);
            }
            return new Step(List.of(), null);
        }
        return new Step(List.of(), null);
    }

    /** The member names whose reports have reached the lead in this body. */
    private static Set<String> reportedIn(JsonNode body) {
        Set<String> names = new LinkedHashSet<>();
        for (JsonNode message : body.path("messages")) {
            if (!"user".equals(message.path("role").asText())) {
                continue;
            }
            names.addAll(teammates(message.toString()));
        }
        return names;
    }

    /**
     * A member's Turn plan: first its board calls, then its report text.
     * Alice claims the task her own create minted — her create's reply is
     * read for its number, so bob's write in flight never re-homes it.
     */
    private Step memberPlan(String name, JsonNode body) {
        long results = countRoleTool(body);
        switch (name) {
            case "alice" -> {
                if (results == 0) {
                    return new Step(List.of(call("alice-create", "task_create",
                            Map.of("subject", "Audit one",
                                    "description", "audit one"))), null);
                }
                if (results == 1) {
                    return new Step(List.of(call("alice-claim", "task_update",
                            Map.of("taskId", createdNumber(body), "status",
                                    "in_progress")),
                            call("alice-list", "task_list", Map.of())), null);
                }
                return new Step(List.of(), reportFor(name));
            }
            case "bob" -> {
                if (results == 0) {
                    return new Step(List.of(
                            call("bob-create", "task_create",
                                    Map.of("subject", "Doc sync",
                                            "description", "sync the docs")),
                            call("bob-list", "task_list", Map.of())), null);
                }
                return new Step(List.of(), reportFor(name));
            }
            case "carol" -> {
                if (results == 0) {
                    return new Step(List.of(call("carol-create", "task_create",
                            Map.of("subject", "Slow audit",
                                    "description", "a slow audit"))), null);
                }
                return new Step(List.of(), reportFor(name));
            }
            default -> throw new AssertionError("Unknown member " + name);
        }
    }

    private record Step(List<Map<String, Object>> calls, String text) {
    }

    /** A tool answer as plain text, whatever JSON escaping carried it. */
    private static String plain(String text) {
        String out = text;
        for (int pass = 0; pass < 4; pass++) {
            out = out.replace("\\\\", "\\").replace("\\\"", "\"")
            .replace("\\n", "\n");
        }
        return out;
    }

    /** The number a member's own task_create opened, from its reply. */
    private String createdNumber(JsonNode body) {
        for (JsonNode message : body.path("messages")) {
            if (!"tool".equals(message.path("role").asText())) {
                continue;
            }
            String text = plain(message.path("content").toString());
            Matcher number = Pattern.compile(
                    "Task #(\\d+) created").matcher(text);
            if (number.find()) {
                return number.group(1);
            }
        }
        throw new AssertionError("member task_create reply lacks its number");
    }

    /** A member's final text after its calls: her result to the leader. */
    private static String reportFor(String name) {
        return name.toUpperCase() + "_REPORT all clean";
    }

    private static long countRoleTool(JsonNode body) {
        long results = 0;
        for (JsonNode message : body.path("messages")) {
            if ("tool".equals(message.path("role").asText())) {
                results += 1;
            }
        }
        return results;
    }

    private static Map<String, Object> call(String id, String name,
            Map<String, Object> args) {
        return Map.of("id", id, "name", name, "args", args);
    }

    private void reply(HttpExchange exchange, Step step) throws IOException {
        reply(exchange, step.calls(), step.text());
    }

    private void reply(HttpExchange exchange,
            List<Map<String, Object>> calls) throws IOException {
        reply(exchange, calls, null);
    }

    private void reply(HttpExchange exchange,
            List<Map<String, Object>> calls, String text) throws IOException {
        ObjectNode chunk = json.createObjectNode().put("id", "h4eb3")
                .put("object", "chat.completion.chunk").put("created", 0)
                .put("model", "h4eb3-fixture");
        ObjectNode choice = chunk.putArray("choices").addObject()
                .put("index", 0);
        ObjectNode delta = choice.putObject("delta").put("role",
                "assistant");
        if (calls.isEmpty()) {
            delta.put("content", text == null ? "" : text);
        } else {
            ArrayNode toolCalls = delta.putArray("tool_calls");
            for (int index = 0; index < calls.size(); index++) {
                Map<String, Object> call = calls.get(index);
                toolCalls.addObject().put("index", index)
                        .put("id", call.get("id").toString())
                        .put("type", "function")
                        .putObject("function")
                        .put("name", call.get("name").toString())
                        .put("arguments",
                                json.writeValueAsString(call.get("args")));
            }
        }
        choice.putNull("finish_reason");
        String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
        choice.putObject("delta");
        choice.put("finish_reason", calls.isEmpty() ? "stop" : "tool_calls");
        byte[] response = (first + "data: "
                + json.writeValueAsString(chunk) + "\n\ndata: [DONE]\n\n")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type",
                "text/event-stream");
        exchange.sendResponseHeaders(200, response.length);
        exchange.getResponseBody().write(response);
    }

    // ------------------------------------------------------------- queries

    private static String firstUserText(JsonNode body) {
        for (JsonNode message : body.path("messages")) {
            if (!"user".equals(message.path("role").asText())) {
                continue;
            }
            String text = message.path("content").isTextual()
                    ? message.path("content").asText()
                    : message.path("content").toString();
            if (text.contains("H4EB3_")) {
                return text;
            }
        }
        return "";
    }

    private static Set<String> teammates(String text) {
        Set<String> names = new LinkedHashSet<>();
        Matcher matcher = TEAMMATE.matcher(text.replace("\\u003c", "<")
                .replace("\\u003e", ">"));
        while (matcher.find()) {
            names.add(matcher.group(1));
        }
        return names;
    }

    /** Every command chain a member committed, newest revision each. */
    private List<JsonNode> commandsOf(String lead, String member) {
        List<String> children = jdbc.queryForList(
                "SELECT session_id FROM ma_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?",
                String.class, tenant, lead);
        for (String child : children) {
            List<Map<String, Object>> commands = rows(child,
                    "session_command");
            if (!commands.isEmpty()) {
                JsonNode task = team(lead);
                if (task != null && task.toString().contains("\"" + member
                        + "\"")) {
                    List<JsonNode> out = new ArrayList<>();
                    for (Map<String, Object> row : commands) {
                        out.add(body(row));
                    }
                    return out;
                }
            }
        }
        return List.of();
    }

    private List<Map<String, Object>> rows(String session, String domain) {
        return jdbc.queryForList(
                "SELECT r.record_id, r.revision, CAST(res.inline_bytes AS CHAR)"
                        + " AS body FROM"
                        + " ma_session_record r"
                        + " JOIN ma_resource res ON"
                        + " res.session_scope_key = r.session_scope_key"
                        + " AND res.resource_id = r.record_resource_id"
                        + " WHERE r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = ? ORDER BY r.record_id",
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

    private String operationStatus(String session, String operation)
            throws Exception {
        return request("GET", "/v1/agents/sessions/" + session + "/operations/"
                + operation, null, null, 200).path("status").asText();
    }

    private void assertNoModelFailure() {
        Throwable failure = modelFailure.get();
        if (failure != null) {
            throw new IllegalStateException("The model fixture failed",
                    failure);
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
        List<Map<String, Object>> failed = jdbc.queryForList(
                "SELECT turn_id, error_code FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND status = 'FAILED'",
                tenant, session);
        if (!failed.isEmpty()) {
            throw new IllegalStateException("Turns failed: " + failed);
        }
    }

    /**
     * The session's in-flight Turns: every terminal write (SETTLED,
     * FAILED, CANCELLED) sets completed_at.
     */
    private List<Map<String, Object>> openTurns(String session) {
        return jdbc.queryForList(
                "SELECT turn_id, status FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND completed_at IS NULL",
                tenant, session);
    }

    /** The restart fixture's single member: the lead's only child. */
    private String onlyChildOf(String lead) {
        List<String> children = jdbc.queryForList(
                "SELECT session_id FROM ma_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?",
                String.class, tenant, lead);
        if (children.size() != 1) {
            throw new IllegalStateException("expected one member session: "
                    + children);
        }
        return children.get(0);
    }

    /** Whether the lead's journal accepted a member result durably. */
    private boolean childResultAccepted(String lead) {
        Integer accepted = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND operation = 'acceptChildResult'",
                Integer.class, tenant, lead);
        return accepted != null && accepted > 0;
    }

    /** Whether the Session parks a Turn on an `await_command` checkpoint. */
    private boolean parkedOnCommand(String session) {
        Integer parked = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND kind = 'managed-checkpoint'"
                        + " AND CAST(inline_bytes AS CHAR) LIKE"
                        + " '%await_command%'",
                Integer.class, tenant, session);
        return parked != null && parked > 0;
    }

    // ------------------------------------------------------------- the stack

    private void boot() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the CLI first").isRegularFile();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with a Node.js 22+ path")
                .isNotBlank();
        assertThat(System.getProperty("mysql.url"))
                .as("Pass -Dmysql.url for a disposable MySQL schema")
                .isNotBlank();
        temporary = temporary.toRealPath();
        Files.createDirectory(temporary.resolve("broker"),
                PosixFilePermissions.asFileAttribute(
                        PosixFilePermissions.fromString("rwx------")));
        Path workspace = Files
                .createDirectory(temporary.resolve("workspace-a"));
        Files.createDirectory(workspace.resolve("child"));
        // The Runtime Broker resolves its workspace cwd eagerly; the decoy
        // directory must exist before the Spring context asks for it.
        Files.createDirectory(temporary.resolve("harness-decoy"));
        port = freePort();
        harnessPort = freePort();
        brokerPort = freePort();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelThreads = Executors.newCachedThreadPool();
        model.setExecutor(modelThreads);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        startSpring(cli, node, workspace);
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id,"
                        + " workspace_generation, storage_id, display_name,"
                        + " config_ref, policy_ref, state) VALUES (?,"
                        + " 'workspace-0', 1, 'storage-0', 'H4e-b3', ?, ?,"
                        + " 'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update(
                "INSERT INTO ma_workspace_access (tenant_id, workspace_id,"
                        + " actor_id, role) VALUES (?, 'workspace-0', ?,"
                        + " 'OPERATOR')",
                tenant, "actor".getBytes(StandardCharsets.UTF_8));
        startHarness();
    }

    private void startSpring(Path cli, String node, Path workspace) {
        List<String> arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=" + port,
                "--spring.datasource.url="
                        + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getProperty("mysql.user"),
                "--spring.datasource.password="
                        + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:"
                        + port,
                "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                // A dead writer's lease lapses within the member command's
                // own 2-minute bound with room to spare, so the restart
                // case's takeover resumes a wait that is still open.
                "--qwen.managed-agent.session-store.writer-lease-duration=15s",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.harness.base-url=http://127.0.0.1:"
                        + harnessPort,
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd="
                        + temporary.resolve("harness-decoy"),
                "--qwen.managed-agent.runtime-broker.state-directory="
                        + temporary.resolve("broker"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=h4eb3-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key="
                        + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id="
                        + tenant,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage-0",
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root="
                        + workspace));
        spring = (ServletWebServerApplicationContext)
                new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                        .initializers(context -> context.getBeanFactory()
                                .registerSingleton("h4eb3Authentication",
                                        authentication()))
                        .run(arguments.toArray(String[]::new));
        jdbc = spring.getBean(JdbcTemplate.class);
    }

    private void startHarness() throws Exception {
        String node = System.getProperty("node.executable");
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath();
        Path home = Files.createDirectory(
                temporary.resolve("home-" + UUID.randomUUID()));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort()
                + "/v1";
        Files.writeString(config.resolve("settings.json"),
                json.writeValueAsString(Map.of(
                        "security",
                        Map.of("auth", Map.of("selectedType", "openai")),
                        "model", Map.of("name", "h4eb3-fixture"),
                        "telemetry", Map.of("enabled", false),
                        "modelProviders",
                        Map.of("openai", List.of(Map.of("id", "h4eb3-fixture",
                                "envKey", "OPENAI_API_KEY", "baseUrl",
                                modelUrl))))));
        Path log = temporary.resolve("harness.log");
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web",
                "--workspace", temporary.resolve("harness-decoy").toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:"
                        + brokerPort,
                "--managed-runtime-broker-token", TOKEN)
                .directory(temporary.resolve("harness-decoy").toFile())
                .redirectErrorStream(true).redirectOutput(log.toFile());
        Map<String, String> environment = builder.environment();
        environment.clear();
        if (System.getenv("PATH") != null) {
            environment.put("PATH", System.getenv("PATH"));
        }
        environment.putAll(Map.of(
                    "HOME", home.toString(),
                    "USERPROFILE", home.toString(),
                    "QWEN_HOME", config.toString(),
                    "QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString(),
                    "OPENAI_API_KEY", "fake-local-key",
                    "OPENAI_BASE_URL", modelUrl,
                    "QWEN_SERVER_TOKEN", TOKEN,
                    "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            environment.put(name,
                        temporary.resolve(name + ".json").toString());
        }
        harness = builder.start();
        waiting().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            if (!harness.isAlive()) {
                throw new IllegalStateException(
                        "Hosted Harness exited: " + Files.readString(log));
            }
            int status;
            try {
                // --require-auth gates every route too — the loopback
                // /health probe needs the same bearer as the routes.
                HttpResponse<String> ready = http.send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                                + harnessPort + "/health"))
                                .header("authorization", "Bearer " + TOKEN)
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
                status = ready.statusCode();
            } catch (IOException ignored) {
                status = -1;
            }
            assertThat(status).isEqualTo(200);
        });
    }

    private JsonNode request(String method, String path, Object body,
            String key, int expected) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(15))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("X-H4eb3-Fixture-Actor", "actor")
                .method(method,
                        body == null ? HttpRequest.BodyPublishers.noBody()
                                : HttpRequest.BodyPublishers.ofString(
                                        json.writeValueAsString(body)));
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        HttpResponse<String> response = http.send(request.build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode())
                .as("%s %s: %s", method, path, response.body())
                .isEqualTo(expected);
        return json.readTree(response.body());
    }

    private FilterRegistrationBean<Filter> authentication() {
        FilterRegistrationBean<Filter> filter = new FilterRegistrationBean<>(
                (request, response, chain) -> chain.doFilter(
                        new HttpServletRequestWrapper(
                                (HttpServletRequest) request) {
                            @Override
                            public Principal getUserPrincipal() {
                                String actor = getHeader(
                                        "X-H4eb3-Fixture-Actor");
                                return actor == null ? null
                                        : new AuthenticatedTenantActor() {
                                            public String tenantId() {
                                                return tenant;
                                            }

                                            public String actorId() {
                                                return actor;
                                            }

                                            public String getName() {
                                                return actor;
                                            }
                                        };
                            }
                        }, response));
        filter.setOrder(Ordered.HIGHEST_PRECEDENCE);
        filter.setAsyncSupported(true);
        filter.addUrlPatterns("/v1/agents/*");
        return filter;
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static ConditionFactory waiting() {
        return await().failFast("The case's @Timeout interrupted it",
                () -> Thread.currentThread().isInterrupted());
    }
}
