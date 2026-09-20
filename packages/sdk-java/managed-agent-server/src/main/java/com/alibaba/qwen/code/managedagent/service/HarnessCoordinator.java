package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class HarnessCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(
            HarnessCoordinator.class);
    private final AgentStateStore store;
    private final HarnessConnector harness;
    private final HarnessEventProjector projector;
    private final RuntimeWarmer runtimeWarmer;
    private final ExecutorService executor;
    private final Clock clock;
    private final Duration leaseDuration;
    private final Duration renewInterval;
    private final Duration batchInterval;
    private final int batchMaxEvents;
    private final int batchMaxBytes;
    private final String owner = UUID.randomUUID().toString();
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService renewer =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable,
                        "managed-agent-dispatch-lease");
                thread.setDaemon(true);
                return thread;
            });

    public HarnessCoordinator(AgentStateStore store,
            HarnessConnector harness, HarnessEventProjector projector,
            RuntimeWarmer runtimeWarmer, ExecutorService executor,
            Clock clock, ManagedAgentProperties properties) {
        this.store = store;
        this.harness = harness;
        this.projector = projector;
        this.runtimeWarmer = runtimeWarmer;
        this.executor = executor;
        this.clock = clock;
        this.leaseDuration = properties.getDispatch().getLeaseDuration();
        this.renewInterval = properties.getDispatch()
                .getLeaseRenewInterval();
        this.batchInterval = properties.getEvents().getBatchInterval();
        this.batchMaxEvents = properties.getEvents().getBatchMaxEvents();
        this.batchMaxBytes = properties.getEvents().getBatchMaxBytes();
        if (batchInterval.isNegative() || batchInterval.isZero()
                || batchMaxEvents <= 0 || batchMaxBytes <= 0) {
            throw new IllegalStateException(
                    "Managed event batch limits must be positive");
        }
    }

    public void dispatch(String tenantId, String sessionId, String turnId) {
        String key = key(tenantId, sessionId, turnId);
        if (!active.add(key)) {
            return;
        }
        executor.execute(() -> {
            try {
                coordinate(tenantId, sessionId, turnId);
            } finally {
                active.remove(key);
            }
        });
    }

    public void cancel(String tenantId, String sessionId, String turnId) {
        dispatch(tenantId, sessionId, turnId);
        executor.execute(() -> cancelAdmittedTurn(tenantId, sessionId,
                turnId));
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void recoverExpiredTurns() {
        if (!harness.isAvailable()) {
            return;
        }
        for (DispatchTarget target : store.findDispatchable(clock.millis(),
                50)) {
            dispatch(target.tenantId(), target.sessionId(), target.turnId());
        }
    }

    @PreDestroy
    public void close() {
        renewer.shutdownNow();
    }

    private void coordinate(String tenantId, String sessionId,
            String turnId) {
        TurnRecord claimed = store.claimTurn(tenantId, sessionId, turnId,
                owner, leaseDuration).orElse(null);
        if (claimed == null) {
            return;
        }
        AtomicBoolean leaseLost = new AtomicBoolean();
        ScheduledFuture<?> renewal = renewer.scheduleAtFixedRate(
                () -> {
                    try {
                        if (!store.renewTurn(tenantId, sessionId, turnId,
                                owner, leaseDuration)) {
                            leaseLost.set(true);
                        }
                    } catch (RuntimeException error) {
                        leaseLost.set(true);
                        LOG.warn("Managed Turn lease renewal failed tenant={}"
                                        + " session={} turn={} failure={}",
                                tenantId, sessionId, turnId,
                                error.getClass().getSimpleName());
                    }
                },
                renewInterval.toMillis(), renewInterval.toMillis(),
                TimeUnit.MILLISECONDS);
        boolean terminal = false;
        try {
            terminal = runClaimed(claimed, leaseLost);
        } catch (HostedHarnessCapabilityMismatchException error) {
            terminal = fail(claimed, error.getCode(),
                    "Hosted Harness capability policy changed.");
        } catch (HostedHarnessGenerationException error) {
            terminal = fail(claimed, error.getCode(),
                    "Hosted Harness generation changed.");
        } catch (DaemonProtocolException error) {
            terminal = fail(claimed, "hosted_harness_protocol_error",
                    "Hosted Harness returned an invalid protocol response.");
        } catch (DaemonHttpException error) {
            if (error.getStatusCode() >= 400
                    && error.getStatusCode() < 500
                    && error.getStatusCode() != 409) {
                terminal = fail(claimed, "hosted_harness_rejected",
                        "Hosted Harness rejected the Turn.");
            } else {
                transientFailure(claimed, error);
            }
        } catch (RuntimeException error) {
            transientFailure(claimed, error);
        } finally {
            renewal.cancel(false);
            if (!terminal) {
                store.releaseTurnLease(tenantId, sessionId, turnId, owner);
            }
        }
    }

    private boolean runClaimed(TurnRecord claimed,
            AtomicBoolean leaseLost) {
        SessionRecord session = store.requireSession(claimed.tenantId(),
                claimed.sessionId());
        if ("CANCELLING".equals(claimed.status())
                && claimed.harnessEventEpoch() == null
                && !claimed.submissionAttempted()) {
            store.cancelBeforeAdmission(claimed.tenantId(),
                    claimed.sessionId(), claimed.turnId(), owner);
            return true;
        }
        warmRuntime(session, claimed);
        requireLease(leaseLost);
        Attachment attachment = harness.createOrLoad(
                session.sessionId(), session.harnessBootId() != null);
        if (!store.bindHarness(session.tenantId(), session.sessionId(),
                attachment.bootId())) {
            return fail(claimed, "hosted_harness_generation_mismatch",
                    "Hosted Harness generation changed.");
        }
        requireLease(leaseLost);
        TurnRecord current = store.findTurn(claimed.tenantId(),
                claimed.sessionId(), claimed.turnId()).orElseThrow();
        if (current.harnessEventEpoch() == null) {
            store.markSubmissionAttempted(current.tenantId(),
                    current.sessionId(), current.turnId(), owner);
            Admission admission = harness.submit(session.sessionId(),
                    current.promptId(), current.input(),
                    current.payloadDigest());
            requireLease(leaseLost);
            store.recordAdmission(current.tenantId(), current.sessionId(),
                    current.turnId(), owner, admission.eventEpoch(),
                    admission.lastEventId());
            current = store.findTurn(current.tenantId(), current.sessionId(),
                    current.turnId()).orElseThrow();
        }
        if ("CANCELLING".equals(current.status())) {
            harness.cancel(session.sessionId());
        }
        long lastEventId = current.harnessLastEventId() == null ? 0
                : current.harnessLastEventId();
        try (SourceStream stream = harness.stream(
                session.sessionId(), lastEventId,
                current.harnessEventEpoch())) {
            return consumeStream(current, attachment.bootId(), stream,
                    leaseLost);
        }
    }

    private boolean consumeStream(TurnRecord turn, String bootId,
            SourceStream stream, AtomicBoolean leaseLost) {
        int capacity = Math.max(128, batchMaxEvents * 2);
        BlockingQueue<StreamItem> incoming =
                new ArrayBlockingQueue<>(capacity);
        Future<?> reader = executor.submit(() -> readStream(stream,
                incoming));
        List<HarnessEvent> batch = new ArrayList<>();
        int batchBytes = 0;
        long flushAt = 0;
        boolean flushFirstVisibleText = true;
        try {
            while (true) {
                StreamItem item = take(incoming, batch, flushAt);
                if (item == null) {
                    flush(turn, stream.eventEpoch(), batch, leaseLost);
                    batchBytes = 0;
                    flushAt = 0;
                    continue;
                }
                if (item.error() != null) {
                    throw item.error();
                }
                if (item.end()) {
                    flush(turn, stream.eventEpoch(), batch, leaseLost);
                    throw new IllegalStateException(
                            "Hosted Harness stream ended before a terminal"
                                    + " event");
                }
                SourceEvent source = item.event();
                requireLease(leaseLost);
                if (source.id() == null
                        || source.promptId() != null
                        && !turn.promptId().equals(source.promptId())) {
                    continue;
                }
                ProjectedEvent projection = projector.project(source,
                        turn.turnId());
                HarnessEvent event = new HarnessEvent(source.id(),
                        bootId + ":" + stream.eventEpoch() + ":"
                                + source.id(),
                        projection);
                if (projection != null && !isTextDelta(projection)) {
                    flush(turn, stream.eventEpoch(), batch, leaseLost);
                    record(turn, stream.eventEpoch(), List.of(event),
                            leaseLost);
                    if (projection.terminal()) {
                        return true;
                    }
                    batchBytes = 0;
                    flushAt = 0;
                    continue;
                }
                if (batch.isEmpty()) {
                    flushAt = System.nanoTime()
                            + batchInterval.toNanos();
                }
                batch.add(event);
                batchBytes += estimatedBytes(projection);
                if (projection != null && flushFirstVisibleText) {
                    flush(turn, stream.eventEpoch(), batch, leaseLost);
                    flushFirstVisibleText = false;
                    batchBytes = 0;
                    flushAt = 0;
                } else if (batch.size() >= batchMaxEvents
                        || batchBytes >= batchMaxBytes) {
                    flush(turn, stream.eventEpoch(), batch, leaseLost);
                    batchBytes = 0;
                    flushAt = 0;
                }
            }
        } finally {
            reader.cancel(true);
        }
    }

    private static void readStream(SourceStream stream,
            BlockingQueue<StreamItem> incoming) {
        try {
            for (SourceEvent event = stream.next(); event != null;
                    event = stream.next()) {
                incoming.put(new StreamItem(event, null, false));
            }
            incoming.put(new StreamItem(null, null, true));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException error) {
            try {
                incoming.put(new StreamItem(null, error, false));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private StreamItem take(BlockingQueue<StreamItem> incoming,
            List<HarnessEvent> batch, long flushAt) {
        try {
            if (batch.isEmpty()) {
                return incoming.take();
            }
            long remaining = Math.max(1, flushAt - System.nanoTime());
            return incoming.poll(remaining, TimeUnit.NANOSECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(
                    "Managed event batching was interrupted", error);
        }
    }

    private void flush(TurnRecord turn, String eventEpoch,
            List<HarnessEvent> events, AtomicBoolean leaseLost) {
        if (events.isEmpty()) {
            return;
        }
        record(turn, eventEpoch, List.copyOf(events), leaseLost);
        events.clear();
    }

    private void record(TurnRecord turn, String eventEpoch,
            List<HarnessEvent> events, AtomicBoolean leaseLost) {
        requireLease(leaseLost);
        store.recordHarnessEvents(turn.tenantId(), turn.sessionId(),
                turn.turnId(), owner, eventEpoch, events);
    }

    private static boolean isTextDelta(ProjectedEvent event) {
        return "item.output_text.delta".equals(event.type())
                || "item.reasoning.delta".equals(event.type());
    }

    private static int estimatedBytes(ProjectedEvent event) {
        if (event == null) {
            return 64;
        }
        Object text = event.data().get("text");
        return 128 + (text instanceof String
                ? ((String) text).getBytes(StandardCharsets.UTF_8).length
                : event.data().toString().getBytes(StandardCharsets.UTF_8)
                        .length);
    }

    private record StreamItem(SourceEvent event, RuntimeException error,
            boolean end) {
    }

    private void warmRuntime(SessionRecord session, TurnRecord turn) {
        if (!runtimeWarmer.isEnabled()) {
            return;
        }
        String startKey = "runtime:start:" + turn.turnId();
        store.appendPublicEventIfAbsent(session.tenantId(),
                session.sessionId(), turn.turnId(),
                "environment.provisioning", Map.of(), false, startKey);
        try {
            runtimeWarmer.warm(session.sessionId()).whenComplete(
                    (ignored, error) -> runtimeWarmResult(session, turn,
                            error));
        } catch (RuntimeException error) {
            runtimeWarmResult(session, turn, error);
        }
    }

    private void runtimeWarmResult(SessionRecord session, TurnRecord turn,
            Throwable error) {
        String suffix = error == null ? "ready" : "failed";
        String type = "environment." + suffix;
        Map<String, Object> data = error == null ? Map.of()
                : Map.of("code", "runtime_warm_failed");
        store.appendPublicEventIfAbsent(session.tenantId(),
                session.sessionId(), turn.turnId(), type, data, false,
                "runtime:" + suffix + ":" + turn.turnId());
    }

    private void cancelAdmittedTurn(String tenantId, String sessionId,
            String turnId) {
        try {
            TurnRecord turn = store.findTurn(tenantId, sessionId, turnId)
                    .orElse(null);
            if (turn == null || !"CANCELLING".equals(turn.status())
                    || turn.harnessEventEpoch() == null) {
                return;
            }
            SessionRecord session = store.requireSession(tenantId,
                    sessionId);
            Attachment attachment = harness.createOrLoad(
                    session.sessionId(), session.harnessBootId() != null);
            if (store.bindHarness(tenantId, sessionId,
                    attachment.bootId())) {
                harness.cancel(session.sessionId());
            }
        } catch (RuntimeException error) {
            LOG.warn("Managed Turn cancellation will recover tenant={}"
                            + " session={} turn={} failure={}",
                    tenantId, sessionId, turnId,
                    error.getClass().getSimpleName());
        }
    }

    private static void requireLease(AtomicBoolean leaseLost) {
        if (leaseLost.get()) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    private boolean fail(TurnRecord turn, String code, String message) {
        store.failTurn(turn.tenantId(), turn.sessionId(), turn.turnId(),
                owner, code, message);
        return true;
    }

    private void transientFailure(TurnRecord turn, RuntimeException error) {
        LOG.warn("Managed Turn coordination will retry tenant={} session={}"
                        + " turn={} failure={}",
                turn.tenantId(), turn.sessionId(), turn.turnId(),
                error.getClass().getSimpleName());
    }

    private static String key(String tenantId, String sessionId,
            String turnId) {
        return tenantId + "\n" + sessionId + "\n" + turnId;
    }
}
