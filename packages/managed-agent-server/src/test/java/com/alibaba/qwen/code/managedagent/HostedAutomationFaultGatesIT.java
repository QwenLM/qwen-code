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
import static org.junit.jupiter.api.Assumptions.assumeTrue;

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
    // The Harness store client's bounded retry of one commit (http-managed-session-store.ts).
    private static final int STORE_ATTEMPTS = 3;

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    // The letter under test names the tenant, the case selector and the evidence directory.
    private String letter;
    private String tenant;
    private final List<String> modelPrompts = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    private final CountDownLatch heldModel = new CountDownLatch(1);
    // Every automation operation Spring sent the Harness, in order.
    private final List<Operation> operations = new CopyOnWriteArrayList<>();
    private final Map<String, Predicate<JsonNode>> armed = new ConcurrentHashMap<>();
    // Operations a rule parks before they reach the Harness, until the case lets them go.
    private final Map<String, Hold> holds = new ConcurrentHashMap<>();
    // The store refusals this test installed, by case, dropped again in teardown.
    private final Map<String, String> refusals = new ConcurrentHashMap<>();
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
    // Kept for a cold restart on the same port.
    private Path harnessCli;
    private int harnessPort;
    private int brokerPort;
    // Spring arguments a test adds before it boots.
    private final List<String> springExtras = new ArrayList<>();
    // Fronts the Session Store for the Harness when a test asks for it before booting, and
    // drops the answer to the one commit whose command id is armed.
    private boolean storeRelayed;
    private HostedLifecycleRelay storeRelay;
    private final AtomicReference<String> storeDrop = new AtomicReference<>();
    private final List<String> storeCommits = new CopyOnWriteArrayList<>();
    // Commits a crash case parks before the store sees them, then drops: the killed Harness
    // never committed that revision.
    private final Map<String, Hold> storeHolds = new ConcurrentHashMap<>();
    private Path decoy;
    private String node;
    private int port;

    record Operation(String kind, String scheduleId, String occurrenceKey, String body, int status,
            boolean dropped) { }

    record Hold(Predicate<JsonNode> rule, CountDownLatch reached, CountDownLatch release) { }

    @Test
    @Timeout(600)
    void fg11aLostRepliesNeverFireTwiceOnMySql() throws Exception {
        boot("fg11a");
        // The clock-bound cases arm first and settle on the next minute boundary, while the
        // others run against their own Sessions in the meantime. The scanner's only thread is
        // parked until all three are armed, so no slot fires before its fault is in place or its
        // held run is live; a boundary that passes meanwhile is still timely when it lets go.
        scannerHold = SchedulerHold.hold(spring.getBean("managedAutomationScheduler",
                ThreadPoolTaskScheduler.class), Duration.ofSeconds(30));
        Clocked scheduled = selected("fg11a", "scheduled-fire-reply") ? scheduledFireReply() : null;
        Clocked reconcile = selected("fg11a", "reconcile-reply") ? reconcileReply() : null;
        Clocked retire = selected("fg11a", "retire-reply") ? retireReply() : null;
        scannerHold.countDown();
        if (selected("fg11a", "create-reply")) {
            createReply();
        }
        if (selected("fg11a", "update-reply")) {
            updateReply();
        }
        if (selected("fg11a", "noop-update-reply")) {
            noopUpdateReply();
        }
        if (selected("fg11a", "manual-run-reply")) {
            manualRunReply();
        }
        if (selected("fg11a", "public-reply")) {
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
        assertOneRun(session, id, run.path("id").asText(), "manual:manual-run", 2, 1);
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
            assertOneRun(session, id, (String) occurrence.get("run_id"), key, 2, 1);
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

    @Test
    @Timeout(600)
    void fg11bStoreFaultsNeverFireTwiceOnMySql() throws Exception {
        assumeTrue(anySelected("fg11b", "occurrence-insert", "occurrence-settle", "watermark", "revision-race",
                "receipt-claim", "receipt-settle"));
        boot("fg11b");
        // As in FG11a, the clock-bound cases set up with the scanner parked, so each fault is in
        // place before the minute boundary its slot fires on.
        scannerHold = SchedulerHold.hold(spring.getBean("managedAutomationScheduler",
                ThreadPoolTaskScheduler.class), Duration.ofSeconds(30));
        Clocked insert = selected("fg11b", "occurrence-insert") ? occurrenceInsert() : null;
        Clocked settle = selected("fg11b", "occurrence-settle") ? occurrenceSettle() : null;
        Clocked watermark = selected("fg11b", "watermark") ? watermark() : null;
        Clocked race = selected("fg11b", "revision-race") ? revisionRace() : null;
        scannerHold.countDown();
        if (selected("fg11b", "receipt-claim")) {
            receiptClaim();
        }
        if (selected("fg11b", "receipt-settle")) {
            receiptSettle();
        }
        for (Clocked clocked : new Clocked[] {insert, settle, watermark, race}) {
            if (clocked != null) {
                clocked.settle();
            }
        }
        // A store fault never settles a slot: only a definitive refusal or a stale, retired or
        // missing definition does, and none of these cases has one.
        assertThat(jdbc.queryForList("SELECT CONCAT(occurrence_key, ' ', outcome, ' ', COALESCE(reason, ''))"
                + " FROM ma_schedule_occurrence WHERE tenant_id = ? AND outcome IN ('skipped', 'unknown')",
                String.class, tenant)).as("skipped or unknown occurrences").isEmpty();
        assertThat(holds).as("every hold was reached").isEmpty();
        assertNoModelFailure();
    }

    @Test
    @Timeout(600)
    void fg11bHarnessStoreFaultsNeverRunTwiceOnMySql() throws Exception {
        // The two FG11b methods share one case selector; neither boots for the other's case.
        assumeTrue(anySelected("fg11b", "store-transport", "revision-1", "revision-2", "projection"));
        // A restarted Harness takes a Session over once its dead writer's lease lapses.
        springExtras.add("--qwen.managed-agent.session-store.writer-lease-duration=15s");
        storeRelayed = true;
        boot("fg11b");
        if (selected("fg11b", "store-transport")) {
            storeTransport();
        }
        if (selected("fg11b", "revision-1")) {
            revisionRefused("revision-1", "rev1", 1);
        }
        if (selected("fg11b", "revision-2")) {
            revisionRefused("revision-2", "rev2", 2);
        }
        if (selected("fg11b", "projection")) {
            projectionRefused();
        }
        assertThat(jdbc.queryForList("SELECT CONCAT(occurrence_key, ' ', outcome, ' ', COALESCE(reason, ''))"
                + " FROM ma_schedule_occurrence WHERE tenant_id = ? AND outcome IN ('skipped', 'unknown')",
                String.class, tenant)).as("skipped or unknown occurrences").isEmpty();
        assertNoModelFailure();
    }

    @Test
    @Timeout(600)
    void fg11cHarnessCrashesNeverRunTwiceOnMySql() throws Exception {
        assumeTrue(anySelected("fg11c", "claim-crash", "turn-crash", "settled-crash"));
        // A restarted Harness takes a Session over once its dead writer's lease lapses.
        springExtras.add("--qwen.managed-agent.session-store.writer-lease-duration=15s");
        storeRelayed = true;
        boot("fg11c");
        if (selected("fg11c", "claim-crash")) {
            claimCrash();
        }
        if (selected("fg11c", "turn-crash")) {
            turnCrash();
        }
        if (selected("fg11c", "settled-crash")) {
            settledCrash();
        }
        assertThat(storeHolds).as("every store hold was reached").isEmpty();
        assertThat(jdbc.queryForList("SELECT CONCAT(occurrence_key, ' ', reason) FROM ma_schedule_occurrence"
                + " WHERE tenant_id = ? AND outcome = 'unknown'", String.class, tenant))
                .as("unknown occurrences").isEmpty();
        assertNoModelFailure();
    }

    // claim-crash: the Harness dies between the run's claim (revision 1) and its dispatch
    // (revision 2), which it was holding before the store. The scanner re-drives the same
    // claim, the replay completes the dispatch on the reloaded Session, and the run executes
    // once: one chain, one accepted input and one model Turn.
    private void claimCrash() throws Exception {
        String session = createSession("claim-crash");
        String id = create(session, "FG11C_CLAIM", "0 0 1 1 *", "claim-crash-base");
        String key = "claim-crash-run";
        String runId = com.alibaba.qwen.code.managedagent.persistence.AutomationLedgerStore.automationRunId(id,
                "manual:" + key);
        Hold hold = storeHold("claim-crash", body -> (runId + ":2").equals(body.path("commandId").asText()));
        var answer = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try {
                return send("POST", "/v1/agent-automations/" + id + "/runs", null, key);
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }, modelExecutor);
        assertThat(hold.reached().await(90, TimeUnit.SECONDS)).as("revision 2 reached the store").isTrue();
        assertThat(commands(session, "fireRun")).containsExactly(runId + ":1");
        long generation = coldRestart(session);
        hold.release().countDown();
        assertUnknown(answer.get(90, TimeUnit.SECONDS));
        waiting().atMost(Duration.ofSeconds(120)).until(() -> "completed".equals(runState(runId)));
        assertThat(writerGeneration(session)).as("the reloaded Session's writer").isGreaterThan(generation);
        // The first fire never answered; each later re-drive meets the same run.
        assertOneRun(session, id, runId, "manual:" + key, -1, 0);
    }

    // turn-crash: the Harness dies with the wake turn's model call in flight. The later slot's
    // reconcile loads the Session, whose aftermath settles the run exactly once as
    // failed/outcome_unknown: the input stays consumed and the turn is never re-run.
    private void turnCrash() throws Exception {
        String session = createSession("turn-crash");
        // Park the scanner until the manual run reaches the crash point: a minute boundary
        // during setup would otherwise admit a scheduled occurrence of its own.
        scannerHold = SchedulerHold.hold(spring.getBean("managedAutomationScheduler",
                ThreadPoolTaskScheduler.class), Duration.ofSeconds(30));
        String id = create(session, "FG11C_HOLD", "* * * * *", "turn-crash-base");
        String key = "turn-crash-run";
        String runId = request("POST", "/v1/agent-automations/" + id + "/runs", null, key, 202)
                .path("id").asText();
        waiting().atMost(Duration.ofSeconds(90)).until(() -> modelPrompts.stream()
                .anyMatch(prompt -> prompt.contains("Automation ID: " + id)));
        assertThat(commands(session, "fireRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":1", runId + ":2");
        long generation = coldRestart(session);
        // Let the next minute slot drive the reconcile now that the crash is in place.
        scannerHold.countDown();
        waiting().atMost(Duration.ofSeconds(210)).untilAsserted(() -> {
            assertNoModelFailure();
            assertThat(runState(runId)).isEqualTo("failed");
        });
        assertThat(writerGeneration(session)).as("the reloaded Session's writer").isGreaterThan(generation);
        assertThat(commands(session, "settleRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":3");
        assertThat(events(session, "input.accepted")).filteredOn(event -> event.startsWith(runId + ":"))
                .containsExactly(runId + ":input:accepted");
        assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Automation ID: " + id)
                && prompt.contains("Occurrence: manual:" + key)).as("model Turns of the crashed run").hasSize(1);
        request("DELETE", "/v1/agent-automations/" + id, null, "turn-crash-retire", 202);
    }

    // settled-crash: the turn settled, and the Harness died before revision 3 reached the
    // store. On reload the run settles from the journal's turn.settled as completed, exactly
    // once, and the input is not run again.
    private void settledCrash() throws Exception {
        String session = createSession("settled-crash");
        // Park the scanner until the manual run reaches the crash point: a minute boundary
        // during setup would otherwise admit a scheduled occurrence of its own.
        scannerHold = SchedulerHold.hold(spring.getBean("managedAutomationScheduler",
                ThreadPoolTaskScheduler.class), Duration.ofSeconds(30));
        String id = create(session, "FG11C_SETTLED", "* * * * *", "settled-crash-base");
        String key = "settled-crash-run";
        String runId = com.alibaba.qwen.code.managedagent.persistence.AutomationLedgerStore.automationRunId(id,
                "manual:" + key);
        // Arm the hold before the POST: the Harness kicks the wake pump before answering
        // fire_run, so revision 3 can otherwise reach the store before the hold exists.
        Hold hold = storeHold("settled-crash", body -> (runId + ":3").equals(body.path("commandId").asText()));
        assertThat(request("POST", "/v1/agent-automations/" + id + "/runs", null, key, 202)
                .path("id").asText()).isEqualTo(runId);
        assertThat(hold.reached().await(90, TimeUnit.SECONDS)).as("revision 3 reached the store").isTrue();
        assertThat(commands(session, "fireRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":1", runId + ":2");
        assertThat(events(session, "turn.settled")).filteredOn(event -> event.contains(runId))
                .containsExactly("turn:" + runId + ":input");
        long generation = coldRestart(session);
        hold.release().countDown();
        // Let the next minute slot drive the reconcile now that the crash is in place.
        scannerHold.countDown();
        waiting().atMost(Duration.ofSeconds(210)).untilAsserted(() -> {
            assertNoModelFailure();
            assertThat(runState(runId)).isEqualTo("completed");
        });
        assertThat(writerGeneration(session)).as("the reloaded Session's writer").isGreaterThan(generation);
        assertThat(commands(session, "settleRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":3");
        assertThat(events(session, "input.accepted")).filteredOn(event -> event.startsWith(runId + ":"))
                .containsExactly(runId + ":input:accepted");
        assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Automation ID: " + id)
                && prompt.contains("Occurrence: manual:" + key)).as("model Turns of the settled run").hasSize(1);
        request("DELETE", "/v1/agent-automations/" + id, null, "settled-crash-retire", 202);
    }

    private Hold storeHold(String name, Predicate<JsonNode> rule) {
        Hold hold = new Hold(rule, new CountDownLatch(1), new CountDownLatch(1));
        assertThat(storeHolds.putIfAbsent(name, hold)).as(name).isNull();
        return hold;
    }

    // revision-1 / revision-2: the journal refuses one revision of a manual run's fire. The
    // Harness's store client gives up after its bounded retry and the manual run answers a
    // retryable 503; the Session keeps the append unsettled instead of latching (#14570). Once
    // the refusal drops, the same key settles against the durable head — the revision never
    // landed — and retries, so the run fires once without a restart. Revision 1 refused leaves
    // nothing committed; revision 2 refused leaves the claim, which the replay completes.
    private void revisionRefused(String name, String marker, int revision) throws Exception {
        String session = createSession(marker);
        String id = create(session, "FG11B_" + marker.toUpperCase(), "0 0 1 1 *", marker + "-base");
        refuse(name, "INSERT", "ma_session_journal_tx", "NEW.session_id = '" + session
                + "' AND NEW.operation = 'fireRun' AND NEW.command_id LIKE '%:" + revision + "'", "NEW.command_id");
        String key = marker + "-run";
        String path = "/v1/agent-automations/" + id + "/runs";
        assertUnknown(send("POST", path, null, key));
        List<String> refused = refusedDetails(name);
        assertThat(refused).as("the store client's bounded retry").hasSizeGreaterThanOrEqualTo(STORE_ATTEMPTS);
        assertThat(refused).containsOnly(refused.getFirst());
        String runId = refused.getFirst().substring(0, refused.getFirst().lastIndexOf(':'));
        assertThat(commands(session, "fireRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .as("committed while refused").hasSize(revision - 1);
        assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Automation ID: " + id)).isEmpty();
        dropRefusal(name);
        JsonNode run = retryUntilAccepted("POST", path, null, key);
        assertThat(run.path("id").asText()).isEqualTo(runId);
        waiting().atMost(Duration.ofSeconds(60)).until(() -> "completed".equals(runState(runId)));
        assertThat(commands(session, "fireRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":1", runId + ":2");
        assertThat(commands(session, "settleRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":3");
        assertThat(events(session, "input.accepted")).filteredOn(event -> event.startsWith(runId + ":"))
                .containsExactly(runId + ":input:accepted");
        assertThat(events(session, "turn.settled")).filteredOn(event -> event.contains(runId))
                .containsExactly("turn:" + runId + ":input");
        assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Automation ID: " + id)).hasSize(1);
        assertThat(jdbc.queryForObject("SELECT outcome FROM ma_schedule_occurrence WHERE tenant_id = ? AND"
                + " schedule_id = ? AND occurrence_key = ?", String.class, tenant, id, "manual:" + key))
                .isEqualTo("fired");
    }

    // store-transport: the store commits a manual run's first revision and its answer to the
    // Harness is lost on the connection. The store client's bounded retry sends the same command
    // again, the store answers it as the commit it holds, and the fire goes on: the run fires
    // once, with no failure reaching the caller and no restart.
    private void storeTransport() throws Exception {
        String session = createSession("transport");
        String id = create(session, "FG11B_TRANSPORT", "0 0 1 1 *", "transport-base");
        String key = "transport-run";
        String runId = com.alibaba.qwen.code.managedagent.persistence.AutomationLedgerStore.automationRunId(id,
                "manual:" + key);
        storeDrop.set(runId + ":1");
        JsonNode run = request("POST", "/v1/agent-automations/" + id + "/runs", null, key, 202);
        assertThat(run.path("id").asText()).isEqualTo(runId);
        assertThat(storeDrop.get()).as("the commit's answer was dropped").isNull();
        assertThat(storeCommits).filteredOn(commit -> commit.startsWith(runId + ":1 "))
                .as("the commit and its replay").hasSize(2).first().isEqualTo(runId + ":1 dropped");
        waiting().atMost(Duration.ofSeconds(60)).until(() -> "completed".equals(runState(runId)));
        assertThat(commands(session, "fireRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":1", runId + ":2");
        assertThat(commands(session, "settleRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":3");
        assertThat(events(session, "turn.settled")).filteredOn(event -> event.contains(runId))
                .containsExactly("turn:" + runId + ":input");
        assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Automation ID: " + id)).hasSize(1);
    }

    // projection: the schedule mirror's projection of an update is refused inside the journal
    // commit's own transaction, so the revision rolls back with it: neither the journal nor the
    // mirror moves past revision 1. After a restart, the retry under the same key commits
    // revision 2 once, and the journal and the mirror agree.
    private void projectionRefused() throws Exception {
        String session = createSession("projection");
        String id = create(session, "FG11B_PROJECTION", "0 0 1 1 *", "projection-base");
        refuse("projection", "UPDATE", "ma_schedule", "NEW.schedule_id = '" + id
                + "' AND NEW.definition_revision <> OLD.definition_revision", "NEW.definition_revision");
        Map<String, Object> update = Map.of("prompt", "FG11B_PROJECTION_TWO reply with FG11_DONE.");
        String path = "/v1/agent-automations/" + id;
        assertUnknown(send("POST", path, update, "projection-update"));
        assertThat(refusedDetails("projection")).as("the store client's bounded retry")
                .hasSizeGreaterThanOrEqualTo(STORE_ATTEMPTS).containsOnly("2");
        assertThat(commands(session, "defineSchedule")).as("the rolled-back revision").hasSize(1);
        assertThat(recordRevision(session, "schedule", id)).isEqualTo(1);
        assertThat(mirrorRevision(id)).isEqualTo(1);
        dropRefusal("projection");
        long generation = coldRestart(session);
        JsonNode revised = retryUntilAccepted("POST", path, update, "projection-update");
        assertThat(revised.path("definition_revision").asLong()).isEqualTo(2);
        assertThat(writerGeneration(session)).as("the reloaded Session's writer").isGreaterThan(generation);
        assertThat(commands(session, "defineSchedule")).hasSize(2);
        assertThat(recordRevision(session, "schedule", id)).isEqualTo(2);
        assertThat(mirrorRevision(id)).isEqualTo(2);
    }

    // A Harness-side store failure reaches the caller as the operation's unknown outcome, never
    // as a refusal the caller would not retry.
    private static void assertUnknown(HttpResponse<String> response) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(503);
        assertThat(response.body()).contains("automation_operation_unknown");
    }

    // SIGKILLs the Harness and starts a cold one on the same port, and returns the Session's
    // writer generation before it; the next relay that reaches the Session reloads it.
    private long coldRestart(String session) throws Exception {
        long generation = writerGeneration(session);
        harness.descendants().forEach(ProcessHandle::destroyForcibly);
        harness.destroyForcibly();
        assertThat(harness.waitFor(20, TimeUnit.SECONDS)).as("the killed Harness exited").isTrue();
        startHarness();
        return generation;
    }

    // Retries the same request, under the same key, until the reloaded Session answers it: the
    // dead writer's lease lapses first, and every attempt before that is the same operation.
    // Until it lapses the cold Harness's load is refused, and the public route passes that
    // through as 409 managed_session_writer_conflict (see the design's Findings); any other
    // refusal fails the case.
    private JsonNode retryUntilAccepted(String method, String path, Object body, String key) throws Exception {
        AtomicReference<HttpResponse<String>> accepted = new AtomicReference<>();
        waiting().atMost(Duration.ofSeconds(90)).pollInterval(Duration.ofSeconds(1)).until(() -> {
            HttpResponse<String> response = send(method, path, body, key);
            if (response.statusCode() == 409) {
                assertThat(response.body()).contains("managed_session_writer_conflict");
            } else {
                assertThat(response.statusCode()).as(response.body()).isIn(202, 503);
            }
            accepted.set(response);
            return response.statusCode() == 202;
        });
        return json.readTree(accepted.get().body());
    }

    private long mirrorRevision(String scheduleId) {
        return jdbc.queryForObject("SELECT definition_revision FROM ma_schedule WHERE tenant_id = ? AND"
                + " schedule_id = ?", Long.class, tenant, scheduleId);
    }

    // occurrence-insert: the scanner's record of the next slot is refused in MySQL. Nothing
    // fires while it is; once the refusal is dropped, that same slot, still timely, is recorded
    // and fires once. A later minute firing in its place would mean the slot was lost.
    private Clocked occurrenceInsert() throws Exception {
        String session = createSession("insert");
        String id = create(session, "FG11B_INSERT", "* * * * *", "insert-base");
        refuse("occurrence-insert", "INSERT", "ma_schedule_occurrence", "NEW.schedule_id = '" + id + "'",
                "NEW.occurrence_key");
        return () -> {
            awaitRefused("occurrence-insert", 2);
            List<String> refused = refusedDetails("occurrence-insert");
            assertThat(refused).as("every refusal is the one slot's record").containsOnly(refused.getFirst());
            assertThat(operations).filteredOn(operation -> id.equals(operation.scheduleId())
                    && kind(operation, "fire_run")).as("fires while the record is refused").isEmpty();
            assertThat(occurrenceKeys(id)).isEmpty();
            dropRefusal("occurrence-insert");
            Map<String, Object> occurrence = awaitOccurrence(id, "fired");
            assertThat(occurrence.get("occurrence_key")).as("the refused slot is the one that fired")
                    .isEqualTo(refused.getFirst());
            assertThat(((Number) occurrence.get("attempts")).intValue()).isZero();
            assertOneRun(session, id, (String) occurrence.get("run_id"), (String) occurrence.get("occurrence_key"),
                    1, 0);
            request("DELETE", "/v1/agent-automations/" + id, null, "insert-retire", 202);
        };
    }

    // occurrence-settle: the fire commits on the Harness, and settling its occurrence fired is
    // refused. The occurrence stays firing and is re-driven; every re-drive meets the same run,
    // and once the refusal drops it settles fired with one run chain and one model Turn.
    private Clocked occurrenceSettle() throws Exception {
        String session = createSession("settle");
        String id = create(session, "FG11B_SETTLE", "* * * * *", "settle-base");
        refuse("occurrence-settle", "UPDATE", "ma_schedule_occurrence", "NEW.schedule_id = '" + id
                + "' AND NEW.outcome = 'fired'", "NEW.occurrence_key");
        return () -> {
            awaitRefused("occurrence-settle", 2);
            List<String> refused = refusedDetails("occurrence-settle");
            assertThat(refused).as("every refusal is the one slot's settle").containsOnly(refused.getFirst());
            assertThat(jdbc.queryForList("SELECT outcome FROM ma_schedule_occurrence WHERE tenant_id = ? AND"
                    + " schedule_id = ?", String.class, tenant, id)).containsExactly("firing");
            dropRefusal("occurrence-settle");
            Map<String, Object> occurrence = awaitOccurrence(id, "fired");
            assertThat(occurrence.get("occurrence_key")).isEqualTo(refused.getFirst());
            int attempts = ((Number) occurrence.get("attempts")).intValue();
            assertThat(attempts).as("re-drives").isGreaterThanOrEqualTo(2);
            assertOneRun(session, id, (String) occurrence.get("run_id"), (String) occurrence.get("occurrence_key"),
                    attempts + 1, 0);
            request("DELETE", "/v1/agent-automations/" + id, null, "settle-retire", 202);
        };
    }

    // watermark: the slot fires and settles, and the watermark advance after it is refused, so
    // every later tick derives the same slot again. Its recorded decision stands: one
    // occurrence and one fire, and the watermark moves once the refusal drops.
    private Clocked watermark() throws Exception {
        String session = createSession("watermark");
        String id = create(session, "FG11B_WATERMARK", "* * * * *", "watermark-base");
        refuse("watermark", "UPDATE", "ma_schedule", "NEW.schedule_id = '" + id
                + "' AND NOT (NEW.watermark_slot <=> OLD.watermark_slot)", "NEW.watermark_slot");
        return () -> {
            Map<String, Object> occurrence = awaitOccurrence(id, "fired");
            long slot = ((Number) occurrence.get("slot")).longValue();
            awaitRefused("watermark", 3);
            assertThat(occurrenceKeys(id)).containsExactly((String) occurrence.get("occurrence_key"));
            assertOneRun(session, id, (String) occurrence.get("run_id"), (String) occurrence.get("occurrence_key"),
                    1, 0);
            dropRefusal("watermark");
            waiting().atMost(Duration.ofSeconds(30)).until(() -> {
                Long watermark = jdbc.queryForObject("SELECT watermark_slot FROM ma_schedule WHERE tenant_id = ?"
                        + " AND schedule_id = ?", Long.class, tenant, id);
                return watermark != null && watermark >= slot;
            });
            request("DELETE", "/v1/agent-automations/" + id, null, "watermark-retire", 202);
        };
    }

    // revision-race: the scanner's fire of revision 1 is parked before the Harness while an
    // update commits revision 2. The Harness answers automation_revision_stale, and the scanner
    // re-pins the occurrence and fires revision 2: the slot fires once, never skipped. The
    // update lands as soon as the fire is parked, well inside the connector's request timeout:
    // a fire parked past it would be re-driven on its own.
    private Clocked revisionRace() throws Exception {
        String session = createSession("race");
        String id = create(session, "FG11B_RACE_ONE", "* * * * *", "race-base");
        Hold hold = hold("revision-race", body -> kind(body, "fire_run") && id.equals(body.path("scheduleId")
                .asText()));
        var update = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try {
                assertThat(hold.reached().await(150, TimeUnit.SECONDS)).as("the fire reached the relay").isTrue();
                return request("POST", "/v1/agent-automations/" + id, Map.of("prompt",
                        "FG11B_RACE_TWO reply with FG11_DONE."), "race-update", 202).path("definition_revision")
                        .asLong();
            } catch (Exception error) {
                throw new IllegalStateException(error);
            } finally {
                hold.release().countDown();
            }
        }, modelExecutor);
        return () -> {
            assertThat(update.get(150, TimeUnit.SECONDS)).isEqualTo(2);
            Map<String, Object> occurrence = awaitOccurrence(id, "fired");
            String key = (String) occurrence.get("occurrence_key");
            var fires = operations.stream().filter(operation -> id.equals(operation.scheduleId())
                    && kind(operation, "fire_run") && key.equals(operation.occurrenceKey())).toList();
            assertThat(fires).extracting(Operation::status).containsExactly(409, 202);
            assertThat(fires).extracting(operation -> revisionOf(operation)).containsExactly(1L, 2L);
            assertOneRun(session, id, (String) occurrence.get("run_id"), key, 2, 0);
            assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Automation ID: " + id)
                    && prompt.contains("Occurrence: " + key)).singleElement()
                    .satisfies(prompt -> assertThat(prompt).contains("FG11B_RACE_TWO"));
            request("DELETE", "/v1/agent-automations/" + id, null, "race-retire", 202);
        };
    }

    // receipt-claim: the create's request receipt is refused in MySQL before anything is
    // relayed. Nothing reaches the Harness, the caller is not told a refusal it would not retry,
    // and once the refusal drops the retry creates the definition once.
    private void receiptClaim() throws Exception {
        String session = createSession("claim");
        refuse("receipt-claim", "INSERT", "ma_request_receipt", "NEW.idempotency_key = 'receipt-claim'", "NULL");
        Map<String, Object> definition = definition(session, "FG11B_CLAIM", "0 0 1 1 *");
        HttpResponse<String> refused = send("POST", "/v1/agent-automations", definition, "receipt-claim");
        assertThat(refused.statusCode()).as(refused.body()).isGreaterThanOrEqualTo(500);
        assertThat(refusedCount("receipt-claim")).isPositive();
        assertThat(operations).filteredOn(operation -> kind(operation, "define_schedule")
                && operation.body().contains("FG11B_CLAIM")).as("relayed without a receipt").isEmpty();
        dropRefusal("receipt-claim");
        String id = request("POST", "/v1/agent-automations", definition, "receipt-claim", 202).path("id").asText();
        assertOperations(id, "define_schedule", 1, 0);
        assertThat(commands(session, "defineSchedule")).hasSize(1);
    }

    // receipt-settle: the Harness commits the definition and Spring's settle of the receipt is
    // refused. The retry finds the receipt claimed but unanswered, re-drives the same operation
    // id, and answers the committed revision 1 without committing again.
    private void receiptSettle() throws Exception {
        String session = createSession("receipt");
        refuse("receipt-settle", "UPDATE", "ma_request_receipt", "NEW.idempotency_key = 'receipt-settle'"
                + " AND NEW.result_json <> ''", "NULL");
        Map<String, Object> definition = definition(session, "FG11B_RECEIPT", "0 0 1 1 *");
        HttpResponse<String> refused = send("POST", "/v1/agent-automations", definition, "receipt-settle");
        assertThat(refused.statusCode()).as(refused.body()).isGreaterThanOrEqualTo(500);
        assertThat(refusedCount("receipt-settle")).isPositive();
        dropRefusal("receipt-settle");
        JsonNode created = request("POST", "/v1/agent-automations", definition, "receipt-settle", 202);
        String id = created.path("id").asText();
        assertThat(created.path("definition_revision").asLong()).isEqualTo(1);
        assertOperations(id, "define_schedule", 2, 0);
        assertThat(sameOperationId(id, "define_schedule")).isTrue();
        assertThat(commands(session, "defineSchedule")).hasSize(1);
    }

    private String create(String session, String marker, String cron, String key) throws Exception {
        return request("POST", "/v1/agent-automations", definition(session, marker, cron), key, 202).path("id")
                .asText();
    }

    private Hold hold(String name, Predicate<JsonNode> rule) {
        Hold hold = new Hold(rule, new CountDownLatch(1), new CountDownLatch(1));
        assertThat(holds.putIfAbsent(name, hold)).as(name).isNull();
        return hold;
    }

    private static boolean kind(Operation operation, String kind) {
        return kind.equals(operation.kind());
    }

    private long revisionOf(Operation operation) {
        try {
            return json.readTree(operation.body()).path("definitionRevision").asLong();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private List<String> occurrenceKeys(String scheduleId) {
        return jdbc.queryForList("SELECT occurrence_key FROM ma_schedule_occurrence WHERE tenant_id = ? AND"
                + " schedule_id = ? ORDER BY slot", String.class, tenant, scheduleId);
    }

    // FG9b's store refusal: a trigger refuses every write of this tenant that matches until it is
    // dropped, and the MyISAM row it writes first survives the rollback, so a case can count the
    // refusals and read what each one refused ({@code detail}, an expression over NEW).
    private void refuse(String name, String event, String table, String condition, String detail) {
        jdbc.execute("CREATE TABLE IF NOT EXISTS fg11b_fire (tenant_id VARCHAR(64) NOT NULL, case_name"
                + " VARCHAR(64) NOT NULL, detail VARCHAR(512) NULL, fired_at TIMESTAMP(6) NOT NULL DEFAULT"
                + " CURRENT_TIMESTAMP(6)) ENGINE = MyISAM");
        String trigger = "fg11b_" + UUID.randomUUID().toString().replace("-", "");
        assertThat(refusals.putIfAbsent(name, trigger)).as(name).isNull();
        jdbc.execute("CREATE TRIGGER " + trigger + " BEFORE " + event + " ON " + table + " FOR EACH ROW BEGIN IF"
                + " NEW.tenant_id = '" + tenant + "' AND " + condition + " THEN INSERT INTO fg11b_fire (tenant_id,"
                + " case_name, detail) VALUES ('" + tenant + "', '" + name + "', " + detail + "); SIGNAL SQLSTATE"
                + " '45000' SET MESSAGE_TEXT = 'FG11B_" + name.toUpperCase().replace('-', '_') + "'; END IF; END");
    }

    private void dropRefusal(String name) {
        jdbc.execute("DROP TRIGGER IF EXISTS " + refusals.remove(name));
    }

    // Drops every trigger this test installed, each on its own so one failing drop leaves none of
    // the others on the shared fork's schema, then the refusal table they wrote to.
    private void dropRefusals() {
        if (jdbc == null) {
            return;
        }
        RuntimeException failure = null;
        try {
            for (String trigger : refusals.values()) {
                try {
                    jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
                } catch (RuntimeException error) {
                    if (failure == null) {
                        failure = error;
                    } else {
                        failure.addSuppressed(error);
                    }
                }
            }
            jdbc.execute("DROP TABLE IF EXISTS fg11b_fire");
        } finally {
            refusals.clear();
        }
        if (failure != null) {
            throw failure;
        }
    }

    private int refusedCount(String name) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM fg11b_fire WHERE tenant_id = ? AND case_name = ?",
                Integer.class, tenant, name);
    }

    private List<String> refusedDetails(String name) {
        return jdbc.queryForList("SELECT detail FROM fg11b_fire WHERE tenant_id = ? AND case_name = ? ORDER BY"
                + " fired_at", String.class, tenant, name);
    }

    private void awaitRefused(String name, int times) {
        waiting().atMost(Duration.ofSeconds(150)).untilAsserted(() -> {
            assertNoModelFailure();
            assertThat(refusedCount(name)).as("%s refusals", name).isGreaterThanOrEqualTo(times);
        });
    }

    private boolean anySelected(String letter, String... names) {
        for (String name : names) {
            if (selected(letter, name)) {
                return true;
            }
        }
        return false;
    }

    private boolean selected(String letter, String name) {
        String selected = System.getProperty("qwen." + letter + ".case", "");
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
            int fires, int dropped) throws Exception {
        waiting().atMost(Duration.ofSeconds(60)).until(() -> "completed".equals(runState(runId)));
        var fired = operations.stream().filter(operation -> scheduleId.equals(operation.scheduleId())
                && "fire_run".equals(operation.kind()) && occurrenceKey.equals(operation.occurrenceKey())).toList();
        // A negative count asks only that the occurrence was fired at least once: a crash
        // case cannot know how many transient refusals its re-drive met first.
        if (fires < 0) {
            assertThat(fired).as("fires of %s", occurrenceKey).isNotEmpty();
        } else {
            assertThat(fired).as("fires of %s", occurrenceKey).hasSize(fires);
        }
        assertThat(fired).filteredOn(Operation::dropped).hasSize(dropped);
        assertThat(commands(session, "fireRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":1", runId + ":2");
        assertThat(commands(session, "settleRun")).filteredOn(command -> command.startsWith(runId + ":"))
                .containsExactly(runId + ":3");
        assertThat(recordRevision(session, "automation_run", runId)).isEqualTo(3);
        assertThat(events(session, "input.accepted")).filteredOn(event -> event.startsWith(runId + ":"))
                .containsExactly(runId + ":input:accepted");
        assertThat(events(session, "turn.settled")).filteredOn(event -> event.contains(runId))
                .containsExactly("turn:" + runId + ":input");
        assertThat(modelPrompts).filteredOn(prompt -> prompt.contains("Automation ID: " + scheduleId)
                && prompt.contains("Occurrence: " + occurrenceKey)).hasSize(1);
        Map<String, Object> occurrence = jdbc.queryForMap("SELECT outcome, run_id FROM ma_schedule_occurrence"
                + " WHERE tenant_id = ? AND schedule_id = ? AND occurrence_key = ?", tenant, scheduleId,
                occurrenceKey);
        assertThat(occurrence).containsEntry("outcome", "fired").containsEntry("run_id", runId);
    }

    private Map<String, Object> awaitOccurrence(String scheduleId, String outcome) {
        AtomicReference<Map<String, Object>> found = new AtomicReference<>();
        waiting().atMost(Duration.ofSeconds(150)).until(() -> {
            var rows = jdbc.queryForList("SELECT occurrence_key, slot, outcome, reason, attempts, run_id FROM"
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

    // FG11d: a definition created disabled records no fired occurrence and no
    // run across two due slots, and the first slot after enabling fires once.
    @Test
    @Timeout(600)
    void fg11dDisabledSpanNeverFiresOnMySql() throws Exception {
        boot("fg11d");
        String session = createSession("disable");
        Map<String, Object> body = new java.util.LinkedHashMap<>(
                definition(session, "FG11D_DISABLE", "* * * * *"));
        body.put("enabled", false);
        String id = request("POST", "/v1/agent-automations", body, "fg11d-base", 202).path("id").asText();
        long disabledAt = System.currentTimeMillis();
        // Two minute boundaries pass while the definition is disabled.
        waiting().atMost(Duration.ofSeconds(200)).until(() -> System.currentTimeMillis()
                >= (disabledAt / 60_000 + 2) * 60_000 + 5_000);
        assertThat(jdbc.queryForList("SELECT occurrence_key FROM ma_schedule_occurrence WHERE tenant_id = ?"
                + " AND schedule_id = ? AND outcome = 'fired'", String.class, tenant, id))
                .as("no slot fires while disabled").isEmpty();
        assertThat(jdbc.queryForList("SELECT record_id FROM ma_session_record WHERE tenant_id = ?"
                + " AND session_id = ? AND domain = 'automation_run'", String.class, tenant, session))
                .as("no run while disabled").isEmpty();
        long enabledAt = System.currentTimeMillis();
        request("POST", "/v1/agent-automations/" + id, Map.of("enabled", true), "fg11d-enable", 202);
        Map<String, Object> fired = awaitOccurrence(id, "fired");
        assertThat(fired).as("the first slot after enabling fires").containsEntry("outcome", "fired");
        // A dropped re-arm back-fills the disabled span instead of arming now.
        assertThat(((Number) fired.get("slot")).longValue())
                .as("the fired slot is not older than the enable").isGreaterThanOrEqualTo(enabledAt);
        assertThat(jdbc.queryForList("SELECT occurrence_key FROM ma_schedule_occurrence WHERE tenant_id = ?"
                + " AND schedule_id = ? AND outcome = 'fired'", String.class, tenant, id))
                .as("exactly one fired slot after enabling").hasSize(1);
        assertThat(jdbc.queryForList("SELECT record_id FROM ma_session_record WHERE tenant_id = ?"
                + " AND session_id = ? AND domain = 'automation_run'", String.class, tenant, session))
                .as("exactly one run after enabling").hasSize(1);
        request("DELETE", "/v1/agent-automations/" + id, null, "fg11d-retire", 202);
    }

    private void boot(String letter) throws Exception {
        assertThat(System.getProperty("mysql.url")).as("FG11 requires real MySQL").startsWith("jdbc:mysql:");
        this.letter = letter;
        tenant = letter.replace("fg11", "fg11-") + "-" + UUID.randomUUID().toString().substring(0, 8);
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
            public boolean before(HostedLifecycleRelay.Request request) throws Exception {
                return held(request);
            }

            @Override
            public boolean after(HostedLifecycleRelay.Request request, int status) throws Exception {
                return relayed(request, status);
            }
        });
        if (storeRelayed) {
            storeRelay = new HostedLifecycleRelay();
            storeRelay.backend(URI.create("http://127.0.0.1:" + port));
            storeRelay.fault(new HostedLifecycleRelay.Fault() {
                @Override
                public boolean before(HostedLifecycleRelay.Request request) throws Exception {
                    return storeHeld(request);
                }

                @Override
                public boolean after(HostedLifecycleRelay.Request request, int status) throws Exception {
                    return storeAnswered(request, status);
                }
            });
        }
        startSpring(cli, root, brokerPort);
        harnessCli = cli;
        startHarness();
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

    // Records each journal commit the Harness sends the store, by command id, and closes the
    // connection without the store's answer for the armed one: the store committed it, and the
    // Harness never reads that it did.
    private boolean storeAnswered(HostedLifecycleRelay.Request request, int status) throws Exception {
        if (!"POST".equals(request.method()) || !request.path().contains("/transactions:commit")) {
            return true;
        }
        String command = json.readTree(request.body()).path("commandId").asText();
        String wanted = storeDrop.get();
        boolean drop = status / 100 == 2 && command.equals(wanted) && storeDrop.compareAndSet(wanted, null);
        storeCommits.add(command + (drop ? " dropped" : " " + status));
        return !drop;
    }

    // Parks the armed journal commit before the store sees it, then drops it: the Harness that
    // sent it is killed while it waits, and the revision never commits.
    private boolean storeHeld(HostedLifecycleRelay.Request request) throws Exception {
        if (!"POST".equals(request.method()) || !request.path().contains("/transactions:commit")) {
            return true;
        }
        JsonNode body = json.readTree(request.body());
        for (var hold : storeHolds.entrySet()) {
            if (hold.getValue().rule().test(body) && storeHolds.remove(hold.getKey()) != null) {
                hold.getValue().reached().countDown();
                assertThat(hold.getValue().release().await(90, TimeUnit.SECONDS)).as(hold.getKey()).isTrue();
                return false;
            }
        }
        return true;
    }

    // Parks the first automation operation a hold rule matches until its case releases it, then
    // forwards it.
    private boolean held(HostedLifecycleRelay.Request request) throws Exception {
        if (!"POST".equals(request.method()) || !request.path().endsWith(OPERATIONS)) {
            return true;
        }
        JsonNode body = json.readTree(request.body());
        for (var hold : holds.entrySet()) {
            if (hold.getValue().rule().test(body) && holds.remove(hold.getKey()) != null) {
                hold.getValue().reached().countDown();
                assertThat(hold.getValue().release().await(90, TimeUnit.SECONDS)).as(hold.getKey()).isTrue();
                break;
            }
        }
        return true;
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
                "--qwen.managed-agent.session-store.base-url="
                        + (storeRelay == null ? "http://127.0.0.1:" + port : storeRelay.uri()),
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
        arguments.addAll(springExtras);
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
            spring.getBean(com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard.class)
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

    // A cold Harness: a fresh HOME and QWEN_HOME each start, on the same port.
    private void startHarness() throws Exception {
        Path cli = harnessCli;
        Path home = Files.createDirectory(temporary.resolve("home-" + UUID.randomUUID()));
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
                .directory(decoy.toFile()).redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()));
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
            // FG11c's turn-crash holds only its manual run's wake turn: later slots of the
            // same definition must keep running while the crashed one is reconciled.
            if (prompt.contains("FG11A_HOLD")
                    || (prompt.contains("FG11C_HOLD") && prompt.contains("Occurrence: manual:"))) {
                // Outlive the whole method: a crash case releases this in teardown, and a
                // timeout here would surface as a broken pipe during the NEXT case.
                heldModel.await(900, TimeUnit.SECONDS);
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
        if (storeRelay != null) {
            assertThat(storeRelay.failure()).as("store relay").isNull();
        }
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

    private long writerGeneration(String session) {
        Long generation = jdbc.queryForObject("SELECT writer_generation FROM ma_session_head WHERE tenant_id = ?"
                + " AND session_id = ?", Long.class, tenant, session);
        return generation == null ? 0 : generation;
    }

    // The relay's operation log and the Harness log, kept for the CI upload either way.
    private void writeEvidence() throws IOException {
        if (temporary == null || harnessRelay == null) {
            return;
        }
        Path cases = Files.createDirectories(Path.of("target", "fg11-cases", letter, tenant));
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
        holds.values().forEach(hold -> hold.release().countDown());
        // A crash case that failed before its SIGKILL must not leave the relay waiting on a
        // commit the store will never see.
        storeHolds.values().forEach(hold -> hold.release().countDown());
        Throwable failure = null;
        List<org.junit.jupiter.api.function.Executable> cleanup = List.of(
                this::writeEvidence,
                this::dropRefusals,
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
                () -> { if (storeRelay != null) {
                    storeRelay.close();
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
