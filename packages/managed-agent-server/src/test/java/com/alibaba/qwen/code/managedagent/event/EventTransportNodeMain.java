package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore;
import com.alibaba.qwen.code.managedagent.session.OwnerSubscriptions;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One control-plane node of the MQ3 multi-node gate
 * (EventTransportMultiNodeGate): the whole application in its own JVM, so a
 * fault can end the process the way a crash does. Test-only hooks stand at
 * the points the §8 rows name — a wake received, a wake claimed, a committed
 * record handed to either wire — and fire only when the gate arms them with a
 * file under the shared directory, at most once across every node; a
 * hold-load fault instead parks every load of its Session, on every node,
 * until the gate releases it. Each wake
 * decision, load and hand-off this node makes is appended to its evidence
 * file, so the gate reads what each node did instead of inferring it.
 *
 * <p>The single argument is a JSON file: {@code node}, {@code root},
 * {@code shared}, {@code ready} and the Spring {@code properties}. A clock
 * skew is applied to the whole JVM from outside (libfaketime), never here:
 * the wake path reads the database clock and no Clock bean.
 */
public final class EventTransportNodeMain {
    /** The exit status of a fault-injected crash, distinct from a kill. */
    public static final int HALTED = 86;

    private EventTransportNodeMain() {
    }

    public static void main(String[] args) throws Exception {
        ObjectMapper json = new ObjectMapper();
        JsonNode config = json.readTree(Files.readString(Path.of(args[0])));
        String node = config.path("node").asText();
        Path root = Path.of(config.path("root").asText());
        Faults faults = new Faults(node, Path.of(config.path("shared").asText()),
                root.resolve("evidence.jsonl"));
        List<String> arguments = new ArrayList<>();
        config.path("properties").fields().forEachRemaining(entry ->
                arguments.add("--" + entry.getKey() + "=" + entry.getValue().asText()));
        var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class)
                .initializers(context -> context.getBeanFactory().addBeanPostProcessor(
                        new Hooks(context.getBeanFactory(), faults)))
                .run(arguments.toArray(String[]::new));
        faults.record(Map.of("event", "ready"));
        Path ready = Path.of(config.path("ready").asText());
        Path writing = ready.resolveSibling(ready.getFileName() + ".tmp");
        json.writeValue(writing.toFile(), Map.of("pid", ProcessHandle.current().pid(),
                "port", spring.getWebServer().getPort()));
        Files.move(writing, ready, StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
    }

    /**
     * The armed faults and this node's evidence. A fault is armed for a
     * Session by the file {@code shared/faults/<rule>/<sessionId>}; it fires on
     * the first node to create {@code shared/fired/<rule>-<sessionId>}.
     */
    static final class Faults {
        private static final ObjectMapper JSON = new ObjectMapper();
        private final String node;
        private final Path shared;
        private final Path evidence;

        Faults(String node, Path shared, Path evidence) {
            this.node = node;
            this.shared = shared;
            this.evidence = evidence;
        }

        boolean armed(String rule, String sessionId) {
            return sessionId != null
                    && Files.exists(shared.resolve("faults").resolve(rule)
                            .resolve(sessionId));
        }

        /** Whether any node has already fired the rule for the Session. */
        boolean fired(String rule, String sessionId) {
            return Files.exists(shared.resolve("fired")
                    .resolve(rule + "-" + sessionId));
        }

