/**
 * Copyright 2026 Alibaba Group
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.workspace.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.awaitility.core.ConditionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.AfterTestExecutionCallback;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
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
import java.security.MessageDigest;
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.LongStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * FG10 (#14165) b–f: the relay-driven settlement of a `child_run`
 * `workflow` launch under fault — a real Spring managed-agent server on
 * MySQL, the embedded Runtime Broker, the packaged Hosted Harness and a
 * scripted model. A coordinator-owned team lead calls `workflow` with a
 * script making one in-process `agent()` call; the child result relay
 * creates and binds the child Session, the child Turn runs the script,
 * the result revision settles the lead's `child_run` record and the
 * notification lands on the lead as a `<task-notification>` input its
 * wake Turn reads. FG10a pins the digest at the child Turn with a
 * driver-held parent; these letters need the coordinator-owned parent
 * because they assert the record's settlement.
 *
 * FG10b drops the store reply to the dispatch revision, to the child
 * Turn's own journal commit and to the result revision: at most one
 * workflow instance per launch — one child Session, one run of the
 * script, one `agent()` dispatch — and one notification. FG10f drops the
 * reply to the notification's commit (delivered at most once) and cuts
 * the child Session's public and WebShell streams while the subagent is
 * in flight: each resumes with no gap and no duplicate.
 *
 * FG10c refuses, at the store, the lead's result revision and the
 * acceptance that lands the notification, only after the child Turn
 * completed and the lead's own Turn settled: the latched lead never
 * advances the record or delivers anything, and after a cold restart the
 * walk resumes through the same run — the script never runs again. FG10e
 * cancels the workflow task while its `agent()` request is held, again
 * with its reply lost, and after settlement: a cancelled record leaves
 * nothing running under it, a lost reply replays the admitted cancel, and
 * a settled run refuses it.
 *
 * FG10d SIGKILLs the Harness under an attached run — with its `agent()`
 * request in flight, and with its work done but the child Turn's
 * settlement swallowed before it reached the store — and starts a cold
 * one: the run is never re-executed and never settled as if observed;
 * the Turn parks marked, the cold load refuses, and the record settles
 * `recovery_blocked` over `outcome_unknown` with an `unknown` ledger and
 * one honest notification (#14387).
 */
class HostedWorkflowRelayFaultGatesIT {
    private static final String TOKEN = "fg10-fixture";
    private static final String DIGEST = "sha256:" + "c".repeat(64);
    /** What the workflow runtime tells every subagent it spawns; the one
     * request that carries it is an `agent()` dispatch. */
    private static final String SUBAGENT_PROMPT =
            "subagent spawned by a workflow";
    private static final String SUB_ANSWER = "FG10_SUB_ANSWER";
    /** An SSE comment: the client's parser skips it, but a write that
     * meets a connection its client aborted fails. */
    private static final byte[] KEEPALIVE = ": fg10 hold\n\n"
            .getBytes(StandardCharsets.UTF_8);
    private static final String SCRIPT = "export const meta = { name:"
            + " \"fg10relay\", description: \"fg10\" };\n"
            + "const answer = await agent(\"FG10_SUB_PROMPT\");\n"
            + "return \"FG10_RESULT \" + answer;";
    private static final String RESULT = "FG10_RESULT " + SUB_ANSWER;
    /** The command id the store proxy logs beside a commit's operation. */
    private static final Pattern COMMAND = Pattern.compile(" cmd=(\\S+) ");
    /** The store client's bounded uncertain-error retry of one commit:
     * `ManagedSessionStoreHttpClient.appendTransaction`'s commit loop
     * (`packages/core/src/managed-runtime/http-managed-session-store.ts`)
     * rethrows once `const exhausted = attempt >= 2`, the third attempt,
     * for every operation but `renewActivation`, which alone may retry
     * past the cap while its lease lasts. */
    private static final int STORE_ATTEMPTS = 3;

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final AtomicReference<Throwable> modelFailure =
            new AtomicReference<>();
    private final AtomicInteger subagentCalls = new AtomicInteger();
    private final AtomicInteger wakeRounds = new AtomicInteger();
    private final AtomicReference<CountDownLatch> subagentHold =
            new AtomicReference<>();
    private volatile CountDownLatch subagentHeld = new CountDownLatch(1);
    private final List<String> slotTenants = new ArrayList<>();
    private final List<Observer> observers = new CopyOnWriteArrayList<>();
    private final AtomicInteger caseSlot = new AtomicInteger();
    private final List<String> refusals = new ArrayList<>();
    private volatile CountDownLatch subagentAborted = new CountDownLatch(1);
    private volatile boolean subagentAbortExpected;

    @TempDir
    private Path temporary;
    private String tenant;
    private ServletWebServerApplicationContext spring;
    private HttpServer model;
    private ExecutorService modelThreads;
    private volatile Path harnessLog;
    private volatile Process harness;
    private volatile JdbcTemplate jdbc;
    private HostedSessionRelayForwardingProxy storeProxy;
    private HostedSessionRelayForwardingProxy publicProxy;
    private int port;
    private int harnessPort;
    private int brokerPort;
    private Path casesRoot;

    @RegisterExtension
    final AfterTestExecutionCallback harnessLogOnFailure = context -> {
        Path log = harnessLog;
        if (context.getExecutionException().isPresent() && log != null
                && Files.exists(log)) {
            String text = Files.readString(log);
            System.out.println("--- harness.log (tail) ---\n"
                    + text.substring(Math.max(0, text.length() - 20_000)));
        }
    };

