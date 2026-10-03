package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.harness.HostedHarnessRecoveryDeclinedException;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
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
    // 409 bodies whose wait is bounded by the predecessor's writer lease,
    // and which may therefore stretch past the pre-admission budget. Every
    // other body shape meets it — including `hosted_session_already_attached`,
    // which looks transient but is not: the daemon drops an attachment only
    // on an explicit detach or delete, and this control plane never detaches,
    // so a Spring restart against a surviving Harness would otherwise retry
    // a permanent refusal forever instead of ending the Turn.
    private static final Set<String> LEASE_BOUNDED_409_CODES = Set.of(
            "hosted_turn_recovery_required",
            "hosted_prompt_recovery_required");
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
    private final Duration retryInitialDelay;
    private final Duration retryMaxDelay;
    private final int maxPreAdmissionRetries;
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
        this.retryInitialDelay = properties.getDispatch()
                .getRetryInitialDelay();
        this.retryMaxDelay = properties.getDispatch().getRetryMaxDelay();
        this.maxPreAdmissionRetries = properties.getDispatch()
                .getMaxPreAdmissionRetries();
        this.batchInterval = properties.getEvents().getBatchInterval();
        this.batchMaxEvents = properties.getEvents().getBatchMaxEvents();
        this.batchMaxBytes = properties.getEvents().getBatchMaxBytes();
        if (batchInterval.isNegative() || batchInterval.isZero()
                || batchMaxEvents <= 0 || batchMaxBytes <= 0) {
            throw new IllegalStateException(
                    "Managed event batch limits must be positive");
        }
        if (retryInitialDelay.isNegative() || retryInitialDelay.isZero()
                || retryMaxDelay.compareTo(retryInitialDelay) < 0
                || maxPreAdmissionRetries < 0) {
            throw new IllegalStateException(
                    "Managed dispatch retry limits are invalid");
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
        AtomicBoolean submissionAttempted = new AtomicBoolean(
                claimed.submissionAttempted());
        AtomicBoolean recoveryPath = new AtomicBoolean();
        try {
            terminal = runClaimed(claimed, leaseLost,
                    submissionAttempted, recoveryPath);
        } catch (HostedHarnessCapabilityMismatchException error) {
            terminal = failTerminally(claimed, error.getCode(),
                    "Hosted Harness capability policy changed.", error);
        } catch (HostedHarnessRecoveryDeclinedException error) {
            // The reason is remote-supplied; the terminal write lands in
            // managed_agent_turn.error_message VARCHAR(2048), so bound it
            // instead of letting one oversized body throw the terminal
            // write itself.
            String declineReason = error.getReason().length() > 1024
                    ? error.getReason().substring(0, 1024)
                    : error.getReason();
            terminal = failTerminally(claimed,
                    "managed_runtime_recovery_blocked",
                    "The prior Harness generation parked a Turn this"
                            + " Harness cannot take over ("
                            + declineReason + ").", error);
        } catch (HostedHarnessGenerationException error) {
            // G3: a generation change is adopted, not failed. The next
            // dispatch attempt re-attaches through the takeover load; on a
            // bound Session the wait is bounded by the prior generation's
            // lease, so only that path escapes the retry budget.
            terminal = transientFailure(claimed,
                    submissionAttempted.get(), error, recoveryPath.get());
        } catch (DaemonProtocolException error) {
            terminal = failTerminally(claimed, "hosted_harness_protocol_error",
                    "Hosted Harness returned an invalid protocol response.",
                    error);
        } catch (DaemonHttpException error) {
            if (error.getStatusCode() >= 400
                    && error.getStatusCode() < 500
                    && error.getStatusCode() != 409) {
                terminal = failTerminally(claimed, "hosted_harness_rejected",
                        "Hosted Harness rejected the Turn.", error);
            } else {
                // Only a live predecessor's guardrails may stretch past
                // the pre-admission budget: a lease-bounded 409 on the
                // recovery attach of a bound Session is a wait bounded by
                // that predecessor's own lease. Configuration-shaped 409s
                // (the code says so) and every other failure meet it.
                terminal = transientFailure(claimed,
                        submissionAttempted.get(), error,
                        recoveryPath.get()
                                && LEASE_BOUNDED_409_CODES.contains(
                                        error.getErrorCode()));
            }
        } catch (RuntimeBrokerException error) {
            terminal = !submissionAttempted.get() && !error.isRetryable()
                    ? failTerminally(claimed, error.getCode(),
                            error.getMessage(), error)
                    : transientFailure(claimed, submissionAttempted.get(),
                            error, false);
        } catch (RuntimeException error) {
            terminal = transientFailure(claimed,
                    submissionAttempted.get(), error, false);
        } finally {
            renewal.cancel(false);
            if (!terminal) {
                store.releaseTurnLease(tenantId, sessionId, turnId, owner);
            }
        }
    }

    private boolean runClaimed(TurnRecord claimed,
            AtomicBoolean leaseLost, AtomicBoolean submissionAttempted,
            AtomicBoolean recoveryPath) {
        SessionRecord session = store.requireSession(claimed.tenantId(),
                claimed.sessionId());
        // A bound Session re-attaches through the takeover load: failures
        // here wait on the prior generation's lease, a wait bounded by that
        // lease itself rather than by the pre-admission retry budget.
        recoveryPath.set(session.harnessBootId() != null);
        if (session.workspace() != null && !harness.isWorkspaceFilesAvailable()) {
            return fail(claimed, "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
        if ("CANCELLING".equals(claimed.status())
                && claimed.harnessEventEpoch() == null
                && !claimed.submissionAttempted()) {
            store.cancelBeforeAdmission(claimed.tenantId(),
                    claimed.sessionId(), claimed.turnId(), owner);
            return true;
        }
        boolean recoveringCancellation =
                "CANCELLING".equals(claimed.status());
        if (!recoveringCancellation) {
            warmRuntime(session, claimed);
        }
        requireLease(leaseLost);
        Attachment attachment;
        if (session.harnessBootId() != null) {
            // A previously attached Session may hold a parked Turn; the
            // takeover load settles or reports it. Plain loads stay inert.
            attachment = harness.recoverManagedRuntime(session.tenantId(),
                    session.sessionId(), recoveringCancellation);
        } else {
            attachment = harness.createOrLoad(session.tenantId(),
                    session.sessionId(), false);
        }
        HarnessRuntimeRecovery runtimeRecovery = attachment.runtimeRecovery();
        if (runtimeRecovery != null
                && runtimeRecovery.hasUnknownOutcome()) {
            return fail(claimed, "managed_runtime_recovery_blocked",
                    "A prior tool execution has an unknown outcome; the"
                            + " Session was blocked without replaying it.");
        }
        TurnRecord current;
        boolean recoveredCancellation = false;
        if (runtimeRecovery != null) {
            if (recoveringCancellation
                    ? !runtimeRecovery.isCancellationReady()
                    : !runtimeRecovery.isContinuationReady()) {
                return fail(claimed, "managed_runtime_recovery_incomplete",
                        "A prior tool execution is not ready for safe"
                                + (recoveringCancellation
                                        ? " cancellation."
                                        : " continuation."));
            }
            if (attachment.eventEpoch() == null
                    || attachment.lastEventId() == null) {
                return fail(claimed,
                        "managed_runtime_recovery_watermark_missing",
                        "Hosted Harness recovery did not return an event"
                                + " watermark.");
            }
            recoveredCancellation = "CANCELLING".equals(claimed.status());
            if (!recoveredCancellation && session.harnessBootId() != null
                    && claimed.harnessEventEpoch() != null) {
                store.retractContinuationOutput(session.tenantId(),
                        session.sessionId(), claimed.turnId(), owner,
                        session.harnessBootId(), claimed.harnessEventEpoch());
            }
            if (!store.bindRecoveredHarness(session.tenantId(),
                    session.sessionId(), claimed.turnId(), owner,
                    session.harnessBootId(), attachment.bootId())) {
                return fail(claimed,
                        "hosted_harness_recovery_generation_mismatch",
                        "Hosted Harness recovery generation changed.");
            }
            requireLease(leaseLost);
            current = store.findTurn(claimed.tenantId(),
                    claimed.sessionId(), claimed.turnId()).orElseThrow();
            String previousEventEpoch = current.harnessEventEpoch();
            if (!attachment.eventEpoch().equals(previousEventEpoch)) {
                store.recordRecoveryAdmission(current.tenantId(),
                        current.sessionId(), current.turnId(), owner,
                        previousEventEpoch, attachment.eventEpoch(),
                        attachment.lastEventId());
                requireLease(leaseLost);
                current = store.findTurn(current.tenantId(),
                        current.sessionId(), current.turnId()).orElseThrow();
            }
            if (recoveredCancellation) {
                Admission admission = harness.cancelManagedRuntime(
                        session.tenantId(), session.sessionId(),
                        current.promptId(), runtimeRecovery.getCheckpointId(),
                        runtimeRecovery.getActivationId());
                requireLease(leaseLost);
                if (!attachment.eventEpoch().equals(admission.eventEpoch())) {
                    throw new IllegalStateException(
                            "Hosted Harness recovery epoch changed");
                }
            } else {
                Admission admission = harness.continueManagedRuntime(
                        session.tenantId(), session.sessionId(),
                        current.promptId(), runtimeRecovery.getCheckpointId(),
                        runtimeRecovery.getActivationId());
                requireLease(leaseLost);
                if (!attachment.eventEpoch().equals(admission.eventEpoch())
                        || admission.lastEventId()
                                < attachment.lastEventId()) {
                    throw new IllegalStateException(
                            "Hosted Harness recovery watermark changed");
                }
                store.recordRecoveryAdmission(current.tenantId(),
                        current.sessionId(), current.turnId(), owner,
                        attachment.eventEpoch(), admission.eventEpoch(),
                        admission.lastEventId());
                current = store.findTurn(current.tenantId(),
                        current.sessionId(), current.turnId()).orElseThrow();
            }
        } else {
            boolean bound = store.bindHarness(session.tenantId(),
                    session.sessionId(), claimed.turnId(), owner,
                    attachment.bootId());
            if (!bound && claimed.submissionAttempted()
                    && claimed.harnessEventEpoch() == null
                    && session.harnessBootId() != null
                    && !attachment.bootId().equals(session.harnessBootId())
                    && store.withdrawSubmissionAttempted(claimed.tenantId(),
                            claimed.sessionId(), claimed.turnId(), owner)) {
                // G3: the mark came from a generation that provably never
                // admitted the prompt (the Turn carries no event epoch);
                // withdraw it so the adopted generation may submit. A lost
                // old-generation admission replays idempotently on the
                // journal under the same commandId.
                LOG.info("Withdrew the submission mark of a never-admitted"
                                + " Turn tenant={} session={} turn={}"
                                + " formerGeneration={} adoptedGeneration={}",
                        claimed.tenantId(), claimed.sessionId(),
                        claimed.turnId(), session.harnessBootId(),
                        attachment.bootId());
                submissionAttempted.set(false);
                // Read the row again: a cancel that landed after the claim
                // is invisible in `claimed`, and acting on that stale status
                // would submit a live execution only to cancel it below.
                TurnRecord afterWithdraw = store.findTurn(claimed.tenantId(),
                        claimed.sessionId(), claimed.turnId())
                        .orElse(claimed);
                if ("CANCELLING".equals(afterWithdraw.status())) {
                    // Cancelled before any generation admitted durably:
                    // with the mark withdrawn the Turn is exactly the case
                    // the early gate fast-cancels, so it must not be
                    // re-dispatched into a live execution at the adopted
                    // generation first.
                    store.cancelBeforeAdmission(claimed.tenantId(),
                            claimed.sessionId(), claimed.turnId(), owner);
                    return true;
                }
                bound = store.bindHarness(session.tenantId(),
                        session.sessionId(), claimed.turnId(), owner,
                        attachment.bootId());
            }
            if (!bound) {
                return fail(claimed, "hosted_harness_generation_mismatch",
                        "Hosted Harness generation changed.");
            }
            requireLease(leaseLost);
            current = store.findTurn(claimed.tenantId(),
                    claimed.sessionId(), claimed.turnId()).orElseThrow();
            if (current.harnessEventEpoch() == null) {
                store.markSubmissionAttempted(current.tenantId(),
                        current.sessionId(), current.turnId(), owner);
                submissionAttempted.set(true);
                Admission admission = harness.submit(session.tenantId(),
                        session.sessionId(), current.promptId(),
                        current.input(), current.payloadDigest());
                requireLease(leaseLost);
                store.recordAdmission(current.tenantId(),
                        current.sessionId(), current.turnId(), owner,
                        admission.eventEpoch(), admission.lastEventId());
                current = store.findTurn(current.tenantId(),
                        current.sessionId(), current.turnId()).orElseThrow();
            }
        }
        if ("CANCELLING".equals(current.status())
                && !recoveredCancellation) {
            harness.cancel(session.tenantId(), session.sessionId());
        }
        long lastEventId = current.harnessLastEventId() == null ? 0
                : current.harnessLastEventId();
        try (SourceStream stream = harness.stream(
                session.tenantId(), session.sessionId(), lastEventId,
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
        if (error != null) {
            LOG.warn("Managed Runtime warm failed tenant={} session={} turn={}",
                    session.tenantId(), session.sessionId(), turn.turnId(),
                    error);
        }
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
            if (session.workspace() != null) {
                return;
            }
            Attachment attachment = harness.createOrLoad(
                    session.tenantId(), session.sessionId(),
                    session.harnessBootId() != null);
            if (store.bindHarness(tenantId, sessionId,
                    turnId, owner, attachment.bootId())) {
                harness.cancel(session.tenantId(), session.sessionId());
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

    // Terminal failures leave the Turn row as their only trace; log the
    // underlying exception once so operators (and fault gates) see the
    // actual cause.
    private boolean failTerminally(TurnRecord turn, String code,
            String message, RuntimeException error) {
        LOG.warn("Managed Turn failed terminally tenant={} session={}"
                        + " turn={} code={} message={}",
                turn.tenantId(), turn.sessionId(), turn.turnId(), code,
                message, error);
        return fail(turn, code, message);
    }

    private boolean transientFailure(TurnRecord turn,
            boolean submissionAttempted, RuntimeException error,
            boolean exemptFromPreAdmissionBudget) {
        if (!submissionAttempted
                && !exemptFromPreAdmissionBudget
                && turn.retryCount() >= maxPreAdmissionRetries) {
            LOG.error("Managed Turn coordination exhausted retries tenant={}"
                            + " session={} turn={} failure={}",
                    turn.tenantId(), turn.sessionId(), turn.turnId(),
                    error.getClass().getSimpleName(), error);
            return fail(turn, "hosted_harness_unavailable",
                    "Hosted Harness remained unavailable before Turn"
                            + " admission.");
        }
        long delay = retryDelay(retryInitialDelay, retryMaxDelay,
                turn.retryCount());
        long retryAfter = Math.addExact(clock.millis(), delay);
        store.scheduleTurnRetry(turn.tenantId(), turn.sessionId(),
                turn.turnId(), owner, retryAfter);
        LOG.warn("Managed Turn coordination will retry tenant={} session={}"
                        + " turn={} retry={} delayMs={} failure={}",
                turn.tenantId(), turn.sessionId(), turn.turnId(),
                turn.retryCount() + 1, delay,
                error.getClass().getSimpleName());
        return true;
    }

    static long retryDelay(Duration initialDelay, Duration maxDelay,
            int retryCount) {
        long initial = initialDelay.toMillis();
        long maximum = maxDelay.toMillis();
        int shift = Math.min(retryCount, 62);
        if (initial > (Long.MAX_VALUE >> shift)) {
            return maximum;
        }
        return Math.min(initial << shift, maximum);
    }

    private static String key(String tenantId, String sessionId,
            String turnId) {
        return tenantId + "\n" + sessionId + "\n" + turnId;
    }
}
