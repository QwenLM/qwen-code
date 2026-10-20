package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.EventTransportConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.event.CompositeCommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.event.EventTransportConsumer;
import com.alibaba.qwen.code.managedagent.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.event.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.event.ManagedEventEnvelopes;
import com.alibaba.qwen.code.managedagent.event.MessageMaterializer;
import com.alibaba.qwen.code.managedagent.event.TransportWakeActivator;
import com.alibaba.qwen.code.managedagent.event.TransportWakeActivator.Outcome;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.AttachedSession;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore;
import com.alibaba.qwen.code.managedagent.session.SessionEventHub;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jdk.jfr.Recording;
import jdk.jfr.consumer.RecordingFile;
import org.apache.rocketmq.client.apis.ClientConfiguration;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.consumer.LitePushConsumer;
import org.apache.rocketmq.client.apis.message.MessageView;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The MQ2d broker gates (design 2026-10-12-managed-agent-event-transport-mq2):
 * the EventTransport against a real RocketMQ 5.5 LiteTopic cluster, with the
 * §8 fault rows the MQ2 exit check names injected through the broker itself.
 * The application runs whole — both producers, both consumer lanes, the owner
 * reconciliation — on H2, with only the Harness stood in for; every consumer
 * decision is still read from SQL.
 *
 * <p>Run by the {@code event-transport-broker-gates} profile against
 * {@code scripts/rocketmq-lite-broker.sh start}; the broker coordinates
 * arrive as system properties, and a missing one fails the gate rather than
 * skipping it.
 */
@Timeout(300)
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:event-transport-broker-gate;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true",
        // The scheduled pass would race the notices the rows hand over.
        "qwen.managed-agent.events.materialize-interval=1h",
        "qwen.managed-agent.event-transport.enabled=true",
        "qwen.managed-agent.event-transport.endpoints=${qwen.gate.rocketmq.endpoints}",
        "qwen.managed-agent.event-transport.topic=${qwen.gate.rocketmq.topic}",
        "qwen.managed-agent.event-transport.owner-reconcile-interval=200ms"
})
class EventTransportBrokerGate {
    static final String ORACLE_GROUP = "qwen-transport-gate-oracle";
    static final String NORMAL_PROBE_GROUP = "qwen-transport-gate-normal-probe";
    private static final String TENANT = "tenant-broker-gate";
    private static final String WORKSPACE = "workspace-broker-gate";
    private static final String WRITER = "gate-writer";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    private static final Duration DELIVERY = Duration.ofSeconds(60);
    // Long enough for a broker to deliver a message it is going to deliver.
    private static final Duration QUIET = Duration.ofSeconds(8);

    @MockitoBean
    private HarnessConnector harness;

    @MockitoSpyBean
    private TransportWakeActivator wakes;

    @MockitoSpyBean
    private TransportConsumerStore consumerStore;

    @MockitoSpyBean
    private MessageMaterializer materializer;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private Clock clock;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ManagedAgentProperties properties;

    @Autowired
    private Producer producer;

    @Autowired
    private ClientServiceProvider provider;

    @Autowired
    private JournalEventTransport journalTransport;

    @Autowired
    private CommittedEventPublisher publisher;

    @Autowired
    private SessionEventHub hub;

    @Autowired
    @Qualifier("eventTransportOwnerConsumer")
    private LitePushConsumer ownerConsumer;

    private final Map<String, List<Outcome>> outcomes =
            new ConcurrentHashMap<>();
    private final List<AutoCloseable> opened = new ArrayList<>();

    @BeforeAll
    static void requireTheBroker() {
        for (String name : List.of("qwen.gate.rocketmq.endpoints",
                "qwen.gate.rocketmq.topic")) {
            if (System.getProperty(name, "").isBlank()) {
                throw new IllegalStateException(name + " is unset: start the"
                        + " broker with scripts/rocketmq-lite-broker.sh start"
                        + " and run the event-transport-broker-gates profile");
            }
        }
    }

    @BeforeEach
    void recordWakeOutcomes() {
        when(harness.isAvailable()).thenReturn(true);
        when(harness.activateForWake(anyString(), anyString())).thenReturn(true);
        doAnswer(invocation -> {
            Outcome outcome = (Outcome) invocation.callRealMethod();
            ManagedEventEnvelope envelope = invocation.getArgument(0);
            outcomes.computeIfAbsent(envelope.sessionId(),
                    ignored -> new CopyOnWriteArrayList<>()).add(outcome);
            return outcome;
        }).when(wakes).onWake(org.mockito.ArgumentMatchers.any());
    }

