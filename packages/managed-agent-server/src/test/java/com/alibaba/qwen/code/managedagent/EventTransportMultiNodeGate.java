package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.event.EventTransportNodeMain;
import com.alibaba.qwen.code.managedagent.event.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.event.ManagedEventEnvelopes;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.rocketmq.client.apis.ClientConfiguration;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.awaitility.Awaitility;
import org.awaitility.core.ConditionFactory;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInfo;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The MQ3 deployment fault matrix (design
 * 2026-10-14-managed-agent-event-transport-mq3): two control-plane nodes,
 * each the whole application in its own JVM with its own packaged Hosted
 * Harness, share one MySQL database and one RocketMQ 5.5 LiteTopic cluster,
 * and the §8 faults are injected into the processes themselves — a node
 * halted at a named point, a broker frozen, a clock moved, the flag turned
 * off. Each node appends what it decided to an evidence file; the gate
 * asserts on that, on SQL and on the public API, never on a node's say-so
 * alone.
 *
 * <p>Run by the {@code event-transport-multi-node-gates} profile against
 * {@code scripts/rocketmq-lite-broker.sh start}, a MySQL 8.4 server and the
 * bundled CLI; every coordinate arrives as a system property and a missing
 * one fails the gate rather than skipping it — only the clock-skew row is
 * skipped without libfaketime, and CI's report check fails on that skip.
 * The rows' timeouts add up to less than the profile's fork timeout. The
 * broker must be this run's
 * alone: the nodes join the server's default groups and the oracle reads
 * the gate group, so a second run against it would split their lite topics.
 */
class EventTransportMultiNodeGate {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "mq3-harness-token";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final String MODEL = "mq3-fixture-model";
    private static final String WORKSPACE = "mq3-workspace";
    private static final String ORACLE_GROUP = "qwen-transport-gate-oracle";
    private static final String BOOTSTRAP_LITE_TOPIC = "qwen-wake-bootstrap";
    private static final Pattern LISTENING = Pattern.compile(
            "listening on http://127\\.0\\.0\\.1:(\\d+)");
    // Short leases so a crashed node's hold lapses within a row.
    private static final String WRITER_LEASE = "6s";
    private static final Duration SETTLE = Duration.ofSeconds(90);
    private static final Duration DELIVERY = Duration.ofSeconds(60);
    // A wake a crashed member held unacknowledged moves to another member
    // only once the broker expires the dead client (about two minutes by
    // default), and its lite topic's later messages wait behind it.
    private static final Duration REDELIVERY = Duration.ofMinutes(4);

    private static IsolatedManagedSchemaMySqlTestDatabase database;
    private static String databaseUrl;
    private static JdbcTemplate jdbc;
    private static HttpServer model;
    private static ExecutorService modelThreads;
    private static final AtomicInteger MODEL_CALLS = new AtomicInteger();
    private static ClientServiceProvider provider;
    private static Producer injector;
    private static LitePushConsumer oracle;
    // Every body the oracle group sees, on the bootstrap lane and on each
    // Session lane a row watches.
    private static final List<String> SEEN = new CopyOnWriteArrayList<>();
    private static final HttpClient HTTP = HttpClient.newHttpClient();
    // Child processes and a frozen proxy outlive a killed gate JVM unless
    // this JVM cleans them up on its way out.
    private static final List<Process> STARTED = new CopyOnWriteArrayList<>();
    private static volatile long frozenProxy;
    private static boolean schemaReady;

    private final List<Node> nodes = new ArrayList<>();
    private Path caseRoot;
    private Path shared;
    private String tenant;

