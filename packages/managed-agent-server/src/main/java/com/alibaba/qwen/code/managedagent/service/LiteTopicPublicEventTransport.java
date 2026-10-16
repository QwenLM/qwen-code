package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.EventTransport;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.message.Message;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BiFunction;

/**
 * Publishes the public {@code managed_agent_event} stream as
 * {@code public_event} envelopes to per-Session LiteTopics (design
 * 2026-10-04-managed-agent-event-transport, phase MQ2c) — the second
 * EventTransport wire, behind the MQ1 after-commit seam. A Session's journal
 * and public envelopes share its LiteTopic and are told apart by
 * {@code stream}.
 *
 * <p>The seam hands the batch over on the committing thread, so this adapter
 * only copies it onto a bounded single-thread queue: deriving the envelope
 * reads the Session's workspace binding (the public row carries none) and
 * digests the row, neither of which may delay the local post-commit SSE. A
 * full queue drops the batch with its replayable identity logged. Delivery
 * is best-effort throughout — consumers reconcile against SQL, and a dropped
 * notice only delays a materialization. A Session with no workspace yet
 * (neither a binding nor a journal) has no envelope identity; its rows are
 * left to the scheduled SQL pass.
 */
public class LiteTopicPublicEventTransport implements EventTransport, Closeable {
    private static final Logger LOG = LoggerFactory.getLogger(
            LiteTopicPublicEventTransport.class);
    private static final int QUEUE_CAPACITY = 1024;
    private static final int WORKSPACE_CACHE_SIZE = 4096;

    private final Producer producer;
    private final ClientServiceProvider provider;
    private final String topic;
    private final ObjectMapper mapper;
    private final BiFunction<String, String, Optional<String>> workspaces;
    private final Executor executor;
    // Found workspaces only, which never change; a Session without one yet is
    // looked up again, since its journal may appear later. Read and written
    // only by the executor's single thread.
    private final Map<String, String> workspaceCache = new LinkedHashMap<>(
            16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
            return size() > WORKSPACE_CACHE_SIZE;
        }
    };

    public LiteTopicPublicEventTransport(Producer producer,
            ClientServiceProvider provider, String topic, ObjectMapper mapper,
            BiFunction<String, String, Optional<String>> workspaces) {
        this(producer, provider, topic, mapper, workspaces,
                new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
                        new ArrayBlockingQueue<>(QUEUE_CAPACITY), runnable -> {
                            Thread thread = new Thread(runnable,
                                    "event-transport-public");
                            thread.setDaemon(true);
                            return thread;
                        }, new ThreadPoolExecutor.AbortPolicy()));
    }

    // The executor is injectable so a test can distribute synchronously.
    LiteTopicPublicEventTransport(Producer producer,
            ClientServiceProvider provider, String topic, ObjectMapper mapper,
            BiFunction<String, String, Optional<String>> workspaces,
            Executor executor) {
        this.producer = producer;
        this.provider = provider;
        this.topic = topic;
        this.mapper = mapper;
        this.workspaces = workspaces;
        this.executor = executor;
    }

    /** Stops the distribution thread; the shared producer is the config's. */
    @Override
    public void close() {
        if (executor instanceof ExecutorService service) {
            service.shutdown();
            try {
                service.awaitTermination(2, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Override
    public void publish(List<EventRecord> events) {
        if (events.isEmpty()) {
            return;
        }
        // The seam lends the list for the duration of the call only.
        List<EventRecord> batch = List.copyOf(events);
        try {
            executor.execute(() -> distribute(batch));
        } catch (RejectedExecutionException full) {
            EventRecord first = batch.getFirst();
            LOG.warn("public_event distribution refused the batch (queue"
                    + " full or shutting down); dropped {} committed events"
                    + " tenant={} session={} firstSequence={}"
                    + " lastSequence={}", batch.size(),
                    first.tenantId(), first.sessionId(), first.sequence(),
                    batch.getLast().sequence());
        }
    }

    private void distribute(List<EventRecord> batch) {
        for (EventRecord event : batch) {
            try {
                Optional<String> workspace = workspaceOf(event.tenantId(),
                        event.sessionId());
                if (workspace.isEmpty()) {
                    continue;
                }
                send(ManagedEventEnvelopes.fromPublicEventRow(
                        ManagedEventEnvelopes.publicEventRow(event, mapper),
                        workspace.get()));
            } catch (RuntimeException failure) {
                // The cause's class only: a contract or JSON message may quote
                // the row, and the body never leaves the SQL record.
                LOG.warn("could not derive the public_event envelope"
                        + " tenant={} session={} sequence={} eventId={}"
                        + " cause={}", event.tenantId(), event.sessionId(),
                        event.sequence(), event.eventId(),
                        failure.getClass().getName());
            }
        }
    }

    private Optional<String> workspaceOf(String tenantId, String sessionId) {
        String key = tenantId + "\n" + sessionId;
        String cached = workspaceCache.get(key);
        if (cached != null) {
            return Optional.of(cached);
        }
        Optional<String> found = workspaces.apply(tenantId, sessionId);
        found.ifPresent(workspace -> workspaceCache.put(key, workspace));
        return found;
    }

    private void send(ManagedEventEnvelope envelope) {
        try {
            Message message = provider.newMessageBuilder()
                    .setTopic(topic)
                    .setLiteTopic(envelope.sessionId())
                    .setKeys(envelope.eventId())
                    .setBody(ManagedEventEnvelopes.toJson(envelope)
                            .getBytes(StandardCharsets.UTF_8))
                    .build();
            producer.sendAsync(message).whenComplete((receipt, failure) -> {
                if (failure != null) {
                    dropped(envelope, failure);
                }
            });
        } catch (RuntimeException failure) {
            dropped(envelope, failure);
        }
    }

    private static void dropped(ManagedEventEnvelope envelope,
            Throwable failure) {
        LOG.warn("dropped public_event envelope eventId={} sessionId={}",
                envelope.eventId(), envelope.sessionId(), failure);
    }
}