        /** Blocks until the gate releases the Session's held loads. */
        void awaitRelease(String sessionId) {
            Path release = shared.resolve("release").resolve(sessionId);
            while (!Files.exists(release)) {
                try {
                    Thread.sleep(50);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }

        /** Halts this JVM if the rule is armed and no node has fired it yet. */
        void haltIfArmed(String rule, String sessionId) {
            haltIfArmed(rule, sessionId, Map.of());
        }

        void haltIfArmed(String rule, String sessionId, Map<String, Object> detail) {
            if (!armed(rule, sessionId)) {
                return;
            }
            try {
                Files.createFile(shared.resolve("fired")
                        .resolve(rule + "-" + sessionId));
            } catch (FileAlreadyExistsException firedElsewhere) {
                return;
            } catch (IOException unwritable) {
                throw new UncheckedIOException(unwritable);
            }
            Map<String, Object> line = new LinkedHashMap<>(detail);
            line.put("event", "halt");
            line.put("rule", rule);
            line.put("session", sessionId);
            record(line);
            // No shutdown hook, no acknowledgement, no flush: a crash.
            Runtime.getRuntime().halt(HALTED);
        }

        synchronized void record(Map<String, Object> fields) {
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("node", node);
            line.put("at", System.currentTimeMillis());
            line.putAll(fields);
            try {
                Files.writeString(evidence, JSON.writeValueAsString(line) + "\n",
                        StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                        StandardOpenOption.APPEND, StandardOpenOption.SYNC);
            } catch (IOException unwritable) {
                throw new UncheckedIOException(unwritable);
            }
        }
    }

    /** Swaps the hooked subclasses in for the production transport beans. */
    private static final class Hooks implements BeanPostProcessor {
        private final ConfigurableListableBeanFactory beans;
        private final Faults faults;

        Hooks(ConfigurableListableBeanFactory beans, Faults faults) {
            this.beans = beans;
            this.faults = faults;
        }

        @Override
        public Object postProcessAfterInitialization(Object bean, String name) {
            if (bean instanceof TransportWakeActivator original
                    && !(bean instanceof HookedWakes)) {
                original.close();
                OwnerSubscriptions owners = beans.getBean(OwnerSubscriptions.class);
                return new HookedWakes(beans.getBean(TransportConsumerStore.class),
                        beans.getBean(HarnessConnector.class), owners::subscribe, faults);
            }
            if (bean instanceof LiteTopicEventTransport
                    && !(bean instanceof HookedJournalWire)) {
                var config = beans.getBean(ManagedAgentProperties.class)
                        .getEventTransport();
                return new HookedJournalWire(beans.getBean(Producer.class),
                        beans.getBean(ClientServiceProvider.class), config.getTopic(),
                        config.getWakeBootstrapLiteTopic(), faults);
            }
            if (bean instanceof LiteTopicPublicEventTransport original
                    && !(bean instanceof HookedPublicWire)) {
                original.close();
                TransportConsumerStore store = beans.getBean(TransportConsumerStore.class);
                return new HookedPublicWire(beans.getBean(Producer.class),
                        beans.getBean(ClientServiceProvider.class),
                        beans.getBean(ManagedAgentProperties.class).getEventTransport()
                                .getTopic(),
                        beans.getBean(ObjectMapper.class), store, faults);
            }
            return bean;
        }
    }

    private static final class HookedWakes extends TransportWakeActivator {
        private final Faults faults;
        // Sessions whose load this JVM must not start: its listener is about
        // to halt it after the claim. Local, so another node's load of the
        // same Session — after the fault fired — runs and is recorded.
        private final java.util.Set<String> halting =
                java.util.concurrent.ConcurrentHashMap.newKeySet();

        HookedWakes(TransportConsumerStore store, HarnessConnector harness,
                java.util.function.Consumer<String> activated, Faults faults) {
            super(store, harness, activated);
            this.faults = faults;
        }

        @Override
        public Outcome onWake(ManagedEventEnvelope envelope) {
            String session = envelope.sessionId();
            boolean wake = ManagedEventEnvelopes.STREAM_AUTHORITATIVE_JOURNAL.equals(
                    envelope.stream()) && "wake.requested".equals(envelope.kind());
            if (wake) {
                // §8 consumer crash before processing: nothing read, nothing
                // claimed, nothing acknowledged.
                faults.haltIfArmed("halt-on-receive", session);
            }
            boolean haltAfterClaim = wake && faults.armed("halt-after-claim", session)
                    && !faults.fired("halt-after-claim", session);
            if (haltAfterClaim) {
                halting.add(session);
            }
            Outcome outcome = super.onWake(envelope);
            if (wake) {
                faults.record(Map.of("event", "wake", "session", session,
                        "sequence", envelope.sequence(), "outcome", outcome.name()));
            }
            if (haltAfterClaim && outcome == Outcome.SCHEDULED) {
                // §8 consumer crash after a local effect: the claim committed,
                // the listener has not returned, so nothing is acknowledged.
                faults.haltIfArmed("halt-after-claim", session);
            }
            halting.remove(session);
            return outcome;
        }

        @Override
        LoadOutcome load(ManagedEventEnvelope envelope) {
            String session = envelope.sessionId();
            if (halting.contains(session)) {
                // This JVM's listener is halting it; the load must not race
                // it to the Harness.
                try {
                    Thread.sleep(Long.MAX_VALUE);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                return LoadOutcome.FAILED;
            }
            if (faults.armed("hold-load", session)) {
                // Every copy the gate sends is decided before the Session
                // activates, so a live writer cannot stand in for the claim.
                faults.awaitRelease(session);
            }
            LoadOutcome outcome = super.load(envelope);
            faults.record(Map.of("event", "load", "session", envelope.sessionId(),
                    "sequence", envelope.sequence(), "outcome", outcome.name()));
            return outcome;
        }
    }

    private static final class HookedJournalWire extends LiteTopicEventTransport {
        private static final ObjectMapper JSON = new ObjectMapper();
        private final Faults faults;

        HookedJournalWire(Producer producer, ClientServiceProvider provider,
                String topic, String bootstrapLiteTopic, Faults faults) {
            super(producer, provider, topic, bootstrapLiteTopic);
            this.faults = faults;
        }

        @Override
        public void publishCommitted(byte[] recordBytes) {
            String session = null;
            List<Long> wakes = new ArrayList<>();
            for (String line : new String(recordBytes, StandardCharsets.UTF_8)
                    .split("\n")) {
                try {
                    JsonNode event = JSON.readTree(line).path("managedSession");
                    if (event.path("sessionKey").path("sessionId").isTextual()) {
                        session = event.path("sessionKey").path("sessionId").asText();
                    }
                    if ("wake.requested".equals(event.path("kind").asText())) {
                        wakes.add(event.path("sequence").asLong());
                    }
                } catch (IOException notJson) {
                    // The wire itself reports a record it cannot read.
                }
            }
            if (!wakes.isEmpty()) {
                // §8 producer crash between the SQL commit and the publish:
                // the record carrying the wake is committed and never sent.
                faults.haltIfArmed("halt-on-journal-wake", session,
                        Map.of("wakes", wakes));
            }
            long started = System.nanoTime();
            super.publishCommitted(recordBytes);
            faults.record(Map.of("event", "journal-handoff",
                    "session", String.valueOf(session), "wakes", wakes,
                    "micros", (System.nanoTime() - started) / 1000));
        }
    }

    private static final class HookedPublicWire extends LiteTopicPublicEventTransport {
        private final Faults faults;

        HookedPublicWire(Producer producer, ClientServiceProvider provider, String topic,
                ObjectMapper objectMapper, TransportConsumerStore store, Faults faults) {
            super(producer, provider, topic, objectMapper, store::workspaceOf);
            this.faults = faults;
        }

        @Override
        public void publish(List<EventRecord> events) {
            String session = events.isEmpty() ? null : events.getFirst().sessionId();
            for (EventRecord event : events) {
                if ("turn.completed".equals(event.type())) {
                    // §8 producer crash between the SQL commit and the
                    // publish: the Turn's last batch is committed and never
                    // handed on, so no later notice of the Session follows.
                    faults.haltIfArmed("halt-on-public-terminal", session,
                            Map.of("eventId", event.eventId(),
                                    "sequence", event.sequence()));
                }
            }
            long started = System.nanoTime();
            super.publish(events);
            faults.record(Map.of("event", "public-handoff",
                    "session", String.valueOf(session),
                    "micros", (System.nanoTime() - started) / 1000));
        }
    }
}
