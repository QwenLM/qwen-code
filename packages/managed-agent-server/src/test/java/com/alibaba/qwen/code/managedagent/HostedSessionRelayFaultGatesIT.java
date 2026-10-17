/**
 * Copyright 2026 Alibaba Group
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
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
import org.junit.jupiter.api.BeforeEach;
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
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.LongStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

/**
 * FG9 (#14164): the session relay fault gates for `session_message` and
 * `session_command` — a real Spring managed-agent server on MySQL, the
 * embedded Runtime Broker behind the relay, the packaged Hosted Harness,
 * and a scripted model. The traffic under gate is the relay itself:
 * alice (a scripted member) issues `send_message` calls that mint a
 * `session_command` on her journal and are passed
 * `planned → accepting → answered → consumed` through the lead's
 * replay-stable execution (probe-before-send under `msgc_` ids, one
 * inbound receipt, `answered` copied back byte-for-byte).
 *
 * One in-JVM lose-once/hold proxy fronts the Session-Store boundary
 * (commit-reply drops whose bounded uncertain-error retry resolves by
 * the original transaction identity); the Harness connection stays
 * direct — a proxied warm/createOrLoad chain breeds resident-vs-attach
 * conflicts, and nothing here needs a harness-side drop point. FG9a
 * drops three store replies (admission commit, inbound receipt commit,
 * fanout mint); FG9f holds the second `sendSessionMessage` commit past
 * the relay's request timeout, then releases it, pinning the
 * partial-fanout honesty the issue names: reached positions reported
 * `sent.` exactly once, changed or stopped ones named with their
 * reason, never silently skipped. FG9d cancels alice's Turn before the
 * relay's first claim (its cancel reply lost once) and while the
 * handover commit is in flight: a withdrawn send delivers nothing, a
 * handed-over one is never answered "not sent". FG9e cuts the sender's
 * and a recipient's public or WebShell stream mid-relay and resumes
 * each from its cursor: no gap, no duplicate, the ledger frame for frame.
 * FG9b refuses one journal write of the pass at the store (a test-only
 * trigger): the sender's outbound, the lead's receipt, the copy-back.
 * The Session that met it latches its writes, so only a cold Harness
 * heals it, and the healing runs through the original command — never a
 * second entry, mint or receipt. FG9c SIGKILLs the Harness mid-fanout
 * and right after the sender's entry landed unacknowledged: the cold
 * load re-executes from the journal, so each step lands exactly once.
 */
class HostedSessionRelayFaultGatesIT {
    private static final String TOKEN = "fg9-fixture";
    private static final String DIGEST = "sha256:" + "b".repeat(64);
    /** The store client's bounded uncertain-error retry of one commit:
     * `ManagedSessionStoreHttpClient.appendTransaction`'s commit loop
     * (`packages/core/src/managed-runtime/http-managed-session-store.ts`),
     * which retries a 429/5xx/transport failure 250 ms apart and rethrows
     * once `const exhausted = attempt >= 2`, the third attempt. */
    private static final int STORE_ATTEMPTS = 3;
    private static final Pattern MEMBER = Pattern.compile(
            "FG9_MEMBER_([a-z]+)_([A-Z]+)");
    private static final Pattern TEAMMATE = Pattern.compile(
            "<teammate>([^<]+)</teammate>");

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final AtomicReference<Throwable> modelFailure =
            new AtomicReference<>();
    private final Set<String> seenReports = new LinkedHashSet<>();
    private final Map<String, Integer> firstContacts = new ConcurrentHashMap<>();
    private final AtomicReference<String> aliceTarget = new AtomicReference<>();
    private final AtomicReference<String> shutdownTarget =
            new AtomicReference<>();
    private final AtomicReference<String> carolMode =
            new AtomicReference<>("DONE");
    private final List<String> slotTenants = new ArrayList<>();
    private final List<Observer> observers = new CopyOnWriteArrayList<>();
    private final AtomicInteger caseSlot = new AtomicInteger();
    private final List<String> refusals = new ArrayList<>();
    private final AtomicInteger harnessGeneration = new AtomicInteger();
    private Map<String, CountDownLatch> releases = Map.of();

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
        // A stream a failed case left open would hold Spring's graceful
        // shutdown for its 30 s window; cut, the server notices it at the
        // next heartbeat write.
        observers.forEach(observer -> observer.client.shutdownNow());
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
            jdbc.execute("DROP TABLE IF EXISTS fg9b_fire");
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
    void fg9aLostRepliesResolveThroughOriginalIdentityOnMySql()
            throws Exception {
        runLetter("fg9a", List.of("admission-commit-reply",
                "receipt-commit-reply", "fanout-step-reply"));
    }

    @Test
    @Timeout(600)
    void fg9fPartialBroadcastAnswersHonestlyUnderAmbiguityOnMySql()
            throws Exception {
        runLetter("fg9f", List.of("partial-timeout",
                "roster-changed", "recipient-stopping"));
    }

    @Test
    @Timeout(600)
    void fg9dCancelledSendsDeliverOnlyWhatTheRelaySettledOnMySql()
            throws Exception {
        runLetter("fg9d", List.of("cancel-after-mint", "cancel-reply-lost",
                "cancel-during-handover"));
    }

    @Test
    @Timeout(600)
    void fg9eRelayStreamsStayContinuousAcrossAbortAndResumeOnMySql()
            throws Exception {
        runLetter("fg9e", List.of("public-resume", "webshell-resume"));
    }

    @Test
    @Timeout(600)
    void fg9bRefusedJournalCommitsHealOnlyThroughTheOriginalCommandOnMySql()
            throws Exception {
        runLetter("fg9b", List.of("outbound-commit-refused",
                "receipt-commit-refused", "answered-commit-refused"));
    }

    @Test
    @Timeout(600)
    void fg9cHarnessCrashesNeverMintARelayStepTwiceOnMySql()
            throws Exception {
        runLetter("fg9c", List.of("lead-kill-mid-fanout",
                "member-kill-after-mint"));
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
        Throwable thrown = null;
        try {
            for (String name : caseNames) {
                seenReports.clear();
                firstContacts.clear();
                aliceTarget.set(null);
                shutdownTarget.set(null);
                carolMode.set("DONE");
                switch (name) {
                    case "admission-commit-reply" -> admissionCommitReply();
                    case "receipt-commit-reply" -> receiptCommitReply();
                    case "fanout-step-reply" -> fanoutStepReply();
                    case "partial-timeout" -> partialTimeout();
                    case "roster-changed" -> rosterChanged();
                    case "recipient-stopping" -> recipientStopping();
                    case "cancel-after-mint" -> cancelAfterMint(false);
                    case "cancel-reply-lost" -> cancelAfterMint(true);
                    case "cancel-during-handover" -> cancelDuringHandover();
                    case "public-resume" -> streamResume("public");
                    case "webshell-resume" -> streamResume("webshell");
                    case "outbound-commit-refused" -> outboundCommitRefused();
                    case "receipt-commit-refused" -> receiptCommitRefused();
                    case "answered-commit-refused" -> answeredCommitRefused();
                    case "lead-kill-mid-fanout" -> leadKillMidFanout();
                    case "member-kill-after-mint" -> memberKillAfterMint();
                    default -> throw new IllegalArgumentException(
                            "unknown case " + letter + "/" + name);
                }
            }
        } catch (Throwable failure) {
            thrown = failure;
            throw failure;
        } finally {
            try {
                drainLetter();
            } catch (AssertionError drainFailure) {
                if (thrown == null) {
                    throw new AssertionError("letter " + letter
                            + " left parked journals behind", drainFailure);
                }
                System.err.println("drain skipped after a failed case: "
                        + drainFailure.getMessage());
            }
        }
    }

    // --------------------------------------------------- case: FG9a-1