    @AfterEach
    void closeTestClients() throws Exception {
        for (AutoCloseable client : opened) {
            client.close();
        }
        opened.clear();
    }

    /**
     * Both wires through the real broker: the journal producer's envelopes
     * and the public producer's land on the Session's own LiteTopic as the
     * contract's canonical bytes, and the wake rides the bootstrap lane too.
     */
    @Test
    void bothWiresDeliverCanonicalEnvelopesToTheSessionLiteTopic()
            throws Exception {
        String session = session("ACTIVE");
        List<String> onSession = oracle(session);
        List<String> onBootstrap = oracle(bootstrapLiteTopic());
        List<JsonNode> journal = List.of(
                journalEvent(session, 1, "input.accepted"),
                journalEvent(session, 2, "wake.requested"));
        List<EventRecord> publicEvents = List.of(
                publicEvent(session, 1, "turn.started"),
                publicEvent(session, 2, "turn.completed"));

        journalTransport.publishCommitted(journalRecord(journal));
        publisher.publish(publicEvents);

        // Derived from the source events, never from the serializer under
        // test: what arrives is parsed back under the contract and compared
        // field by field, then held to its own canonical form.
        List<ManagedEventEnvelope> expected = new ArrayList<>();
        for (JsonNode event : journal) {
            expected.add(ManagedEventEnvelopes.from(event));
        }
        for (EventRecord event : publicEvents) {
            expected.add(ManagedEventEnvelopes.fromPublicEventRow(
                    ManagedEventEnvelopes.publicEventRow(event, objectMapper),
                    WORKSPACE));
        }
        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(parsed(onSession))
                        .containsExactlyInAnyOrderElementsOf(expected));
        for (String body : onSession) {
            assertThat(body).isEqualTo(ManagedEventEnvelopes.toJson(
                    ManagedEventEnvelopes.parse(JSON.readTree(body))));
        }
        ManagedEventEnvelope wake = expected.get(1);
        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(parsed(onBootstrap)).contains(wake));
    }

    private static List<ManagedEventEnvelope> parsed(List<String> bodies)
            throws Exception {
        List<ManagedEventEnvelope> envelopes = new ArrayList<>();
        for (String body : bodies) {
            envelopes.add(ManagedEventEnvelopes.parse(JSON.readTree(body)));
        }
        return envelopes;
    }

    /** §8 duplicate delivery: the second copy is refused on the watermark. */
    @Test
    void aDuplicatedWakeActivatesOnce() throws Exception {
        String session = session("ACTIVE");
        head(session, "SEALED", 5, -60, "old-writer");
        ManagedEventEnvelope wake = wake(session, 3);

        inject(bootstrapLiteTopic(), wake);
        inject(bootstrapLiteTopic(), wake);

        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(outcomes.get(session)).containsExactly(
                        Outcome.SCHEDULED, Outcome.DUPLICATE));
        verify(harness, timeout(10_000).times(1)).activateForWake(TENANT,
                session);
        assertThat(wakeWatermark(session)).isEqualTo(3);
    }

    /** §8 reorder: an older wake after a newer one is a no-op. */
    @Test
    void aReorderedWakeIsANoOp() throws Exception {
        String session = session("ACTIVE");
        head(session, "SEALED", 5, -60, "old-writer");

        inject(bootstrapLiteTopic(), wake(session, 5));
        inject(bootstrapLiteTopic(), wake(session, 3));

        await().atMost(DELIVERY).untilAsserted(() ->
                assertThat(outcomes.get(session)).containsExactly(
                        Outcome.SCHEDULED, Outcome.DUPLICATE));
        verify(harness, timeout(10_000).times(1)).activateForWake(TENANT,
                session);
        assertThat(wakeWatermark(session)).isEqualTo(5);
    }

    /**
     * The owner lane: of two Sessions this node holds an attachment for, only
     * the one whose journal this node's Harness writes gets subscribed — the
     * other's writer is another node's — its public notices materialize it,
     * and a duplicated or reordered notice reaches the consumer and runs no
     * batch.
     */
    @Test
    void theOwnerMaterializesOnceDespiteDuplicatesAndReorder()
            throws Exception {
        String session = session("ACTIVE");
        head(session, "ACTIVE", 3, 120, WRITER);
        // Attached here too, but another node's Harness writes its journal.
        String elsewhere = session("ACTIVE");
        head(elsewhere, "ACTIVE", 3, 120, "another-writer");
        when(harness.writerIdentity()).thenReturn(WRITER);
        when(harness.attachedSessions()).thenReturn(List.of(
                new AttachedSession(TENANT, session),
                new AttachedSession(TENANT, elsewhere)));
        await().atMost(DELIVERY).until(() ->
                ownerConsumer.getLiteTopicSet().contains(session));
        await().during(Duration.ofSeconds(2)).atMost(Duration.ofSeconds(5))
                .until(() -> !ownerConsumer.getLiteTopicSet()
                        .contains(elsewhere));
        List<EventRecord> rows = new ArrayList<>();
        for (long sequence = 1; sequence <= 3; sequence++) {
            rows.add(storedPublicEvent(session, sequence, "session.updated"));
        }

        publisher.publish(List.of(rows.get(2)));
        await().atMost(DELIVERY).until(() -> projectionWatermark(session) == 3);
        int batches = notifiedBatches(session);
        int notices = noticesSeen(session);

        inject(session, publicEnvelope(rows.get(2)));
        inject(session, publicEnvelope(rows.get(0)));

        await().atMost(DELIVERY).until(() -> noticesSeen(session) >= notices + 2);
        // A batch would be queued onto another thread: hold the count for a
        // while rather than reading it once.
        await().during(Duration.ofSeconds(3)).atMost(Duration.ofSeconds(10))
                .until(() -> notifiedBatches(session) == batches);
        assertThat(projectionWatermark(session)).isEqualTo(3);
    }

    /**
     * §11 owner handoff. A stale subscriber (a node whose writer lapsed) still
     * holds the Session's subscription in the owner group while another
     * writer holds the journal. It receives the wake, does no side effect —
     * no load, no claim — and acknowledges. Once it unsubscribes (its next
     * reconciliation tick) the new owner subscribes and never receives that
     * wake: the acknowledgement advanced the group's offset. Two controls
     * make the absence the acknowledgement's doing: an unacknowledged notice
     * sent to the same lite topic before the new owner subscribed is
     * delivered to it as backlog, and a later notice reaches it too. The
     * stale acknowledgement consumed
     * nothing in SQL: the wake is unclaimed, and once the journal is free a
     * later notice still activates it.
     */
    @Test
    void aStaleSubscriberAcknowledgesAsANoOpAndTheWakeStaysClaimable()
            throws Exception {
        String session = session("ACTIVE");
        head(session, "ACTIVE", 3, 120, "new-owner-writer");
        HarnessConnector staleHarness = mock(HarnessConnector.class);
        when(staleHarness.isAvailable()).thenReturn(true);
        List<String> staleSaw = new CopyOnWriteArrayList<>();
        List<ConsumeResult> staleAnswers = new CopyOnWriteArrayList<>();
        TransportWakeActivator staleWakes = new TransportWakeActivator(
                consumerStore, staleHarness, ignored -> {});
        EventTransportConsumer staleNode = new EventTransportConsumer(
                staleWakes, consumerStore, mock(MessageMaterializer.class));
        opened.add(staleWakes);
        opened.add(staleNode);
        String owners = properties.getEventTransport().getOwnerGroup();
        LitePushConsumer stale = subscribe(owners, session, message -> {
            // Recorded after the node handled it, so the checks below see a
            // finished consume.
            ConsumeResult answer = staleNode.consume(message);
            staleAnswers.add(answer);
            staleSaw.add(body(message));
            return answer;
        });
        ManagedEventEnvelope wake = wake(session, 3);
        String wakeBody = ManagedEventEnvelopes.toJson(wake);

        inject(session, wake);

        await().atMost(DELIVERY).until(() -> staleSaw.contains(wakeBody));
        assertThat(staleAnswers).containsOnly(ConsumeResult.SUCCESS);
        verify(staleHarness, never()).activateForWake(anyString(),
                anyString());
        assertThat(wakeWatermark(session)).isNull();

        // The stale node's next reconciliation tick drops its subscription;
        // closing it outright keeps the broker from handing it anything more.
        stale.unsubscribeLite(session);
        opened.remove(stale);
        stale.close();
        // A notice on the same lite topic that nobody in the owner group
        // acknowledged, sent before the new owner subscribes: delivered as
        // backlog. So the new subscription resumes from the group's offset —
        // not from the latest message — and the acknowledged wake's absence
        // below is the acknowledgement's doing.
        String backlogBody = ManagedEventEnvelopes.toJson(wake(session, 4));
        inject(session, wake(session, 4));
        List<String> newOwnerSaw = new CopyOnWriteArrayList<>();
        subscribe(owners, session, message -> {
            newOwnerSaw.add(body(message));
            return ConsumeResult.SUCCESS;
        });
        await().atMost(DELIVERY).until(() -> newOwnerSaw.contains(backlogBody));
        Thread.sleep(QUIET.toMillis());
        assertThat(newOwnerSaw).doesNotContain(wakeBody);
        assertThat(staleSaw).containsOnlyOnce(wakeBody);
        // The new owner's subscription is live: a later notice reaches it.
        String laterBody = ManagedEventEnvelopes.toJson(wake(session, 5));
        inject(session, wake(session, 5));
        await().atMost(DELIVERY).until(() -> newOwnerSaw.contains(laterBody));
        assertThat(newOwnerSaw).doesNotContain(wakeBody);

        // The journal freed (the new owner sealed it): a later notice of the
        // same wake still finds it unclaimed.
        jdbc.update("UPDATE ma_session_head SET state ="
                + " 'SEALED' WHERE tenant_id = ? AND session_id = ?",
                TENANT, session);
        inject(bootstrapLiteTopic(), wake);
        verify(harness, timeout(DELIVERY.toMillis()).times(1))
                .activateForWake(TENANT, session);
        assertThat(wakeWatermark(session)).isEqualTo(3);
    }

    /**
     * MQ2 exit row: the post-commit path does not regress. The same batches
     * go through the deployed composite (hub, then the public transport) and
     * through a flag-off composite (hub only), interleaved; the committing
     * thread's publish time and the hub subscriber's delivery time are
     * compared at p95. The journal wire's after-commit hand-off is measured
     * alongside. The figures are written to target/ for the record.
     */
    @Test
    void thePostCommitPathDoesNotRegress() throws Exception {
        Throwable gateFailure = null;
        try {
            verifyPostCommitPath();
        } catch (Exception | AssertionError failure) {
            gateFailure = failure;
            throw failure;
        } finally {
            try {
                capturePostCommitDiagnostics();
            } catch (Exception | AssertionError failure) {
                if (gateFailure == null) {
                    throw failure;
                }
                gateFailure.addSuppressed(failure);
            }
        }
    }

    private void verifyPostCommitPath() throws Exception {
        String session = session("ACTIVE");
        SessionEventHub flagOffHub = new SessionEventHub();
        CompositeCommittedEventPublisher flagOff =
                new CompositeCommittedEventPublisher(flagOffHub, List.of());
        int rounds = 300;
        List<Long> onPublish = new ArrayList<>();
        List<Long> offPublish = new ArrayList<>();
        List<Long> onDelivery = new ArrayList<>();
        List<Long> offDelivery = new ArrayList<>();
        List<Long> journalHandOff = new ArrayList<>();
        try (SessionEventHub.Subscription onHub = hub.subscribe(TENANT, session);
                SessionEventHub.Subscription offHub =
                        flagOffHub.subscribe(TENANT, session)) {
            for (int round = 1; round <= rounds; round++) {
                EventRecord event = publicEvent(session, round,
                        "item.output_text.delta");
                measure(publisher, onHub, event, onPublish, onDelivery);
                measure(flagOff, offHub, event, offPublish, offDelivery);
                byte[] record = journalRecord(List.of(
                        journalEvent(session, round, "message.delta")));
                long started = System.nanoTime();
                journalTransport.publishCommitted(record);
                journalHandOff.add(System.nanoTime() - started);
            }
        }
        // Discard the warm-up quarter.
        long onP95 = p95(onPublish.subList(rounds / 4, rounds));
        long offP95 = p95(offPublish.subList(rounds / 4, rounds));
        long onDeliveryP95 = p95(onDelivery.subList(rounds / 4, rounds));
        long offDeliveryP95 = p95(offDelivery.subList(rounds / 4, rounds));
        long journalP95 = p95(journalHandOff.subList(rounds / 4, rounds));
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("rounds", rounds);
        record.put("publishP95Micros", Map.of("on", onP95 / 1000,
                "off", offP95 / 1000));
        record.put("hubDeliveryP95Micros", Map.of("on", onDeliveryP95 / 1000,
                "off", offDeliveryP95 / 1000));
        record.put("journalHandOffP95Micros", journalP95 / 1000);
        Files.createDirectories(Path.of("target"));
        Files.writeString(Path.of("target/event-transport-latency.json"),
                JSON.writerWithDefaultPrettyPrinter().writeValueAsString(record));
        // Shared CI runners can deschedule this thread between nanoTime calls.
        // Keep the 1 ms local benchmark; CI uses the journal hand-off's 20 ms budget.
        long budget = Duration.ofMillis(
                Boolean.parseBoolean(System.getenv("CI")) ? 20 : 1).toNanos();
        assertThat(onP95).as("publish p95, flag on vs off (ns)")
                .isLessThanOrEqualTo(offP95 + budget);
        assertThat(onDeliveryP95).as("hub delivery p95, flag on vs off (ns)")
                .isLessThanOrEqualTo(offDeliveryP95 + budget);
        assertThat(journalP95).as("journal hand-off p95 (ns)")
                .isLessThanOrEqualTo(Duration.ofMillis(20).toNanos());
    }

    private void capturePostCommitDiagnostics() throws Exception {
        String session = session("ACTIVE");
        SessionEventHub flagOffHub = new SessionEventHub();
        CompositeCommittedEventPublisher flagOff =
                new CompositeCommittedEventPublisher(flagOffHub, List.of());
        int rounds = 300;
        List<Long> onPublish = new ArrayList<>();
        List<Long> offPublish = new ArrayList<>();
        List<Long> onDelivery = new ArrayList<>();
        List<Long> offDelivery = new ArrayList<>();
        List<Long> journalHandOff = new ArrayList<>();
        List<Map<String, Object>> samples = new ArrayList<>();
        Files.createDirectories(Path.of("target"));
        Recording recording = new Recording();
        recording.enable("com.qwen.ManagedEventPublish").withThreshold(Duration.ZERO);
        recording.enable("jdk.ExecutionSample").withPeriod(Duration.ofMillis(1));
        recording.enable("jdk.ThreadPark").withThreshold(Duration.ZERO).withStackTrace();
        recording.enable("jdk.JavaMonitorEnter").withThreshold(Duration.ZERO).withStackTrace();
        recording.enable("jdk.GCPhasePause").withThreshold(Duration.ZERO);
        recording.start();
        Throwable measurementFailure = null;
        try (SessionEventHub.Subscription onHub = hub.subscribe(TENANT, session);
                SessionEventHub.Subscription offHub =
                        flagOffHub.subscribe(TENANT, session)) {
            for (int round = 1; round <= rounds; round++) {
                EventRecord event = publicEvent(session, round,
                        "item.output_text.delta");
                measureDiagnostics(publisher, onHub, event, onPublish, onDelivery, "on", samples);
                measureDiagnostics(flagOff, offHub, event, offPublish, offDelivery, "off", samples);
                JsonNode journal = journalEvent(session, round, "message.delta");
                byte[] record = journalRecord(List.of(journal));
                long cpuStarted = cpuTime();
                long started = System.nanoTime();
                journalTransport.publishCommitted(record);
                long completed = System.nanoTime();
                long cpuCompleted = cpuTime();
                journalHandOff.add(completed - started);
                samples.add(Map.of("path", "journal", "sequence", round,
                        "threadId", Thread.currentThread().threadId(),
                        "startedNanos", started, "publishNanos", completed - started,
                        "publishCpuNanos", cpuStarted < 0 ? -1 : cpuCompleted - cpuStarted));
            }
        } catch (Exception | AssertionError failure) {
            measurementFailure = failure;
            throw failure;
        } finally {
            try {
                recording.stop();
                Path flightRecording = Path.of("target/event-transport-latency.jfr");
                recording.dump(flightRecording);
                Files.writeString(Path.of("target/event-transport-latency-samples.json"),
                        JSON.writerWithDefaultPrettyPrinter().writeValueAsString(samples));
                List<Map<String, Object>> stages = new ArrayList<>();
                try (RecordingFile events = new RecordingFile(flightRecording)) {
                    while (events.hasMoreEvents()) {
                        var event = events.readEvent();
                        if (event.getEventType().getName().equals("com.qwen.ManagedEventPublish")) {
                            Map<String, Object> stage = new LinkedHashMap<>();
                            stage.put("sessionId", event.getString("sessionId"));
                            stage.put("sequence", event.getLong("sequence"));
                            stage.put("threadId", event.getThread().getJavaThreadId());
                            stage.put("startTime", event.getStartTime().toString());
                            stage.put("durationNanos", event.getDuration().toNanos());
                            stage.put("transportCount", event.getInt("transportCount"));
                            stage.put("hubNanos", event.getLong("hubNanos"));
                            stage.put("transportNanos", event.getLong("transportNanos"));
                            stages.add(stage);
                        }
                    }
                }
                Files.writeString(Path.of("target/event-transport-latency-stages.json"),
                        JSON.writerWithDefaultPrettyPrinter().writeValueAsString(stages));
            } catch (Exception failure) {
                if (measurementFailure == null) {
                    throw failure;
                }
                measurementFailure.addSuppressed(failure);
            } finally {
                recording.close();
            }
        }
        // Discard the warm-up quarter.
        long onP95 = p95(onPublish.subList(rounds / 4, rounds));
        long offP95 = p95(offPublish.subList(rounds / 4, rounds));
        long onDeliveryP95 = p95(onDelivery.subList(rounds / 4, rounds));
        long offDeliveryP95 = p95(offDelivery.subList(rounds / 4, rounds));
        long journalP95 = p95(journalHandOff.subList(rounds / 4, rounds));
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("rounds", rounds);
        record.put("flightRecordingEnabled", true);
        record.put("cpuTimeAvailable", cpuTime() >= 0);
        record.put("publishP95Micros", Map.of("on", onP95 / 1000,
                "off", offP95 / 1000));
        record.put("hubDeliveryP95Micros", Map.of("on", onDeliveryP95 / 1000,
                "off", offDeliveryP95 / 1000));
        record.put("journalHandOffP95Micros", journalP95 / 1000);
        Files.createDirectories(Path.of("target"));
        Files.writeString(Path.of("target/event-transport-latency-diagnostics.json"),
                JSON.writerWithDefaultPrettyPrinter().writeValueAsString(record));
    }

    /**
     * Deployment faults fail startup instead of degrading: a topic that is
     * not LITE (the subscription probe alone would pass it), and a probe
     * group nobody pre-created.
     */
    @Test
    void aMisconfiguredBrokerFailsStartup() {
        String normalTopic = System.getProperty(
                "qwen.gate.rocketmq.normal-topic", "");
        assertThat(normalTopic).as("qwen.gate.rocketmq.normal-topic").isNotBlank();
        startup(normalTopic, NORMAL_PROBE_GROUP).run(started ->
                assertThat(started).hasFailed().getFailure()
                        .hasStackTraceContaining("refused a LiteTopic message"));
        startup(System.getProperty("qwen.gate.rocketmq.topic"),
                "qwen-transport-gate-missing-" + UUID.randomUUID())
                .run(started -> assertThat(started).hasFailed().getFailure()
                        .hasStackTraceContaining("capability probe failed"));
    }

    // --- broker clients ---

    private String bootstrapLiteTopic() {
        return properties.getEventTransport().getWakeBootstrapLiteTopic();
    }

    private ClientConfiguration clientConfiguration() {
        return ClientConfiguration.newBuilder()
                .setEndpoints(properties.getEventTransport().getEndpoints())
                .build();
    }

    /**
     * Every body the oracle group sees on a lite topic. Each row's Session is
     * new, so its lite topic is read from the start; the shared bootstrap
     * lite topic resumes from the group's committed offset on a reused
     * broker, and its row subscribes before it sends.
     */
    private List<String> oracle(String liteTopic) throws Exception {
        List<String> seen = new CopyOnWriteArrayList<>();
        subscribe(ORACLE_GROUP, liteTopic, message -> {
            seen.add(body(message));
            return ConsumeResult.SUCCESS;
        });
        return seen;
    }

    private LitePushConsumer subscribe(String group, String liteTopic,
            java.util.function.Function<MessageView, ConsumeResult> listener)
            throws Exception {
        LitePushConsumer consumer = provider.newLitePushConsumerBuilder()
                .setClientConfiguration(clientConfiguration())
                .setConsumerGroup(group)
                .bindTopic(properties.getEventTransport().getTopic())
                .setMessageListener(listener::apply)
                .build();
        opened.add(consumer);
        consumer.subscribeLite(liteTopic);
        return consumer;
    }

    private void inject(String liteTopic, ManagedEventEnvelope envelope)
            throws Exception {
        producer.send(provider.newMessageBuilder()
                .setTopic(properties.getEventTransport().getTopic())
                .setLiteTopic(liteTopic)
                .setKeys(envelope.eventId())
                .setBody(ManagedEventEnvelopes.toJson(envelope)
                        .getBytes(StandardCharsets.UTF_8))
                .build());
    }

    private static String body(MessageView message) {
        ByteBuffer view = message.getBody().duplicate();
        byte[] bytes = new byte[view.remaining()];
        view.get(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private ApplicationContextRunner startup(String topic, String probeGroup) {
        return new ApplicationContextRunner()
                .withUserConfiguration(EventTransportConfiguration.class,
                        PropertiesConfiguration.class)
                .withPropertyValues(
                        "qwen.managed-agent.event-transport.enabled=true",
                        "qwen.managed-agent.event-transport.endpoints="
                                + properties.getEventTransport().getEndpoints(),
                        "qwen.managed-agent.event-transport.topic=" + topic,
                        "qwen.managed-agent.event-transport.capability-probe-group="
                                + probeGroup)
                .withBean(JdbcTemplate.class, () -> mock(JdbcTemplate.class))
                .withBean(Clock.class, Clock::systemUTC)
                .withBean(ObjectMapper.class, ObjectMapper::new)
                .withBean(HarnessConnector.class,
                        () -> mock(HarnessConnector.class))
                .withBean(MessageMaterializer.class,
                        () -> mock(MessageMaterializer.class))
                .withBean(ThreadPoolTaskSchedulerBuilder.class,
                        ThreadPoolTaskSchedulerBuilder::new);
    }

    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class PropertiesConfiguration {
    }

    // --- latency ---

    private static void measure(CommittedEventPublisher composite,
            SessionEventHub.Subscription subscription, EventRecord event,
            List<Long> publish, List<Long> delivery) throws Exception {
        long started = System.nanoTime();
        composite.publish(List.of(event));
        long published = System.nanoTime();
        SessionEventHub.Delivery delivered = subscription.await(
                event.sequence() - 1, Duration.ofSeconds(5));
        long received = System.nanoTime();
        assertThat(delivered.events()).extracting(EventRecord::sequence)
                .contains(event.sequence());
        publish.add(published - started);
        delivery.add(received - started);
    }

    private static void measureDiagnostics(CommittedEventPublisher composite,
            SessionEventHub.Subscription subscription, EventRecord event,
            List<Long> publish, List<Long> delivery, String path,
            List<Map<String, Object>> samples) throws Exception {
        long cpuStarted = cpuTime();
        long started = System.nanoTime();
        composite.publish(List.of(event));
        long published = System.nanoTime();
        long cpuPublished = cpuTime();
        long readStarted = System.nanoTime();
        SessionEventHub.Delivery delivered;
        try {
            delivered = subscription.await(event.sequence() - 1, Duration.ofSeconds(5));
        } finally {
            long received = System.nanoTime();
            long cpuReceived = cpuTime();
            Map<String, Object> sample = new LinkedHashMap<>();
            sample.put("path", path);
            sample.put("sequence", event.sequence());
            sample.put("threadId", Thread.currentThread().threadId());
            sample.put("startedNanos", started);
            sample.put("publishNanos", published - started);
            sample.put("readStartedNanos", readStarted);
            sample.put("hubReadNanos", received - readStarted);
            sample.put("observedDeliveryNanos", received - started);
            sample.put("publishCpuNanos", cpuStarted < 0 ? -1 : cpuPublished - cpuStarted);
            sample.put("hubReadCpuNanos", cpuPublished < 0 ? -1 : cpuReceived - cpuPublished);
            samples.add(sample);
            publish.add(published - started);
            delivery.add(received - started);
        }
        assertThat(delivered.events()).extracting(EventRecord::sequence)
                .contains(event.sequence());
    }

    private static long cpuTime() {
        return THREADS.isCurrentThreadCpuTimeSupported() && THREADS.isThreadCpuTimeEnabled()
                ? THREADS.getCurrentThreadCpuTime() : -1;
    }

    private static long p95(List<Long> samples) {
        List<Long> sorted = new ArrayList<>(samples);
        Collections.sort(sorted);
        return sorted.get((int) Math.ceil(sorted.size() * 0.95) - 1);
    }

    // --- SQL and record fixtures ---

    private String session(String status) {
        String session = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified, workspace_storage_id, workspace_id, workspace_generation, cwd_relative, context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref) VALUES (?, ?, 'qwen-code', ?, 1, 1, ?, ?, 1, '.', ?, 1, ?, ?)",
                TENANT, session, status, "storage-" + session, WORKSPACE,
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, covered_sequence, gmt_modified) VALUES (?, ?, 'SESSION', X'', 0, 1)",
                TENANT, session);
        return session;
    }

    private void head(String session, String state, long committed,
            int leaseOffsetSeconds, String writer) {
        jdbc.update("INSERT INTO ma_session_head (tenant_id, workspace_id, session_id, storage_version, state, writer_generation, writer_id, writer_lease_until, journal_revision, committed_sequence, activation_epoch, compacted_through_revision, recovery_status, gmt_create, gmt_modified, tenant_key, harness_key, harness_session_id, head_kind) VALUES (?, ?, ?, 1, ?, 1, ?, (" + ManagedSchemaTime.SQL_NOW + " + " + (leaseOffsetSeconds * 1000L) + "), 3, ?, 0, 0, 'READY', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ", ?, ?, ?, 'MANAGED_SESSION')",
                TENANT, WORKSPACE, session, state, writer, committed,
                ManagedSchemaKeys.key(TENANT), ManagedSchemaKeys.key(session),
                session);
    }

    private static JsonNode journalEvent(String session, long sequence,
            String kind) throws Exception {
        return JSON.readTree("{\"v\":1,\"sequence\":" + sequence
                + ",\"eventId\":\"" + session + ":" + sequence
                + "\",\"sessionKey\":{\"tenantId\":\"" + TENANT
                + "\",\"workspaceId\":\"" + WORKSPACE + "\",\"sessionId\":\""
                + session + "\"},\"kind\":\"" + kind
                + "\",\"occurredAt\":1760000000000,\"payload\":{}}");
    }

    private static byte[] journalRecord(List<JsonNode> events) {
        StringBuilder lines = new StringBuilder();
        for (JsonNode event : events) {
            lines.append("{\"subtype\":\"managed_session_event_v1\",")
                    .append("\"managedSession\":").append(event).append("}\n");
        }
        lines.append("{\"subtype\":\"managed_session_commit_v1\",")
                .append("\"managedSession\":{}}\n");
        return lines.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static ManagedEventEnvelope wake(String session, long sequence)
            throws Exception {
        return ManagedEventEnvelopes.from(journalEvent(session, sequence,
                "wake.requested"));
    }

    private static EventRecord publicEvent(String session, long sequence,
            String type) {
        return new EventRecord(TENANT, session, sequence,
                "evt-" + session + "-" + sequence, "turn-1", type,
                Map.of("text", "delta " + sequence), false, null,
                1_760_000_000_000L + sequence);
    }

    private EventRecord storedPublicEvent(String session, long sequence,
            String type) {
        EventRecord event = publicEvent(session, sequence, type);
        jdbc.update("INSERT INTO ma_public_event (tenant_id, session_id, sequence_id, event_id, turn_id, event_type, data_json, terminal, source_key, gmt_create) VALUES (?, ?, ?, ?, ?, ?, '{}', FALSE, NULL, ?)", TENANT, session, sequence,
                event.eventId(), event.turnId(), type, event.createdAt());
        jdbc.update("UPDATE ma_event_stream SET last_sequence = ? WHERE"
                + " tenant_id = ? AND session_id = ? AND stream_kind ="
                + " 'SESSION' AND stream_id = X''", sequence, TENANT,
                session);
        return event;
    }

    private ManagedEventEnvelope publicEnvelope(EventRecord event) {
        return ManagedEventEnvelopes.fromPublicEventRow(
                ManagedEventEnvelopes.publicEventRow(event, objectMapper),
                WORKSPACE);
    }

    private int notifiedBatches(String session) {
        return (int) org.mockito.Mockito.mockingDetails(materializer)
                .getInvocations().stream()
                .filter(call -> call.getMethod().getName()
                        .equals("materializeNotified")
                        && session.equals(call.getArgument(1)))
                .count();
    }

    private int noticesSeen(String session) {
        return (int) org.mockito.Mockito.mockingDetails(consumerStore)
                .getInvocations().stream()
                .filter(call -> call.getMethod().getName()
                        .equals("materializedThrough")
                        && session.equals(call.getArgument(1)))
                .count();
    }

    private Long wakeWatermark(String session) {
        List<Long> covered = jdbc.queryForList("SELECT"
                + " wake_covered_sequence FROM ma_event_stream WHERE"
                + " tenant_id = ? AND session_id = ? AND stream_kind ="
                + " 'SESSION' AND stream_id = X''", Long.class, TENANT,
                session);
        return covered.isEmpty() ? null : covered.getFirst();
    }

    private long projectionWatermark(String session) {
        return jdbc.queryForObject("SELECT covered_sequence FROM"
                + " ma_event_stream WHERE tenant_id = ? AND session_id = ? AND"
                + " stream_kind = 'SESSION' AND stream_id = X''",
                Long.class, TENANT, session);
    }
}
