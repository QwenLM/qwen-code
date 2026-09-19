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
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import jakarta.annotation.PreDestroy;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    private final ManagedAgentStore store;
    private final HarnessConnector harness;
    private final HarnessEventProjector projector;
    private final RuntimeWarmer runtimeWarmer;
    private final ExecutorService executor;
    private final Clock clock;
    private final Duration leaseDuration;
    private final Duration renewInterval;
    private final String owner = UUID.randomUUID().toString();
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService renewer =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable,
                        "managed-agent-dispatch-lease");
                thread.setDaemon(true);
                return thread;
            });

    public HarnessCoordinator(ManagedAgentStore store,
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
                session.harnessSessionId(), session.harnessBootId() != null);
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
            Admission admission = harness.submit(session.harnessSessionId(),
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
            harness.cancel(session.harnessSessionId());
        }
        long lastEventId = current.harnessLastEventId() == null ? 0
                : current.harnessLastEventId();
        try (SourceStream stream = harness.stream(
                session.harnessSessionId(), lastEventId,
                current.harnessEventEpoch())) {
            for (SourceEvent event = stream.next(); event != null;
                    event = stream.next()) {
                requireLease(leaseLost);
                if (event.id() == null
                        || (event.promptId() != null
                                && !current.promptId().equals(
                                        event.promptId()))) {
                    continue;
                }
                ProjectedEvent projection = projector.project(event);
                String sourceKey = attachment.bootId() + ":"
                        + stream.eventEpoch() + ":" + event.id();
                store.recordHarnessEvent(current.tenantId(),
                        current.sessionId(), current.turnId(), owner,
                        stream.eventEpoch(), event.id(), sourceKey,
                        projection);
                if (projection != null && projection.terminal()) {
                    return true;
                }
            }
        }
        throw new IllegalStateException(
                "Hosted Harness stream ended before a terminal event");
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
            runtimeWarmer.warm(session.harnessSessionId()).whenComplete(
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
                    session.harnessSessionId(),
                    session.harnessBootId() != null);
            if (store.bindHarness(tenantId, sessionId,
                    attachment.bootId())) {
                harness.cancel(session.harnessSessionId());
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