    private void admissionCommitReply() throws Exception {
        String lead = newTeam("admission", "bob");
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.drop(
                matchCommitOperation("sendSessionCommand", 1),
                "admission-reply-loss"));
        openSend();
        awaitMsgcMinted(lead, 1);
        releases.get("bob").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        JsonNode reply = receiptReply(lead, "alice");
        assertThat(reply.path("text").asText()).contains(
                "Message sent to bob.");
        assertThat(countOps(storeProxy, "dropped admission-reply-loss"))
                .isEqualTo(1);
        settleAndCheckDelivered(lead);
    }

    // --------------------------------------------------- case: FG9a-2

    private void receiptCommitReply() throws Exception {
        String lead = newTeam("receiptcommit", "bob");
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.drop(
                matchCommitOperation("commitSessionCommandReceipt", 1),
                "receipt-reply-loss"));
        openSend();
        awaitMsgcMinted(lead, 1);
        releases.get("bob").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        JsonNode reply = receiptReply(lead, "alice");
        assertThat(reply.path("text").asText()).contains(
                "Message sent to bob.");
        assertThat(countOps(storeProxy, "dropped receipt-reply-loss"))
                .isEqualTo(1);
        settleAndCheckDelivered(lead);
    }

    // --------------------------------------------------- case: FG9a-3

    private void fanoutStepReply() throws Exception {
        carolMode.set("WAIT");
        String lead = newTeam("fanoutstep", "*");
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.drop(
                matchCommitOperation("sendSessionMessage", 1),
                "fanout-reply-loss"));
        openSend();
        awaitMsgcMinted(lead, 1);
        releases.get("bob").countDown();
        releases.get("carol").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        assertThat(msgcRows(lead)).hasSize(2);
        JsonNode reply = receiptReply(lead, "alice");
        assertThat(reply.path("text").asText())
                .contains("every other member")
                .contains("- bob: sent.")
                .contains("- carol: sent.");
        assertThat(countOps(storeProxy, "dropped fanout-reply-loss"))
                .isEqualTo(1);
        settleAndCheckDelivered(lead);
    }

    // --------------------------------------------------- case: FG9f-1

    private void partialTimeout() throws Exception {
        carolMode.set("WAIT");
        String lead = newTeam("ptimeout", "*");
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.hold(
                matchCommitOperation("sendSessionMessage", 2),
                "carol-mint", 2));
        openSend();
        // Witness the hold before anything is released: attempt_count
        // also counts the handover/attachment failures that can precede
        // the held mint, so an attempt-only gate can fire early —
        // release("carol-mint") then lands as "(nothing held)", the
        // signal is lost, and bob/carol open before the real send can
        // reach them.
        awaitHolding("carol-mint");
        int before = attemptCount(lead, "cmd_");
        awaitDeliveryAttempt(lead, "cmd_", before + 1);
        storeProxy.release("carol-mint");
        releases.get("bob").countDown();
        releases.get("carol").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        assertThat(msgcRows(lead)).hasSize(2);
        JsonNode reply = receiptReply(lead, "alice");
        assertThat(reply.path("text").asText())
                .contains("every other member")
                .contains("- bob: sent.")
                .contains("- carol: sent.");
        assertThat(countOps(storeProxy, "holding carol-mint"))
                .isEqualTo(1);
        assertThat(attemptCount(lead, "cmd_"))
                .isGreaterThanOrEqualTo(before + 1);
        settleAndCheckDelivered(lead);
    }

    // --------------------------------------------------- case: FG9f-2

    private void rosterChanged() throws Exception {
        carolMode.set("DONE");
        String lead = newTeam("rosterchanged", "*");
        awaitRunState(lead, "carol", "completed");
        openSend();
        awaitMsgcMinted(lead, 1);
        releases.get("bob").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        assertThat(msgcRows(lead)).hasSize(1);
        JsonNode reply = receiptReply(lead, "alice");
        assertThat(reply.path("text").asText())
                .contains("1 of 2")
                .contains("- bob: sent.")
                .contains("- carol: not reached:")
                .contains("it has finished");
        settleAndCheckDelivered(lead);
    }

    // --------------------------------------------------- case: FG9f-3

    private void recipientStopping() throws Exception {
        shutdownTarget.set("carol");
        carolMode.set("WAIT");
        String lead = newTeam("stopping", "*");
        awaitRunField(lead, "carol", record ->
                record.path("stopRequested").asBoolean(false));
        openSend();
        awaitMsgcMinted(lead, 1);
        releases.get("bob").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        assertThat(msgcRows(lead)).hasSize(1);
        JsonNode reply = receiptReply(lead, "alice");
        assertThat(reply.path("text").asText())
                .contains("- bob: sent.")
                .contains("- carol: not reached:")
                .contains("it is being stopped");
        settleAndCheckDelivered(lead, "carol");
    }

    // ---------------------------------------- cases: FG9d-1 and FG9d-2

    /** alice's Turn is cancelled while her minted command still waits for
     * the held relay; with {@code replyLost} the cancel's reply is dropped
     * after it committed and the client re-issues the same cancel. */
    private void cancelAfterMint(boolean replyLost) throws Exception {
        String lead = newTeam(replyLost ? "cancelreply" : "cancelmint",
                "bob");
        String alice = attachedSession(lead, "alice");
        String bob = attachedSession(lead, "bob");
        String commandId;
        String turn;
        CountDownLatch relay = holdRelay();
        try {
            openSend();
            commandId = awaitOutbound(alice, "planned");
            turn = onlyTurn(alice);
            String key = "fg9d-cancel-" + turn;
            if (replyLost) {
                publicProxy.arm(HostedSessionRelayForwardingProxy.Rule.drop(
                        (method, path, body) -> "POST".equals(method)
                                && path.equals(eventsPath(alice))
                                && body.contains("agent.session.cancel"),
                        "cancel-reply-loss"));
                String base = publicProxy.baseUrl();
                assertThatThrownBy(() -> request(base, "POST",
                        eventsPath(alice), cancel(turn), key, 202))
                        .isInstanceOf(IOException.class);
                assertThat(countOps(publicProxy,
                        "dropped cancel-reply-loss")).isEqualTo(1);
            }
            JsonNode admission = request("POST", eventsPath(alice),
                    cancel(turn), key, 202);
            assertThat(admission.path("turn_id").asText()).isEqualTo(turn);
            assertThat(admission.path("replayed").asBoolean())
                    .as("the re-issued cancel answers the committed one")
                    .isEqualTo(replyLost);
            awaitOutbound(alice, "cancelled");
            awaitTurnStatus(alice, turn, "CANCELLED");
            assertThat(jdbc.queryForObject(
                    "SELECT COUNT(*) FROM ma_request_receipt"
                            + " WHERE tenant_id = ? AND idempotency_key = ?",
                    Integer.class, tenant, key)).isEqualTo(1);
        } finally {
            relay.countDown();
        }
        settleAndCheckDelivered(lead);
        // The relay discovers only planned, accepting and unknown entries:
        // one withdrawn before its first claim never enters the ledger,
        // however many scans ran since the release.
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_delivery WHERE tenant_id = ? AND"
                        + " delivery_id = ?",
                Integer.class, tenant, commandId))
                .as("the withdrawn command was never claimed").isZero();
        assertThat(outboundRow(alice).get("revision"))
                .as("planned, then cancelled, and nothing after").isEqualTo(2L);
        assertThat(commandsOf(alice, "session_command").get(0)
                .path("replyRef").isNull()).as("no fabricated reply").isTrue();
        assertThat(sendAnswers(alice)).containsExactly(
                "The leader did not take the command before the wait ended;"
                        + " it was not sent and nothing happened. Send it"
                        + " again in a fresh turn.");
        assertThat(commandsOf(lead, "session_command"))
                .as("no receipt on the lead").isEmpty();
        assertThat(msgcRows(lead)).as("no minted message").isEmpty();
        assertThat(commandsOf(bob, "session_message"))
                .as("nothing reached bob").isEmpty();
        assertThat(eventCount(alice, turn, "turn.cancel.requested"))
                .isEqualTo(1);
        assertThat(eventCount(alice, turn, "turn.cancelled")).isEqualTo(1);
    }

    // --------------------------------------------------- case: FG9d-3

    /** alice's Turn is cancelled while the relay's handover commit landed
     * upstream but its reply is held, so the handover is first in her
     * journal's revision chain and the cancel can no longer withdraw the
     * command: it must answer "reached the leader", and the receipt the
     * relay goes on to commit is the only answer copied back. */
    private void cancelDuringHandover() throws Exception {
        String lead = newTeam("cancelhandover", "bob");
        String alice = attachedSession(lead, "alice");
        String bob = attachedSession(lead, "bob");
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.hold(
                (method, path, body) -> "POST".equals(method)
                        && path.contains("/sessions/" + alice
                                + "/transactions:commit")
                        && body.contains(
                                "\"operation\":\"commitSessionCommand\"")
                        && body.matches("(?s).*\"commandId\":\"cmd_[0-9a-f]+:2\".*"),
                "handover", 1));
        openSend();
        awaitHolding("handover");
        String commandId = outboundRow(alice).get("record_id").toString();
        String turn = onlyTurn(alice);
        request("POST", eventsPath(alice), cancel(turn),
                "fg9d-cancel-" + turn, 202);
        awaitTurnStatus(alice, turn, "CANCELLING");
        // The coordinator sends the admitted cancel at once, and the
        // Harness answers it only after the Session's in-flight commit:
        // a beat here keeps the cancel outstanding across the hold, which
        // the cancel route's own duration proves below.
        waiting().pollDelay(Duration.ofSeconds(2))
                .atMost(Duration.ofSeconds(10)).until(() -> true);
        storeProxy.release("handover");
        awaitTurnStatus(alice, turn, "CANCELLED");
        assertThat(cancelRouteMillis(alice))
                .as("the Harness held the cancel behind the handover")
                .isGreaterThanOrEqualTo(1_500L);
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                        assertThat(jdbc.queryForObject(
                                "SELECT transport_state FROM ma_delivery"
                                        + " WHERE tenant_id = ? AND"
                                        + " delivery_id = ?",
                                String.class, tenant, commandId))
                                .isEqualTo("done"));
        settleAndCheckDelivered(lead);
        assertThat(countOps(storeProxy, "holding handover")).isEqualTo(1);
        // Never both: once the handover landed, nothing may read the
        // command as withdrawn while the relay executes it.
        Map<String, Object> outbound = outboundRow(alice);
        assertThat(outbound.get("delivery_state"))
                .as("planned, accepting, unknown (the cancel), accepted"
                        + " (the receipt copied back)")
                .isEqualTo("accepted");
        assertThat(outbound.get("revision")).isEqualTo(4L);
        assertThat(sendAnswers(alice)).containsExactly(
                "The message reached the leader, but its reply did not"
                        + " arrive in time; some recipients may already have"
                        + " it or get it later. Do not send it again; end"
                        + " your turn and say so in your result.");
        assertSingleCommandChain(lead, "alice");
        assertThat(replyBytes(alice, commandsOf(alice, "session_command")
                .get(0)))
                .as("the sender holds the receipt's reply byte for byte")
                .isEqualTo(replyBytes(lead,
                        commandsOf(lead, "session_command").get(0)));
        // Which arm the relay's execute took is the race between it and
        // alice's run settling after the cancel: both are honest, and the
        // receipt says which.
        JsonNode reply = receiptReply(lead, "alice");
        if ("refused".equals(reply.path("outcome").asText())) {
            assertThat(reply.path("text").asText()).isEqualTo(
                    "Your run has ended or is being stopped; it takes no"
                            + " more team commands.");
            assertThat(msgcRows(lead)).isEmpty();
            assertThat(commandsOf(bob, "session_message")).isEmpty();
        } else {
            assertThat(reply.path("text").asText())
                    .isEqualTo("Message sent to bob.\n- bob: sent.");
            assertThat(msgcRows(lead)).hasSize(1);
            assertThat(commandsOf(bob, "session_message")).hasSize(1);
        }
        System.out.println("FG9D cancel-during-handover execute arm: "
                + reply.path("outcome").asText());
    }

    // --------------------------------------------- cases: FG9e-1, FG9e-2

    /**
     * One `*` broadcast observed on one surface from both of its ends:
     * alice's stream is cut while her command waits for the held relay,
     * so the whole relay runs while she is disconnected and her Turn's
     * tail commits only once it answered; bob's stream is cut after his
     * message was minted and before it was delivered, and his delivery
     * and consumption land while he is disconnected. The wake Turn that
     * reads a relayed message is the Harness's own and is not projected,
     * so his stream's tail is his launch Turn ending. Each stream resumes
     * from its own cursor only after JDBC proves events committed beyond
     * it, and the client's view must be the ledger exactly.
     */
    private void streamResume(String surface) throws Exception {
        carolMode.set("WAIT");
        String lead = newTeam(surface + "resume", "*");
        String alice = attachedSession(lead, "alice");
        String bob = attachedSession(lead, "bob");
        Observer sender;
        Observer recipient;
        CountDownLatch relay = holdRelay();
        try {
            sender = new Observer(surface, alice, 0);
            recipient = new Observer(surface, bob, 0);
            openSend();
            awaitOutbound(alice, "planned");
            sender.awaitCaughtUp(alice);
            sender.abort();
            assertThat(msgcRows(lead)).as("nothing relayed before the cut")
                    .isEmpty();
        } finally {
            relay.countDown();
        }
        awaitMsgcMinted(lead, 2);
        recipient.awaitCaughtUp(bob);
        recipient.abort();
        assertThat(commandsOf(bob, "session_message"))
                .as("bob's message is minted, not yet delivered").isEmpty();
        settleAndCheckDelivered(lead);
        String aliceTurn = onlyTurn(alice);
        String bobTurn = onlyTurn(bob);
        awaitTerminal(alice, aliceTurn);
        awaitTerminal(bob, bobTurn);
        // The replay is never vacuous: both sessions committed events
        // beyond the cursor their client was cut at.
        assertThat(ledger(alice)).hasSizeGreaterThan(
                sender.frames.size());
        assertThat(ledger(bob)).hasSizeGreaterThan(
                recipient.frames.size());
        Observer senderResumed = new Observer(surface, alice,
                sender.lastSequence());
        Observer recipientResumed = new Observer(surface, bob,
                recipient.lastSequence());
        List<JsonNode> senderView = senderResumed.continueFrom(sender, alice);
        List<JsonNode> recipientView = recipientResumed.continueFrom(
                recipient, bob);
        assertThat(terminalTurns(senderView)).containsExactly(aliceTurn);
        assertThat(terminalTurns(recipientView)).contains(bobTurn);
        assertThat(senderView.stream().filter(frame -> frame.toString()
                .contains("ALICE_REPORT done")))
                .as("alice's answer after the relay, once").hasSize(1);
    }

    // --------------------------------------------------- case: FG9b-1

    /** alice's outbound commit is refused at the store: nothing of the
     * command exists anywhere, her Session latches its writes, and only a
     * cold load answers the parked call — from the journal, as not sent,
     * never by minting the command afresh. */
    private void outboundCommitRefused() throws Exception {
        String name = "outbound-commit-refused";
        carolMode.set("WAIT");
        String lead = newTeam("outrefused", "bob");
        awaitLeadSettled(lead);
        String alice = attachedSession(lead, "alice");
        String bob = attachedSession(lead, "bob");
        long mark = harnessLogMark();
        refuse(name, "INSERT", "NEW.session_id = '" + alice
                + "' AND NEW.domain = 'session_command'");
        openSend();
        awaitRefusals(name);
        awaitHarnessLog(mark, "is recovery blocked: "
                + "ManagedSessionWritesStoppedError");
        String turn = onlyTurn(alice);
        // Latched, not answered: no entry, no ledger row, no answer, and
        // the Turn stays open rather than settling over its call.
        assertThat(commandsOf(alice, "session_command")).isEmpty();
        assertThat(deliveryRows()).isZero();
        assertThat(sendAnswers(alice)).isEmpty();
        assertThat(turnStatus(alice, turn)).isEqualTo("RUNNING");
        dropRefusals();
        restartHarness(alice);
        awaitTurnStatus(alice, turn, "COMPLETED");
        assertThat(sendAnswers(alice)).containsExactly(
                "The leader did not take the command before the wait ended;"
                        + " it was not sent and nothing happened. Send it"
                        + " again in a fresh turn.");
        assertThat(commandsOf(alice, "session_command"))
                .as("the call was answered, never minted afresh").isEmpty();
        assertThat(journalCommits(alice, "sendSessionCommand")).isZero();
        assertThat(deliveryRows()).isZero();
        assertThat(commandsOf(lead, "session_command")).isEmpty();
        assertThat(msgcRows(lead)).isEmpty();
        assertThat(commandsOf(bob, "session_message")).isEmpty();
        assertThat(fired(name)).isEqualTo(STORE_ATTEMPTS);
        settleAndCheckDelivered(lead);
    }

    // --------------------------------------------------- case: FG9b-2

    /** The lead's inbound receipt is refused after bob's position was
     * minted: the execute fails with no receipt and nothing answered, and
     * the re-execution after the lead's cold load finds the minted
     * position through the probe — `sent.`, never sent again. */
    private void receiptCommitRefused() throws Exception {
        String name = "receipt-commit-refused";
        carolMode.set("WAIT");
        String lead = newTeam("receiptrefused", "bob");
        awaitLeadSettled(lead);
        String alice = attachedSession(lead, "alice");
        String bob = attachedSession(lead, "bob");
        long mark = harnessLogMark();
        refuse(name, "INSERT", "NEW.session_id = '" + lead
                + "' AND NEW.domain = 'session_command'");
        openSend();
        awaitRefusals(name);
        awaitHarnessLog(mark, "Hosted command operation execute of session "
                + lead + " failed in its store");
        List<String> minted = msgcRows(lead);
        assertThat(minted).as("bob's position minted before the receipt")
                .hasSize(1);
        assertThat(commandsOf(lead, "session_command")).as("no receipt")
                .isEmpty();
        assertThat(outboundRow(alice).get("delivery_state"))
                .isEqualTo("accepting");
        assertThat(sendAnswers(alice)).isEmpty();
        dropRefusals();
        restartHarness(lead);
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        assertThat(receiptReply(lead, "alice").path("text").asText())
                .isEqualTo("Message sent to bob.\n- bob: sent.");
        assertThat(msgcRows(lead)).isEqualTo(minted);
        assertThat(journalCommits(lead, "sendSessionMessage"))
                .as("the re-execution probed the position, never re-sent it")
                .isEqualTo(1);
        assertThat(sendAnswers(alice)).containsExactly(
                "Message sent to bob.\n- bob: sent.");
        assertThat(fired(name)).isEqualTo(STORE_ATTEMPTS);
        settleAndCheckDelivered(lead);
        assertThat(commandsOf(bob, "session_message")).hasSize(1);
    }

    // --------------------------------------------------- case: FG9b-3

    /** The copy-back of the receipt's reply onto alice's journal is
     * refused: the lead's half is durable, alice's latches, and after her
     * cold load the relay's retry re-executes into the stored receipt and
     * copies the same bytes back once. */
    private void answeredCommitRefused() throws Exception {
        String name = "answered-commit-refused";
        carolMode.set("WAIT");
        String lead = newTeam("answeredrefused", "bob");
        awaitLeadSettled(lead);
        String alice = attachedSession(lead, "alice");
        String bob = attachedSession(lead, "bob");
        refuse(name, "UPDATE", "NEW.session_id = '" + alice
                + "' AND NEW.domain = 'session_command' AND"
                + " NEW.delivery_state = 'accepted'");
        openSend();
        // Only the copy-back writes this row in this state, so the fire
        // count is the whole attribution: the Harness answers the relay
        // 400 invalid_command_operation for a store failure on this verb
        // (its RecordError catch also takes the store's errors), with no
        // log line of its own.
        awaitRefusals(name);
        assertThat(commandsOf(lead, "session_command")).as("the receipt")
                .hasSize(1);
        assertThat(msgcRows(lead)).hasSize(1);
        assertThat(outboundRow(alice).get("delivery_state"))
                .isEqualTo("accepting");
        assertThat(sendAnswers(alice)).isEmpty();
        dropRefusals();
        restartHarness(alice);
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        Map<String, Object> outbound = outboundRow(alice);
        assertThat(outbound.get("revision"))
                .as("planned, accepting, accepted, consumed — one accepted")
                .isEqualTo(4L);
        assertThat(replyBytes(alice, commandsOf(alice, "session_command")
                .get(0)))
                .as("the copied-back reply is the receipt's, byte for byte")
                .isEqualTo(replyBytes(lead,
                        commandsOf(lead, "session_command").get(0)));
        assertThat(sendAnswers(alice)).containsExactly(
                "Message sent to bob.\n- bob: sent.");
        assertThat(journalCommits(lead, "sendSessionMessage")).isEqualTo(1);
        assertThat(journalCommits(lead, "commitSessionCommandReceipt"))
                .as("the retry re-executed into the stored receipt")
                .isEqualTo(1);
        assertThat(fired(name)).isEqualTo(STORE_ATTEMPTS);
        settleAndCheckDelivered(lead);
        assertThat(commandsOf(bob, "session_message")).hasSize(1);
    }

    // --------------------------------------------------- case: FG9c-1

    /** The Harness dies with the broadcast's first position minted and
     * its commit reply held, before the second position and the receipt.
     * The re-execution after the cold load reports the first position
     * `sent.` from the journal, sends only the second, and commits the
     * one receipt. */
    private void leadKillMidFanout() throws Exception {
        carolMode.set("WAIT");
        String lead = newTeam("leadkill", "*");
        awaitLeadSettled(lead);
        String alice = attachedSession(lead, "alice");
        storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.hold(
                (method, path, body) -> "POST".equals(method)
                        && path.contains("/sessions/" + lead
                                + "/transactions:commit")
                        && body.contains("\"operation\":\"sendSessionMessage\""),
                "first-mint", 1));
        openSend();
        awaitHolding("first-mint");
        List<String> first = msgcRows(lead);
        assertThat(first).as("the first position landed upstream").hasSize(1);
        assertThat(commandsOf(lead, "session_command")).as("no receipt")
                .isEmpty();
        restartHarness(lead, () -> storeProxy.release("first-mint"));
        awaitMsgcMinted(lead, 2);
        releases.get("bob").countDown();
        releases.get("carol").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        assertThat(msgcRows(lead)).hasSize(2).containsAll(first);
        assertThat(journalCommits(lead, "sendSessionMessage"))
                .as("one mint per position: the first never re-sent")
                .isEqualTo(2);
        String reply = "Message sent to every other member of team"
                + " \"review\".\n- bob: sent.\n- carol: sent.";
        assertThat(receiptReply(lead, "alice").path("text").asText())
                .isEqualTo(reply);
        assertThat(sendAnswers(alice)).containsExactly(reply);
        assertThat(countOps(storeProxy, "holding first-mint")).isEqualTo(1);
        settleAndCheckDelivered(lead);
        assertThat(commandsOf(attachedSession(lead, "bob"),
                "session_message")).hasSize(1);
        assertThat(commandsOf(attachedSession(lead, "carol"),
                "session_message")).hasSize(1);
    }

    // --------------------------------------------------- case: FG9c-2

    /** The Harness dies with alice's planned entry committed upstream and
     * its reply held, so the dead process never learned it landed. The
     * takeover resumes her parked wait from the journal: the entry is the
     * one command, never minted again, and its answer arrives once. */
    private void memberKillAfterMint() throws Exception {
        carolMode.set("WAIT");
        String lead = newTeam("memberkill", "bob");
        awaitLeadSettled(lead);
        String alice = attachedSession(lead, "alice");
        String commandId;
        CountDownLatch relay = holdRelay();
        try {
            storeProxy.arm(HostedSessionRelayForwardingProxy.Rule.hold(
                    matchCommitOperation("sendSessionCommand", 1),
                    "outbound", 1));
            openSend();
            awaitHolding("outbound");
            commandId = awaitOutbound(alice, "planned");
            restartHarness(alice, () -> storeProxy.release("outbound"));
        } finally {
            relay.countDown();
        }
        releases.get("bob").countDown();
        awaitCommandConsumed(lead, "alice");
        assertSingleCommandChain(lead, "alice");
        assertThat(outboundRow(alice).get("record_id")).isEqualTo(commandId);
        assertThat(outboundRow(alice).get("revision")).isEqualTo(4L);
        assertThat(journalCommits(alice, "sendSessionCommand"))
                .as("the entry the dead process never acknowledged, once")
                .isEqualTo(1);
        assertThat(sendAnswers(alice)).containsExactly(
                "Message sent to bob.\n- bob: sent.");
        assertThat(msgcRows(lead)).hasSize(1);
        assertThat(countOps(storeProxy, "holding outbound")).isEqualTo(1);
        settleAndCheckDelivered(lead);
        assertThat(commandsOf(attachedSession(lead, "bob"),
                "session_message")).hasSize(1);
    }

    // --------------------------------------------------- choreography

    private String newTeam(String caseKey, String target) throws Exception {
        int slot = caseSlot.getAndIncrement();
        tenant = slotTenants.get(slot);
        releases = new ConcurrentHashMap<>(Map.of(
                "bob", new CountDownLatch(1),
                "carol", new CountDownLatch(1),
                "stophit", new CountDownLatch(1),
                "send", new CountDownLatch(1)));
        aliceTarget.set(target);
        seedWorkspace(slot);
        String lead = createLead(slot,
                "FG9_LEAD_" + caseKey.toUpperCase());
        waiting().atMost(Duration.ofSeconds(180))
                .pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertThat(firstContacts.keySet())
                            .contains("alice", "bob", "carol");
                    assertThat(teamMembers(lead)).containsExactlyInAnyOrder(
                            "alice", "bob", "carol");
                });
        return lead;
    }

    private void openSend() {
        releases.get("send").countDown();
    }

    private void awaitCommandConsumed(String lead, String member) {
        waiting().atMost(Duration.ofSeconds(180))
                .pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertNoFailedTurn(memberSession(lead, member));
                    assertNoFailedTurn(lead);
                    List<JsonNode> commands = new ArrayList<>(commandsOf(
                            memberSession(lead, member),
                            "session_command"));
                    assertThat(commands).isNotEmpty();
                    JsonNode latest = commands.get(commands.size() - 1);
                    assertThat(latest.path("run").path("delivery")
                            .path("state").asText()).isEqualTo("consumed");
                });
    }

    /** One outbound chain on the member, exactly one inbound receipt at
     * revision 1 on the lead, one delivery ledger row. */
    private void assertSingleCommandChain(String lead, String member)
            throws Exception {
        String session = memberSession(lead, member);
        assertTaskLinksChildSession(lead, member, session);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT record_id, revision FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " domain = 'session_command'",
                tenant, session);
        assertThat(rows.stream().map(row -> row.get("record_id"))
                .distinct()).hasSize(1);
        String commandId = rows.get(0).get("record_id").toString();
        List<Map<String, Object>> receipts = jdbc.queryForList(
                "SELECT record_id, revision FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " domain = 'session_command' AND record_id = ?",
                tenant, lead, commandId);
        assertThat(receipts).hasSize(1);
        assertThat(receipts.get(0).get("revision")).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_delivery"
                        + " WHERE tenant_id = ? AND delivery_id = ?",
                Integer.class, tenant, commandId)).isEqualTo(1);
    }

    private void settleAndCheckDelivered(String lead,
            String... keepWaiting) {
        Set<String> hold = new LinkedHashSet<>(List.of(keepWaiting));
        if (!hold.contains("bob")) {
            releases.get("bob").countDown();
        }
        if (!hold.contains("carol")) {
            releases.get("carol").countDown();
        }
        waiting().atMost(Duration.ofSeconds(120))
                .pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
                    assertNoModelFailure();
                    // No row still owed work may remain.
                    assertThat(jdbc.queryForList(
                            "SELECT transport_state FROM ma_delivery"
                                    + " WHERE tenant_id = ? AND"
                                    + " delivery_kind = 'SESSION_MESSAGE'"
                                    + " AND transport_state NOT IN"
                                    + " ('done', 'orphaned', 'unknown')",
                            tenant)).isEmpty();
                    // A terminal-lost row cannot stand in for receipt at
                    // an expected delivered position either: 'unknown'
                    // and 'orphaned' mean the relay never delivered.
                    assertThat(jdbc.queryForList(
                            "SELECT transport_state FROM ma_delivery"
                                    + " WHERE tenant_id = ? AND"
                                    + " delivery_kind = 'SESSION_MESSAGE'"
                                    + " AND transport_state IN"
                                    + " ('unknown', 'orphaned')",
                            tenant)).isEmpty();
                    // Per-position promise: every minted msgc_ owns exactly
                    // one ledger row proven done/accepted/consumed — a
                    // missing, duplicated, or unproven row fails honestly.
                    for (String minted : msgcRows(lead)) {
                        Long proven = jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_delivery"
                                        + " WHERE tenant_id = ? AND"
                                        + " delivery_kind = 'SESSION_MESSAGE'"
                                        + " AND delivery_id = ? AND"
                                        + " transport_state = 'done' AND"
                                        + " reception_state = 'accepted'"
                                        + " AND consumption_state ="
                                        + " 'consumed'",
                                Long.class, tenant, minted);
                        assertThat(proven)
                                .as("accepted/consumed proof for %s",
                                        minted)
                                .isEqualTo(1L);
                        // The ledger is auxiliary evidence only, after
                        // SessionMessageRelayStore.classify()'s widening
                        // write of consumption_state='consumed' on every
                        // 'done' — even for the fallback paths in
                        // SessionMessageRelay.awaitConsumption where the
                        // receiver's reading Turn ended incompletely and
                        // the receipt stayed accepted. The consumption
                        // authority is the target session's own
                        // session_message journal: its inbound record for
                        // this msgc_ must reach delivery_state='consumed'.
                        List<String> receivers = jdbc.queryForList(
                                "SELECT DISTINCT target_session_id"
                                        + " FROM ma_delivery"
                                        + " WHERE tenant_id = ? AND"
                                        + " delivery_kind = 'SESSION_MESSAGE'"
                                        + " AND delivery_id = ?",
                                String.class, tenant, minted);
                        assertThat(receivers)
                                .as("receiver session for %s", minted)
                                .hasSize(1);
                        Long receiverConsumed = jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session_record"
                                        + " WHERE tenant_id = ? AND"
                                        + " session_id = ? AND"
                                        + " domain = 'session_message' AND"
                                        + " record_id = ? AND"
                                        + " delivery_state = 'consumed'",
                                Long.class, tenant, receivers.get(0),
                                minted);
                        assertThat(receiverConsumed)
                                .as("receiver consumed journal for %s",
                                        minted)
                                .isEqualTo(1L);
                    }
                });
    }

    /** The next letter boots a fresh Spring context whose workspace
     * mounts know only its own tenants; a parked turn or relay row from
     * this letter would be re-claimed there and fail every warm with a
     * mount miss. Open every latch and wait for this letter's journals
     * to reach their terminal states while this context still runs. */
    private void drainLetter() {
        releases.values().forEach(CountDownLatch::countDown);
    }

    /** The distinct msgc_ record ids minted on the lead's journal. */
    private List<String> msgcRows(String lead) {
        return jdbc.queryForList(
                "SELECT DISTINCT record_id FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " domain = 'session_message' AND record_id LIKE"
                        + " 'msgc_%' ORDER BY record_id",
                String.class, tenant, lead);
    }

    /** The receipt's reply document on the lead, via its replyRef. */
    private JsonNode receiptReply(String lead, String member) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT CAST(res.inline_bytes AS CHAR) AS body,"
                        + " r.session_scope_key AS scope FROM"
                        + " ma_session_record r JOIN ma_resource res ON"
                        + " res.session_scope_key = r.session_scope_key"
                        + " AND res.resource_id = r.record_resource_id"
                        + " WHERE r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = 'session_command'"
                        + " ORDER BY r.record_id, r.revision",
                tenant, lead);
        // The lead's only session_command rows are this case's receipt
        // (any rows from prior cases live on prior tenants).
        assertThat(rows).hasSize(1);
        JsonNode receipt = body(rows.get(0));
        String replyRef = receipt.required("replyRef")
                .required("resourceId").asText();
        String scope = rows.get(0).get("scope").toString();
        List<Map<String, Object>> resources = jdbc.queryForList(
                "SELECT CAST(inline_bytes AS CHAR) AS body"
                        + " FROM ma_resource WHERE tenant_id = ? AND"
                        + " session_scope_key = ? AND resource_id = ?",
                tenant, scope, replyRef);
        assertThat(resources).as("replyRef resource").hasSize(1);
        return body(resources.get(0));
    }

    private int attemptCount(String lead, String prefix) {
        Integer count = jdbc.queryForObject(
                "SELECT MAX(attempt_count) FROM ma_delivery"
                        + " WHERE tenant_id = ? AND delivery_id LIKE ?",
                Integer.class, tenant, prefix + "%");
        return count == null ? 0 : count;
    }

    private void awaitDeliveryAttempt(String lead, String prefix,
            int attempts) {
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                        assertThat(attemptCount(lead, prefix))
                                .isGreaterThanOrEqualTo(attempts));
    }

    /** Witness the proxy holding the named rule before anything is
     * released: an early release only logs "(nothing held)" and loses the
     * signal, so the hold must be observed first. */
    private void awaitHolding(String ruleName) {
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofMillis(200)).untilAsserted(() ->
                        assertThat(countOps(storeProxy, "holding "
                                + ruleName)).isGreaterThanOrEqualTo(1));
    }

    /** A peer send to a finished member is refused before any mint lands,
     * so a roster latch may open for delivery only after the minted rows
     * prove the fanout probes committed while the member was still
     * alive. */
    private void awaitMsgcMinted(String lead, int count) {
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                        assertThat(msgcRows(lead).size())
                                .isGreaterThanOrEqualTo(count));
    }

    private List<JsonNode> commandsOf(String session, String domain) {
        List<Map<String, Object>> records = jdbc.queryForList(
                "SELECT CAST(res.inline_bytes AS CHAR) AS body FROM"
                        + " ma_session_record r JOIN ma_resource res ON"
                        + " res.session_scope_key = r.session_scope_key"
                        + " AND res.resource_id = r.record_resource_id"
                        + " WHERE r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = ? ORDER BY r.record_id,"
                        + " r.revision",
                tenant, session, domain);
        List<JsonNode> out = new ArrayList<>();
        for (Map<String, Object> row : records) {
            out.add(jsonBody(row.get("body").toString()));
        }
        return out;
    }

    private JsonNode body(Map<String, Object> row) {
        return jsonBody(row.get("body").toString());
    }

    private JsonNode jsonBody(String text) {
        try {
            return json.readTree(text);
        } catch (IOException failure) {
            throw new AssertionError(failure);
        }
    }

    /** The names in the latest team_state revision on the lead. */
    private List<String> teamMembers(String lead) {
        List<JsonNode> state = commandsOf(lead, "team_state");
        if (state.isEmpty()) {
            return List.of();
        }
        List<String> names = new ArrayList<>();
        for (JsonNode member : state.get(state.size() - 1)
                .path("members")) {
            names.add(member.path("name").asText());
        }
        return names;
    }

    /** team_state → childRunId → child_run record → its session id. */
    private String memberSession(String lead, String member) {
        String runId = childRunIdOf(lead, member);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT CAST(res.inline_bytes AS CHAR) AS body FROM"
                        + " ma_session_record r JOIN ma_resource res ON"
                        + " res.session_scope_key = r.session_scope_key"
                        + " AND res.resource_id = r.record_resource_id"
                        + " WHERE r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = 'child_run' AND r.record_id = ?"
                        + " ORDER BY r.revision DESC LIMIT 1",
                tenant, lead, runId);
        assertThat(rows).hasSize(1);
        String session = body(rows.get(0)).at("/childSessionId")
                .asText("");
        assertThat(session).as("attached session for " + member).isNotEmpty();
        return session;
    }

    /** The member's session once its attach landed on the lead's
     * child_run record, which can trail the member's first model call. */
    private String attachedSession(String lead, String member) {
        AtomicReference<String> session = new AtomicReference<>();
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() ->
                        session.set(memberSession(lead, member)));
        return session.get();
    }

    private void awaitRunState(String lead, String member, String state) {
        waiting().atMost(Duration.ofSeconds(120))
                .pollInterval(Duration.ofSeconds(1)).untilAsserted(() -> {
                    JsonNode record = childRunBody(lead, member);
                    assertThat(record.path("stopReason").asText())
                            .isEqualTo(state);
                });
    }

    private void awaitRunField(String lead, String member,
            Function<JsonNode, Boolean> expect) {
        waiting().atMost(Duration.ofSeconds(120))
                .pollInterval(Duration.ofSeconds(1)).untilAsserted(() ->
                        assertThat(expect.apply(childRunBody(lead, member)))
                                .isTrue());
    }

    /** The latest child_run record body: completion and stopping both
     * live at its top level (stopReason / stopRequested), which the run
     * subdocument does not carry. */
    private JsonNode childRunBody(String lead, String member) {
        String runId = childRunIdOf(lead, member);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT CAST(res.inline_bytes AS CHAR) AS body FROM"
                        + " ma_session_record r JOIN ma_resource res ON"
                        + " res.session_scope_key = r.session_scope_key"
                        + " AND res.resource_id = r.record_resource_id"
                        + " WHERE r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = 'child_run' AND r.record_id = ?"
                        + " ORDER BY r.revision DESC LIMIT 1",
                tenant, lead, runId);
        assertThat(rows).hasSize(1);
        return body(rows.get(0));
    }

    private String childRunIdOf(String lead, String member) {
        List<JsonNode> state = commandsOf(lead, "team_state");
        for (int i = state.size() - 1; i >= 0; i--) {
            for (JsonNode node : state.get(i).path("members")) {
                if (member.equals(node.path("name").asText())) {
                    String runId = node.path("childRunId").asText();
                    if (!runId.isEmpty()) {
                        return runId;
                    }
                }
            }
        }
        throw new AssertionError("no childRunId for " + member
                + " in team_state of " + lead);
    }

    /**
     * Holds the session message relay: its scheduler runs one thread, so a
     * task parked on it keeps every scan, and with it every handover, from
     * running until the latch is released (the H4e-b3 hold).
     */
    private CountDownLatch holdRelay() throws InterruptedException {
        return SchedulerHold.hold(spring.getBean("messageRelayScheduler",
                ThreadPoolTaskScheduler.class), Duration.ofSeconds(30));
    }

    /** The member's only outbound command row, as committed now. */
    private Map<String, Object> outboundRow(String member) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT record_id, revision, delivery_state"
                        + " FROM ma_session_record WHERE tenant_id = ? AND"
                        + " session_id = ? AND domain = 'session_command'",
                tenant, member);
        assertThat(rows).as("one outbound command on " + member).hasSize(1);
        return rows.get(0);
    }

    /** Waits for the member's command to reach {@code state}; its id. */
    private String awaitOutbound(String member, String state) {
        AtomicReference<String> commandId = new AtomicReference<>();
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                    assertNoModelFailure();
                    Map<String, Object> row = outboundRow(member);
                    assertThat(row.get("delivery_state")).isEqualTo(state);
                    commandId.set(row.get("record_id").toString());
                });
        return commandId.get();
    }

    /** A member's Session holds the one Turn its launch admitted. */
    private String onlyTurn(String session) {
        return jdbc.queryForObject(
                "SELECT CAST(turn_id AS CHAR) FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session);
    }

    private void awaitTurnStatus(String session, String turn,
            String status) {
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() ->
                        assertThat(jdbc.queryForObject(
                                "SELECT status FROM ma_turn WHERE"
                                        + " tenant_id = ? AND session_id = ?"
                                        + " AND turn_id = ?",
                                String.class, tenant, session, turn))
                                .isEqualTo(status));
    }

    /** The longest the Harness took to answer a cancel of the Session,
     * read from its request log. */
    private long cancelRouteMillis(String session) throws IOException {
        Matcher route = Pattern.compile("route=POST /session/"
                + Pattern.quote(session) + "/cancel .*durationMs=(\\d+)")
                .matcher(Files.readString(harnessLog));
        long longest = -1;
        while (route.find()) {
            longest = Math.max(longest, Long.parseLong(route.group(1)));
        }
        return longest;
    }

    private static String eventsPath(String session) {
        return "/v1/agents/sessions/" + session + "/events";
    }

    private static Map<String, Object> cancel(String turn) {
        return Map.of("type", "agent.session.cancel", "turn_id", turn);
    }

    private int eventCount(String session, String turn, String type) {
        return jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_public_event WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ? AND"
                        + " event_type = ?",
                Integer.class, tenant, session, turn, type);
    }

    /** Every answer alice's journal committed for her send call. */
    private List<String> sendAnswers(String member) {
        List<String> answers = new ArrayList<>();
        for (String text : jdbc.queryForList(
                "SELECT CAST(inline_bytes AS CHAR) FROM ma_resource"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " kind = 'managed-message'",
                String.class, tenant, member)) {
            JsonNode message = jsonBody(text);
            if (!"tool_result".equals(message.path("type").asText())) {
                continue;
            }
            for (JsonNode part : message.path("message").path("parts")) {
                JsonNode response = part.path("functionResponse");
                if ("alice-send".equals(response.path("id").asText())) {
                    JsonNode answer = response.path("response");
                    answers.add(answer.has("error")
                            ? answer.path("error").asText()
                            : answer.path("output").asText());
                }
            }
        }
        return answers;
    }

    /** The stored bytes a session_command body's replyRef names. */
    private String replyBytes(String session, JsonNode command) {
        return jdbc.queryForObject(
                "SELECT CAST(inline_bytes AS CHAR) FROM ma_resource"
                        + " WHERE tenant_id = ? AND session_id = ? AND"
                        + " resource_id = ?",
                String.class, tenant, session,
                command.required("replyRef").required("resourceId").asText());
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

    /** One ledger row exactly as the surface serves it (FG8e's mapping:
     * snake_case and seconds publicly, camelCase and milliseconds on the
     * WebShell, nulls omitted). */
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
                    .header("X-Fg9-Fixture-Actor", "actor")
                    .header("Accept", "text/event-stream").build(),
                    HttpResponse.BodyHandlers.ofInputStream());
            assertThat(response.statusCode()).as("%s stream of %s", surface,
                    session).isEqualTo(200);
            assertThat(response.headers().firstValue("content-type")
                    .orElse("")).contains("text/event-stream");
            reader = new Thread(() -> read(response.body()),
                    "fg9e-" + surface + "-" + session);
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

    /**
     * Match a POST to the journal commit endpoints whose request body
     * names `operation`; the matcher stays true for up to `occurrences`
     * matching requests and then disengages.
     */
    private static HostedSessionRelayForwardingProxy.Matcher
            matchCommitOperation(String operation, int occurrences) {
        final AtomicInteger seen = new AtomicInteger();
        return (method, path, body) -> {
            if (!"POST".equals(method)
                    || !path.contains("/transactions:commit")
                    || !body.contains("\"" + operation + "\"")) {
                return false;
            }
            return seen.incrementAndGet() <= occurrences;
        };
    }

    // ------------------------------------------- store refusals, crashes

    /**
     * FG9b's fault source, the FG8b shape: a test-only trigger on the
     * journal's record table, scoped to the case tenant and one record
     * kind, refusing every matching write until the case drops it. A
     * fire-once arm would be healed by the store client's own bounded
     * retry before the Session saw it. Each fire also lands in fg9b_fire
     * (MyISAM, so the row survives the signalled rollback) — Spring
     * flattens the SQLException into a 500, so the fire count is the
     * attribution.
     */
    private void refuse(String name, String event, String condition) {
        jdbc.execute("CREATE TABLE IF NOT EXISTS fg9b_fire (case_name"
                + " VARCHAR(64) NOT NULL, fired_at TIMESTAMP(6) NOT NULL"
                + " DEFAULT CURRENT_TIMESTAMP(6)) ENGINE = MyISAM");
        String trigger = "fg9b_" + UUID.randomUUID().toString()
                .replace("-", "");
        refusals.add(trigger);
        jdbc.execute("CREATE TRIGGER " + trigger + " BEFORE " + event
                + " ON ma_session_record FOR EACH ROW BEGIN IF"
                + " NEW.tenant_id = '" + tenant + "' AND " + condition
                + " THEN INSERT INTO fg9b_fire (case_name) VALUES ('" + name
                + "'); SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'FG9B_"
                + name.toUpperCase().replace('-', '_') + "'; END IF; END");
    }

    private void dropRefusals() {
        for (String trigger : refusals) {
            jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
        }
        refusals.clear();
    }

    private int fired(String name) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM fg9b_fire WHERE"
                + " case_name = ?", Integer.class, name);
    }

    /** Every attempt of the store client's bounded retry met the
     * refusal; past it the Session latches its writes and sends no more. */
    private void awaitRefusals(String name) {
        waiting().atMost(Duration.ofSeconds(90))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                    assertNoModelFailure();
                    assertThat(fired(name)).isEqualTo(STORE_ATTEMPTS);
                });
    }

    /** The case tenant's relay ledger rows. */
    private int deliveryRows() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_delivery WHERE"
                + " tenant_id = ? AND delivery_kind = 'SESSION_MESSAGE'",
                Integer.class, tenant);
    }

    private String turnStatus(String session, String turn) {
        return jdbc.queryForObject("SELECT status FROM ma_turn WHERE"
                + " tenant_id = ? AND session_id = ? AND turn_id = ?",
                String.class, tenant, session, turn);
    }

    /**
     * Journal commits of `operation` on the session that the store
     * accepted, as the store proxy saw them: a refused attempt answers
     * 500, and a dropped or held reply still landed.
     */
    private long journalCommits(String session, String operation) {
        return storeProxy.operations().stream()
                .filter(line -> line.startsWith("PROXY passthru ")
                        || line.startsWith("PROXY dropped ")
                        || line.startsWith("PROXY holding "))
                .filter(line -> line.contains("/sessions/" + session
                        + "/transactions:commit"))
                .filter(line -> line.contains(" op=" + operation + " "))
                .filter(line -> line.contains(" status=2"))
                .count();
    }

    /** The lead's own Turn has settled. A Turn still open when its
     * Session latches or its Harness dies keeps the workspace its dead
     * owner held, and the lead's takeover then churns on
     * workspace_unavailable instead of executing anything. */
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

    private long harnessLogMark() throws IOException {
        return Files.size(harnessLog);
    }

    /** The Harness's own log names the fault after `mark`. */
    private void awaitHarnessLog(long mark, String needle) {
        waiting().atMost(Duration.ofSeconds(60))
                .pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
                    byte[] log = Files.readAllBytes(harnessLog);
                    assertThat(new String(log, (int) mark,
                            log.length - (int) mark, StandardCharsets.UTF_8))
                            .contains(needle);
                });
    }

    private long writerGeneration(String session) {
        Long generation = jdbc.queryForObject(
                "SELECT writer_generation FROM ma_session_head"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session);
        return generation == null ? 0 : generation;
    }

    private void restartHarness(String session) throws Exception {
        restartHarness(session, () -> {});
    }

    /**
     * SIGKILLs the packaged Harness (POSIX; every Session it hosts dies
     * with it), runs `whileDown`, and starts a cold one — a new HOME and
     * QWEN_HOME — on the same port; returns once a new writer generation
     * holds `session`, the takeover's witness.
     */
    private void restartHarness(String session, Runnable whileDown)
            throws Exception {
        long generation = writerGeneration(session);
        harnessGeneration.incrementAndGet();
        harness.descendants().forEach(ProcessHandle::destroyForcibly);
        harness.destroyForcibly();
        assertThat(harness.waitFor(20, TimeUnit.SECONDS))
                .as("the killed Harness exited").isTrue();
        whileDown.run();
        startHarness();
        waiting().atMost(Duration.ofSeconds(100))
                .pollInterval(Duration.ofMillis(500)).untilAsserted(() ->
                        assertThat(writerGeneration(session))
                                .as("a new writer generation holds %s",
                                        session)
                                .isGreaterThan(generation));
    }

    // ------------------------------------------------------------- stack

    @BeforeEach
    void reset() {
        carolMode.set("DONE");
    }

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
        // Spring and the embedded broker bind ephemeral ports and are read
        // back after boot: a port picked ahead of a multi-second boot can
        // be taken by any connection opened meanwhile.
        harnessPort = freePort();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelThreads = Executors.newCachedThreadPool();
        model.setExecutor(modelThreads);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        casesRoot = Path.of(System.getProperty("user.dir"), "target",
                "fg9-cases", letter);
        deleteRecursively(casesRoot);
        Files.createDirectories(casesRoot);
        harnessLog = casesRoot.resolve("harness.log");
        slotTenants.clear();
        for (int i = 0; i < caseCount; i++) {
            slotTenants.add("fg9-" + letter + "-"
                    + UUID.randomUUID().toString().substring(0, 8) + "-"
                    + i);
        }
        caseSlot.set(0);
        storeProxy = HostedSessionRelayForwardingProxy.start("store",
                casesRoot.resolve("store-proxy.log"));
        // FG9d's lost cancel reply: only the client's own request passes it.
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
                        + " ?, 1, ?, 'FG9', ?, ?, 'ACTIVE')",
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
                .untilAsserted(() -> request("POST",
                        "/v1/agents/sessions/" + lead + "/events",
                        Map.of("type", "agent.session.input.message",
                                "input",
                                List.of(Map.of("type", "input_text", "text",
                                        marker))),
                        "input-" + marker, 202));
        return lead;
    }

    private void startSpring(Path cli, String node, int caseCount,
            String letter) {
        // The store proxy sits on the Session-Store boundary (all drops
        // and holds live there); the Harness stays direct: proxied, its
        // warm/createOrLoad chain yields hosted_session_already_attached
        // on the second operation (axis probes fg9.harness.direct).
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
                "--qwen.managed-agent.runtime-broker.credential-key-id=fg9-fixture",
                "--qwen.managed-agent.runtime-broker.credential-key="
                        + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        if ("fg9f".equals(letter)) {
            arguments.add(
                    "--qwen.managed-agent.harness.request-timeout=3s");
        }
        if ("fg9e".equals(letter)) {
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
                                .registerSingleton("fg9Authentication",
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
                        "model", Map.of("name", "fg9-fixture"),
                        "telemetry", Map.of("enabled", false),
                        "modelProviders",
                        Map.of("openai", List.of(Map.of("id", "fg9-fixture",
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

    /** #13746 F2: the member's task on the lead names the member's child
     * Session publicly, and that Session reads through the public route. */
    private void assertTaskLinksChildSession(String lead, String member,
            String session) throws Exception {
        String runId = childRunIdOf(lead, member);
        String taskId = "task_" + ManagedExtensionProjection.recordKey(lead,
                "child_run", runId);
        JsonNode task = request("GET", "/v1/agents/sessions/" + lead
                + "/tasks/" + taskId, null, null, 200);
        assertThat(task.path("kind").asText()).isEqualTo("child_agent");
        assertThat(task.path("child_session_id").asText())
                .as("the task view links the member's child Session")
                .isEqualTo(session);
        assertThat(request("GET", "/v1/agents/sessions/" + session, null,
                null, 200).path("id").asText()).isEqualTo(session);
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
                .header("X-Fg9-Fixture-Actor", "actor")
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
                                        "X-Fg9-Fixture-Actor");
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

    private void modelReply(HttpExchange exchange) throws IOException {
        int generation = harnessGeneration.get();
        try {
            JsonNode body = json.readTree(exchange.getRequestBody());
            seenReports.addAll(teammatesOf(body));
            String first = firstUserText(body);
            Matcher member = MEMBER.matcher(first);
            if (member.find()) {
                String name = member.group(1);
                firstContacts.merge(name, 1, Integer::sum);
                if (name.equals(shutdownTarget.get())) {
                    releases.get("stophit").countDown();
                }
                reply(exchange, memberPlan(name, member.group(2), body));
                return;
            }
            if (first.contains("FG9_LEAD_")) {
                reply(exchange, leadPlan(body));
                return;
            }
            reply(exchange, List.of(), "OK");
            return;
        } catch (Exception | AssertionError failure) {
            // A round the killed Harness left open returns into a dead
            // connection once its latch opens; its re-driven round is the
            // one that counts.
            if (generation != harnessGeneration.get()) {
                return;
            }
            modelFailure.compareAndSet(null, failure);
            try {
                reply(exchange, List.of());
            } catch (Exception ignored) {
            }
        } finally {
            exchange.close();
        }
    }

    private record Step(List<Map<String, Object>> calls, String text) {
    }

    /**
     * The lead's staged plan: pure round-count sequencing —
     * team_create, launch bob (DONE), launch carol (DONE or WAIT per
     * case), launch alice (who then fires the case's send when her latch
     * opens), optionally request_shutdown of the named member.
     */
    private Step leadPlan(JsonNode body) throws InterruptedException {
        long rounds = countRoleTool(body);
        if (rounds == 0) {
            return new Step(List.of(call("lead-create", "team_create",
                    Map.of("team_name", "review"))), null);
        }
        if (rounds == 1) {
            return new Step(List.of(call("lead-bob", "agent",
                    Map.of("description", "bob review", "prompt",
                            "FG9_MEMBER_bob_WAIT messaging",
                            "name", "bob"))), null);
        }
        if (rounds == 2) {
            return new Step(List.of(call("lead-carol", "agent",
                    Map.of("description", "carol review", "prompt",
                            "FG9_MEMBER_carol_" + carolMode.get()
                                    + " messaging",
                            "name", "carol"))), null);
        }
        if (rounds == 3) {
            return new Step(List.of(call("lead-alice", "agent",
                    Map.of("description", "alice review", "prompt",
                            "FG9_MEMBER_alice_SEND messaging",
                            "name", "alice"))), null);
        }
        String stop = shutdownTarget.get();
        if (rounds == 4 && stop != null) {
            /* The shutdown must land on an attached run: by length the
             * lead reaches this round long before the target's launch
             * admission finishes, and cancelling a not-started run is
             * honest data but no contact, which strands the case gate. */
            if (!releases.get("stophit").await(60, TimeUnit.SECONDS)) {
                throw new AssertionError(
                        stop + " never contacted before the shutdown");
            }
            return new Step(List.of(call("lead-stop", "request_shutdown",
                    Map.of("to", stop))), null);
        }
        // A closing round with no text is an empty response the model
        // client retries for ~20 s; the lead's Turn (and every wake Turn
        // that reads a member's result) would stay open that long.
        return new Step(List.of(), "LEAD_REPORT done");
    }

    private Step memberPlan(String name, String mode, JsonNode body)
            throws InterruptedException {
        if ("alice".equals(name)) {
            if (!releases.get("send").await(300, TimeUnit.SECONDS)) {
                throw new AssertionError("alice's send latch never opened");
            }
            if (countRoleTool(body) == 0) {
                return new Step(List.of(call("alice-send", "send_message",
                        Map.of("to", aliceTarget.get(), "message",
                                "FG9 hello from alice"))), null);
            }
            return new Step(List.of(), "ALICE_REPORT done");
        }
        if ("DONE".equals(mode)) {
            return new Step(List.of(), name.toUpperCase() + "_REPORT done");
        }
        CountDownLatch latch = releases.get(name);
        if (latch == null || !latch.await(300, TimeUnit.SECONDS)) {
            throw new AssertionError(name + " latch never opened");
        }
        return new Step(List.of(), name.toUpperCase() + "_REPORT done");
    }

    private Set<String> teammatesOf(JsonNode body) {
        Set<String> names = new LinkedHashSet<>();
        for (JsonNode message : body.path("messages")) {
            if (!"user".equals(message.path("role").asText())) {
                continue;
            }
            String text = message.toString().replace("\\u003c", "<")
                    .replace("\\u003e", ">");
            Matcher matcher = TEAMMATE.matcher(text);
            while (matcher.find()) {
                names.add(matcher.group(1));
            }
        }
        return names;
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
        ObjectNode chunk = json.createObjectNode().put("id", "fg9")
                .put("object", "chat.completion.chunk").put("created", 0)
                .put("model", "fg9-fixture");
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

    private static String firstUserText(JsonNode body) {
        for (JsonNode message : body.path("messages")) {
            if (!"user".equals(message.path("role").asText())) {
                continue;
            }
            String text = message.path("content").isTextual()
                    ? message.path("content").asText()
                    : message.path("content").toString();
            if (text.contains("FG9_")) {
                return text;
            }
        }
        return "";
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
