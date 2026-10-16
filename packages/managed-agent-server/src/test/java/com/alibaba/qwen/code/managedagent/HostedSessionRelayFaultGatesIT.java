/**
 * Copyright 2026 Alibaba Group
 * SPDX-License-Identifier: Apache-2.0
 */

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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
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
 * reason, never silently skipped.
 */
class HostedSessionRelayFaultGatesIT {
    private static final String TOKEN = "fg9-fixture";
    private static final String DIGEST = "sha256:" + "b".repeat(64);
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
    private final AtomicInteger caseSlot = new AtomicInteger();
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
        if (harness != null) {
            harness.destroyForcibly();
            try {
                harness.waitFor(20, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        if (storeProxy != null) {
            storeProxy.close();
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
    private void assertSingleCommandChain(String lead, String member) {
        String session = memberSession(lead, member);
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
        port = freePort();
        harnessPort = freePort();
        brokerPort = freePort();
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
                URI.create("http://127.0.0.1:" + port),
                casesRoot.resolve("store-proxy.log"));
        startSpring(cli, node, caseCount,
                "fg9f".equals(letter));
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
            boolean shortHarnessTimeout) {
        // The store proxy sits on the Session-Store boundary (all drops
        // and holds live there); the Harness stays direct: proxied, its
        // warm/createOrLoad chain yields hosted_session_already_attached
        // on the second operation (axis probes fg9.harness.direct).
        List<String> arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=" + port,
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
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
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
        if (shortHarnessTimeout) {
            arguments.add(
                    "--qwen.managed-agent.harness.request-timeout=3s");
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
                .redirectErrorStream(true).redirectOutput(harnessLog.toFile());
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
        HttpRequest.Builder request = HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + path))
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
        filter.addUrlPatterns("/v1/agents/*");
        return filter;
    }

    // ------------------------------------------------------- the model

    private void modelReply(HttpExchange exchange) throws IOException {
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
        return new Step(List.of(), null);
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