    @AfterEach
    void tearDown() {
        observers.forEach(observer -> observer.client.shutdownNow());
        CountDownLatch hold = subagentHold.getAndSet(null);
        if (hold != null) {
            hold.countDown();
        }
        if (harness != null) {
            harness.destroyForcibly();
            try {
                harness.waitFor(20, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        if (jdbc != null && spring != null && spring.isActive()) {
            dropRefusals();
            jdbc.execute("DROP TABLE IF EXISTS fg10c_fire");
        }
        if (storeProxy != null) {
            storeProxy.close();
        }
        if (publicProxy != null) {
            publicProxy.close();
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

    @Test
    @Timeout(600)
    void fg10bLostRepliesNeverRunAWorkflowTwiceOnMySql() throws Exception {
        runLetter("fg10b", List.of("dispatch-reply", "child-message-reply",
                "result-reply"));
    }

    @Test
    @Timeout(600)
    void fg10fNotificationsAndStreamsDeliverOnceOnMySql() throws Exception {
        runLetter("fg10f", List.of("notification-reply",
                "child-stream-resume"));
    }

    @Test
    @Timeout(600)
    void fg10cRefusedRelayCommitsNeverAdvanceAWorkflowOnMySql()
            throws Exception {
        runLetter("fg10c", List.of("result-revision-refused",
                "notification-refused"));
    }

    @Test
    @Timeout(600)
    void fg10eCancelledWorkflowsLeaveNothingRunningOnMySql()
            throws Exception {
        runLetter("fg10e", List.of("cancel-subagent-in-flight",
                "cancel-reply-lost", "cancel-after-settlement"));
    }

    @Test
    @Timeout(600)
    void fg10dKilledWorkflowsSettleBlockedAndNeverRunAgainOnMySql()
            throws Exception {
        runLetter("fg10d", List.of("kill-mid-workflow-subagents-in-flight",
                "kill-after-last-subagent-before-settlement"));
    }

    // ---------------------------------------------------------- letters

    private void runLetter(String letter, List<String> caseNames)
            throws Exception {
        String selected = System.getProperty("qwen." + letter + ".case");
        if (selected != null) {
            assertThat(caseNames).as("unknown case " + selected)
                    .contains(selected);
            caseNames = List.of(selected);
        }
        boot(letter, caseNames.size());
        for (String name : caseNames) {
            subagentCalls.set(0);
            wakeRounds.set(0);
            subagentHold.set(null);
            subagentHeld = new CountDownLatch(1);
            subagentAborted = new CountDownLatch(1);
            subagentAbortExpected = false;
            switch (name) {
                case "dispatch-reply" -> dispatchReply();
                case "child-message-reply" -> childMessageReply();
                case "result-reply" -> resultReply();
                case "notification-reply" -> notificationReply();
                case "child-stream-resume" -> childStreamResume();
                case "result-revision-refused" -> refusedAfterChild(
                        "result-revision-refused", "UPDATE",
                        "NEW.domain = 'child_run' AND NEW.revision = 4");
                case "notification-refused" -> refusedAfterChild(
                        "notification-refused", "INSERT",
                        "NEW.domain = 'child_acceptance'");
                case "cancel-subagent-in-flight" -> cancelInFlight(false);
                case "cancel-reply-lost" -> cancelInFlight(true);
                case "cancel-after-settlement" -> cancelAfterSettlement();
                case "kill-mid-workflow-subagents-in-flight" ->
                        killMidWorkflow(false);
                case "kill-after-last-subagent-before-settlement" ->
                        killMidWorkflow(true);
                default -> throw new IllegalArgumentException(
                        "unknown case " + letter + "/" + name);
            }
        }
    }

    // --------------------------------------------------- case: FG10b-1

    /** The relay's dispatch revision lands but its reply is held past
     * the relay's request timeout, so the relay re-drives the step under a
     * fresh operation while the first is still in flight: both resolve
     * through the same revision, the child Session is created once and
     * the script runs once. */
    private void dispatchReply() throws Exception {
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.hold(
                matchChildRunCommit(2), "dispatch-hold", 1));
        String lead = launch("dispatch");
        holdPastRelayTimeout(lead, "dispatch-hold");
        awaitConsumed(lead);
        assertOneWorkflowInstance(lead);
    }

    // --------------------------------------------------- case: FG10b-2

    /** The child Turn's own journal commit lands and its reply is lost:
     * the retry replays it, so the child Turn completes once and the
     * script's answer is the one the lead is notified with. */
    private void childMessageReply() throws Exception {
        AtomicReference<String> lead = new AtomicReference<>();
        AtomicInteger seen = new AtomicInteger();
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.drop(
                (method, path, body) -> lead.get() != null
                        && "POST".equals(method)
                        && path.contains("/transactions:commit")
                        && !path.contains("/sessions/" + lead.get() + "/")
                        && body.contains("\"operation\":\"commitMessage\"")
                        && seen.incrementAndGet() == 1,
                "child-message-reply-loss"));
        lead.set(launch("childmessage"));
        awaitConsumed(lead.get());
        assertThat(countOps(storeProxy, "dropped child-message-reply-loss"))
                .isEqualTo(1);
        String child = onlyChildSession(lead.get());
        assertThat(countOps(storeProxy, "dropped child-message-reply-loss",
                "/sessions/" + child + "/"))
                .as("the dropped reply was the child Session's").isEqualTo(1);
        assertOneWorkflowInstance(lead.get());
    }

    // --------------------------------------------------- case: FG10b-3

    /** The result revision lands but its reply is held past the relay's
     * request timeout, so the relay re-drives `commit_result`: the record
     * settles once and the lead is notified once. */
    private void resultReply() throws Exception {
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.hold(
                matchChildRunCommit(4), "result-hold", 1));
        String lead = launch("result");
        holdPastRelayTimeout(lead, "result-hold");
        awaitConsumed(lead);
        assertOneWorkflowInstance(lead);
    }

    // --------------------------------------------------- case: FG10f-1

    /** The commit that lands the notification input is held past the
     * relay's request timeout, so the relay re-drives the acceptance: the
     * lead holds one notification and reads it in one wake round. */
    private void notificationReply() throws Exception {
        // The first acceptance commit is the notification's; the second,
        // after the wake Turn read it, is its consumption.
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.hold(
                matchCommit("acceptChildResult"), "notification-hold", 1));
        String lead = launch("notification");
        holdPastRelayTimeout(lead, "notification-hold");
        awaitConsumed(lead);
        assertOneWorkflowInstance(lead);
    }

    // --------------------------------------------------- case: FG10f-2

    /**
     * The workflow child's public and WebShell streams are cut while its
     * `agent()` request is held, so the subagent's answer, the Turn's
     * output and its terminal all commit while both clients are gone.
     * Each resumes from its own cursor only after JDBC proves events
     * beyond it, and each client's whole view must be the ledger exactly.
     */
    private void childStreamResume() throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        subagentHold.set(hold);
        String lead;
        String child;
        Observer publicCut;
        Observer webShellCut;
        try {
            lead = launch("childstream");
            assertThat(subagentHeld.await(90, TimeUnit.SECONDS))
                    .as("the subagent request reached the model").isTrue();
            child = onlyChildSession(lead);
            publicCut = new Observer("public", child, 0);
            webShellCut = new Observer("webshell", child, 0);
            publicCut.awaitCaughtUp(child);
            webShellCut.awaitCaughtUp(child);
            publicCut.abort();
            webShellCut.abort();
        } finally {
            hold.countDown();
            subagentHold.set(null);
        }
        awaitConsumed(lead);
        String turn = onlyTurn(child);
        awaitTerminal(child, turn);
        assertThat(ledger(child)).as("events committed beyond the cut")
                .hasSizeGreaterThan(publicCut.frames.size());
        Observer publicResumed = new Observer("public", child,
                publicCut.lastSequence());
        Observer webShellResumed = new Observer("webshell", child,
                webShellCut.lastSequence());
        List<JsonNode> publicView = publicResumed.continueFrom(publicCut,
                child);
        List<JsonNode> webShellView = webShellResumed.continueFrom(
                webShellCut, child);
        assertThat(terminalTurns(publicView)).containsExactly(turn);
        assertThat(terminalTurns(webShellView)).containsExactly(turn);
        assertOneWorkflowInstance(lead);
    }

    // ------------------------------------------------ cases: FG10c-1, -2

