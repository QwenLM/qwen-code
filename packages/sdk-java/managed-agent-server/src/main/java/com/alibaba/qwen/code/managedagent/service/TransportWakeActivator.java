package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.alibaba.qwen.code.managedagent.store.TransportConsumerStore;
import com.alibaba.qwen.code.managedagent.store.TransportConsumerStore.WakeFence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * The wake consumer role (design 2026-10-04-managed-agent-event-transport,
 * phase MQ2c): a delivered {@code wake.requested} envelope is only a hint to
 * look at SQL sooner. Every check below reads SQL truth; the envelope only
 * names which Session to look at, and only a wake SQL can show — committed,
 * in the journal's own workspace, on an open Session nobody holds — is
 * attempted. The attempt loads the Session into this node's Harness through
 * the new-work admission, and the Harness's writer acquisition is the
 * activation fence: it, not the message, decides whether this node may act.
 *
 * <p>The SQL checks and the claim run on the listener thread; the load, a
 * Harness round trip, runs on a small bounded pool, because the bootstrap
 * lane is one ordered LiteTopic and a load held on its listener would delay
 * every other Session's wake. Every outcome is final for the message (the
 * consumer always acknowledges). A wake a notice missed — lost, or claimed
 * and then not loaded — recovers exactly as with the transport off: the
 * ledger of the source that committed its input, where that source has one,
 * re-drives the Session (the public Turn dispatcher, the session-message
 * consume loop, the child and automation relays), and a loaded Session's
 * wake pump runs what its journal holds. No generic scan backs the
 * transport; the MQ2 design records the sources without a ledger and the
 * gaps the ledgers already have. A claim never blocks a later wake: the
 * watermark refuses only its own and older sequences.
 */
public class TransportWakeActivator implements Closeable {
    private static final Logger LOG = LoggerFactory.getLogger(
            TransportWakeActivator.class);
    private static final String WAKE_KIND = "wake.requested";
    private static final int LOAD_THREADS = 4;
    private static final int LOAD_QUEUE = 256;

    /** What one delivered wake came to on the listener thread. */
    public enum Outcome {
        /** Not a journal wake: nothing for this role. */
        NOT_A_WAKE,
        /** No Session or no journal: nothing SQL can show. */
        UNKNOWN_SESSION,
        /** The envelope's workspace contradicts the journal's. */
        WORKSPACE_MISMATCH,
        /** The sequence is beyond what the journal has committed. */
        NOT_VISIBLE,
        /** The Session is closing, closed, or its journal is retired. */
        SETTLED,
        /** A live writer holds the Session; its own wake pump runs the input. */
        OWNED,
        /** This Harness cannot load Sessions now. */
        UNAVAILABLE,
        /** Redelivered, duplicated or older than an already-claimed wake. */
        DUPLICATE,
        /** Claimed, and the load handed to the load pool. */
        SCHEDULED,
        /** Claimed, but the load pool was full; left to its source's ledger. */
        DROPPED
    }

    /** What a scheduled load came to. */
    public enum LoadOutcome {
        /** This node loaded the Session. */
        ACTIVATED,
        /** This node already holds an attachment for the Session. */
        ALREADY_ATTACHED,
        /** The load failed and SQL now shows another live writer. */
        FENCED,
        /** The load failed otherwise; left to its source's ledger. */
        FAILED
    }

    private final TransportConsumerStore store;
    private final HarnessConnector harness;
    private final Consumer<String> activated;
    private final Executor loads;

    /**
     * @param activated told the session id of every Session this node
     *     activated, so its owner-side subscription starts at once instead of
     *     at the next reconciliation tick
     */
    public TransportWakeActivator(TransportConsumerStore store,
            HarnessConnector harness, Consumer<String> activated) {
        this(store, harness, activated, loadPool());
    }

