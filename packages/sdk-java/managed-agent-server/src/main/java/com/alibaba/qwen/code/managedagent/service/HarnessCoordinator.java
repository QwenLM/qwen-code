package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HarnessSessionRefusedException;
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
    // The one 409 whose wait provably ends on its own: a fenced
    // predecessor's writer lease lapses, so retrying past the budget's
    // pre-admission window is exactly the wait D9a meant. The exemption is
    // keyed on the lease's own wire code, never on a catch-all code:
    // `hosted_turn_recovery_required` covers arbitrary takeover failures
    // including refusals no retry can change, so exempting IT wedged a
    // durable refusal in an unbounded retry (R6-1). Every other body shape
    // meets the budget — including `hosted_session_already_attached`, which
    // looks transient but is not: the daemon drops an attachment only on
    // an explicit detach or delete, and this control plane never detaches.
    // `hosted_prompt_recovery_required` is absent not by oversight: it only
    // arrives after markSubmissionAttempted, where the budget is bypassed
    // anyway, so an entry could never change an outcome.
    private static final Set<String> LEASE_BOUNDED_409_CODES =
            Set.of("managed_session_writer_conflict");
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
    private final Set<String> cancellations = ConcurrentHashMap.newKeySet();
    // See cancelAdmittedTurn: forced cancellation takeover loads are paced
    // per Turn, far below the ~500ms lease-renewal cadence that re-runs
    // the coded-refusal pair (the round-10 hot loop).
    private static final long TAKEOVER_LOAD_MIN_INTERVAL_MS = 5_000;
    private final Map<String, Long> takeoverPace = new ConcurrentHashMap<>();
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
                        } else if (!leaseLost.get()) {
                            executor.execute(() -> cancelAdmittedTurn(
                                    tenantId, sessionId, turnId));
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
            // An approval wait is not a durable verdict: the decision is
            // still deliverable through the attached Session, so the Turn
            // must never die while the Action is requested — the approval
            // timeout bounds the retry like the predecessor's lease does.
            // The daemon itself now answers await_action plain, so this
            // guard only catches a Harness that still declines it.
            if ("await_action".equals(error.getReason())) {
                terminal = transientFailure(claimed,
                        submissionAttempted.get(), error, false);
            } else {
                // The reason is remote-supplied; the terminal write lands
                // in managed_agent_turn.error_message VARCHAR(2048), so bound it
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
            }
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
        } catch (HarnessSessionRefusedException error) {
            // A named load refusal is fail-closed and known, but the Turn
            // still awaits a Harness that can open the Session (a mixed
            // fleet rolls forward), so it retries like any transient
            // failure — with the refusal code recorded when retries run
            // out. Not a writer-lease wait, so the budget still applies.
            terminal = transientFailure(claimed, submissionAttempted.get(),
                    error, false);
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
                // (the code says so) and every other failure meet it — and
                // a codeless body must never take the contains() NPE hostage.
                // A duplicate-admission 409 from the submit call itself is
                // pre-admission too: no new admission happened on this
                // pass, so the mark taken moments ago must not exempt the
                // failure from the budget — without the exemption any
                // Turn stuck behind another Session Turn's unsettled input
                // would re-mark and re-POST the identical refusal forever.
                // The session-level wedge code is pre-admission as well
                // when the Turn provably never recorded an epoch (a
                // continue past admission keeps the budget exempt — and
                // the prompt-scoped naming stays what it was (R11-1).
                String errorCode = error.getErrorCode();
                terminal = transientFailure(claimed,
                        submissionAttempted.get()
                                && !"hosted_prompt_recovery_required"
                                        .equals(errorCode)
                                && !("hosted_turn_recovery_required"
                                                .equals(errorCode)
                                        && claimed.harnessEventEpoch()
                                                == null),
                        error,
                        recoveryPath.get() && errorCode != null
                                && LEASE_BOUNDED_409_CODES.contains(errorCode));
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
        boolean cancelledOnAttach = false;
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
                // Only the epoch moves here, same rule as the plain-attach
                // arms (R10-3): the consumed watermark stays put so a
                // committed-but-undelivered journal tail still replays
                // before this recovery's own commit.
                store.recordRecoveryAdmission(current.tenantId(),
                        current.sessionId(), current.turnId(), owner,
                        previousEventEpoch, previousEventEpoch,
                        attachment.eventEpoch(),
                        current.harnessLastEventId() == null ? 0
                                : current.harnessLastEventId());
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
                        attachment.eventEpoch(), attachment.eventEpoch(),
                        admission.eventEpoch(), admission.lastEventId());
                current = store.findTurn(current.tenantId(),
                        current.sessionId(), current.turnId()).orElseThrow();
            }
        } else if ("CANCELLING".equals(claimed.status())) {
            // A CANCELLING Turn does not submit, so generation bind is not
            // its gate: the plain attach holds the replacement Session, and
            // the cancel itself is the terminal act — the next Turn's
            // takeover adopt moves the generation when anything continues
            // (bindCAS would otherwise fail boot-old != boot-new, failing
            // the Turn as hosted_harness_generation_mismatch while the
            // cancel was never issued, wedging every later prompt and the
            // Session close).
            try {
                harness.cancel(session.tenantId(), session.sessionId());
                requireLease(leaseLost);
            } catch (DaemonHttpException error) {
                // The plain cancel route aborts only a live, in-memory
                // Turn; on a freshly attached Session whose parked Turn its
                // old generation owned (a requested approval died with that
                // owner), a coded 409 is the honest answer and re-issuing
                // the same cancel cannot settle the Turn either. Adopt the
                // attach epoch below and open the stream instead: the
                // replay surfaces the pending Action, whose durable
                // resolution the next redispatch settles as this cancel.
                if (error.getStatusCode() != 409
                        || !"hosted_turn_recovery_required"
                                .equals(error.getErrorCode())) {
                    throw error;
                }
                LOG.info("Hosted Harness cancel lands on no live Turn;"
                                + " streaming the parked Turn instead"
                                + " tenant={} session={} turn={}",
                        claimed.tenantId(), claimed.sessionId(),
                        claimed.turnId());
            }
            // The plain attach minted this generation's own epoch: the
            // SSE that follows must stream THAT epoch, or the daemon
            // rejects the channel on epoch mismatch (R8-1'). Only the epoch
            // moves, though — the consumed watermark must NOT jump to the
            // attach's journal tail, or a committed-but-undelivered tail
            // (including this Turn's own turn.settled) is skipped forever
            // while no action left can produce another terminal event
            // (R10-3).
            current = claimed;
            String priorEpoch = current.harnessEventEpoch();
            if (!attachment.eventEpoch().equals(priorEpoch)) {
                // Turn and Session epochs are expected separately: on a
                // CANCELLING Turn whose own epoch was never recorded the
                // Session may still carry an earlier Turn's, and the CAS
                // must name each as it stands rather than assume equality.
                store.recordRecoveryAdmission(current.tenantId(),
                        current.sessionId(), current.turnId(), owner,
                        priorEpoch, session.harnessEventEpoch(),
                        attachment.eventEpoch(),
                        current.harnessLastEventId() == null ? 0
                                : current.harnessLastEventId());
                requireLease(leaseLost);
                current = store.findTurn(current.tenantId(),
                        current.sessionId(), current.turnId()).orElseThrow();
            }
            cancelledOnAttach = true;
        } else {
            boolean bound;
            if (claimed.submissionAttempted()
                    && claimed.harnessEventEpoch() != null
                    && session.harnessBootId() != null
                    && !attachment.bootId().equals(session.harnessBootId())) {
                // A plain attach after adoption: bindHarness provably
                // refuses this shape because the Turn already posted an
                // epoch, so the generation must move on its own store CAS
                // first — owner, live lease, expected = the row's boot id.
                // Losing that CAS means someone else adopted meanwhile,
                // and no host may keep the Turn through here (R8-1).
                if (!store.bindRecoveredHarness(session.tenantId(),
                        session.sessionId(), claimed.turnId(), owner,
                        session.harnessBootId(), attachment.bootId())) {
                    return fail(claimed,
                            "hosted_harness_recovery_generation_mismatch",
                            "Hosted Harness recovery generation changed.");
                }
                session = store.requireSession(session.tenantId(),
                        session.sessionId());
                // The plain attach minted its own epoch: the stream's
                // epoch must move to this generation as well, or the
                // follow-on SSE is rejected (R8-1').
                current = store.findTurn(claimed.tenantId(),
                        claimed.sessionId(), claimed.turnId()).orElseThrow();
                String priorEpoch = current.harnessEventEpoch();
                if (!attachment.eventEpoch().equals(priorEpoch)) {
                    // Only the epoch moves: the consumed watermark must NOT
                    // jump to the attach's journal tail — anything the
                    // prior generation committed but never delivered
                    // (including this Turn's turn.settled) would be skipped
                    // forever, and nothing left can produce another
                    // terminal event (R10-3).
                    store.recordRecoveryAdmission(current.tenantId(),
                            current.sessionId(), current.turnId(), owner,
                            priorEpoch, priorEpoch, attachment.eventEpoch(),
                            current.harnessLastEventId() == null ? 0
                                    : current.harnessLastEventId());
                    requireLease(leaseLost);
                    current = store.findTurn(current.tenantId(),
                            current.sessionId(), current.turnId())
                            .orElseThrow();
                }
            }
            bound = store.bindHarness(session.tenantId(),
                    session.sessionId(), claimed.turnId(), owner,
                    attachment.bootId());
            if (!bound && claimed.submissionAttempted()
                    && claimed.harnessEventEpoch() == null
                    && session.harnessBootId() != null
                    && !attachment.bootId().equals(session.harnessBootId())
                    && store.withdrawSubmissionAttempted(claimed.tenantId(),
                            claimed.sessionId(), claimed.turnId(), owner)) {
                // G3: the Turn carries no event epoch, so the mark's
                // generation never consumed an admission reply; withdraw
                // it so the adopted generation may submit. A null epoch
                // does not prove non-admission (R10-4): a settled admission
                // from the old generation replays idempotently on the
                // journal under the same commandId, and an admission still
                // unsettled answers the resubmit with a coded 409 the
                // submit block adopts into an epoch migration instead of
                // withdrawing a second time.
                LOG.info("Withdrew the submission mark of a never-replied"
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
                Admission admission = null;
                try {
                    admission = harness.submit(session.tenantId(),
                            session.sessionId(), current.promptId(),
                            current.input(), current.payloadDigest());
                    requireLease(leaseLost);
                } catch (DaemonHttpException error) {
                    // A coded 409 on this prompt proves the mark's lineage:
                    // a prior generation's admission reply was lost, so no
                    // epoch was ever recorded, yet the daemon durably holds
                    // THIS prompt accepted and unsettled — re-POSTing can
                    // never replay it. Adopt the attach's epoch with the
                    // consumed watermark kept, then open the stream: the
                    // replay surfaces the parked Turn (a requested Action
                    // resolves durably, and a later redispatch drives what
                    // it unlocks — R10-4). Without the prior mark this code
                    // names a different Turn's work, so it stays a failure.
                    if (error.getStatusCode() != 409
                            || !"hosted_prompt_recovery_required"
                                    .equals(error.getErrorCode())
                            || !claimed.submissionAttempted()) {
                        throw error;
                    }
                    LOG.info("Hosted Harness already holds the Turn's"
                                    + " prompt tenant={} session={} turn={}"
                                    + " adoptedGeneration={}",
                            current.tenantId(), current.sessionId(),
                            current.turnId(), attachment.bootId());
                    store.recordRecoveryAdmission(current.tenantId(),
                            current.sessionId(), current.turnId(), owner,
                            null, session.harnessEventEpoch(),
                            attachment.eventEpoch(),
                            current.harnessLastEventId() == null ? 0
                                    : current.harnessLastEventId());
                    requireLease(leaseLost);
                    current = store.findTurn(current.tenantId(),
                            current.sessionId(), current.turnId())
                            .orElseThrow();
                }
                if (admission != null) {
                    store.recordAdmission(current.tenantId(),
                            current.sessionId(), current.turnId(), owner,
                            admission.eventEpoch(), admission.lastEventId());
                    current = store.findTurn(current.tenantId(),
                            current.sessionId(), current.turnId())
                            .orElseThrow();
                }
            }
        }
        if ("CANCELLING".equals(current.status())
                && !recoveredCancellation && !cancelledOnAttach) {
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
                if ("message_retracted".equals(source.type())) {
                    // A restarted model attempt retracts the prefix the failed
                    // one published (#13319). Flush the pending batch first:
                    // the retraction range covers deltas this stream already
                    // read but has not recorded yet.
                    flush(turn, stream.eventEpoch(), batch, leaseLost);
                    batchBytes = 0;
                    flushAt = 0;
                    store.retractHarnessTurnOutput(turn.tenantId(),
                            turn.sessionId(), turn.turnId(), owner,
                            stream.eventEpoch(), retractionFromSequence(source),
                            source.id());
                    // The replay's first chunk is the new first visible text:
                    // the transcript it replaces was just blanked.
                    flushFirstVisibleText = true;
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

    // The journal sequence of the retracted message's first delta (#13319).
    // Fail closed on a malformed event: skipping it would keep the orphaned
    // prefix in the public transcript.
    private static long retractionFromSequence(SourceEvent event) {
        Object data = event.data();
        if (data instanceof Map<?, ?> map) {
            Object fromSequence = map.get("fromSequence");
            if (fromSequence instanceof Number number) {
                return number.longValue();
            }
        }
        throw new IllegalStateException(
                "Hosted Harness retraction is missing fromSequence");
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
            // A bound Session's Turn is cancelled like any other once
            // Workspace files are enabled: the Hosted Harness aborts the
            // Turn and settles its Runtime calls through their original
            // identities. Without the opt-in nothing may reach it.
            if (session.workspace() != null
                    && !harness.isWorkspaceFilesAvailable()) {
                return;
            }
            // Reuse the admitted attachment: attaching would recheck grants
            // needed for new work and could replace the running attachment.
            if (session.harnessBootId() != null && store.bindHarness(tenantId,
                    sessionId, turnId, owner, session.harnessBootId())) {
                // Renewal requeues this poller while the Turn is still
                // settling, so only one concurrent poller may send the
                // cancel; a failed send releases the claim so the next
                // renewal retries it.
                String cancelKey = key(tenantId, sessionId, turnId) + "\n"
                        + turn.harnessEventEpoch();
                if (cancellations.add(cancelKey)) {
                    try {
                        harness.cancel(session.tenantId(),
                                session.sessionId());
                    } catch (DaemonHttpException error) {
                        if (error.getStatusCode() != 409
                                || !"hosted_turn_recovery_required"
                                        .equals(error.getErrorCode())) {
                            throw error;
                        }
                        // The coded refusal is a failed plain send: release
                        // the claim here and let the paced takeover below,
                        // not the claim, gate re-sends of this path.
                        cancellations.remove(cancelKey);
                        // The plain cancel route aborts only a live, in-memory
                        // Turn: a parked Turn its dead generation owned answers
                        // the coded refusal, and re-issuing that same cancel
                        // settles nothing (the round-9 wedge). The cancellation
                        // takeover load is the only route that pays it, so it
                        // goes out inline over THIS attachment — the stream the
                        // coordination already runs then lands the settle. A
                        // load the daemon can only answer with a plain attach
                        // pays nothing at that moment, and this method runs
                        // once per lease-renewal tick (~500ms): pace the load
                        // per Turn or every wedged wait costs ~4 requests/s of
                        // daemon work against the same Session (the round-10
                        // hot loop).
                        String paceKey = tenantId + '/' + sessionId + '/'
                                + turnId;
                        long now = clock.millis();
                        Long lastAttempt = takeoverPace.get(paceKey);
                        if (lastAttempt != null
                                && now - lastAttempt
                                        < TAKEOVER_LOAD_MIN_INTERVAL_MS) {
                            return;
                        }
                        takeoverPace.put(paceKey, now);
                        Attachment takeover =
                                harness.recoverManagedCancellation(
                                        tenantId, sessionId);
                        HarnessRuntimeRecovery recovery =
                                takeover.runtimeRecovery();
                        if (recovery != null) {
                            if (!recovery.isCancellationReady()) {
                                throw new IllegalStateException("Hosted Harness"
                                        + " reported a cancellation recovery"
                                        + " that is not ready");
                            }
                            harness.cancelManagedRuntime(tenantId,
                                    sessionId, turn.promptId(),
                                    recovery.getCheckpointId(),
                                    recovery.getActivationId());
                        }
                    } catch (RuntimeException error) {
                        cancellations.remove(cancelKey);
                        throw error;
                    }
                }
            }
        } catch (RuntimeException error) {
            LOG.warn("Managed Turn cancellation awaits lease renewal tenant={}"
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
                    failureLabel(error), error);
            if (error instanceof HarnessSessionRefusedException refusal) {
                return fail(turn, refusal.getCode(),
                        "Hosted Harness refused to open the Session before"
                                + " Turn admission.");
            }
            if (error instanceof DaemonHttpException http
                    && ("hosted_prompt_recovery_required"
                                    .equals(http.getErrorCode())
                            || ("hosted_turn_recovery_required"
                                            .equals(http.getErrorCode())
                                    && turn.submissionAttempted()))) {
                // The coded refusal is a named, fail-closed verdict from
                // the daemon — this prompt's duplicate, or the Session's
                // unsettled wedge against a Turn already claiming a
                // submission — so record its own code like the named load
                // refusal above. Without that mark the same code arrives
                // from the open-LOAD path, whose reviewed exhaustion
                // answer is the generic unavailable.
                return fail(turn, http.getErrorCode().length() > 128
                        ? http.getErrorCode().substring(0, 128)
                        : http.getErrorCode(),
                        "Hosted Harness refused the Turn before Turn"
                                + " admission.");
            }
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
                turn.retryCount() + 1, delay, failureLabel(error));
        return true;
    }

    private static String failureLabel(RuntimeException error) {
        return error instanceof HarnessSessionRefusedException refusal
                ? refusal.getCode()
                : error.getClass().getSimpleName();
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