    /**
     * One relay write on the lead is refused after the child Turn
     * completed — the result revision (`result-revision-refused`) or the
     * acceptance that lands the notification (`notification-refused`). The
     * subagent is held until the lead's own Turn settled, so the refusal
     * meets an idle lead (a Turn still open there would keep its
     * workspace with the dead owner across the restart) and lands after
     * the child's run, never across it (that is FG10d's ground).
     * The refused commit stays unsettled rather than latching (#14570):
     * each settle that finds the revision absent retries it, so the fire
     * count is a multiple of the bounded retry, not exactly one batch.
     */
    private void refusedAfterChild(String name, String event,
            String condition) throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        subagentHold.set(hold);
        String lead;
        try {
            lead = launch(name.replace("-", ""));
            assertThat(subagentHeld.await(90, TimeUnit.SECONDS))
                    .as("the subagent request reached the model").isTrue();
            awaitLeadSettled(lead);
            refuse(name, event, "NEW.session_id = '" + lead + "' AND "
                    + condition);
        } finally {
            hold.countDown();
            subagentHold.set(null);
        }
        awaitRefusals(name);
        String child = onlyChildSession(lead);
        assertThat(turnStatus(child, onlyTurn(child)))
                .as("the child's run completed before the refusal")
                .isEqualTo("COMPLETED");
        // Unsettled, not advanced: nothing delivered, nothing woken.
        JsonNode record = childRun(lead);
        if ("result-revision-refused".equals(name)) {
            assertThat(childRunRevision(lead)).isEqualTo(3L);
            assertThat(record.path("run").path("state").asText())
                    .isEqualTo("running");
        } else {
            assertThat(record.path("run").path("state").asText())
                    .isEqualTo("settled");
            assertThat(record.path("run").path("delivery").path("state")
                    .asText()).isNotEqualTo("consumed");
        }
        assertThat(notifications(lead)).isEmpty();
        assertThat(wakeRounds.get()).isZero();
        assertThat(childResultRows())
                .noneMatch(row -> row.contains("/accepted/"));
        dropRefusals();
        restartHarness(lead);
        awaitConsumed(lead);
        assertOneWorkflowInstance(lead);
        assertThat(fired(name)).isGreaterThanOrEqualTo(STORE_ATTEMPTS);
    }

    // ------------------------------------------------ cases: FG10d-1, -2

    /**
     * The packaged Harness is SIGKILLed under an attached workflow run —
     * with its `agent()` request in flight at the model, or (`afterWork`)
     * with the run's work done and the child Turn's settlement swallowed
     * at the store before it ever left the wire — and a cold one starts.
     * The run's in-process work died with the generation and no witness
     * of it survives, so the recovery must neither re-run the script nor
     * settle the Turn as if its outcome had been observed (#14387): the
     * Turn parks marked and unsettled, the restarted Harness refuses the
     * child's load, and the relay settles the record `recovery_blocked`
     * over `outcome_unknown`, classifies its ledger `unknown` and tells
     * the lead once, honestly.
     */
    private void killMidWorkflow(boolean afterWork) throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        subagentHold.set(hold);
        String lead;
        String child;
        String turn;
        try {
            lead = launch(afterWork ? "killsettle" : "killflight");
            assertThat(subagentHeld.await(90, TimeUnit.SECONDS))
                    .as("the subagent request reached the model").isTrue();
            awaitLeadSettled(lead);
            child = onlyChildSession(lead);
            turn = onlyTurn(child);
            waiting().atMost(Duration.ofSeconds(60))
                    .pollInterval(Duration.ofMillis(250)).untilAsserted(() ->
                            assertThat(childRun(lead).path("run")
                                    .path("execution").asText())
                                    .as("the run is attached")
                                    .isEqualTo("running_attached"));
            if (afterWork) {
                storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.swallow(
                        matchSettleTurn(child), "settle-swallow"));
                hold.countDown();
                waiting().atMost(Duration.ofSeconds(60))
                        .pollInterval(Duration.ofMillis(100))
                        .untilAsserted(() -> {
                            assertNoModelFailure();
                            assertThat(countOps(storeProxy,
                                    "swallowing settle-swallow"))
                                    .isEqualTo(1);
                        });
                assertThat(childMessagesMentioning(child, SUB_ANSWER))
                        .as("the run's work landed; only its settlement"
                                + " is missing").isEqualTo(1);
            } else {
                subagentAbortExpected = true;
            }
            killHarness();
            if (afterWork) {
                storeProxy.release("settle-swallow");
            } else {
                assertThat(subagentAborted.await(30, TimeUnit.SECONDS))
                        .as("the kill took the in-flight subagent request")
                        .isTrue();
            }
        } finally {
            hold.countDown();
            subagentHold.set(null);
        }
        assertThat(turnStatus(child, turn)).as("nothing settled the Turn")
                .isEqualTo("RUNNING");
        startHarness();
        awaitRecoveryBlocked(lead, child, turn);
        // Give a re-drive, a stray settlement or a second notification the
        // chance to land before proving none did.
        waiting().pollDelay(Duration.ofSeconds(5))
                .atMost(Duration.ofSeconds(10)).until(() -> true);
        assertNoModelFailure();
        // Never re-executed: the script's one `agent()` dispatch, and the
        // child journal holds no more answers than the killed run left.
        assertThat(subagentCalls.get()).as("agent() dispatches").isEqualTo(1);
        assertThat(childMessagesMentioning(child, SUB_ANSWER))
                .isEqualTo(afterWork ? 1 : 0);
        assertThat(jdbc.queryForMap("SELECT status, error_code FROM ma_turn"
                + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                tenant, child, turn))
                .as("parked, marked, never settled")
                .containsEntry("status", "RUNNING")
                .containsEntry("error_code",
                        AgentStateStore.WORKFLOW_RECOVERY_BLOCKED);
        assertThat(Files.readAllLines(harnessLog)).as("the cold load refused")
                .anyMatch(line -> line.contains("sessionId=" + child)
                        && line.contains("code=hosted_turn_recovery_required"));
        if (afterWork) {
            String swallowed = storeProxy.operations().stream()
                    .filter(line -> line.startsWith(
                            "PROXY swallowing settle-swallow "))
                    .map(line -> line.substring(line.indexOf(" cmd=") + 5))
                    .findFirst().orElseThrow();
            assertThat(storeProxy.operations()).as("the settlement never"
                    + " reached the store").noneMatch(line -> line.startsWith(
                            "PROXY passthru ") && line.contains(" cmd="
                                    + swallowed + " "));
        }
        // The cold load closes the child journal's Turn as interrupted
        // before refusing; nothing ever records it completed.
        assertThat(jdbc.queryForList("SELECT CAST(inline_bytes AS CHAR) FROM"
                + " ma_resource WHERE tenant_id = ? AND session_id = ? AND"
                + " kind = 'managed-turn-result'", String.class, tenant, child))
                .as("the child journal's Turn results")
                .noneMatch(body -> body.contains("\"state\":\"completed\""));
        JsonNode record = childRun(lead);
        assertThat(record.path("childSessionId").asText()).isEqualTo(child);
        assertThat(record.path("run").path("state").asText())
                .isEqualTo("recovery_blocked");
        assertThat(record.path("run").path("execution").asText())
                .isEqualTo("outcome_unknown");
        assertThat(record.path("run").path("reason").asText())
                .isEqualTo("runtime_lost");
        assertThat(record.path("stopReason").isNull()).isTrue();
        assertThat(record.path("resultRef").isNull()).isTrue();
        assertThat(record.path("run").path("definition")
                .path("definitionDigest").asText())
                .as("the pin is never re-resolved").isEqualTo(sha256(SCRIPT));
        assertThat(childResultRows()).as("nothing was delivered")
                .containsExactly("unknown/pending/pending");
        assertThat(jdbc.queryForList("SELECT state FROM ma_operation WHERE"
                + " tenant_id = ? AND session_id = ? AND operation_kind ="
                + " 'CHILD_SESSION_START'", String.class, tenant, lead))
                .containsExactly("unknown");
        List<String> told = notifications(lead);
        assertThat(told).as("one blocked line").hasSize(1);
        assertThat(told.get(0)).contains("<status>blocked</status>")
                .contains("<result>\\nWorkflow child run recovery blocked"
                        + " (outcome unknown).")
                .doesNotContain("running");
        assertThat(wakeRounds.get()).as("one wake reads it").isEqualTo(1);
        assertThat(operations(lead, "CHILD_SESSION_START")).isEqualTo(1);
    }

    /** The coordinator parked the killed Turn and the relay settled its
     * record from the mark. */
    private void awaitRecoveryBlocked(String lead, String child,
            String turn) {
        waiting().atMost(Duration.ofSeconds(150))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertThat(jdbc.queryForObject("SELECT error_code FROM"
                            + " ma_turn WHERE tenant_id = ? AND session_id = ?"
                            + " AND turn_id = ?", String.class, tenant, child,
                            turn)).isEqualTo(
                                    AgentStateStore.WORKFLOW_RECOVERY_BLOCKED);
                    assertThat(childRun(lead).path("run").path("state")
                            .asText()).isEqualTo("recovery_blocked");
                    assertThat(childResultRows()).isNotEmpty();
                    assertThat(wakeRounds.get()).isEqualTo(1);
                });
    }

    /** A POST of the child Turn's settlement commit. */
    private static HostedSessionRelayForwardingProxy.Matcher matchSettleTurn(
            String child) {
        return (method, path, body) -> "POST".equals(method)
                && path.contains("/sessions/" + child + "/transactions:commit")
                && body.contains("\"operation\":\"settleTurn\"");
    }

    private static String sha256(String text) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    // ------------------------------------------------ cases: FG10e-1, -2

    /** The workflow task is cancelled while its `agent()` request is held;
     * with {@code replyLost} the cancel's reply is dropped after it
     * committed and the client re-issues the same cancel. */
    private void cancelInFlight(boolean replyLost) throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        subagentHold.set(hold);
        String lead;
        String child;
        String taskId;
        String key;
        try {
            lead = launch(replyLost ? "cancelreply" : "cancelflight");
            assertThat(subagentHeld.await(90, TimeUnit.SECONDS))
                    .as("the subagent request reached the model").isTrue();
            child = onlyChildSession(lead);
            taskId = taskIdOf(lead);
            key = "fg10e-cancel-" + taskId;
            subagentAbortExpected = true;
            if (replyLost) {
                String path = cancelPath(lead, taskId);
                publicProxy.arm(HostedSessionRelayForwardingProxy.Rule.drop(
                        (method, requested, body) -> "POST".equals(method)
                                && requested.equals(path),
                        "cancel-reply-loss"));
                String base = publicProxy.baseUrl();
                boolean lost = false;
                try {
                    request(base, "POST", path, Map.of(), key, 202);
                } catch (IOException dropped) {
                    lost = true;
                }
                assertThat(lost).as("the cancel's reply was lost").isTrue();
                assertThat(countOps(publicProxy, "dropped cancel-reply-loss"))
                        .isEqualTo(1);
            }
            JsonNode admission = request("POST", cancelPath(lead, taskId),
                    Map.of(), key, 202);
            assertThat(admission.path("task_id").asText()).isEqualTo(taskId);
            assertThat(admission.path("replayed").asBoolean())
                    .as("the re-issued cancel answers the committed one")
                    .isEqualTo(replyLost);
            awaitCancelled(lead, child);
            // The run settling cancelled is not the subagent stopping: the
            // sandbox's abort race settles the run with its dispatch still
            // in flight. Only the request failing while still held proves
            // the stop reached the subagent itself.
            assertThat(subagentAborted.await(60, TimeUnit.SECONDS))
                    .as("the cancel aborted the held subagent request")
                    .isTrue();
        } finally {
            hold.countDown();
            subagentHold.set(null);
        }
        // Give a re-dispatch or a stray answer the chance to land before
        // proving neither did.
        waiting().pollDelay(Duration.ofSeconds(3))
                .atMost(Duration.ofSeconds(10)).until(() -> true);
        assertNoModelFailure();
        assertThat(operations(lead, "TASK_CANCEL")).isEqualTo(1);
        // A task cancel keeps its idempotency key on its admission row.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation"
                + " WHERE tenant_id = ? AND operation_kind = 'TASK_CANCEL'"
                + " AND idempotency_key = ?", Integer.class, tenant, key))
                .as("one admission under the key").isEqualTo(1);
        JsonNode record = childRun(lead);
        assertThat(record.path("run").path("state").asText())
                .isEqualTo("cancelled");
        assertThat(record.path("stopReason").asText())
                .isEqualTo("stop_requested");
        assertThat(turnStatus(child, onlyTurn(child))).isEqualTo("CANCELLED");
        assertThat(subagentCalls.get()).as("agent() dispatches").isEqualTo(1);
        assertThat(childMessagesMentioning(child, SUB_ANSWER))
                .as("the held answer never reached the cancelled run")
                .isZero();
        assertThat(notifications(lead)).isEmpty();
        assertThat(wakeRounds.get()).isZero();
        assertThat(childResultRows())
                .noneMatch(row -> row.contains("/accepted/"));
        assertThat(request("GET", "/v1/agents/sessions/" + lead + "/tasks/"
                + taskId, null, null, 200).path("state").asText())
                .isEqualTo("cancelled");
    }

    // --------------------------------------------------- case: FG10e-3

    /** A cancel of a workflow task whose run completed and was consumed
     * is refused and changes nothing. */
    private void cancelAfterSettlement() throws Exception {
        String lead = launch("cancelsettled");
        awaitConsumed(lead);
        long revision = childRunRevision(lead);
        String taskId = taskIdOf(lead);
        JsonNode refused = request("POST", cancelPath(lead, taskId),
                Map.of(), "fg10e-cancel-late-" + taskId, 409);
        assertThat(refused.path("error").path("code").asText())
                .isEqualTo("task_action_unavailable");
        assertThat(operations(lead, "TASK_CANCEL")).isZero();
        assertThat(childRunRevision(lead)).isEqualTo(revision);
        assertOneWorkflowInstance(lead);
    }

    // --------------------------------------------------- choreography

    /** A fresh tenant and team lead whose first model round calls
     * `workflow` with {@link #SCRIPT}. */
    private String launch(String caseKey) throws Exception {
        int slot = caseSlot.getAndIncrement();
        tenant = slotTenants.get(slot);
        seedWorkspace(slot);
        return createLead(slot, "FG10_LEAD_" + caseKey.toUpperCase());
    }

    /**
     * The held commit already landed upstream; the relay's call carrying
     * it times out and the relay defers the step, spending one more
     * attempt on its creation row, before the hold is released. The count
     * is cumulative over the whole creation — an earlier step, such as a
     * bind that met a binding not yet visible, may have deferred already
     * — so the witness is one attempt beyond the count read as this hold
     * began (FG9's `partialTimeout` baseline). While the call is held the
     * relay's one scan thread is blocked in it, so nothing else of this
     * row can spend that attempt.
     */
    private void holdPastRelayTimeout(String lead, String rule) {
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(50)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertThat(countOps(storeProxy, "holding " + rule))
                            .isEqualTo(1);
                });
        int baseline = creationAttempts(lead);
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() ->
                        assertThat(creationAttempts(lead))
                                .as("the relay timed out on the held call"
                                        + " and deferred it")
                                .isGreaterThan(baseline));
        storeProxy.release(rule);
        assertThat(countOps(storeProxy, "holding " + rule)).isEqualTo(1);
    }

    /** The attempts the relay spent on the lead's child creation. */
    private int creationAttempts(String lead) {
        Integer attempts = jdbc.queryForObject(
                "SELECT MAX(attempt_count) FROM ma_operation WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " operation_kind = 'CHILD_SESSION_START'",
                Integer.class, tenant, lead);
        return attempts == null ? 0 : attempts;
    }

    /** The lead's record settled and its delivery consumed, and the
     * relay classified its ledger row — the record's consumed revision
     * lands before the row's classification: the whole walk ran, through
     * the wake Turn's read. */
    private void awaitConsumed(String lead) {
        waiting().atMost(Duration.ofSeconds(150))
                .pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertNoFailedTurn(lead);
                    JsonNode record = childRun(lead);
                    assertThat(record.path("run").path("state").asText())
                            .isEqualTo("settled");
                    assertThat(record.path("run").path("delivery")
                            .path("state").asText()).isEqualTo("consumed");
                    assertThat(childResultRows()).isNotEmpty()
                            .allMatch(row -> row.endsWith("/consumed"));
                });
    }

    /** The relay ledger's result-delivery rows of the case tenant. */
    private List<String> childResultRows() {
        return jdbc.queryForList(
                "SELECT CONCAT(transport_state, '/', reception_state, '/',"
                        + " consumption_state) FROM ma_delivery WHERE"
                        + " tenant_id = ? AND delivery_kind = 'CHILD_RESULT'",
                String.class, tenant);
    }

    /**
     * At most one workflow instance per launch, and one notification:
     * one child Session, one creation operation, one `agent()` dispatch,
     * the record walked once to `settled`/`completed`/`consumed` as a
     * `workflow` run, each of its revisions committed once (a lost reply
     * replays the same command, never a new one), one result-delivery
     * row, one notification input carrying the script's return, and one
     * wake round that read it.
     */
    private void assertOneWorkflowInstance(String lead) {
        String child = onlyChildSession(lead);
        assertThat(operations(lead, "CHILD_SESSION_START")).isEqualTo(1);
        assertThat(subagentCalls.get()).as("agent() dispatches")
                .isEqualTo(1);
        JsonNode record = childRun(lead);
        assertThat(record.path("kind").asText()).isEqualTo("workflow");
        assertThat(record.path("stopReason").asText()).isEqualTo("completed");
        assertThat(record.path("childSessionId").asText()).isEqualTo(child);
        assertThat(childRunRevision(lead)).isEqualTo(6L);
        List<String> commands = childRunCommands(lead);
        assertThat(commands).as("each child_run revision committed once")
                .doesNotHaveDuplicates()
                .hasSize(5);
        assertThat(childResultRows())
                .containsExactly("delivered/accepted/consumed");
        List<String> notifications = notifications(lead);
        assertThat(notifications).hasSize(1);
        assertThat(notifications.get(0)).contains(RESULT)
                .contains("<status>completed</status>");
        assertThat(wakeRounds.get()).as("wake rounds that read it")
                .isEqualTo(1);
        assertThat(turnStatus(child, onlyTurn(child)))
                .isEqualTo("COMPLETED");
    }

    /** The lead's one `child_run` record body, as committed now. */
    private JsonNode childRun(String lead) {
        List<String> bodies = jdbc.queryForList(
                "SELECT CAST(res.inline_bytes AS CHAR) FROM"
                        + " ma_session_record r JOIN ma_resource res ON"
                        + " res.session_scope_key = r.session_scope_key"
                        + " AND res.resource_id = r.record_resource_id"
                        + " WHERE r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = 'child_run'",
                String.class, tenant, lead);
        assertThat(bodies).as("one child_run record on the lead").hasSize(1);
        return jsonBody(bodies.get(0));
    }

    private long childRunRevision(String lead) {
        return jdbc.queryForObject("SELECT revision FROM ma_session_record"
                + " WHERE tenant_id = ? AND session_id = ? AND"
                + " domain = 'child_run'", Long.class, tenant, lead);
    }

    /** The relay's `child_run` revision commands the store accepted on
     * the lead, in order — a held reply's commit landed too; a replayed
     * commit names the same command. */
    private List<String> childRunCommands(String lead) {
        List<String> commands = new ArrayList<>();
        for (String line : storeProxy.operations()) {
            if ((line.startsWith("PROXY passthru ")
                    || line.startsWith("PROXY dropped ")
                    || line.startsWith("PROXY holding "))
                    && line.contains("/sessions/" + lead + "/")
                    && line.contains(" op=commitChildRunRecord ")
                    && line.contains(" status=2")) {
                Matcher command = COMMAND.matcher(line);
                assertThat(command.find()).as("the commit names its command:"
                        + " %s", line).isTrue();
                if (!commands.contains(command.group(1))) {
                    commands.add(command.group(1));
                }
            }
        }
        return commands;
    }

    /** The one Session the relay created for the lead's workflow. */
    private String onlyChildSession(String lead) {
        AtomicReference<String> child = new AtomicReference<>();
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                    List<String> sessions = jdbc.queryForList(
                            "SELECT CAST(session_id AS CHAR) FROM ma_session"
                                    + " WHERE tenant_id = ? AND"
                                    + " session_id <> ?",
                            String.class, tenant, lead);
                    assertThat(sessions).as("one child Session").hasSize(1);
                    child.set(sessions.get(0));
                });
        return child.get();
    }

    private int operations(String session, String kind) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE"
                + " tenant_id = ? AND session_id = ? AND operation_kind = ?",
                Integer.class, tenant, session, kind);
    }

    /** The notification inputs committed on the lead. */
    private List<String> notifications(String lead) {
        return jdbc.queryForList("SELECT CAST(inline_bytes AS CHAR) FROM"
                + " ma_resource WHERE tenant_id = ? AND session_id = ? AND"
                + " kind = 'managed-input'", String.class, tenant, lead)
                .stream().filter(body -> body.contains("<task-notification>"))
                .collect(Collectors.toList());
    }

    private String onlyTurn(String session) {
        return jdbc.queryForObject(
                "SELECT CAST(turn_id AS CHAR) FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session);
    }

    private String turnStatus(String session, String turn) {
        return jdbc.queryForObject("SELECT status FROM ma_turn WHERE"
                + " tenant_id = ? AND session_id = ? AND turn_id = ?",
                String.class, tenant, session, turn);
    }

    /** A POST commit of the lead's `child_run` record at `revision`. */
    private static HostedSessionRelayForwardingProxy.Matcher
            matchChildRunCommit(long revision) {
        return (method, path, body) -> "POST".equals(method)
                && path.contains("/transactions:commit")
                && body.contains("\"operation\":\"commitChildRunRecord\"")
                && body.matches("(?s).*\"commandId\":\"[^\"]+:"
                        + revision + "\".*");
    }

    /** A POST commit naming `operation`. */
    private static HostedSessionRelayForwardingProxy.Matcher matchCommit(
            String operation) {
        return (method, path, body) -> "POST".equals(method)
                && path.contains("/transactions:commit")
                && body.contains("\"operation\":\"" + operation + "\"");
    }

    private JsonNode jsonBody(String text) {
        try {
            return json.readTree(text);
        } catch (IOException failure) {
            throw new AssertionError(failure);
        }
    }

    // ---------------------------------------- refusals, restarts, cancels

    /**
     * FG10c's fault source, the FG9b shape: a test-only trigger on the
     * journal's record table, scoped to the case tenant, the lead and one
     * record shape, refusing every matching write until the case drops it
     * (a fire-once arm would be healed by the store client's own bounded
     * retry). Each fire also lands in the MyISAM fg10c_fire table, which
     * survives the signalled rollback: Spring flattens the SQLException
     * into a 500, so the fire count is the attribution.
     */
    private void refuse(String name, String event, String condition) {
        jdbc.execute("CREATE TABLE IF NOT EXISTS fg10c_fire (case_name"
                + " VARCHAR(64) NOT NULL, fired_at TIMESTAMP(6) NOT NULL"
                + " DEFAULT CURRENT_TIMESTAMP(6)) ENGINE = MyISAM");
        String trigger = "fg10c_" + UUID.randomUUID().toString()
                .replace("-", "");
        refusals.add(trigger);
        jdbc.execute("CREATE TRIGGER " + trigger + " BEFORE " + event
                + " ON ma_session_record FOR EACH ROW BEGIN IF"
                + " NEW.tenant_id = '" + tenant + "' AND " + condition
                + " THEN INSERT INTO fg10c_fire (case_name) VALUES ('" + name
                + "'); SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'FG10C_"
                + name.toUpperCase().replace('-', '_') + "'; END IF; END");
    }

    private void dropRefusals() {
        for (String trigger : refusals) {
            jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
        }
        refusals.clear();
    }

    private int fired(String name) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM fg10c_fire WHERE"
                + " case_name = ?", Integer.class, name);
    }

    /** Every attempt of the store client's bounded retry met the
     * refusal; past it the lead keeps the append unsettled and sends no
     * more until the refusal drops (#14570). A settle that fires before
     * the drop retries the same commit, so only the lower bound is exact. */
    private void awaitRefusals(String name) {
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertThat(fired(name)).isGreaterThanOrEqualTo(STORE_ATTEMPTS);
                });
    }

    /** The lead's own Turn has settled: a Turn still open when its
     * Session latches keeps the workspace its dead owner held, and the
     * cold lead then churns instead of executing anything. */
    private void awaitLeadSettled(String lead) {
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertThat(jdbc.queryForList("SELECT status FROM ma_turn"
                            + " WHERE tenant_id = ? AND session_id = ?",
                            String.class, tenant, lead))
                            .containsExactly("COMPLETED");
                });
    }

    private long writerGeneration(String session) {
        Long generation = jdbc.queryForObject(
                "SELECT writer_generation FROM ma_session_head"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session);
        return generation == null ? 0 : generation;
    }

    /** SIGKILLs the packaged Harness (POSIX) and starts a cold one — a new
     * HOME and QWEN_HOME — on the same port; returns once a new writer
     * generation holds `session`, the takeover's witness. */
    private void restartHarness(String session) throws Exception {
        long generation = writerGeneration(session);
        killHarness();
        startHarness();
        waiting().atMost(Duration.ofSeconds(100))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                        assertThat(writerGeneration(session))
                                .as("a new writer generation holds %s",
                                        session)
                                .isGreaterThan(generation));
    }

    /** SIGKILLs the packaged Harness and its descendants (POSIX). */
    private void killHarness() throws InterruptedException {
        harness.descendants().forEach(ProcessHandle::destroyForcibly);
        harness.destroyForcibly();
        assertThat(harness.waitFor(20, TimeUnit.SECONDS))
                .as("the killed Harness exited").isTrue();
    }

    /** The public task id of the lead's workflow run. */
    private String taskIdOf(String lead) {
        String runId = jdbc.queryForObject("SELECT CAST(record_id AS CHAR)"
                + " FROM ma_session_record WHERE tenant_id = ? AND"
                + " session_id = ? AND domain = 'child_run'", String.class,
                tenant, lead);
        return ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(lead, "child_run",
                        runId));
    }

    private static String cancelPath(String lead, String taskId) {
        return "/v1/agents/sessions/" + lead + "/tasks/" + taskId
                + "/cancel";
    }

    /** The cancel reached the run: its child Turn ended and the record
     * settled cancelled. */
    private void awaitCancelled(String lead, String child) {
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertThat(turnStatus(child, onlyTurn(child)))
                            .isEqualTo("CANCELLED");
                    assertThat(childRun(lead).path("run").path("state")
                            .asText()).isEqualTo("cancelled");
                });
    }

    /** The child Session's journal messages carrying `text`. */
    private long childMessagesMentioning(String child, String text) {
        return jdbc.queryForList("SELECT CAST(inline_bytes AS CHAR) FROM"
                + " ma_resource WHERE tenant_id = ? AND session_id = ? AND"
                + " kind = 'managed-message'", String.class, tenant, child)
                .stream().filter(body -> body.contains(text)).count();
    }

    // ---------------------------------------------------------- streams

    private static String eventsPath(String session) {
        return "/v1/agents/sessions/" + session + "/events";
    }

    /** The Session stream's committed public events, in sequence. */
    private List<Map<String, Object>> ledger(String session) {
        return jdbc.queryForList(
                "SELECT schema_version, projection_version, sequence_id,"
                        + " CAST(event_id AS CHAR) AS event_id,"
                        + " CAST(session_id AS CHAR) AS session_id,"
                        + " CAST(turn_id AS CHAR) AS turn_id,"
                        + " CAST(item_id AS CHAR) AS item_id,"
                        + " CAST(content_part_id AS CHAR) AS content_part_id,"
                        + " event_type, gmt_create, data_json, terminal"
                        + " FROM ma_public_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND stream_kind = 'SESSION' AND"
                        + " stream_id = X'' ORDER BY sequence_id",
                tenant, session);
    }

    /** One ledger row exactly as the surface serves it (snake_case and
     * seconds publicly, camelCase and milliseconds on the WebShell, nulls
     * omitted). */
    private JsonNode served(Map<String, Object> row, String surface)
            throws IOException {
        boolean web = "webshell".equals(surface);
        long created = ((Number) row.get("gmt_create")).longValue();
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("schema_version", row.get("schema_version"));
        fields.put("projection_version", row.get("projection_version"));
        fields.put("sequence", row.get("sequence_id"));
        fields.put("event_id", row.get("event_id"));
        fields.put("session_id", row.get("session_id"));
        fields.put("turn_id", row.get("turn_id"));
        fields.put("item_id", row.get("item_id"));
        fields.put("content_part_id", row.get("content_part_id"));
        fields.put("type", row.get("event_type"));
        fields.put("created_at", web ? created : created / 1000);
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

    private static String camel(String key) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (c == '_' && i + 1 < key.length()) {
                out.append(Character.toUpperCase(key.charAt(++i)));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private void awaitTerminal(String session, String turn) {
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_public_event"
                                        + " WHERE tenant_id = ? AND"
                                        + " session_id = ? AND turn_id = ?"
                                        + " AND terminal",
                                Integer.class, tenant, session, turn))
                                .isEqualTo(1));
    }

    /** The turn of every terminal frame; a turn named twice fails. */
    private static List<String> terminalTurns(List<JsonNode> frames) {
        List<String> turns = new ArrayList<>();
        for (JsonNode frame : frames) {
            if (frame.path("terminal").asBoolean()) {
                String turn = frame.has("turn_id")
                        ? frame.path("turn_id").asText()
                        : frame.path("turnId").asText();
                assertThat(turns).as("terminal of %s once", turn)
                        .doesNotContain(turn);
                turns.add(turn);
            }
        }
        return turns;
    }

    /**
     * One client of a Session's public or WebShell event stream. It owns
     * its HttpClient, so {@link #abort} cuts the connection mid-stream the
     * way a lost client does; {@link #frames} is everything it read.
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

        Observer(String surface, String session, long after)
                throws Exception {
            this.surface = surface;
            HttpRequest.Builder request;
            if ("public".equals(surface)) {
                request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                        + port + eventsPath(session) + "?stream=true")).GET();
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
                    .header("X-Fg10-Fixture-Actor", "actor")
                    .header("Accept", "text/event-stream").build(),
                    HttpResponse.BodyHandlers.ofInputStream());
            assertThat(response.statusCode()).as("%s stream of %s", surface,
                    session).isEqualTo(200);
            reader = new Thread(() -> read(response.body()),
                    "fg10f-" + surface + "-" + session);
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
                    : frames.get(frames.size() - 1).path("sequence")
                            .asLong();
        }

        /** Every event the ledger holds now has reached this client. */
        void awaitCaughtUp(String session) {
            waiting().atMost(Duration.ofSeconds(60))
                    .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                        assertThat(failure.get()).isNull();
                        assertThat(lastSequence()).isEqualTo(
                                (long) ledger(session).size());
                    });
        }

        void abort() throws InterruptedException {
            aborted = true;
            client.shutdownNow();
            reader.join(10_000);
            assertThat(reader.isAlive()).as("the cut stream stopped").isFalse();
        }

        /**
         * This resumed client's frames after the cut one's, once it read
         * the ledger's tail: one contiguous sequence from 1 with no gap
         * and no duplicate, each frame exactly its committed row.
         */
        List<JsonNode> continueFrom(Observer cut, String session)
                throws Exception {
            long tail = ledger(session).size();
            waiting().atMost(Duration.ofSeconds(90))
                    .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                        assertThat(failure.get()).isNull();
                        assertThat(lastSequence())
                                .isGreaterThanOrEqualTo(tail);
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

    // ------------------------------------------------------- witnesses

    private long countOps(HostedSessionRelayForwardingProxy proxy,
            String... needles) {
        return proxy.operations().stream()
                .filter(line -> {
                    for (String needle : needles) {
                        if (!line.contains(needle)) {
                            return false;
                        }
                    }
                    return true;
                })
                .count();
    }

    private void assertNoModelFailure() {
        Throwable failure = modelFailure.get();
        if (failure != null) {
            throw new IllegalStateException("The model fixture failed",
                    failure);
        }
    }

    private void assertNoFailedTurn(String session) {
        List<Map<String, Object>> failed = jdbc.queryForList(
                "SELECT turn_id, error_code FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " status = 'FAILED'",
                tenant, session);
        if (!failed.isEmpty()) {
            throw new IllegalStateException("Turns failed: " + failed);
        }
    }

    // ------------------------------------------------------------- stack

    private void boot(String letter, int caseCount) throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../../dist/cli.js")).toAbsolutePath();
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
        Files.createDirectory(temporary.resolve("harness-decoy"));
        for (int i = 0; i < caseCount; i++) {
            Path workspace = Files.createDirectory(
                    temporary.resolve("workspace-" + i));
            Files.createDirectory(workspace.resolve("child"));
        }
        // Spring and the embedded broker bind ephemeral ports read back
        // after boot; the Harness port is picked ahead because Spring's
        // connector is configured with it.
        harnessPort = freePort();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelThreads = Executors.newCachedThreadPool();
        model.setExecutor(modelThreads);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        casesRoot = Path.of(System.getProperty("user.dir"), "target",
                "fg10-cases", letter);
        deleteRecursively(casesRoot);
        Files.createDirectories(casesRoot);
        harnessLog = casesRoot.resolve("harness.log");
        slotTenants.clear();
        for (int i = 0; i < caseCount; i++) {
            slotTenants.add("fg10-" + letter + "-"
                    + UUID.randomUUID().toString().substring(0, 8) + "-"
                    + i);
        }
        caseSlot.set(0);
        storeProxy = HostedSessionRelayForwardingProxy.start("store",
                casesRoot.resolve("store-proxy.log"));
        // FG10e's lost cancel reply: only the client's own request passes it.
        publicProxy = HostedSessionRelayForwardingProxy.start("public",
                casesRoot.resolve("public-proxy.log"));
        startSpring(cli, node, caseCount, letter);
        port = spring.getWebServer().getPort();
        brokerPort = spring.getBean(EmbeddedRuntimeBroker.class).getBaseUri()
                .getPort();
        storeProxy.forwardTo(URI.create("http://127.0.0.1:" + port));
        publicProxy.forwardTo(URI.create("http://127.0.0.1:" + port));
        startHarness();
    }

    private void seedWorkspace(int slot) {
        String workspaceId = "workspace-" + slot;
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id,"
                        + " workspace_generation, storage_id, display_name,"
                        + " config_ref, policy_ref, state) VALUES (?,"
                        + " ?, 1, ?, 'FG10', ?, ?, 'ACTIVE')",
                tenant, workspaceId, "storage-" + slot,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update(
                "INSERT INTO ma_workspace_access (tenant_id, workspace_id,"
                        + " actor_id, role) VALUES (?, ?, ?, 'OPERATOR')",
                tenant, workspaceId,
                "actor".getBytes(StandardCharsets.UTF_8));
    }

    private String createLead(int slot, String marker) throws Exception {
        ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
        String workspaceId = "workspace-" + slot;
        TransactionTemplate transaction = new TransactionTemplate(
                spring.getBean(PlatformTransactionManager.class));
        var created = transaction.execute(status ->
                store.insertInternalTeamLeadSessionCommand(tenant,
                        "actor", "create-" + marker, DIGEST, null,
                        new WorkspaceSelection(workspaceId, "child")));
        String lead = created.sessionId();
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofSeconds(1)).ignoreExceptions()
                .untilAsserted(() -> request("POST", eventsPath(lead),
                        Map.of("type", "agent.session.input.message",
                                "input",
                                List.of(Map.of("type", "input_text", "text",
                                        marker))),
                        "input-" + marker, 202));
        return lead;
    }

    private void startSpring(Path cli, String node, int caseCount,
            String letter) {
        List<String> arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url="
                        + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username="
                        + System.getProperty("mysql.user"),
                "--spring.datasource.password="
                        + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url="
                        + storeProxy.baseUrl(),
                "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                "--qwen.managed-agent.session-store.writer-lease-duration=15s",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.harness.base-url="
                        + "http://127.0.0.1:" + harnessPort,
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd="
                        + temporary.resolve("harness-decoy"),
                "--qwen.managed-agent.runtime-broker.state-directory="
                        + temporary.resolve("broker"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=fg10-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key="
                        + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        if ("fg10b".equals(letter) || "fg10f".equals(letter)) {
            // A held reply outlives the relay's call only below this bound,
            // so the relay re-drives the step while the first is in flight.
            arguments.add(
                    "--qwen.managed-agent.harness.request-timeout=3s");
        }
        if ("fg10f".equals(letter)) {
            // A stream the gate cut stays open server-side until its next
            // write fails, holding Spring's graceful shutdown for its whole
            // 30 s window; a short heartbeat is that write.
            arguments.add(
                    "--qwen.managed-agent.events.heartbeat-interval=2s");
        }
        for (int i = 0; i < caseCount; i++) {
            arguments.add("--qwen.managed-agent.runtime-broker.workspace-mounts["
                    + i + "].tenant-id=" + slotTenants.get(i));
            arguments.add("--qwen.managed-agent.runtime-broker.workspace-mounts["
                    + i + "].storage-id=storage-" + i);
            arguments.add("--qwen.managed-agent.runtime-broker.workspace-mounts["
                    + i + "].root=" + temporary.resolve("workspace-" + i));
        }
        spring = (ServletWebServerApplicationContext)
                new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                        .initializers(context -> context.getBeanFactory()
                                .registerSingleton("fg10Authentication",
                                        authentication()))
                        .run(arguments.toArray(String[]::new));
        jdbc = spring.getBean(JdbcTemplate.class);
    }

    private void startHarness() throws Exception {
        String node = System.getProperty("node.executable");
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../../dist/cli.js")).toAbsolutePath();
        Path home = Files.createDirectory(
                temporary.resolve("home-" + UUID.randomUUID()));
        Path config = Files.createDirectory(home.resolve(".qwen"));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort()
                + "/v1";
        Files.writeString(config.resolve("settings.json"),
                json.writeValueAsString(Map.of(
                        "security",
                        Map.of("auth", Map.of("selectedType", "openai")),
                        "model", Map.of("name", "fg10-fixture"),
                        "telemetry", Map.of("enabled", false),
                        "modelProviders",
                        Map.of("openai", List.of(Map.of("id", "fg10-fixture",
                                "envKey", "OPENAI_API_KEY", "baseUrl",
                                modelUrl))))));
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web",
                "--workspace", temporary.resolve("harness-decoy").toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:"
                        + brokerPort,
                "--managed-runtime-broker-token", TOKEN)
                .directory(temporary.resolve("harness-decoy").toFile())
                .redirectErrorStream(true).redirectOutput(
                        ProcessBuilder.Redirect.appendTo(harnessLog.toFile()));
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
        waiting().atMost(Duration.ofSeconds(60)).untilAsserted(() -> {
            if (!harness.isAlive()) {
                throw new IllegalStateException(
                        "Hosted Harness exited: "
                                + Files.readString(harnessLog));
            }
            int status;
            try {
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
        return request("http://127.0.0.1:" + port, method, path, body, key,
                expected);
    }

    private JsonNode request(String base, String method, String path,
            Object body, String key, int expected) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                URI.create(base + path))
                .timeout(Duration.ofSeconds(15))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("X-Fg10-Fixture-Actor", "actor")
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
                                        "X-Fg10-Fixture-Actor");
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
        filter.setDispatcherTypes(DispatcherType.REQUEST,
                DispatcherType.ASYNC);
        filter.addUrlPatterns("/v1/agents/*", "/api/agent/web-shell/v1/*");
        return filter;
    }

    // ------------------------------------------------------- the model

    /**
     * Three requests: an `agent()` dispatch (its system prompt names the
     * workflow that spawned it), answered {@link #SUB_ANSWER} or parked on
     * the case's hold; the lead's wake round (its history carries the
     * notification), closed with text; and the lead's launch round, which
     * calls `workflow` once and then closes.
     */
    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            JsonNode body = json.readTree(exchange.getRequestBody());
            String text = body.path("messages").toString();
            if (text.contains(SUBAGENT_PROMPT)) {
                subagentCalls.incrementAndGet();
                CountDownLatch hold = subagentHold.get();
                if (hold == null) {
                    reply(exchange, List.of(), SUB_ANSWER);
                } else {
                    holdSubagent(exchange, hold);
                }
                return;
            }
            if (text.contains("FG10_LEAD_")) {
                if (text.contains("task-notification")) {
                    wakeRounds.incrementAndGet();
                    reply(exchange, List.of(), "LEAD_REPORT done");
                } else if (countRoleTool(body) == 0) {
                    reply(exchange, List.of(Map.of("id", "lead-wf", "name",
                            "workflow", "args", Map.of("script", SCRIPT))),
                            null);
                } else {
                    reply(exchange, List.of(), "LEAD_REPORT launched");
                }
                return;
            }
            reply(exchange, List.of(), "OK");
        } catch (Exception | AssertionError failure) {
            modelFailure.compareAndSet(null, failure);
            try {
                reply(exchange, List.of(), null);
            } catch (Exception ignored) {
                // the exchange may already be gone
            }
        } finally {
            exchange.close();
        }
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

    /**
     * Holds a subagent request open on a live stream: the headers go out
     * at once and an SSE comment every 250 ms, so a request its client
     * aborts fails the next write while the hold is still closed. That
     * failure is {@link #subagentAborted}, the witness that a stop reached
     * the subagent's own request, not only the run awaiting it.
     */
    private void holdSubagent(HttpExchange exchange, CountDownLatch hold)
            throws IOException, InterruptedException {
        exchange.getResponseHeaders().set("Content-Type",
                "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        OutputStream out = exchange.getResponseBody();
        out.write(KEEPALIVE);
        out.flush();
        subagentHeld.countDown();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(180);
        try {
            while (!hold.await(250, TimeUnit.MILLISECONDS)) {
                if (System.nanoTime() > deadline) {
                    throw new AssertionError("subagent hold never opened");
                }
                out.write(KEEPALIVE);
                out.flush();
            }
            out.write(completion(List.of(), SUB_ANSWER));
            out.flush();
        } catch (IOException aborted) {
            subagentAborted.countDown();
            if (!subagentAbortExpected) {
                throw aborted;
            }
        }
    }

    private void reply(HttpExchange exchange,
            List<Map<String, Object>> calls, String text) throws IOException {
        byte[] response = completion(calls, text);
        exchange.getResponseHeaders().set("Content-Type",
                "text/event-stream");
        exchange.sendResponseHeaders(200, response.length);
        exchange.getResponseBody().write(response);
    }

    private byte[] completion(List<Map<String, Object>> calls, String text)
            throws IOException {
        ObjectNode chunk = json.createObjectNode().put("id", "fg10")
                .put("object", "chat.completion.chunk").put("created", 0)
                .put("model", "fg10-fixture");
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
        return (first + "data: " + json.writeValueAsString(chunk)
                + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (!Files.exists(root)) {
            return;
        }
        try (var stream = Files.walk(root)) {
            stream.sorted((a, b) -> b.compareTo(a)).forEach(path -> {
                try {
                    Files.delete(path);
                } catch (IOException failure) {
                    throw new IllegalStateException(failure);
                }
            });
        }
    }

    private static ConditionFactory waiting() {
        return await().failFast("The case's @Timeout interrupted it",
                () -> Thread.currentThread().isInterrupted());
    }
}
