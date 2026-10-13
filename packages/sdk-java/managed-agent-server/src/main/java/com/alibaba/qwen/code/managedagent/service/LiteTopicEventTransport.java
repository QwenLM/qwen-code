package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.Closeable;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.message.Message;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Publishes {@code authoritative_journal} envelopes to per-Session LiteTopics
 * (design 2026-10-04-managed-agent-event-transport, phase MQ2b). The committed
 * journal facts arrive as the raw record bytes; this adapter derives one
 * envelope per committed event through the frozen-contract mirror and forwards
 * it over RocketMQ. Delivery is best-effort — it never blocks the committing
 * thread and never propagates a failure, because consumers reconcile against
 * SQL and a dropped notice only delays a wake or a materialization.
 */
public class LiteTopicEventTransport
        implements JournalEventTransport, Closeable {
    private static final Logger LOG = LoggerFactory.getLogger(
            LiteTopicEventTransport.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    // The managed_session_commit_v1 marker and any non-event record carry a
    // different subtype and are not events.
    private static final String EVENT_SUBTYPE = "managed_session_event_v1";

    private final Producer producer;
    private final ClientServiceProvider provider;
    private final String topic;

    public LiteTopicEventTransport(Producer producer,
            ClientServiceProvider provider, String topic) {
        this.producer = producer;
        this.provider = provider;
        this.topic = topic;
    }

    /** Closes the producer and its broker connections on shutdown. */
    @Override
    public void close() throws IOException {
        producer.close();
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
            publish(envelope);
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

    private void publish(ManagedEventEnvelope envelope) {
        Message message;
        try {
            message = provider.newMessageBuilder()
                    .setTopic(topic)
                    .setLiteTopic(envelope.sessionId())
                    .setKeys(envelope.eventId())
                    .setBody(ManagedEventEnvelopes.toJson(envelope)
                            .getBytes(StandardCharsets.UTF_8))
                    .build();
        } catch (RuntimeException failure) {
            LOG.warn("could not build the envelope message eventId={}",
                    envelope.eventId(), failure);
            return;
        }
        producer.sendAsync(message).whenComplete((receipt, failure) -> {
            if (failure != null) {
                LOG.warn("dropped authoritative_journal envelope eventId={}"
                        + " sessionId={}", envelope.eventId(),
                        envelope.sessionId(), failure);
            }
        });
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