    // The executor is injectable so a test can load synchronously.
    TransportWakeActivator(TransportConsumerStore store,
            HarnessConnector harness, Consumer<String> activated,
            Executor loads) {
        this.store = store;
        this.harness = harness;
        this.activated = activated;
        this.loads = loads;
    }

    private static ExecutorService loadPool() {
        AtomicInteger threads = new AtomicInteger();
        return new ThreadPoolExecutor(LOAD_THREADS, LOAD_THREADS, 0,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(LOAD_QUEUE),
                runnable -> {
                    Thread thread = new Thread(runnable,
                            "event-transport-wake-" + threads.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    /** Stops the load pool; a load in flight finishes or times out. */
    @Override
    public void close() {
        if (loads instanceof ExecutorService service) {
            service.shutdown();
            try {
                service.awaitTermination(2, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    public Outcome onWake(ManagedEventEnvelope envelope) {
        if (!ManagedEventEnvelopes.STREAM_AUTHORITATIVE_JOURNAL.equals(
                envelope.stream()) || !WAKE_KIND.equals(envelope.kind())) {
            return Outcome.NOT_A_WAKE;
        }
        String tenantId = envelope.tenantId();
        String sessionId = envelope.sessionId();
        Optional<WakeFence> read = store.wakeFence(tenantId, sessionId);
        if (read.isEmpty()) {
            return Outcome.UNKNOWN_SESSION;
        }
        WakeFence fence = read.get();
        if (!envelope.workspaceId().equals(fence.workspaceId())) {
            return Outcome.WORKSPACE_MISMATCH;
        }
        if (envelope.sequence() > fence.committedSequence()) {
            return Outcome.NOT_VISIBLE;
        }
        if (!"ACTIVE".equals(fence.sessionStatus())
                || !("ACTIVE".equals(fence.headState())
                        || "SEALED".equals(fence.headState()))) {
            return Outcome.SETTLED;
        }
        if (fence.liveWriter()) {
            return Outcome.OWNED;
        }
        if (!harness.isAvailable()) {
            return Outcome.UNAVAILABLE;
        }
        // Claimed before the attempt, so a racing redelivery on another node
        // never loads the same Session twice for one wake.
        if (!store.claimWake(tenantId, sessionId, envelope.sequence())) {
            return Outcome.DUPLICATE;
        }
        try {
            loads.execute(() -> load(envelope));
            return Outcome.SCHEDULED;
        } catch (RejectedExecutionException full) {
            LOG.warn("transport wake load pool is full; the wake is left to"
                    + " its source's ledger tenant={} session={} sequence={}",
                    tenantId, sessionId, envelope.sequence());
            return Outcome.DROPPED;
        }
    }

    LoadOutcome load(ManagedEventEnvelope envelope) {
        String tenantId = envelope.tenantId();
        String sessionId = envelope.sessionId();
        try {
            if (!harness.activateForWake(tenantId, sessionId)) {
                LOG.debug("transport wake found the Session already attached"
                        + " tenant={} session={} sequence={}", tenantId,
                        sessionId, envelope.sequence());
                return LoadOutcome.ALREADY_ATTACHED;
            }
            activated.accept(sessionId);
            return LoadOutcome.ACTIVATED;
        } catch (RuntimeException failure) {
            // Whether another writer won is read from SQL, never inferred
            // from the failure's status: a 409 also names a parked Turn or a
            // Session another process still holds.
            boolean fenced;
            try {
                fenced = store.wakeFence(tenantId, sessionId)
                        .map(WakeFence::liveWriter).orElse(false);
            } catch (RuntimeException unreadable) {
                fenced = false;
            }
            if (fenced) {
                LOG.debug("transport wake fenced tenant={} session={}"
                        + " sequence={}", tenantId, sessionId,
                        envelope.sequence());
                return LoadOutcome.FENCED;
            }
            LOG.warn("transport wake activation failed tenant={} session={}"
                    + " sequence={} cause={}", tenantId, sessionId,
                    envelope.sequence(), failure.toString());
            return LoadOutcome.FAILED;
        }
    }
}
