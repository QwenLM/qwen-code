package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.awaitility.core.ConditionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

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
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * FG11 (#14446): the automation domains, {@code schedule} and
 * {@code automation_run}, on the packaged stack: in-JVM Spring with the
 * scanner on, a real Harness behind a relay, a real MySQL schema and a
 * model stub.
 */
class HostedAutomationFaultGatesIT {
    private static final String TOKEN = "fg11-local-fixture";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final String OPERATIONS = "/automations/operations";

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final String tenant = "fg11-a-" + UUID.randomUUID().toString().substring(0, 8);
    private final List<String> modelPrompts = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    private final CountDownLatch heldModel = new CountDownLatch(1);
    // Every automation operation Spring sent the Harness, in order.
    private final List<Operation> operations = new CopyOnWriteArrayList<>();
    private final Map<String, Predicate<JsonNode>> armed = new ConcurrentHashMap<>();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private JdbcTemplate jdbc;
    private HttpServer model;
    private ExecutorService modelExecutor;
    private HostedLifecycleRelay harnessRelay;
    // Fronts Spring for the public-reply case: the Idempotency-Key whose 202 it drops once.
    private HostedLifecycleRelay publicRelay;
    private final AtomicReference<String> publicDrop = new AtomicReference<>();
    // Parks the scanner while the clock-bound cases set up.
    private CountDownLatch scannerHold;
    private Process harness;
    private Path decoy;
    private String node;
    private int port;

    record Operation(String kind, String scheduleId, String occurrenceKey, String body, int status,
            boolean dropped) { }

    @Test
    @Timeout(600)
    void fg11aLostRepliesNeverFireTwiceOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).as("FG11 requires real MySQL").startsWith("jdbc:mysql:");
        boot();
        // The clock-bound cases arm first and settle on the next minute boundary, while the
        // others run against their own Sessions in the meantime. The scanner's only thread is
        // parked until all three are armed, so no slot fires before its fault is in place or its
        // held run is live; a boundary that passes meanwhile is still timely when it lets go.
        scannerHold = SchedulerHold.hold(spring.getBean("managedAutomationScheduler",
                ThreadPoolTaskScheduler.class), Duration.ofSeconds(30));
        Clocked scheduled = selected("scheduled-fire-reply") ? scheduledFireReply() : null;
        Clocked reconcile = selected("reconcile-reply") ? reconcileReply() : null;
        Clocked retire = selected("retire-reply") ? retireReply() : null;
        scannerHold.countDown();
        if (selected("create-reply")) {
            createReply();
        }
        if (selected("update-reply")) {
            updateReply();
        }
        if (selected("noop-update-reply")) {
            noopUpdateReply();
        }
        if (selected("manual-run-reply")) {
            manualRunReply();
        }
        if (selected("public-reply")) {
            publicReply();
        }
        for (Clocked clocked : new Clocked[] {scheduled, reconcile, retire}) {
            if (clocked != null) {
                clocked.settle();
            }
        }
        assertThat(jdbc.queryForList("SELECT CONCAT(occurrence_key, ' ', reason) FROM ma_schedule_occurrence"
                + " WHERE tenant_id = ? AND outcome = 'unknown'", String.class, tenant)).as("unknown occurrences")
                .isEmpty();
        assertThat(armed).as("every armed reply was dropped").isEmpty();
        assertNoModelFailure();
    }

    interface Clocked {
        void settle() throws Exception;
    }

    // create-reply: the Harness committed the definition and its 202 is lost. The public
    // answer is 503 automation_operation_unknown; the retry under the same key re-drives the
    // same operation id and answers the committed revision 1 without committing again.
    private void createReply() throws Exception {
        String session = createSession("create");
        arm("create-reply", body -> kind(body, "define_schedule") && prompt(body).contains("FG11A_CREATE"));
        Map<String, Object> definition = definition(session, "FG11A_CREATE", "0 0 1 1 *");
        assertRefused(send("POST", "/v1/agent-automations", definition, "create-reply"));
        JsonNode created = request("POST", "/v1/agent-automations", definition, "create-reply", 202);
        String id = created.path("id").asText();
        assertThat(created.path("definition_revision").asLong()).isEqualTo(1);
        assertOperations(id, "define_schedule", 2, 1);
        assertThat(sameOperationId(id, "define_schedule")).isTrue();
        assertThat(commands(session, "defineSchedule")).hasSize(1);
        assertThat(recordRevision(session, "schedule", id)).isEqualTo(1);
    }

    // update-reply: a lost update answer, then a newer update under another key lands. The
    // retry answers the lost update's own committed revision and never commits over the newer.
    private void updateReply() throws Exception {
        String session = createSession("update");
        String id = request("POST", "/v1/agent-automations", definition(session, "FG11A_UPDATE", "0 0 1 1 *"),
                "update-base", 202).path("id").asText();
        arm("update-reply", body -> kind(body, "define_schedule") && prompt(body).contains("FG11A_UPDATE_ONE"));
        Map<String, Object> one = Map.of("prompt", "FG11A_UPDATE_ONE reply with FG11_DONE.");
        assertRefused(send("POST", "/v1/agent-automations/" + id, one, "update-one"));
        assertThat(request("POST", "/v1/agent-automations/" + id, Map.of("prompt",
                "FG11A_UPDATE_TWO reply with FG11_DONE."), "update-two", 202).path("definition_revision").asLong())
                .isEqualTo(3);
        assertThat(request("POST", "/v1/agent-automations/" + id, one, "update-one", 202)
                .path("definition_revision").asLong()).isEqualTo(2);
        assertThat(request("GET", "/v1/agent-automations/" + id, null, null, 200).path("definition_revision")
                .asLong()).isEqualTo(3);
        assertThat(commands(session, "defineSchedule")).hasSize(3);
        assertThat(recordRevision(session, "schedule", id)).isEqualTo(3);
    }

    // noop-update-reply: an update that changes nothing commits only its replay marker; with
    // that answer lost, the retry answers revision 1 and the definition never moves.
    private void noopUpdateReply() throws Exception {
        String session = createSession("noop");
        String id = request("POST", "/v1/agent-automations", definition(session, "FG11A_NOOP", "0 0 1 1 *"),
                "noop-base", 202).path("id").asText();
        arm("noop-update-reply", body -> kind(body, "define_schedule") && id.equals(body.path("scheduleId")
                .asText()));
        Map<String, Object> same = Map.of("prompt", "FG11A_NOOP reply with FG11_DONE.");
        assertRefused(send("POST", "/v1/agent-automations/" + id, same, "noop-update"));
        assertThat(request("POST", "/v1/agent-automations/" + id, same, "noop-update", 202)
                .path("definition_revision").asLong()).isEqualTo(1);
        assertOperations(id, "define_schedule", 3, 1);
        assertThat(commands(session, "defineSchedule")).hasSize(2);
        assertThat(recordRevision(session, "schedule", id)).isEqualTo(1);
    }

    // manual-run-reply: the fire committed both run revisions and woke the Turn, and its 202
    // is lost. The public answer is 503; the retry under the same key meets the same run, and
    // the occurrence has one run chain and one model Turn.
    private void manualRunReply() throws Exception {
        String session = createSession("manual");
        String id = request("POST", "/v1/agent-automations", definition(session, "FG11A_MANUAL", "0 0 1 1 *"),
                "manual-base", 202).path("id").asText();
        arm("manual-run-reply", body -> kind(body, "fire_run") && id.equals(body.path("scheduleId").asText()));
        assertRefused(send("POST", "/v1/agent-automations/" + id + "/runs", null, "manual-run"));
        JsonNode run = request("POST", "/v1/agent-automations/" + id + "/runs", null, "manual-run", 202);
        assertThat(run.path("occurrence_key").asText()).isEqualTo("manual:manual-run");
        assertOneRun(session, id, run.path("id").asText(), "manual:manual-run", 2);
    }

    // public-reply: Spring settled the create's receipt and its own 202 is lost on the way to
    // the caller. The retry replays the receipt; the Harness sees the operation once.
    private void publicReply() throws Exception {
        String session = createSession("public");
        Map<String, Object> definition = definition(session, "FG11A_PUBLIC", "0 0 1 1 *");
        publicDrop.set("public-reply");
        try {
            HttpResponse<String> answered = http.send(builder(publicRelay.uri() + "/v1/agent-automations",
                    "POST", definition, "public-reply").build(), HttpResponse.BodyHandlers.ofString());
            throw new AssertionError("The public 202 reached the caller: " + answered.statusCode() + " "
                    + answered.body());
        } catch (IOException dropped) {
            // The relay closed the connection after Spring answered.
        }
        assertThat(publicDrop.get()).as("the public 202 was dropped").isNull();
        HttpResponse<String> replay = send("POST", "/v1/agent-automations", definition, "public-reply");
        assertThat(replay.statusCode()).as(replay.body()).isEqualTo(202);
        assertThat(replay.headers().firstValue("X-Qwen-Idempotent-Replay")).contains("true");
        String id = json.readTree(replay.body()).path("id").asText();
        assertOperations(id, "define_schedule", 1, 0);
        assertThat(commands(session, "defineSchedule")).hasSize(1);
    }

    // scheduled-fire-reply: the scanner's fire of the next minute's slot commits and its 202
    // is lost. The scanner re-drives the occurrence once and the Harness answers the same run.
    private Clocked scheduledFireReply() throws Exception {
        String session = createSession("scheduled");
        String id = request("POST", "/v1/agent-automations", definition(session, "FG11A_SCHEDULED", "* * * * *"),
                "scheduled-base", 202).path("id").asText();
        arm("scheduled-fire-reply", body -> kind(body, "fire_run") && id.equals(body.path("scheduleId").asText()));
        return () -> {
            Map<String, Object> occurrence = awaitOccurrence(id, "fired");
            String key = (String) occurrence.get("occurrence_key");
            assertThat(key).startsWith("schedule:");
            assertThat(((Number) occurrence.get("attempts")).intValue()).as("re-drives").isEqualTo(1);
            assertOneRun(session, id, (String) occurrence.get("run_id"), key, 2);
            request("DELETE", "/v1/agent-automations/" + id, null, "scheduled-retire", 202);
        };
    }

    // reconcile-reply: a held manual run keeps the skip policy's count closed when the next
    // slot comes due, so the scanner asks reconcile_run, and that answer is lost. The slot is
    // skipped under its own refusal, never unknown, and the held run is left running.
    private Clocked reconcileReply() throws Exception {
        String session = createSession("reconcile");
        String id = request("POST", "/v1/agent-automations", definition(session, "FG11A_HOLD", "* * * * *"),
                "reconcile-base", 202).path("id").asText();
        String held = request("POST", "/v1/agent-automations/" + id + "/runs", null, "reconcile-hold", 202)
                .path("id").asText();
        waiting().atMost(Duration.ofSeconds(60)).until(() -> modelPrompts.stream()
                .anyMatch(prompt -> prompt.contains("manual:reconcile-hold")));
        arm("reconcile-reply", body -> kind(body, "reconcile_run") && id.equals(body.path("scheduleId").asText()));
        return () -> {
            Map<String, Object> occurrence = awaitOccurrence(id, "skipped");
            assertThat((String) occurrence.get("occurrence_key")).startsWith("schedule:");
            assertThat((String) occurrence.get("reason")).isIn("overlap", "count_limit");
            assertThat(operations).filteredOn(operation -> id.equals(operation.scheduleId())
                    && "reconcile_run".equals(operation.kind())).first().extracting(Operation::dropped)
                    .isEqualTo(true);
            assertThat(runState(held)).isEqualTo("running");
            request("DELETE", "/v1/agent-automations/" + id, null, "reconcile-retire", 202);
            heldModel.countDown();
            waiting().atMost(Duration.ofSeconds(60)).until(() -> "completed".equals(runState(held)));
        };
    }

    // retire-reply: the retire committed and its 202 is lost. The journal commit projected the
    // retired mirror in the same transaction, so the retry answers that committed retire as its
    // replay without asking the Harness again, and the every-minute definition never fires
    // after it.
    private Clocked retireReply() throws Exception {
        String session = createSession("retire");
        String id = request("POST", "/v1/agent-automations", definition(session, "FG11A_RETIRE", "* * * * *"),
                "retire-base", 202).path("id").asText();
        arm("retire-reply", body -> kind(body, "retire_schedule") && id.equals(body.path("scheduleId").asText()));
        assertRefused(send("DELETE", "/v1/agent-automations/" + id, null, "retire-reply"));
        HttpResponse<String> retry = send("DELETE", "/v1/agent-automations/" + id, null, "retire-reply");
        assertThat(retry.statusCode()).as(retry.body()).isEqualTo(202);
        assertThat(retry.headers().firstValue("X-Qwen-Idempotent-Replay")).contains("true");
        assertThat(json.readTree(retry.body()).path("state").asText()).isEqualTo("retired");
        long retiredAt = System.currentTimeMillis();
        assertOperations(id, "retire_schedule", 1, 1);
        assertThat(commands(session, "retireSchedule")).hasSize(1);
        return () -> {
            // The boundary has passed once the other clock-bound cases settled; a slot before
            // the retire may have fired, none after it.
            waiting().atMost(Duration.ofSeconds(70)).until(() -> System.currentTimeMillis()
                    >= (retiredAt / 60_000 + 1) * 60_000 + 5_000);
            assertThat(jdbc.queryForList("SELECT occurrence_key FROM ma_schedule_occurrence WHERE tenant_id = ?"
                    + " AND schedule_id = ? AND slot > ?", String.class, tenant, id, retiredAt)).isEmpty();
        };
    }

    private boolean selected(String name) {
        String selected = System.getProperty("qwen.fg11a.case", "");
        return selected.isEmpty() || selected.equals(name);
    }

    private void arm(String name, Predicate<JsonNode> rule) {
        assertThat(armed.putIfAbsent(name, rule)).as(name).isNull();
    }

    private static boolean kind(JsonNode body, String kind) {
        return kind.equals(body.path("kind").asText());
    }

    private static String prompt(JsonNode body) {
        return body.path("definition").path("prompt").asText();
    }

    // A lost Harness answer reaches the caller as the operation's unknown outcome.
    private static void assertRefused(HttpResponse<String> response) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(503);
        assertThat(response.body()).contains("automation_operation_unknown");
    }

    private void assertOperations(String scheduleId, String kind, int total, int dropped) {
        var matching = operations.stream().filter(operation -> scheduleId.equals(operation.scheduleId())
                && kind.equals(operation.kind())).toList();
        assertThat(matching).as("%s operations for %s", kind, scheduleId).hasSize(total);
        assertThat(matching).filteredOn(Operation::dropped).hasSize(dropped);
    }

    private boolean sameOperationId(String scheduleId, String kind) throws Exception {
        var ids = new java.util.HashSet<String>();
        for (Operation operation : operations) {
            if (scheduleId.equals(operation.scheduleId()) && kind.equals(operation.kind())) {
                ids.add(json.readTree(operation.body()).path("operationId").asText());
            }
        }
        return ids.size() == 1;
    }

    // One occurrence, one run chain: the fires the Harness saw for it (the dropped one and its
    // re-drive), its two fire revisions and its settle committed once, one accepted input and
    // one model Turn. Everything is scoped to this occurrence: a later slot of an every-minute
    // definition, due while the other cases run, is a run of its own.
    private void assertOneRun(String session, String scheduleId, String runId, String occurrenceKey,
            int fires) throws Exception {
        waiting().atMost(Duration.ofSeconds(60)).until(() -> "completed".equals(runState(runId)));
        var fired = operations.stream().filter(operation -> scheduleId.equals(operation.scheduleId())
                && "fire_run".equals(operation.kind()) && occurrenceKey.equals(operation.occurrenceKey())).toList();
        assertThat(fired).as("fires of %s", occurrenceKey).hasSize(fires);
        assertThat(fired).filteredOn(Operation::dropped).hasSize(1);
        assertThat(commands(session, "fireRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":1", runId + ":2");
        assertThat(commands(session, "settleRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":3");
        assertThat(recordRevision(session, "automation_run", runId)).isEqualTo(3);
        assertThat(events(session, "input.accepted")).filteredOn(event -> event.startsWith(runId + ":"))
                .containsExactly(runId + ":input:accepted");
        assertThat(events(session, "turn.settled")).filteredOn(event -> event.contains(runId))
                .containsExactly("turn:" + runId + ":input");
        assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Occurrence: " + occurrenceKey)).hasSize(1);
        Map<String, Object> occurrence = jdbc.queryForMap("SELECT outcome, run_id FROM ma_schedule_occurrence"
                + " WHERE tenant_id = ? AND schedule_id = ? AND occurrence_key = ?", tenant, scheduleId,
                occurrenceKey);
        assertThat(occurrence).containsEntry("outcome", "fired").containsEntry("run_id", runId);
    }

    private Map<String, Object> awaitOccurrence(String scheduleId, String outcome) {
        AtomicReference<Map<String, Object>> found = new AtomicReference<>();
        waiting().atMost(Duration.ofSeconds(150)).until(() -> {
            var rows = jdbc.queryForList("SELECT occurrence_key, outcome, reason, attempts, run_id FROM"
                    + " ma_schedule_occurrence WHERE tenant_id = ? AND schedule_id = ? AND occurrence_key LIKE"
                    + " 'schedule:%' ORDER BY slot", tenant, scheduleId);
            if (rows.isEmpty() || "firing".equals(rows.getFirst().get("outcome"))) {
                return false;
            }
            found.set(rows.getFirst());
            return true;
        });
        assertThat(found.get()).as("the first slot of %s", scheduleId).containsEntry("outcome", outcome);
        return found.get();
    }

    private List<String> commands(String session, String operation) {
        return jdbc.queryForList("SELECT CAST(command_id AS CHAR) FROM ma_session_journal_tx WHERE tenant_id = ?"
                + " AND session_id = ? AND operation = ? ORDER BY journal_revision", String.class, tenant, session,
                operation);
    }

    // The event ids of one kind the Session's journal committed.
    private List<String> events(String session, String kind) throws Exception {
        var ids = new ArrayList<String>();
        for (byte[] record : jdbc.queryForList("SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id"
                + " = ? AND session_id = ? ORDER BY journal_revision", byte[].class, tenant, session)) {
            for (String line : new String(record, StandardCharsets.UTF_8).lines().toList()) {
                JsonNode entry = json.readTree(line);
                if ("managed_session_event_v1".equals(entry.path("subtype").asText())
                        && kind.equals(entry.path("managedSession").path("kind").asText())) {
                    ids.add(entry.path("managedSession").path("eventId").asText());
                }
            }
        }
        return ids;
    }

    private long recordRevision(String session, String domain, String recordId) {
        return jdbc.queryForObject("SELECT revision FROM ma_session_record WHERE tenant_id = ? AND session_id = ?"
                + " AND domain = ? AND record_id = ?", Long.class, tenant, session, domain, recordId);
    }

    private Map<String, Object> definition(String session, String marker, String cron) {
        return Map.of("session_id", session, "goal", marker, "cron", cron, "timezone", "UTC",
                "prompt", marker + " reply with FG11_DONE.");
    }

    private String runState(String runId) {
        List<String> states = jdbc.queryForList("SELECT task_state FROM ma_session_record WHERE tenant_id = ?"
                + " AND domain = 'automation_run' AND record_id = ?", String.class, tenant, runId);
        return states.isEmpty() ? null : states.getFirst();
    }

    private void boot() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath();
        assertThat(cli).as("Build and bundle the CLI first").isRegularFile();
        node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        decoy = Files.createDirectory(temporary.resolve("harness-decoy"));
        Files.createDirectory(temporary.resolve("broker"));
        Path root = Files.createDirectory(temporary.resolve("workspace-0"));
        Files.createDirectory(root.resolve("child"));
        // Keep the initialized root's mtime distinct from its birth time without sleeping.
        Files.setLastModifiedTime(root, FileTime.fromMillis(1));
        int harnessPort;
        int brokerPort;
        try (var springSocket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
                var harnessSocket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
                var brokerSocket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            port = springSocket.getLocalPort();
            harnessPort = harnessSocket.getLocalPort();
            brokerPort = brokerSocket.getLocalPort();
        }
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelExecutor = Executors.newVirtualThreadPerTaskExecutor();
        model.setExecutor(modelExecutor);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        harnessRelay = new HostedLifecycleRelay();
        harnessRelay.backend(URI.create("http://127.0.0.1:" + harnessPort));
        harnessRelay.fault(new HostedLifecycleRelay.Fault() {
            @Override
            public boolean after(HostedLifecycleRelay.Request request, int status) throws Exception {
                return relayed(request, status);
            }
        });
        startSpring(cli, root, brokerPort);
        startHarness(cli, harnessPort, brokerPort);
        register(root);
        publicRelay = new HostedLifecycleRelay();
        publicRelay.backend(URI.create("http://127.0.0.1:" + port));
        publicRelay.fault(new HostedLifecycleRelay.Fault() {
            @Override
            public boolean after(HostedLifecycleRelay.Request request, int status) {
                // The relay copies the exchange's headers, whose names it normalizes.
                List<String> key = request.headers().entrySet().stream()
                        .filter(header -> header.getKey().equalsIgnoreCase("Idempotency-Key"))
                        .flatMap(header -> header.getValue().stream()).toList();
                String wanted = publicDrop.get();
                // compareAndSet compares identity, so it is handed the armed instance itself.
                return status != 202 || wanted == null || !key.contains(wanted)
                        || !publicDrop.compareAndSet(wanted, null);
            }
        });
    }

    // Records each automation operation and drops the reply of the first one an armed rule
    // matches: the Harness answered, the connection closes, Spring never reads the 202.
    private boolean relayed(HostedLifecycleRelay.Request request, int status) throws Exception {
        if (!"POST".equals(request.method()) || !request.path().endsWith(OPERATIONS)) {
            return true;
        }
        JsonNode body = json.readTree(request.body());
        boolean drop = false;
        if (status == 202) {
            for (var rule : armed.entrySet()) {
                if (rule.getValue().test(body) && armed.remove(rule.getKey()) != null) {
                    drop = true;
                    break;
                }
            }
        }
        operations.add(new Operation(body.path("kind").asText(), body.path("scheduleId").asText(),
                body.path("occurrenceKey").asText(), body.toString(), status, drop));
        return !drop;
    }

    private void startSpring(Path cli, Path root, int brokerPort) {
        List<String> arguments = new ArrayList<>(List.of("--server.address=127.0.0.1", "--server.port=" + port,
                "--spring.datasource.url=" + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getProperty("mysql.user", "root"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + port,
                "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.harness.base-url=" + harnessRelay.uri(),
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.automation.enabled=true",
                "--qwen.managed-agent.automation.scan-delay=1s",
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled="
                        + "Linux".equals(System.getProperty("os.name")),
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + decoy,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("broker"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=fg11-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage-0",
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + root));
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .initializers(context -> context.getBeanFactory().registerSingleton("fg11Authentication",
                        authentication()))
                .run(arguments.toArray(String[]::new));
        jdbc = spring.getBean(JdbcTemplate.class);
    }

    private void register(Path root) {
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, ?, 1, ?, 'FG11', ?, ?,"
                        + " 'ACTIVE')", tenant, "workspace-0", "storage-0", WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, ?, ?, 'OPERATOR')", tenant, "workspace-0", "actor".getBytes(StandardCharsets.UTF_8));
        if ("Linux".equals(System.getProperty("os.name"))) {
            spring.getBean(com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard.class)
                    .register(tenant, "storage-0", UUID.randomUUID().toString());
        }
    }

    private String createSession(String name) throws Exception {
        var body = Map.of("agent_id", "qwen-code", "input", List.of(), "workspace",
                Map.of("workspace_id", "workspace-0", "cwd_relative", "child"));
        String session = request("POST", "/v1/agents/sessions", body, "session-" + name, 202).path("id").asText();
        waiting().atMost(Duration.ofSeconds(60)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                "SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?", String.class, tenant,
                session)).isEqualTo("ACTIVE"));
        // The automation verbs load the Session on the Harness, never create it, so it runs
        // one Turn first.
        request("POST", "/v1/agents/sessions/" + session + "/events", Map.of("type", "agent.session.input.message",
                "input", List.of(Map.of("type", "input_text", "text", "FG11_WARM " + name))), "warm-" + name, 202);
        waiting().atMost(Duration.ofSeconds(60)).untilAsserted(() -> assertThat(jdbc.queryForList(
                "SELECT status FROM ma_turn WHERE tenant_id = ? AND session_id = ?", String.class, tenant, session))
                .containsExactly("COMPLETED"));
        return session;
    }

    private FilterRegistrationBean<Filter> authentication() {
        FilterRegistrationBean<Filter> filter = new FilterRegistrationBean<>((request, response, chain) ->
                chain.doFilter(new HttpServletRequestWrapper((HttpServletRequest) request) {
                    @Override
                    public Principal getUserPrincipal() {
                        return new AuthenticatedTenantActor() {
                            public String tenantId() { return tenant; }
                            public String actorId() { return "actor"; }
                            public String getName() { return "actor"; }
                        };
                    }
                }, response));
        filter.setOrder(Ordered.HIGHEST_PRECEDENCE);
        filter.setAsyncSupported(true);
        filter.addUrlPatterns("/v1/agents/*", "/v1/agent-automations", "/v1/agent-automations/*");
        return filter;
    }

    private void startHarness(Path cli, int harnessPort, int brokerPort) throws Exception {
        Path home = Files.createDirectory(temporary.resolve("home"));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
        Files.writeString(config.resolve("settings.json"), json.writeValueAsString(Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")), "model", Map.of("name", "fg11-fixture"),
                "telemetry", Map.of("enabled", false), "modelProviders", Map.of("openai", List.of(Map.of(
                        "id", "fg11-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl))))));
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
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE", home.toString(), "QWEN_HOME",
                config.toString(), "QWEN_RUNTIME_DIR", temporary.resolve("runtime").toString(), "OPENAI_API_KEY",
                "fake-local-key", "OPENAI_BASE_URL", modelUrl, "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST, "TMPDIR", temporary.toString()));
        for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            environment.put(name, temporary.resolve(name + ".json").toString());
        }
        harness = builder.start();
        waiting().atMost(Duration.ofSeconds(60)).ignoreExceptions().untilAsserted(() -> {
            if (!harness.isAlive()) {
                throw new AssertionError("Hosted Harness exited: " + Files.readString(log));
            }
            assertThat(http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + harnessPort
                    + "/capabilities")).timeout(Duration.ofSeconds(2)).header("Authorization", "Bearer " + TOKEN)
                    .build(), HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(200);
        });
    }

    // Answers every wake Turn at once with text, except a prompt carrying FG11A_HOLD, which
    // waits for the case to release it.
    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode body = json.readTree(exchange.getRequestBody());
            String prompt = "";
            for (JsonNode message : body.path("messages")) {
                if ("user".equals(message.path("role").asText())) {
                    prompt = message.path("content").toString();
                }
            }
            modelPrompts.add(prompt);
            if (prompt.contains("FG11A_HOLD")) {
                heldModel.await(120, TimeUnit.SECONDS);
            }
            var chunk = json.createObjectNode().put("id", "fg11").put("object", "chat.completion.chunk")
                    .put("created", 1).put("model", "fg11-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            choice.putObject("delta").put("role", "assistant").put("content", "FG11_DONE");
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
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

    private void assertNoModelFailure() {
        assertThat(modelFailure.get()).as("model stub").isNull();
        assertThat(harnessRelay.failure()).as("Harness relay").isNull();
        assertThat(publicRelay.failure()).as("public relay").isNull();
    }

    private JsonNode request(String method, String path, Object body, String key, int expected) throws Exception {
        HttpResponse<String> response = send(method, path, body, key);
        assertThat(response.statusCode()).as("%s %s: %s", method, path, response.body()).isEqualTo(expected);
        return json.readTree(response.body());
    }

    private HttpResponse<String> send(String method, String path, Object body, String key) throws Exception {
        return http.send(builder("http://127.0.0.1:" + port + path, method, body, key).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private HttpRequest.Builder builder(String url, String method, Object body, String key) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(60))
                .header("X-Qwen-Tenant-Id", tenant).header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        return request;
    }

    // The relay's operation log and the Harness log, kept for the CI upload either way.
    private void writeEvidence() throws IOException {
        if (temporary == null || harnessRelay == null) {
            return;
        }
        Path cases = Files.createDirectories(Path.of("target", "fg11-cases", "fg11a", tenant));
        var lines = new ArrayList<String>();
        for (Operation operation : operations) {
            lines.add(json.writeValueAsString(Map.of("kind", operation.kind(), "scheduleId",
                    operation.scheduleId(), "occurrenceKey", operation.occurrenceKey(), "status",
                    operation.status(), "dropped", operation.dropped())));
        }
        Files.write(cases.resolve("operations.jsonl"), lines);
        Path log = temporary.resolve("harness.log");
        if (Files.exists(log)) {
            Files.copy(log, cases.resolve("harness.log"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    // Awaitility ignores the interrupt a @Timeout sends, so every wait fails on it.
    private static ConditionFactory waiting() {
        return await().failFast("The case's @Timeout interrupted it", () -> Thread.currentThread().isInterrupted())
                .pollInterval(Duration.ofMillis(200));
    }

    @AfterEach
    void stop() throws Exception {
        heldModel.countDown();
        if (scannerHold != null) {
            scannerHold.countDown();
        }
        Throwable failure = null;
        List<org.junit.jupiter.api.function.Executable> cleanup = List.of(
                this::writeEvidence,
                () -> {
                    if (harness != null) {
                        harness.descendants().forEach(ProcessHandle::destroyForcibly);
                        harness.destroyForcibly();
                        harness.waitFor(10, TimeUnit.SECONDS);
                    }
                },
                () -> { if (spring != null) {
                    spring.close();
                } },
                () -> { if (harnessRelay != null) {
                    harnessRelay.close();
                } },
                () -> { if (publicRelay != null) {
                    publicRelay.close();
                } },
                () -> { if (model != null) {
                    model.stop(0);
                } },
                () -> { if (modelExecutor != null) {
                    modelExecutor.close();
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
