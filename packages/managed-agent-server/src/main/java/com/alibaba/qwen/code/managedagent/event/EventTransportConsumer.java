package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.consumer.ConsumeResult;
import org.apache.rocketmq.client.apis.message.MessageView;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.nio.ByteBuffer;
import java.util.OptionalLong;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * The message listener of both EventTransport consumer lanes (design
 * 2026-10-04-managed-agent-event-transport, phase MQ2c): it parses the
 * envelope against the frozen contract and hands it to its role — a journal
 * {@code wake.requested} to the wake activator, a {@code public_event} to the
 * materializer — and acknowledges every message, whatever it came to.
 *
 * <p>Acknowledging unconditionally is the design, not a shortcut. A LiteTopic
 * is consumed in order, so a FAILURE would hold every later notice of the
 * Session (or, on the bootstrap lane, of every Session) behind a retry; and
 * no outcome here is recovery-relevant, because SQL — never the broker — is
 * the truth each role re-reads: a missed public notice is covered by the
 * scheduled materialization pass, a missed wake by the ledger of the source
 * that committed its input. A message that is not a contract envelope is
 * dropped with its message id logged, never its body.
 *
 * <p>Materialization notices are coalesced per Session onto one thread: at
 * most one batch per Session is queued and one runs, so a streaming Turn's
 * notices cost at most one locking store transaction at a time on this node,
 * never one per notice in parallel, and the listener thread never waits on
 * the store's row locks.
 */
public class EventTransportConsumer implements Closeable {
    private static final Logger LOG = LoggerFactory.getLogger(
            EventTransportConsumer.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MATERIALIZE_QUEUE = 1024;

    /** What one public-event notice came to. */
    public enum MaterializeOutcome {
        /** No projection progress: the Session is not materialized. */
        UNKNOWN_SESSION,
        /** At or below what the projection covers: redelivered or older. */
        DUPLICATE,
        /** A batch for the Session is queued now. */
        QUEUED,
        /** A batch for the Session was already queued; it reads SQL fresh. */
        COALESCED,
        /** The queue was full; the scheduled pass covers the Session. */
        DROPPED
    }

    private final TransportWakeActivator wakes;
    private final TransportConsumerStore store;
    private final MessageMaterializer materializer;
    private final Executor materializations;
    // Sessions with a queued, not yet started, batch.
    private final Set<String> queued = ConcurrentHashMap.newKeySet();

    public EventTransportConsumer(TransportWakeActivator wakes,
            TransportConsumerStore store, MessageMaterializer materializer) {
        this(wakes, store, materializer, new ThreadPoolExecutor(1, 1, 0,
                TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(MATERIALIZE_QUEUE), runnable -> {
                    Thread thread = new Thread(runnable,
                            "event-transport-materialize");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy()));
    }

    // The executor is injectable so a test can materialize synchronously.
    EventTransportConsumer(TransportWakeActivator wakes,
            TransportConsumerStore store, MessageMaterializer materializer,
            Executor materializations) {
        this.wakes = wakes;
        this.store = store;
        this.materializer = materializer;
        this.materializations = materializations;
    }

    /** Stops the materialization thread; the scheduled pass carries on. */
    @Override
    public void close() {
        if (materializations instanceof ExecutorService service) {
            service.shutdown();
            try {
                service.awaitTermination(2, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    public ConsumeResult consume(MessageView message) {
        ManagedEventEnvelope envelope;
        try {
            envelope = ManagedEventEnvelopes.parse(JSON.readTree(
                    bytes(message.getBody())));
        } catch (Exception notAnEnvelope) {
            LOG.warn("dropped a transport message that is not a contract"
                    + " envelope messageId={} cause={}",
                    message.getMessageId(), notAnEnvelope.getClass().getName());
            return ConsumeResult.SUCCESS;
        }
        try {
            dispatch(envelope);
        } catch (RuntimeException failure) {
            LOG.warn("transport envelope handling failed tenant={} session={}"
                    + " stream={} sequence={} cause={}", envelope.tenantId(),
                    envelope.sessionId(), envelope.stream(),
                    envelope.sequence(), failure.toString());
        }
        return ConsumeResult.SUCCESS;
    }

    void dispatch(ManagedEventEnvelope envelope) {
        if (ManagedEventEnvelopes.STREAM_PUBLIC_EVENT.equals(
                envelope.stream())) {
            materialize(envelope);
            return;
        }
        TransportWakeActivator.Outcome outcome = wakes.onWake(envelope);
        if (outcome != TransportWakeActivator.Outcome.NOT_A_WAKE) {
            LOG.debug("transport wake tenant={} session={} sequence={}"
                    + " outcome={}", envelope.tenantId(), envelope.sessionId(),
                    envelope.sequence(), outcome);
        }
    }

    /**
     * The materialization role: deduped on the projection's covered sequence
     * — the SQL watermark — and then coalesced per Session; the queued batch
     * runs the materializer's own locked re-read.
     */
    MaterializeOutcome materialize(ManagedEventEnvelope envelope) {
        String tenantId = envelope.tenantId();
        String sessionId = envelope.sessionId();
        OptionalLong covered = store.materializedThrough(tenantId, sessionId);
        if (covered.isEmpty()) {
            return MaterializeOutcome.UNKNOWN_SESSION;
        }
        if (envelope.sequence() <= covered.getAsLong()) {
            return MaterializeOutcome.DUPLICATE;
        }
        String key = tenantId + "\n" + sessionId;
        if (!queued.add(key)) {
            return MaterializeOutcome.COALESCED;
        }
        try {
            materializations.execute(() -> {
                // Leaving the queued set first: a notice that arrives while
                // this batch runs queues one more, which reads its rows.
                queued.remove(key);
                materializer.materializeNotified(tenantId, sessionId);
            });
            return MaterializeOutcome.QUEUED;
        } catch (RejectedExecutionException full) {
            queued.remove(key);
            LOG.debug("transport materialization queue is full; the"
                    + " scheduled pass covers tenant={} session={}", tenantId,
                    sessionId);
            return MaterializeOutcome.DROPPED;
        }
    }

    private static byte[] bytes(ByteBuffer body) {
        ByteBuffer view = body.duplicate();
        byte[] bytes = new byte[view.remaining()];
        view.get(bytes);
        return bytes;
    }
}
