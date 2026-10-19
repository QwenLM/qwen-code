package com.alibaba.qwen.code.managedagent.event;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.message.Message;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Publishes {@code authoritative_journal} envelopes to per-Session LiteTopics
 * (design 2026-10-04-managed-agent-event-transport, phase MQ2b). The committed
 * journal facts arrive as the raw record bytes; this adapter derives one
 * envelope per committed event through the frozen-contract mirror and forwards
 * it over RocketMQ. Delivery is best-effort — it never blocks the committing
 * thread and never propagates a failure, because consumers reconcile against
 * SQL and a dropped notice only delays a wake or a materialization.
 *
 * <p>A {@code wake.requested} envelope is also sent to the shared wake
 * bootstrap LiteTopic (phase MQ2c, the §11 routing decision): a Session whose
 * wake nobody owns yet has no subscriber on its own LiteTopic, so the
 * bootstrap lane is how any node learns of it and attempts activation
 * through the fence.
 */
public class LiteTopicEventTransport implements JournalEventTransport {
    private static final Logger LOG = LoggerFactory.getLogger(
            LiteTopicEventTransport.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    // The managed_session_commit_v1 marker and any non-event record carry a
    // different subtype and are not events.
    private static final String EVENT_SUBTYPE = "managed_session_event_v1";
    private static final String WAKE_KIND = "wake.requested";

    // Shared with the public-event transport; the configuration closes it.
    private final Producer producer;
    private final ClientServiceProvider provider;
    private final String topic;
    private final String wakeBootstrapLiteTopic;

    public LiteTopicEventTransport(Producer producer,
            ClientServiceProvider provider, String topic,
            String wakeBootstrapLiteTopic) {
        this.producer = producer;
        this.provider = provider;
        this.topic = topic;
        this.wakeBootstrapLiteTopic = wakeBootstrapLiteTopic;
    }

    /** Publish one envelope per event in a committed journal record. */
    @Override
    public void publishCommitted(byte[] recordBytes) {
        List<ManagedEventEnvelope> envelopes;
        try {
            envelopes = envelopesOf(recordBytes);
        } catch (RuntimeException failure) {
            LOG.error("could not read a committed journal record; its events"
                    + " are not published", failure);
            return;
        }
        for (ManagedEventEnvelope envelope : envelopes) {
            publish(envelope, envelope.sessionId());
            if (WAKE_KIND.equals(envelope.kind())) {
                publish(envelope, wakeBootstrapLiteTopic);
            }
        }
    }

    /**
     * The committed events of a journal record as envelopes. The record is
     * UTF-8 JSON Lines; each line is a record envelope and the events are the
     * lines whose subtype is a managed-session event.
     */
    static List<ManagedEventEnvelope> envelopesOf(byte[] recordBytes) {
        List<ManagedEventEnvelope> envelopes = new ArrayList<>();
        for (String line : new String(recordBytes, StandardCharsets.UTF_8)
                .split("\n")) {
            if (line.isBlank()) {
                continue;
            }
            JsonNode record = readLine(line);
            if (EVENT_SUBTYPE.equals(record.path("subtype").asText())) {
                envelopes.add(ManagedEventEnvelopes.from(
                        record.required("managedSession")));
            }
        }
        return envelopes;
    }

    private void publish(ManagedEventEnvelope envelope, String liteTopic) {
        Message message;
        try {
            message = provider.newMessageBuilder()
                    .setTopic(topic)
                    .setLiteTopic(liteTopic)
                    .setKeys(envelope.eventId())
                    .setBody(ManagedEventEnvelopes.toJson(envelope)
                            .getBytes(StandardCharsets.UTF_8))
                    .build();
        } catch (RuntimeException failure) {
            LOG.warn("could not build the envelope message eventId={}",
                    envelope.eventId(), failure);
            return;
        }
        try {
            producer.sendAsync(message).whenComplete((receipt, failure) -> {
                if (failure != null) {
                    dropped(envelope, liteTopic, failure);
                }
            });
        } catch (RuntimeException failure) {
            // A send refused synchronously (a closing producer) must not
            // reach the committing thread or skip the remaining envelopes.
            dropped(envelope, liteTopic, failure);
        }
    }

    private static void dropped(ManagedEventEnvelope envelope,
            String liteTopic, Throwable failure) {
        LOG.warn("dropped authoritative_journal envelope eventId={}"
                + " sessionId={} liteTopic={}", envelope.eventId(),
                envelope.sessionId(), liteTopic, failure);
    }

    private static JsonNode readLine(String line) {
        try {
            return JSON.readTree(line);
        } catch (Exception error) {
            throw new IllegalStateException(
                    "journal record line is not valid JSON", error);
        }
    }
}