    @BeforeAll
    static void startSharedServices() throws Exception {
        for (String name : List.of("mysql.url", "mysql.user", "qwen.cli.entry",
                "qwen.gate.rocketmq.endpoints", "qwen.gate.rocketmq.topic",
                "qwen.gate.rocketmq.work-dir")) {
            if (System.getProperty(name, "").isBlank()) {
                throw new IllegalStateException(name + " is unset: run the"
                        + " event-transport-multi-node-gates profile against a"
                        + " MySQL 8.4 server, the bundled CLI and"
                        + " scripts/rocketmq-lite-broker.sh start");
            }
        }
        assertThat(Path.of(System.getProperty("qwen.cli.entry"))).as(
                "Build and bundle the packaged CLI first").isRegularFile();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            long frozen = frozenProxy;
            if (frozen != 0) {
                ProcessHandle.of(frozen).ifPresent(ignored -> {
                    try {
                        new ProcessBuilder("kill", "-CONT", Long.toString(frozen))
                                .start().waitFor(5, TimeUnit.SECONDS);
                    } catch (Exception unsignalled) {
                        // The broker script's stop still ends it.
                    }
                });
            }
            for (Process process : STARTED) {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
            }
        }));
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        databaseUrl = ((DriverManagerDataSource) database.source()).getUrl();
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        modelThreads = Executors.newCachedThreadPool();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.setExecutor(modelThreads);
        model.createContext("/v1/chat/completions", EventTransportMultiNodeGate::reply);
        model.start();
        provider = ClientServiceProvider.loadService();
        ClientConfiguration client = ClientConfiguration.newBuilder()
                .setEndpoints(endpoints()).build();
        injector = provider.newProducerBuilder().setClientConfiguration(client)
                .setTopics(topic()).build();
        oracle = provider.newLitePushConsumerBuilder().setClientConfiguration(client)
                .setConsumerGroup(ORACLE_GROUP).bindTopic(topic())
                .setMessageListener(message -> {
                    ByteBuffer view = message.getBody().duplicate();
                    byte[] bytes = new byte[view.remaining()];
                    view.get(bytes);
                    SEEN.add(new String(bytes, StandardCharsets.UTF_8));
                    return ConsumeResult.SUCCESS;
                }).build();
        oracle.subscribeLite(BOOTSTRAP_LITE_TOPIC);
    }

    @AfterAll
    static void stopSharedServices() throws Exception {
        if (oracle != null) {
            oracle.close();
        }
        if (injector != null) {
            injector.close();
        }
        if (model != null) {
            model.stop(0);
            modelThreads.shutdownNow();
        }
        if (database != null) {
            database.close();
        }
    }

    @BeforeEach
    void prepareCase(TestInfo test) throws IOException {
        tenant = "mq3-" + UUID.randomUUID();
        caseRoot = Path.of("target", "mq3-multi-node",
                test.getTestMethod().orElseThrow().getName()).toAbsolutePath();
        deleteRecursively(caseRoot);
        shared = Files.createDirectories(caseRoot.resolve("shared"));
        Files.createDirectories(shared.resolve("fired"));
    }

    @AfterEach
    void stopNodes() throws InterruptedException {
        if (!nodes.isEmpty()) {
            // Let acknowledgements leave first: a node killed holding an
            // unacknowledged message holds its lite topic for the broker's
            // client expiry, and the next row would wait behind it.
            Thread.sleep(2_000);
        }
        for (Node node : nodes) {
            node.crash();
        }
        nodes.clear();
    }

    // --- rows ---

    /**
     * §8 duplicate, reorder and redelivery after a lost acknowledgement, with
     * both nodes in the shared bootstrap group: a Session's committed wakes,
     * re-sent to the lane after its writer lapsed — the newer one twice, then
     * the older — activate it once, through a real Harness load. The load is
     * held until every copy is decided, so each refusal is the claim
     * watermark's, never a live writer's. Which node a copy lands on is the
     * broker's choice; the concurrent claim race itself is pinned at the SQL
     * level (EventTransportConsumerSqlTest).
     */
    @Test
    @Timeout(240)
    void wakesDeliveredAgainActivateTheSessionOnce() throws Exception {
        // The second node joins after the Turns: any node's dispatcher may
        // claim a fresh Turn, and the row needs a's Harness to hold the
        // Session it then frees.
        Node a = node("a").start(true);
        String session = createSession(a);
        turn(a, session, "MQ3_FIRST");
        turn(a, session, "MQ3_SECOND");
        assertThat(writerId(session)).isEqualTo(a.bootId);
        Node b = node("b").start(true);
        List<ManagedEventEnvelope> wakes = committedWakes(session, 2);
        // Live writer: each wake the two Turns committed was owned, on the
        // bootstrap lane and on the owner's lane alike.
        await().atMost(DELIVERY).untilAsserted(() -> assertThat(since(Map.of(), "wake",
                session, a, b).stream().map(line -> line.path("sequence").asLong()))
                .contains(wakes.get(0).sequence(), wakes.get(1).sequence()));
        assertThat(outcomes(since(Map.of(), "wake", session, a, b))).containsOnly("OWNED");
        freeSession(a, session);
        Node a2 = node("a2").start(true);
        long generation = writerGeneration(session);
        Map<Node, Integer> base = baseline("wake", session, b, a2);
        arm("hold-load", session);

        inject(wakes.get(1));
        inject(wakes.get(1));
        inject(wakes.get(0));

        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(since(base, "wake", session, b, a2)).hasSize(3));
        assertThat(outcomes(since(base, "wake", session, b, a2)))
                .containsExactlyInAnyOrder("SCHEDULED", "DUPLICATE", "DUPLICATE");
        assertThat(wakeWatermark(session)).isEqualTo(wakes.get(1).sequence());
        assertThat(writerGeneration(session)).isEqualTo(generation);
        release(session);
        await().atMost(SETTLE).untilAsserted(() ->
                assertThat(outcomes(since(Map.of(), "load", session, b, a2)))
                        .containsExactly("ACTIVATED"));
        Node activator = activator(session, b, a2);
        assertThat(writerGeneration(session)).isEqualTo(generation + 1);
        assertThat(writerId(session)).isEqualTo(activator.bootId);
        // Nothing more is coming: the copies were all consumed.
        Thread.sleep(5_000);
        assertThat(since(base, "wake", session, b, a2)).hasSize(3);
        assertThat(writerGeneration(session)).isEqualTo(generation + 1);
    }

    /**
     * §8 consumer crash before processing: the node the broker hands the
     * wake to halts before it reads anything, so nothing is claimed or
     * acknowledged; the broker re-dispatches to the other member of the
     * shared bootstrap group, which activates the Session.
     */
    @Test
    @Timeout(360)
    void aWakeWhoseReceiverCrashesBeforeProcessingActivatesOnTheOtherNode()
            throws Exception {
        Node a = node("a").start(true);
        String session = createSession(a);
        turn(a, session, "MQ3_FIRST");
        assertThat(writerId(session)).isEqualTo(a.bootId);
        Node b = node("b").start(true);
        ManagedEventEnvelope wake = committedWakes(session, 1).getFirst();
        freeSession(a, session);
        Node a2 = node("a2").start(true);
        long generation = writerGeneration(session);
        Map<Node, Integer> wakesBefore = baseline("wake", session, b, a2);
        Map<Node, Integer> loadsBefore = baseline("load", session, b, a2);
        arm("halt-on-receive", session);

        inject(wake);

        Node halted = awaitHalt(b, a2);
        Node survivor = halted == b ? a2 : b;
        halted.crash();
        assertThat(lines(halted, "halt")).singleElement().satisfies(line ->
                assertThat(line.path("rule").asText()).isEqualTo("halt-on-receive"));
        assertThat(since(wakesBefore, "wake", session, halted)).isEmpty();
        assertThat(wakeWatermark(session)).isNull();
        await().atMost(REDELIVERY).untilAsserted(() -> {
            assertThat(outcomes(since(loadsBefore, "load", session, survivor)))
                    .containsExactly("ACTIVATED");
            assertThat(outcomes(since(wakesBefore, "wake", session, survivor)))
                    .containsExactly("SCHEDULED");
        });
        recordRedelivery(session, halted, since(wakesBefore, "wake", session, survivor));
        assertThat(wakeWatermark(session)).isEqualTo(wake.sequence());
        assertThat(writerGeneration(session)).isEqualTo(generation + 1);
        assertThat(writerId(session)).isEqualTo(survivor.bootId);
    }

    /**
     * §8 consumer crash after a local effect, before the acknowledgement:
     * the receiver claims the wake and halts before its listener returns.
     * The redelivery reaches the other node and is refused on the watermark,
     * so the Session is never loaded twice for one wake, and new input still
     * runs on the survivor through its Turn. (That a claim never blocks a
     * later wake is pinned at the SQL level, EventTransportConsumerSqlTest.)
     */
    @Test
    @Timeout(360)
    void aWakeWhoseReceiverCrashesAfterClaimingItIsNotLoadedTwice() throws Exception {
        Node a = node("a").start(true);
        String session = createSession(a);
        turn(a, session, "MQ3_FIRST");
        assertThat(writerId(session)).isEqualTo(a.bootId);
        Node b = node("b").start(true);
        ManagedEventEnvelope wake = committedWakes(session, 1).getFirst();
        freeSession(a, session);
        Node a2 = node("a2").start(true);
        long generation = writerGeneration(session);
        Map<Node, Integer> wakesBefore = baseline("wake", session, b, a2);
        Map<Node, Integer> loadsBefore = baseline("load", session, b, a2);
        arm("halt-after-claim", session);

        inject(wake);

        Node halted = awaitHalt(b, a2);
        Node survivor = halted == b ? a2 : b;
        halted.crash();
        assertThat(outcomes(since(wakesBefore, "wake", session, halted)))
                .containsExactly("SCHEDULED");
        assertThat(lines(halted, "halt")).singleElement().satisfies(line ->
                assertThat(line.path("rule").asText()).isEqualTo("halt-after-claim"));
        assertThat(wakeWatermark(session)).isEqualTo(wake.sequence());
        // The unacknowledged copy moves to the survivor and is refused there.
        await().atMost(REDELIVERY).untilAsserted(() ->
                assertThat(outcomes(since(wakesBefore, "wake", session, survivor)))
                        .containsExactly("DUPLICATE"));
        recordRedelivery(session, halted, since(wakesBefore, "wake", session, survivor));
        Thread.sleep(3_000);
        assertThat(since(loadsBefore, "load", session, survivor)).isEmpty();
        assertThat(writerGeneration(session)).isEqualTo(generation);

        turn(survivor, session, "MQ3_AFTER_CLAIM");
        assertThat(writerGeneration(session)).isEqualTo(generation + 1);
        assertThat(writerId(session)).isEqualTo(survivor.bootId);
    }

    /**
     * §8 producer crash between the SQL commit and the publish, on the
     * journal wire: the node whose Harness commits the Turn's input halts
     * after the commit and before its wake reaches the broker. The wake is
     * committed, never sent on either lane and never claimed; the Turn
     * dispatcher — that input's own ledger — picks the Turn up on the other
     * node once the dead node's leases lapse and settles it there, once.
     */
    @Test
    @Timeout(240)
    void aWakeLostWithItsProducerLeavesTheTurnToItsLedger() throws Exception {
        Node a = node("a").start(true);
        Node b = node("b").start(true);
        String session = createSession(a);
        watch(session);
        arm("halt-on-journal-wake", session);

        inputToANodeThatMayHalt(a, session, "MQ3_LOST_WAKE");

        Node halted = awaitHalt(a, b);
        Node survivor = halted == a ? b : a;
        long lost = lines(halted, "halt").getFirst().path("wakes").get(0).asLong();
        // A whole node is gone, its Harness with it.
        halted.crash();
        assertThat(journalWakes(session)).as("the committed wakes").contains(lost);
        await().atMost(SETTLE).pollInterval(Duration.ofMillis(500)).until(() ->
                !terminalTurns(survivor, session).isEmpty());
        Thread.sleep(5_000);
        List<String> terminal = terminalTurns(survivor, session);
        assertThat(terminal).hasSize(1);
        assertThat(sentWakes(session)).doesNotContain(lost);
        assertThat(wakeWatermark(session)).isNull();
        Files.writeString(caseRoot.resolve("settled.json"), JSON.writeValueAsString(
                Map.of("haltedNode", halted.name, "lostWake", lost,
                        "terminal", terminal.getFirst())));
    }

    /**
     * §8 producer crash between the SQL commit and the publish, on the public
     * wire: the node recording a Turn's last batch — the one carrying
     * {@code turn.completed} — halts after committing it and before handing
     * it to the broker. No later notice of the Session follows, so only the
     * scheduled materialization pass, on the other node, can project that
     * batch: the committed events are served with no gap, the projection
     * covers them, and the items carry the input and the reply.
     */
    @Test
    @Timeout(240)
    void publicEventsLostWithTheirProducerAreStillServedFromSql() throws Exception {
        Node a = node("a").start(true);
        Node b = node("b").start(true);
        String session = createSession(a);
        arm("halt-on-public-terminal", session);

        input(a, session, "MQ3_LOST_NOTICE");

        Node halted = awaitHalt(a, b);
        Node survivor = halted == a ? b : a;
        halted.crash();
        JsonNode halt = lines(halted, "halt").getFirst();
        // The batch the dead node committed, not one a re-run would write.
        JsonNode completed = null;
        for (JsonNode event : events(survivor, session)) {
            if (halt.path("eventId").asText().equals(event.path("event_id").asText())) {
                completed = event;
            }
        }
        assertThat(completed).as("the committed turn.completed").isNotNull();
        assertThat(completed.path("type").asText()).isEqualTo("turn.completed");
        assertThat(completedTurns(survivor, session)).isEqualTo(1);
        List<Long> sequences = new ArrayList<>();
        for (JsonNode event : events(survivor, session)) {
            sequences.add(event.path("sequence").asLong());
        }
        for (int index = 0; index < sequences.size(); index++) {
            assertThat(sequences.get(index)).as("public event %s", index).isEqualTo(index + 1L);
        }
        assertThat(stream(session, "last_sequence")).isEqualTo(sequences.getLast());
        await().atMost(DELIVERY).untilAsserted(() -> assertThat(stream(session,
                "covered_sequence")).isEqualTo(stream(session, "last_sequence")));
        String items = api(survivor, "GET", "/v1/agents/sessions/" + session + "/items",
                null, null, 200).toString();
        assertThat(items).contains("MQ3_LOST_NOTICE").contains("MQ3_REPLY_");
    }

    /**
     * §8 broker short outage: the proxy every client talks to is frozen while
     * a Turn runs. The Turn completes, both hand-offs on the committing
     * thread stay bounded — the broker is never on the commit path — and
     * once the proxy is back the transport carries the next Turn's wake.
     */
    @Test
    @Timeout(240)
    void aShortBrokerOutageNeverReachesTheCommitPath() throws Exception {
        Node a = node("a").start(true);
        Node b = node("b").start(true);
        String session = createSession(a);
        turn(a, session, "MQ3_BEFORE_OUTAGE");
        Map<Node, Integer> journalBefore = baseline("journal-handoff", null, a, b);
        Map<Node, Integer> publicBefore = baseline("public-handoff", null, a, b);

        long started = System.nanoTime();
        try (Frozen proxy = freezeProxy()) {
            turn(a, session, "MQ3_DURING_OUTAGE");
            assertThat(Duration.ofNanos(System.nanoTime() - started))
                    .as("a Turn while the broker is frozen").isLessThan(Duration.ofSeconds(30));
        }
        assertBounded(since(journalBefore, "journal-handoff", null, a, b), "journal");
        assertBounded(since(publicBefore, "public-handoff", null, a, b), "public");

        turn(a, session, "MQ3_AFTER_OUTAGE");
        long next = journalWakes(session).getLast();
        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(sentWakes(session)).contains(next));
    }

    /**
     * §8 broker long outage and flag rollback: with the proxy frozen past
     * the client's own attempts, a running node keeps serving Turns with
     * both hand-offs bounded; a node restarted with the flag on refuses to
     * start (its startup probes need the broker), and the same node — the
     * only one left — restarted with the flag off starts and serves. Once
     * the broker is back, it restarts with the flag on and carries wakes
     * again.
     */
    @Test
    @Timeout(360)
    void aLongBrokerOutageLeavesTheFlagAsTheWayBack() throws Exception {
        Node a = node("a").start(true);
        String session = createSession(a);
        turn(a, session, "MQ3_BEFORE_LONG_OUTAGE");
        assertThat(writerId(session)).isEqualTo(a.bootId);
        // Establish a's writer before b joins: either dispatcher can claim
        // a fresh Turn, but a live writer keeps its journal ownership.
        Node b = node("b").start(true);
        // The surviving node must still own the journal whose failed sends we await.
        assertThat(writerId(session)).isEqualTo(a.bootId);

        try (Frozen proxy = freezeProxy()) {
            turn(a, session, "MQ3_DURING_LONG_OUTAGE");
            assertThat(writerId(session)).isEqualTo(a.bootId);
            b.crashSpring();
            String refused = b.startSpringExpectingFailure(true, Duration.ofMinutes(4));
            // Pins MQ3 finding 3 (startup needs the broker): a fix that lets a
            // node start through an outage inverts this.
            assertThat(refused).contains("capability probe failed");
            // The client's own attempts have run out: sends are failing.
            await().atMost(DELIVERY).until(() -> Files.readString(a.root.resolve(
                    "spring.log")).contains("dropped authoritative_journal envelope"));
            Map<Node, Integer> journalBefore = baseline("journal-handoff", null, a);
            Map<Node, Integer> publicBefore = baseline("public-handoff", null, a);
            turn(a, session, "MQ3_DEEP_IN_THE_OUTAGE");
            // A Session nobody holds yet: its first load and subscription
            // happen in the outage.
            String cold = createSession(a);
            long started = System.nanoTime();
            turn(a, cold, "MQ3_COLD_IN_THE_OUTAGE");
            assertThat(Duration.ofNanos(System.nanoTime() - started))
                    .as("a cold Session's first Turn while the broker is frozen")
                    .isLessThan(Duration.ofSeconds(30));
            assertBounded(since(journalBefore, "journal-handoff", null, a), "journal");
            assertBounded(since(publicBefore, "public-handoff", null, a), "public");
            a.crash();
            int hooked = hookLines(b);
            b.startSpring(false);
            String other = createSession(b);
            turn(b, other, "MQ3_FLAG_OFF_DURING_OUTAGE");
            assertThat(writerId(other)).isEqualTo(b.bootId);
            assertThat(hookLines(b)).as("flag off, the hooked beans do not exist").isEqualTo(hooked);
        }

        b.crashSpring();
        b.startSpring(true);
        String later = createSession(b);
        turn(b, later, "MQ3_AFTER_LONG_OUTAGE");
        assertThat(writerId(later)).isEqualTo(b.bootId);
        long wake = journalWakes(later).getLast();
        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(sentWakes(later)).contains(wake));
        assertThat(since(Map.of(), "journal-handoff", later, b)).isNotEmpty();
    }

    /**
     * §8 flag rollback across the fleet: with every node restarted flag-off,
     * Turns run exactly as before and nothing reaches the broker or the
     * consumers; turned back on, the next Turn's wake is published again and
     * the Session is served as before.
     */
    @Test
    @Timeout(300)
    void theFleetRollsTheFlagBackAndForth() throws Exception {
        Node a = node("a").start(true);
        Node b = node("b").start(true);
        String session = createSession(a);
        watch(session);
        turn(a, session, "MQ3_FLAG_ON");
        long first = journalWakes(session).getLast();
        await().atMost(DELIVERY).untilAsserted(() -> {
            assertThat(sentWakes(session)).contains(first);
            // The watched Session lane carries the public stream too.
            assertThat(seenPublic(session)).isPositive();
        });

        // A rolling restart of whole nodes: a Harness that outlives its
        // control plane keeps attachments the restarted one does not honor.
        for (Node node : List.of(a, b)) {
            node.restart(false);
        }
        int hookedA = hookLines(a);
        int hookedB = hookLines(b);
        int seen = SEEN.size();
        turn(a, session, "MQ3_FLAG_OFF");
        turn(b, session, "MQ3_FLAG_OFF_ON_B");
        Thread.sleep(5_000);
        assertThat(SEEN).as("anything on the Session's or the bootstrap lane").hasSize(seen);
        // Flag off, the hooked beans do not exist at all: a wake sent now
        // waits on the broker, unconsumed.
        ManagedEventEnvelope parked = journalEnvelopes(session).getLast();
        inject(parked);
        Thread.sleep(5_000);
        assertThat(hookLines(a)).isEqualTo(hookedA);
        assertThat(hookLines(b)).isEqualTo(hookedB);

        for (Node node : List.of(a, b)) {
            node.restart(true);
        }
        // Flag on again, the parked wake is consumed.
        await().atMost(DELIVERY).until(() -> since(Map.of(), "wake", session, a, b).stream()
                .anyMatch(line -> line.path("sequence").asLong() == parked.sequence()));
        turn(a, session, "MQ3_FLAG_ON_AGAIN");
        long again = journalWakes(session).getLast();
        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(sentWakes(session)).contains(again));
        assertThat(completedTurns(a, session)).isEqualTo(4);
    }

    /**
     * §8 stale wake after a re-route: the Session moved from the node that
     * committed a wake to another node, whose Harness now holds its journal.
     * The old wake, delivered again, finds that live writer on whichever node
     * it lands: no claim, no load, the writer unchanged.
     */
    @Test
    @Timeout(240)
    void aStaleWakeAfterAReRouteIsANoOp() throws Exception {
        Node a = node("a").start(true);
        String session = createSession(a);
        turn(a, session, "MQ3_ON_A");
        assertThat(writerId(session)).isEqualTo(a.bootId);
        Node b = node("b").start(true);
        ManagedEventEnvelope stale = committedWakes(session, 1).getFirst();
        freeSession(a, session);
        // Only b runs the re-routed Turn; a2 joins the lane after it.
        turn(b, session, "MQ3_REROUTED_TO_B");
        assertThat(writerId(session)).isEqualTo(b.bootId);
        Node a2 = node("a2").start(true);
        long generation = writerGeneration(session);
        // Every wake so far met a live writer, and a live writer is never
        // claimed past.
        assertThat(wakeWatermark(session)).isNull();
        Map<Node, Integer> wakesBefore = baseline("wake", session, b, a2);
        Map<Node, Integer> loadsBefore = baseline("load", session, b, a2);

        inject(stale);

        await().atMost(DELIVERY).until(() -> !staleLines(wakesBefore, session, stale,
                b, a2).isEmpty());
        assertThat(outcomes(staleLines(wakesBefore, session, stale, b, a2)))
                .containsOnly("OWNED");
        Thread.sleep(3_000);
        assertThat(since(loadsBefore, "load", session, b, a2)).isEmpty();
        assertThat(wakeWatermark(session)).isNull();
        assertThat(writerGeneration(session)).isEqualTo(generation);
        assertThat(writerId(session)).isEqualTo(b.bootId);
    }

    /**
     * §8 clock skew between Java nodes: the wake decisions read the database
     * clock. A node whose JVM wall clock runs ten minutes ahead still sees
     * another node's live writer as live, and one whose clock runs ten
     * minutes behind still sees a lapsed writer as lapsed and activates the
     * Session. The skew is libfaketime's, on the application JVM (its
     * Harness keeps the host clock), and each skewed node proves it took
     * effect; without libfaketime the row cannot test anything — the wake
     * path reads no Clock bean — and is skipped. The node that holds the
     * Session runs with the flag off, so the skewed node is the only member
     * of the bootstrap lane, and no Turn runs while a skewed node is up: the
     * Turn dispatch lease is stamped with the JVM clock, which the MQ3 design
     * records as outside this row.
     */
    @Test
    @Timeout(300)
    void wakeDecisionsFollowTheDatabaseClockNotTheNode() throws Exception {
        assumeTrue(!System.getProperty("qwen.gate.faketime.library", "").isBlank(),
                "the clock-skew row needs libfaketime (qwen.gate.faketime.library)");
        Node a = node("a").start(false);
        String session = createSession(a);
        turn(a, session, "MQ3_HELD_BY_A");
        // Started after the Turn: a node this far ahead reads every Turn
        // dispatch lease, which the JVM clock stamps, as lapsed.
        Node ahead = node("ahead").skewed(Duration.ofMinutes(10)).start(true);
        ManagedEventEnvelope wake = journalEnvelopes(session).getFirst();
        long generation = writerGeneration(session);

        inject(wake);

        await().atMost(DELIVERY).untilAsserted(() -> assertThat(
                outcomes(since(Map.of(), "wake", session, ahead))).containsExactly("OWNED"));
        assertThat(writerGeneration(session)).isEqualTo(generation);
        assertThat(wakeWatermark(session)).isNull();

        // Let the acknowledgement leave before the node goes: an unacknowledged
        // message would hold the lane for the broker's client expiry.
        Thread.sleep(3_000);
        ahead.crash();
        freeSession(a, session);
        Node behind = node("behind").skewed(Duration.ofMinutes(-10)).start(true);
        inject(wake);
        await().atMost(SETTLE).untilAsserted(() -> {
            assertThat(outcomes(since(Map.of(), "load", session, behind)))
                    .containsExactly("ACTIVATED");
            assertThat(outcomes(since(Map.of(), "wake", session, behind)))
                    .containsExactly("SCHEDULED");
        });
        assertThat(writerId(session)).isEqualTo(behind.bootId);
        assertThat(writerGeneration(session)).isEqualTo(generation + 1);
        // The lease it was granted, and keeps renewing, is live by database time.
        assertThat(leaseLive(session)).isTrue();
        Thread.sleep(4_000);
        assertThat(leaseLive(session)).isTrue();
    }

    /**
     * Awaitility ignores the interrupt a row's {@code @Timeout} sends, so a
     * stalled row would run every await out and the class past its fork:
     * each wait fails fast once the calling thread is interrupted.
     */
    private static ConditionFactory await() {
        Thread caller = Thread.currentThread();
        return Awaitility.await().failFast("the row ran out of time", caller::isInterrupted);
    }

    // --- the public API ---

    private String createSession(Node node) {
        return api(node, "POST", "/v1/agents/sessions", UUID.randomUUID().toString(),
                "{\"agent_id\":\"qwen-code\"}", 202).path("id").asText();
    }

    private void input(Node node, String session, String text) {
        api(node, "POST", "/v1/agents/sessions/" + session + "/events",
                UUID.randomUUID().toString(), "{\"type\":\"agent.session.input.message\","
                        + "\"input\":[{\"type\":\"input_text\",\"text\":\"" + text + "\"}]}",
                202);
    }

    /** Sends an input to a node armed to halt while it handles it. */
    private void inputToANodeThatMayHalt(Node node, String session, String text) {
        try {
            input(node, session, text);
        } catch (UncheckedIOException dropped) {
            // The node halted mid-request; the gate asserts what it committed.
        }
    }

    private List<String> terminalTurns(Node node, String session) {
        List<String> terminal = new ArrayList<>();
        for (JsonNode event : events(node, session)) {
            String type = event.path("type").asText();
            if (List.of("turn.completed", "turn.failed", "turn.cancelled").contains(type)) {
                terminal.add(type);
            }
        }
        return terminal;
    }

    private JsonNode events(Node node, String session) {
        return api(node, "GET", "/v1/agents/sessions/" + session + "/events?limit=1000",
                null, null, 200).path("data");
    }

    /** Sends one input through the node's public API and waits for its Turn. */
    private void turn(Node node, String session, String text) {
        int before = completedTurns(node, session);
        input(node, session, text);
        await().atMost(SETTLE).pollInterval(Duration.ofMillis(200)).until(() ->
                completedTurns(node, session) > before);
    }

    private int completedTurns(Node node, String session) {
        int count = 0;
        for (JsonNode event : events(node, session)) {
            if ("turn.completed".equals(event.path("type").asText())) {
                count++;
            }
        }
        return count;
    }

    private JsonNode api(Node node, String method, String path, String idempotencyKey,
            String body, int expected) {
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(
                    URI.create("http://127.0.0.1:" + node.springPort + path))
                    .timeout(Duration.ofSeconds(20))
                    .header("X-Qwen-Tenant-Id", tenant)
                    .header("Accept", "application/json")
                    .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body));
            if (body != null) {
                request.header("Content-Type", "application/json");
            }
            if (idempotencyKey != null) {
                request.header("Idempotency-Key", idempotencyKey);
            }
            HttpResponse<String> response = HTTP.send(
                    request.build(), HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).as("%s %s on %s: %s", method, path,
                    node.name, response.body()).isEqualTo(expected);
            return JSON.readTree(response.body());
        } catch (IOException failure) {
            throw new UncheckedIOException(failure);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
    }

    // --- faults and evidence ---

    private void arm(String rule, String session) throws IOException {
        Files.createDirectories(shared.resolve("faults").resolve(rule));
        Files.createFile(shared.resolve("faults").resolve(rule).resolve(session));
    }

    /** Lets the loads the hold-load fault parked go on. */
    private void release(String session) throws IOException {
        Files.createDirectories(shared.resolve("release"));
        Files.createFile(shared.resolve("release").resolve(session));
    }

    /** Crashes a node outright and waits until its writer lease has lapsed. */
    private void freeSession(Node node, String session) {
        node.crash();
        await().atMost(SETTLE).pollInterval(Duration.ofMillis(250)).until(() ->
                Boolean.TRUE.equals(jdbc.queryForObject("SELECT writer_lease_until"
                        + " <= " + ManagedSchemaTime.SQL_NOW + " FROM ma_session_head WHERE"
                        + " tenant_id = ? AND session_id = ? AND head_kind ="
                        + " 'MANAGED_SESSION'", Boolean.class, tenant, session)));
    }

    /** Writes how long the broker took to hand the held wake on, for the record. */
    private void recordRedelivery(String session, Node halted, List<JsonNode> survivorLines)
            throws IOException {
        long haltedAt = lines(halted, "halt").getFirst().path("at").asLong();
        Files.writeString(caseRoot.resolve("redelivery.json"), JSON.writeValueAsString(
                Map.of("session", session, "haltedNode", halted.name,
                        "survivor", survivorLines.getFirst().path("node").asText(),
                        "redeliveryMillis",
                        survivorLines.getFirst().path("at").asLong() - haltedAt)));
    }

    private Node awaitHalt(Node... candidates) {
        await().atMost(DELIVERY).until(() -> {
            for (Node candidate : candidates) {
                if (!candidate.spring.isAlive()) {
                    return true;
                }
            }
            return false;
        });
        for (Node candidate : candidates) {
            if (!candidate.spring.isAlive()) {
                assertThat(candidate.spring.exitValue()).as("%s exit status",
                        candidate.name).isEqualTo(EventTransportNodeMain.HALTED);
                return candidate;
            }
        }
        throw new AssertionError("no node halted");
    }

    /** Each node's count of {@code event} lines (for the Session, if named). */
    private static Map<Node, Integer> baseline(String event, String session, Node... sources) {
        Map<Node, Integer> counts = new LinkedHashMap<>();
        for (Node source : sources) {
            counts.put(source, lines(source, event, session).size());
        }
        return counts;
    }

    /** The {@code event} lines each node wrote after its baseline. */
    private static List<JsonNode> since(Map<Node, Integer> baseline, String event,
            String session, Node... sources) {
        List<JsonNode> recent = new ArrayList<>();
        for (Node source : sources) {
            List<JsonNode> all = lines(source, event, session);
            recent.addAll(all.subList(baseline.getOrDefault(source, 0), all.size()));
        }
        return recent;
    }

    private static List<String> outcomes(List<JsonNode> lines) {
        return lines.stream().map(line -> line.path("outcome").asText()).toList();
    }

    private static List<JsonNode> staleLines(Map<Node, Integer> baseline, String session,
            ManagedEventEnvelope stale, Node... sources) {
        return since(baseline, "wake", session, sources).stream()
                .filter(line -> line.path("sequence").asLong() == stale.sequence())
                .toList();
    }

    private static Node activator(String session, Node... candidates) {
        for (Node candidate : candidates) {
            if (outcomes(lines(candidate, "load", session)).contains("ACTIVATED")) {
                return candidate;
            }
        }
        throw new AssertionError("no node activated " + session);
    }

    /** Every line the hooked transport beans wrote: none exist with the flag off. */
    private static int hookLines(Node node) {
        int count = 0;
        for (String event : List.of("journal-handoff", "public-handoff", "wake", "load")) {
            count += lines(node, event, null).size();
        }
        return count;
    }

    /** A wire's hand-offs on the committing thread happened and stayed short. */
    private static void assertBounded(List<JsonNode> handoffs, String wire) {
        assertThat(handoffs).as("%s hand-offs while the broker is frozen", wire).isNotEmpty();
        assertThat(handoffs.stream().mapToLong(line -> line.path("micros").asLong()).max()
                .orElseThrow()).as("%s hand-off on the committing thread (µs)", wire)
                .isLessThan(Duration.ofMillis(250).toNanos() / 1000);
    }

    private static List<JsonNode> lines(Node node, String event) {
        return lines(node, event, null);
    }

    private static List<JsonNode> lines(Node node, String event, String session) {
        List<JsonNode> lines = new ArrayList<>();
        Path evidence = node.root.resolve("evidence.jsonl");
        if (!Files.exists(evidence)) {
            return lines;
        }
        try {
            String text = Files.readString(evidence);
            // The node may be writing: a line without its newline is not yet whole.
            String whole = text.substring(0, text.lastIndexOf('\n') + 1);
            for (String line : whole.split("\n")) {
                if (line.isEmpty()) {
                    continue;
                }
                JsonNode parsed = JSON.readTree(line);
                if (event.equals(parsed.path("event").asText()) && (session == null
                        || session.equals(parsed.path("session").asText()))) {
                    lines.add(parsed);
                }
            }
        } catch (IOException unreadable) {
            throw new UncheckedIOException(unreadable);
        }
        return lines;
    }

    // --- broker ---

    private static String endpoints() {
        return System.getProperty("qwen.gate.rocketmq.endpoints");
    }

    private static String topic() {
        return System.getProperty("qwen.gate.rocketmq.topic");
    }

    /** Has the oracle read the Session's own lite topic as well. */
    private static void watch(String session) throws Exception {
        oracle.subscribeLite(session);
    }

    private int seenPublic(String session) throws Exception {
        int count = 0;
        for (String body : SEEN) {
            ManagedEventEnvelope envelope = ManagedEventEnvelopes.parse(JSON.readTree(body));
            if (session.equals(envelope.sessionId())
                    && ManagedEventEnvelopes.STREAM_PUBLIC_EVENT.equals(envelope.stream())) {
                count++;
            }
        }
        return count;
    }

    private List<ManagedEventEnvelope> seenWakes(String session) throws Exception {
        Map<Long, ManagedEventEnvelope> wakes = new java.util.TreeMap<>();
        for (String body : SEEN) {
            ManagedEventEnvelope envelope = ManagedEventEnvelopes.parse(JSON.readTree(body));
            if (session.equals(envelope.sessionId()) && tenant.equals(envelope.tenantId())
                    && ManagedEventEnvelopes.STREAM_AUTHORITATIVE_JOURNAL.equals(
                            envelope.stream())
                    && "wake.requested".equals(envelope.kind())) {
                wakes.put(envelope.sequence(), envelope);
            }
        }
        return new ArrayList<>(wakes.values());
    }

    /** The Session's committed wakes, as the journal wire sent them. */
    private List<ManagedEventEnvelope> committedWakes(String session, int count) {
        await().atMost(DELIVERY).until(() -> seenWakes(session).size() >= count);
        try {
            return seenWakes(session);
        } catch (Exception unreadable) {
            throw new IllegalStateException(unreadable);
        }
    }

    /** The wake sequences of the Session the broker has carried, on any lane read. */
    private List<Long> sentWakes(String session) throws Exception {
        return seenWakes(session).stream().map(ManagedEventEnvelope::sequence).toList();
    }

    /**
     * The Session's committed wakes, read from its journal rather than the
     * broker: for a node with the flag off, or a wake never sent, the journal
     * is the only witness.
     */
    private List<ManagedEventEnvelope> journalEnvelopes(String session) throws Exception {
        List<ManagedEventEnvelope> wakes = new ArrayList<>();
        for (byte[] record : jdbc.queryForList("SELECT record_bytes FROM"
                + " ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY journal_revision", byte[].class, tenant, session)) {
            for (String line : new String(record, StandardCharsets.UTF_8).split("\n")) {
                JsonNode event = JSON.readTree(line).path("managedSession");
                if ("wake.requested".equals(event.path("kind").asText())) {
                    wakes.add(ManagedEventEnvelopes.from(event));
                }
            }
        }
        assertThat(wakes).as("committed wakes of %s", session).isNotEmpty();
        return wakes;
    }

    private List<Long> journalWakes(String session) throws Exception {
        return journalEnvelopes(session).stream().map(ManagedEventEnvelope::sequence).toList();
    }

    /**
     * SIGSTOPs the broker's gRPC proxy until closed — only the process the
     * pid file names that is listening on the gate's endpoint, and only once
     * it is seen stopped.
     */
    private static Frozen freezeProxy() throws Exception {
        String recorded = Files.readString(Path.of(System.getProperty(
                "qwen.gate.rocketmq.work-dir"), "proxy.pid")).trim();
        long pid = Long.parseLong(recorded.split(" ")[0]);
        String port = endpoints().substring(endpoints().lastIndexOf(':') + 1);
        assertThat(listeners(port)).as("the proxy on port %s", port)
                .contains(Long.toString(pid));
        frozenProxy = pid;
        signal(pid, "STOP");
        try {
            await().atMost(Duration.ofSeconds(10)).until(() -> run("ps", "-o", "stat=", "-p",
                    Long.toString(pid)).trim().startsWith("T"));
        } catch (RuntimeException | AssertionError unconfirmed) {
            signal(pid, "CONT");
            frozenProxy = 0;
            throw unconfirmed;
        }
        return () -> {
            signal(pid, "CONT");
            frozenProxy = 0;
        };
    }

    private static List<String> listeners(String port) throws Exception {
        String lsof = run("sh", "-c", "command -v lsof || true").trim();
        String out = lsof.isEmpty()
                ? run("sh", "-c", "ss -ltnpH 'sport = :" + port + "' | sed -n"
                        + " 's/.*pid=\\([0-9]*\\).*/\\1/p'")
                : run(lsof, "-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t");
        return out.lines().map(String::trim).filter(line -> !line.isEmpty()).toList();
    }

    private static String run(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String out = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        return out;
    }

    private interface Frozen extends AutoCloseable {
        @Override
        void close() throws Exception;
    }

    private static void signal(long pid, String signal) throws Exception {
        Process kill = new ProcessBuilder("kill", "-" + signal, Long.toString(pid))
                .redirectErrorStream(true).start();
        assertThat(kill.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(kill.exitValue()).as("kill -%s %s", signal, pid).isZero();
    }

    private static void inject(ManagedEventEnvelope envelope) throws Exception {
        injector.send(provider.newMessageBuilder().setTopic(topic())
                .setLiteTopic(BOOTSTRAP_LITE_TOPIC).setKeys(envelope.eventId())
                .setBody(ManagedEventEnvelopes.toJson(envelope)
                        .getBytes(StandardCharsets.UTF_8)).build());
    }

    // --- SQL ---

    private boolean leaseLive(String session) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT writer_lease_until >"
                + " " + ManagedSchemaTime.SQL_NOW + " FROM ma_session_head WHERE tenant_id = ? AND"
                + " session_id = ? AND head_kind = 'MANAGED_SESSION'", Boolean.class,
                tenant, session));
    }

    private long stream(String session, String column) {
        return jdbc.queryForObject("SELECT " + column + " FROM ma_event_stream WHERE"
                + " tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION'"
                + " AND stream_id = X''", Long.class, tenant, session);
    }

    private Long wakeWatermark(String session) {
        return jdbc.queryForObject("SELECT wake_covered_sequence FROM ma_event_stream"
                + " WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION'"
                + " AND stream_id = X''", Long.class, tenant, session);
    }

    private long writerGeneration(String session) {
        return jdbc.queryForObject("SELECT writer_generation FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ? AND head_kind ="
                + " 'MANAGED_SESSION'", Long.class, tenant, session);
    }

    private String writerId(String session) {
        return jdbc.queryForObject("SELECT writer_id FROM ma_session_head WHERE"
                + " tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                String.class, tenant, session);
    }

    // --- the model ---

    private static void reply(HttpExchange exchange) throws IOException {
        try (exchange) {
            exchange.getRequestBody().readAllBytes();
            ObjectNode chunk = JSON.createObjectNode();
            chunk.put("id", "mq3-fixture").put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", MODEL);
            ObjectNode choice = chunk.putArray("choices").addObject().put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "MQ3_REPLY_" + MODEL_CALLS.incrementAndGet());
            choice.putNull("finish_reason");
            String first = "data: " + JSON.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
            byte[] body = (first + "data: " + JSON.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
        }
    }

    // --- nodes ---

    private Node node(String name) {
        Node node = new Node(name, caseRoot.resolve(name));
        nodes.add(node);
        return node;
    }

    /** One control-plane node: a packaged Hosted Harness and the application. */
    private final class Node {
        final String name;
        final Path root;
        Process harness;
        Process spring;
        int harnessPort;
        int springPort;
        String bootId;
        private Duration skew = Duration.ZERO;
        private final StringBuilder harnessOutput = new StringBuilder();

        Node(String name, Path root) {
            this.name = name;
            this.root = root;
        }

        /**
         * Runs the application's JVM this far off the host clock, through
         * the libfaketime that {@code qwen.gate.faketime.library} names: the
         * process's wall clock moves, monotonic time does not, and the
         * node's Harness keeps the host clock.
         */
        Node skewed(Duration skew) {
            this.skew = skew;
            return this;
        }

        Node start(boolean transport) throws Exception {
            Files.createDirectories(root);
            startHarness();
            startSpring(transport);
            return this;
        }

        void startHarness() throws Exception {
            Path home = Files.createDirectories(root.resolve("home"));
            Path config = Files.createDirectories(home.resolve(".qwen"));
            Path workspace = Files.createDirectories(root.resolve("workspace"));
            Path temporary = Files.createDirectories(root.resolve("tmp"));
            String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
            Files.writeString(config.resolve("settings.json"), JSON.writeValueAsString(Map.of(
                    "security", Map.of("auth", Map.of("selectedType", "openai")),
                    "model", Map.of("name", MODEL), "telemetry", Map.of("enabled", false),
                    "modelProviders", Map.of("openai", List.of(Map.of("id", MODEL,
                            "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl))))));
            ProcessBuilder builder = new ProcessBuilder(
                    System.getProperty("node.executable", "node"),
                    Path.of(System.getProperty("qwen.cli.entry")).toAbsolutePath().toString(),
                    "serve", "--profile", "hosted-harness", "--http-bridge",
                    "--port", "0", "--hostname", "127.0.0.1", "--require-auth", "--no-web",
                    "--workspace", workspace.toString()).directory(workspace.toFile())
                    .redirectErrorStream(true);
            Map<String, String> environment = builder.environment();
            environment.clear();
            environment.put("PATH", System.getenv("PATH"));
            environment.putAll(Map.of("HOME", home.toString(),
                    "QWEN_HOME", config.toString(),
                    "QWEN_RUNTIME_DIR", root.resolve("runtime").toString(),
                    "OPENAI_API_KEY", "fake-local-key", "OPENAI_BASE_URL", modelUrl,
                    "OPENAI_MODEL", MODEL, "QWEN_MODEL", MODEL,
                    "QWEN_SERVER_TOKEN", TOKEN,
                    "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
            environment.put("TMPDIR", temporary.toString());
            environment.put("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                    root.resolve("system-settings.json").toString());
            environment.put("QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                    root.resolve("system-defaults.json").toString());
            environment.put("QWEN_CODE_TRUSTED_FOLDERS_PATH",
                    root.resolve("trusted-folders.json").toString());
            harness = builder.start();
            STARTED.add(harness);
            Path log = root.resolve("harness.log");
            Thread.ofPlatform().daemon().start(() -> {
                try (var reader = harness.inputReader(StandardCharsets.UTF_8)) {
                    char[] buffer = new char[2048];
                    for (int count; (count = reader.read(buffer)) >= 0;) {
                        String text = new String(buffer, 0, count);
                        synchronized (harnessOutput) {
                            harnessOutput.append(text);
                        }
                        Files.writeString(log, text, java.nio.file.StandardOpenOption.CREATE,
                                java.nio.file.StandardOpenOption.APPEND);
                    }
                } catch (IOException ended) {
                    // The process is gone; the log holds what it said.
                }
            });
            await().atMost(Duration.ofSeconds(60)).pollInterval(Duration.ofMillis(100))
                    .until(() -> {
                        assertThat(harness.isAlive()).as("%s Harness exited:\n%s", name,
                                harnessOutput()).isTrue();
                        Matcher match = LISTENING.matcher(harnessOutput());
                        if (!match.find()) {
                            return false;
                        }
                        harnessPort = Integer.parseInt(match.group(1));
                        return true;
                    });
            await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(100))
                    .until(this::harnessReady);
            JsonNode capabilities = JSON.readTree(readCapabilities((HttpURLConnection)
                    URI.create("http://127.0.0.1:" + harnessPort + "/capabilities").toURL()
                            .openConnection()));
            JsonNode boot = capabilities.findValue("bootId");
            assertThat(boot).as("%s Harness capabilities: %s", name, capabilities).isNotNull();
            bootId = boot.asText();
        }

        private String readCapabilities(HttpURLConnection connection) throws IOException {
            connection.setRequestProperty("Authorization", "Bearer " + TOKEN);
            try (var in = connection.getInputStream()) {
                return new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
        }

        private boolean harnessReady() {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) URI.create("http://127.0.0.1:"
                        + harnessPort + "/capabilities").toURL().openConnection();
                connection.setRequestProperty("Authorization", "Bearer " + TOKEN);
                connection.setConnectTimeout(1000);
                connection.setReadTimeout(1000);
                return connection.getResponseCode() == 200;
            } catch (IOException unavailable) {
                return false;
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }

        private String harnessOutput() {
            synchronized (harnessOutput) {
                return harnessOutput.toString();
            }
        }

        void startSpring(boolean transport) throws Exception {
            launch(transport);
            // Only the first boot of the class migrates the schema.
            Duration boot = Duration.ofSeconds(schemaReady ? 90 : 180);
            Path ready = root.resolve("ready.json");
            await().atMost(boot).pollInterval(Duration.ofMillis(100)).until(() ->
                    Files.exists(ready) || !spring.isAlive());
            long observed = System.currentTimeMillis();
            assertThat(spring.isAlive()).as("%s failed to start:\n%s", name,
                    tail(root.resolve("spring.log"))).isTrue();
            schemaReady = true;
            if (!skew.isZero()) {
                // An LD_PRELOAD the loader cannot use is ignored with a
                // warning: prove the node's wall clock really moved.
                long nodeClock = lines(this, "ready").getLast().path("at").asLong();
                assertThat(Duration.ofMillis(nodeClock - observed).minus(skew).abs())
                        .as("%s wall clock off the host's by %s", name, skew)
                        .isLessThan(Duration.ofMinutes(1));
            }
        }

        /** Starts the application and returns the log of a start that fails. */
        String startSpringExpectingFailure(boolean transport, Duration within)
                throws Exception {
            long offset = Files.exists(root.resolve("spring.log"))
                    ? Files.size(root.resolve("spring.log")) : 0;
            launch(transport);
            Path ready = root.resolve("ready.json");
            assertThat(spring.waitFor(within.toMillis(), TimeUnit.MILLISECONDS))
                    .as("%s with the broker down should refuse to start", name).isTrue();
            assertThat(Files.exists(ready)).isFalse();
            assertThat(spring.exitValue()).isNotZero();
            byte[] log = Files.readAllBytes(root.resolve("spring.log"));
            int from = (int) Math.min(offset, log.length);
            return new String(log, from, log.length - from, StandardCharsets.UTF_8);
        }

        private void launch(boolean transport) throws Exception {
            // A restart keeps the node's address: its Harness holds its
            // Sessions against this store URL.
            if (springPort == 0) {
                springPort = freePort();
            }
            Map<String, String> properties = new LinkedHashMap<>();
            properties.put("server.address", "127.0.0.1");
            properties.put("server.port", Integer.toString(springPort));
            properties.put("spring.datasource.url", databaseUrl);
            properties.put("spring.datasource.username", System.getProperty("mysql.user"));
            properties.put("spring.datasource.password",
                    System.getProperty("mysql.password", ""));
            properties.put("spring.datasource.driver-class-name", "com.mysql.cj.jdbc.Driver");
            properties.put("qwen.managed-agent.session-store.enabled", "true");
            properties.put("qwen.managed-agent.session-store.base-url",
                    "http://127.0.0.1:" + springPort);
            properties.put("qwen.managed-agent.session-store.workspace-id", WORKSPACE);
            properties.put("qwen.managed-agent.session-store.writer-lease-duration",
                    WRITER_LEASE);
            properties.put("qwen.managed-agent.harness.enabled", "true");
            properties.put("qwen.managed-agent.harness.base-url",
                    "http://127.0.0.1:" + harnessPort);
            properties.put("qwen.managed-agent.harness.token", TOKEN);
            properties.put("qwen.managed-agent.harness.capability-digest", DIGEST);
            properties.put("qwen.managed-agent.runtime-broker.enabled", "false");
            properties.put("qwen.managed-agent.dispatch.scan-delay", "200ms");
            properties.put("qwen.managed-agent.dispatch.lease-duration", "6s");
            properties.put("qwen.managed-agent.dispatch.lease-renew-interval", "2s");
            properties.put("qwen.managed-agent.dispatch.retry-initial-delay", "500ms");
            properties.put("qwen.managed-agent.dispatch.retry-max-delay", "2s");
            properties.put("qwen.managed-agent.event-transport.enabled",
                    Boolean.toString(transport));
            properties.put("qwen.managed-agent.event-transport.endpoints", endpoints());
            properties.put("qwen.managed-agent.event-transport.topic", topic());
            properties.put("qwen.managed-agent.event-transport.owner-reconcile-interval",
                    "500ms");
            Path ready = root.resolve("ready.json");
            Files.deleteIfExists(ready);
            Path config = root.resolve("node.json");
            JSON.writeValue(config.toFile(), Map.of("node", name, "root", root.toString(),
                    "shared", shared.toString(), "ready", ready.toString(),
                    "properties", properties));
            ProcessBuilder builder = new ProcessBuilder(
                    Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", System.getProperty("surefire.test.class.path",
                            System.getProperty("java.class.path")),
                    EventTransportNodeMain.class.getName(), config.toString())
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.appendTo(
                            root.resolve("spring.log").toFile()));
            if (!skew.isZero()) {
                builder.environment().put("LD_PRELOAD",
                        System.getProperty("qwen.gate.faketime.library"));
                builder.environment().put("FAKETIME", (skew.isNegative() ? "-" : "+")
                        + skew.abs().toSeconds());
                builder.environment().put("FAKETIME_DONT_FAKE_MONOTONIC", "1");
            }
            spring = builder.start();
            STARTED.add(spring);
        }

        void crashSpring() {
            kill(spring);
        }

        /** Restarts the whole node: a new Harness, the same address. */
        void restart(boolean transport) throws Exception {
            crash();
            synchronized (harnessOutput) {
                harnessOutput.setLength(0);
            }
            start(transport);
        }

        void crash() {
            kill(spring);
            kill(harness);
        }

        private void kill(Process process) {
            if (process != null && process.isAlive()) {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
                try {
                    process.waitFor(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 0, InetAddress.getLoopbackAddress())) {
            return socket.getLocalPort();
        }
    }

    private static String tail(Path log) {
        try {
            List<String> lines = Files.readAllLines(log);
            return String.join("\n", lines.subList(Math.max(0, lines.size() - 80),
                    lines.size()));
        } catch (IOException unreadable) {
            return "(no log)";
        }
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (!Files.exists(root)) {
            return;
        }
        try (var paths = Files.walk(root)) {
            for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.delete(path);
            }
        }
    }
}
