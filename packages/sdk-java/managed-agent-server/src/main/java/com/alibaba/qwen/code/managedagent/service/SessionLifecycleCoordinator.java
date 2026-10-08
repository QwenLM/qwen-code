package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.CwdChangeOutcome;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import java.time.Clock;
import java.time.Duration;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Delivers admitted close, delete and cwd-change operations. An
 * operation admitted on an active Session closes it in the Hosted
 * Harness and waits until no Harness holds the Session's journal
 * writer; a close or delete then drains the Session's Runtime
 * binding and completes. A failed attempt is retried with the
 * dispatch backoff; once the retry budget is spent the operation
 * reaches a terminal failure that keeps the failure code and leaves
 * the Session in its pending status, rather than retrying forever
 * or certifying a settle that never happened. The budget counts
 * only attempts that could have made progress; two conditions keep
 * waiting instead, and their attempts stay budget-exempt: a live
 * journal writer while the failure is still retryable (the close
 * can still succeed once the writer stops; past the budget the
 * wait is published as recovery_blocked with the
 * session_close_writer_live code), and a generation error from
 * Java's stale view of a restarted Harness (the close can still
 * succeed once this replica refreshes; past the budget that wait
 * is published as recovery_blocked with the
 * hosted_harness_generation_mismatch code). A cwd change is settled
 * without Harness or worker involvement — a read-only mount probe
 * and one revision-CAS commit. A structural probe refusal or a
 * moved fact is a terminal failure that is never retried; a
 * momentary probe failure retries through the same dispatch
 * backoff, bounded at {@link #CWD_CHANGE_ATTEMPT_BUDGET} attempts —
 * a fault that outlives the budget settles with the typed terminal
 * failure instead of wedging the Session behind the admission
 * barriers forever, and a refusal that exhausts it leaves the
 * Session unchanged and executable.
 */
@Component
public class SessionLifecycleCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(
            SessionLifecycleCoordinator.class);
    private static final int SCAN_LIMIT = 50;
    // A transient cwd-probe refusal re-arms through the capped dispatch
    // backoff, but only this many times: a fault lasting past the budget
    // (a retired NFS/FUSE export, a re-pointed mount) is permanent for the
    // caller, and only database surgery could free a Session the scan kept
    // re-arming. Greater than one by contract — the first retry's success
    // is the documented transient case.
    private static final int CWD_CHANGE_ATTEMPT_BUDGET = 8;
    private final AgentStateStore store;
    private com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore lifecycle;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setWorkspaceLifecycleStore(com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore lifecycle) {
        this.lifecycle = lifecycle;
    }

    public boolean supportsWorkspaceLifecycle() {
        return runtimeWarmer.supportsWorkspaceClose() && harness.supportsLifecycle();
    }

    private final ManagedSessionStore sessionStore;
    private final HarnessConnector harness;
    private final RuntimeWarmer runtimeWarmer;
    private final ExecutorService executor;
    private final Clock clock;
    private final Duration leaseDuration;
    private final Duration retryInitialDelay;
    private final Duration retryMaxDelay;
    private final int maxOperationRetries;
    private final String owner = UUID.randomUUID().toString();
    private final java.util.concurrent.ScheduledExecutorService renewals =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor(task -> {
                Thread thread = new Thread(task, "session-lifecycle-renewal");
                thread.setDaemon(true);
                return thread;
            });

    @jakarta.annotation.PreDestroy
    void stopRenewals() {
        renewals.shutdownNow();
    }

    private final Set<String> active = ConcurrentHashMap.newKeySet();

    public SessionLifecycleCoordinator(AgentStateStore store,
            ManagedSessionStore sessionStore, HarnessConnector harness,
            RuntimeWarmer runtimeWarmer, ExecutorService executor,
            Clock clock, ManagedAgentProperties properties) {
        this.store = store;
        this.sessionStore = sessionStore;
        this.harness = harness;
        this.runtimeWarmer = runtimeWarmer;
        this.executor = executor;
        this.clock = clock;
        this.leaseDuration = properties.getDispatch().getLeaseDuration();
        this.retryInitialDelay = properties.getDispatch()
                .getRetryInitialDelay();
        this.retryMaxDelay = properties.getDispatch().getRetryMaxDelay();
        this.maxOperationRetries = properties.getDispatch()
                .getMaxOperationRetries();
    }

    public void dispatch(String tenantId, String sessionId,
            String operationId) {
        String key = tenantId + "\n" + sessionId + "\n" + operationId;
        if (!active.add(key)) {
            return;
        }
        executor.execute(() -> {
            try {
                deliver(tenantId, sessionId, operationId);
            } finally {
                active.remove(key);
            }
        });
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void recoverOperations() {
        for (OperationTarget target : store.findDeliverableOperations(
                clock.millis(), SCAN_LIMIT)) {
            dispatch(target.tenantId(), target.sessionId(),
                    target.operationId());
        }
    }

    private void deliver(String tenantId, String sessionId,
            String operationId) {
        OperationRecord claimed = store.claimOperation(tenantId, sessionId,
                operationId, owner, leaseDuration).orElse(null);
        if (claimed == null) {
            return;
        }
        var valid = new java.util.concurrent.atomic.AtomicBoolean(true);
        long period = Math.max(1, leaseDuration.toMillis() / 3);
        var renewal = renewals.scheduleWithFixedDelay(() -> {
            try {
                if (!store.renewLifecycleOperation(tenantId, sessionId, operationId, owner,
                        claimed.claimGeneration(), leaseDuration)) {
                    valid.set(false);
                }
            } catch (RuntimeException error) {
                valid.set(false);
            }
        }, period, period, java.util.concurrent.TimeUnit.MILLISECONDS);
        Boolean harnessConfirmed = null;
        try {
            if (claimed.kind() == OperationKind.CWD_CHANGE) {
                settleCwdChange(claimed);
                return;
            }
            harnessConfirmed = settle(claimed);
            if (!valid.get()) {
                return;
            }
            if (!store.completeOperation(tenantId, sessionId, operationId,
                    owner, claimed.claimGeneration(), harnessConfirmed)) {
                LOG.warn("Managed Session operation was claimed by another"
                                + " worker tenant={} session={} operation={}",
                        tenantId, sessionId, operationId);
            }
        } catch (RuntimeException error) {
            // A capability digest mismatch lands here too: nothing may be
            // completed honestly (completing unconfirmed would flip the
            // session while skipping the drain and record a clean row),
            // and the mismatch is permanent, so its attempts consume the
            // budget and the terminal record keeps the mismatch code.
            long delay = HarnessCoordinator.retryDelay(retryInitialDelay,
                    retryMaxDelay, claimed.attemptCount());
            Throwable cause = error;
            while (cause.getCause() != null && cause instanceof java.util.concurrent.CompletionException) {
                cause = cause.getCause();
            }
            // A blocked close waits on a fact only an operator or the
            // original worker can change; it keeps its failure code through
            // every attempt and through the terminal record.
            String blocked = null;
            String failureCode = "session_lifecycle_delivery_failed";
            if (cause instanceof HostedHarnessCapabilityMismatchException mismatch) {
                failureCode = mismatch.getCode();
            } else if (cause instanceof DaemonProtocolException) {
                failureCode = "hosted_harness_protocol_error";
            } else if (cause instanceof com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException brokerError) {
                failureCode = brokerError.getCode();
                if ("workspace_close_execution_unsettled".equals(brokerError.getCode())) {
                    blocked = brokerError.getCode();
                } else if ("workspace_close_identity_unverified".equals(brokerError.getCode())
                        || "runtime_broker_recovery_blocked".equals(brokerError.getCode())) {
                    blocked = "workspace_close_identity_unverified";
                }
            }
            if (cause instanceof com.alibaba.qwen.code.managedagent.api.ApiException apiError
                    && (apiError.getCode().startsWith("workspace_lifecycle") || apiError.getCode().startsWith("workspace_close"))) {
                blocked = apiError.getCode();
            }
            if ((cause instanceof com.alibaba.qwen.code.daemon.DaemonHttpException
                    || cause instanceof com.alibaba.qwen.code.daemon.MutationOutcomeUnknownException)
                    && operationIsLifecycle(claimed)) {
                blocked = "workspace_lifecycle_hooks_unsettled";
            }
            if (blocked != null) {
                failureCode = blocked;
            }
            // Two settle outcomes wait on a condition the retry itself or
            // an operator can still change, so the budget must not
            // terminate them and their attempts must not consume it: a live
            // journal writer while the failure is still retryable (the
            // close can still succeed once the writer stops — a permanent
            // refusal thrown before the Harness was asked to stop would
            // otherwise wait on its own writer lease forever), and a
            // generation error from Java's stale view of a restarted
            // Harness — the connector adopts the new generation on that
            // signal (G3), so the next attempt renegotiates and the close
            // can still succeed; only a Harness that restarts between every
            // attempt keeps the wait alive. Both reschedule through the
            // budget-exempt baseline, and past the budget both are
            // published as recovery_blocked with their own code: an
            // unbounded wait has to stay visible, because neither row is
            // otherwise distinguishable from a healthy pending retry.
            // A cwd change never reaches settle(): the close-specific
            // waits (live writer, stale boot) and the terminal budget arm
            // are not its semantics — its rethrown probe refusal takes the
            // plain reschedule below, bounded by CWD_CHANGE_ATTEMPT_BUDGET
            // inside settleCwdChange.
            boolean cwdChange = claimed.kind() == OperationKind.CWD_CHANGE;
            boolean writerLive = !cwdChange && retryable(cause)
                    && writerStillLive(claimed);
            boolean staleBoot =
                    cause instanceof HostedHarnessGenerationException;
            // The budget bounds every settle outcome that could have made
            // progress, blocked or not, and the terminal record keeps the
            // cause instead of certifying a completion that never settled.
            // A failure thrown AFTER settle() returned also keeps waiting:
            // the settle did happen then, and a terminal
            // session_lifecycle_delivery_failed would certify the opposite;
            // the completion write is simply retried (settle is idempotent).
            if (!cwdChange && harnessConfirmed == null
                    && claimed.attemptCount() - claimed.budgetExemptAttempt()
                            >= maxOperationRetries
                    && valid.get() && !writerLive && !staleBoot) {
                LOG.error("Managed Session operation exhausted retries"
                                + " tenant={} session={} operation={}"
                                + " attempts={}",
                        tenantId, sessionId, operationId,
                        claimed.attemptCount(), error);
                // The Runtime binding is still released best-effort, along
                // settle()'s routing: a session whose operation is terminal
                // must not stay warmable. A bound Session this replica
                // cannot verify releases nothing — closing its workspace
                // without the original worker's stop verified is what the
                // blocked code exists to refuse — and a delete of an
                // already closed Session makes zero calls, as settle() does.
                try {
                    boolean bound = store.requireSession(tenantId, sessionId)
                            .workspace() != null;
                    if (bound && closedSessionDeletion(claimed)) {
                        // The completed CLOSE is the cleanup authority.
                    } else if (bound) {
                        if (runtimeWarmer.supportsWorkspaceClose()) {
                            if (claimed.lifecycleProtocolVersion() != 1) {
                                runtimeWarmer.requestWorkspaceClose(tenantId,
                                        sessionId);
                            }
                            // A v1 operation never takes the v0 drain route:
                            // requestHarnessDrain would flip the fence row to
                            // DRAINING without the lifecycle store's claim
                            // checks, and failOperation's terminal write is
                            // what releases that mirror below.
                            runtimeWarmer.closeWorkspace(tenantId, sessionId)
                                    .toCompletableFuture().join();
                        }
                    } else {
                        runtimeWarmer.drain(sessionId).toCompletableFuture()
                                .join();
                    }
                } catch (RuntimeException drainError) {
                    LOG.warn("Managed Session operation drain failed"
                                    + " tenant={} session={} operation={}"
                                    + " failure={}",
                            tenantId, sessionId, operationId,
                            drainError.getMessage());
                }
                try {
                    if (!store.failOperation(tenantId, sessionId,
                            operationId, owner, claimed.claimGeneration(),
                            failureCode)) {
                        LOG.warn("Managed Session operation was claimed by"
                                        + " another worker tenant={}"
                                        + " session={} operation={}",
                                tenantId, sessionId, operationId);
                    }
                } catch (RuntimeException writeError) {
                    // The terminal record itself failed: reschedule rather
                    // than leave the operation wedged on a spent lease. A
                    // blocked code keeps the BLOCKED reschedule — the
                    // recovery scan re-drives every blocked lifecycle shape;
                    // every other shape goes back to PENDING, which is
                    // always re-driven.
                    LOG.warn("Managed Session operation terminal record"
                                    + " failed; rescheduling tenant={}"
                                    + " session={} operation={} failure={}",
                            tenantId, sessionId, operationId,
                            writeError.getMessage());
                    if (valid.get()) {
                        if (blocked != null) {
                            store.blockLifecycleOperation(tenantId, sessionId,
                                    operationId, owner,
                                    claimed.claimGeneration(), blocked,
                                    Math.addExact(clock.millis(), delay));
                        } else {
                            store.retryOperation(tenantId, sessionId,
                                    operationId, owner,
                                    claimed.claimGeneration(),
                                    Math.addExact(clock.millis(), delay));
                        }
                    }
                }
                return;
            }
            if (valid.get() && blocked != null) {
                store.blockLifecycleOperation(tenantId, sessionId, operationId, owner,
                        claimed.claimGeneration(), blocked, Math.addExact(clock.millis(), delay),
                        writerLive || staleBoot);
            } else if (valid.get() && writerLive && !staleBoot
                    && claimed.attemptCount() >= maxOperationRetries) {
                // Past the budget the writer wait is published: the row reads
                // recovery_blocked with its code rather than a healthy
                // pending retry, and the recovery scan still re-drives it —
                // the wait itself stays unbounded. A generation error wins
                // the overlap: the live writer it surfaces beside is the old
                // boot's unexpired lease, which the close does not wait on
                // once this replica adopts the new generation, so the code
                // names the wait that actually bounds the close (review
                // R1-30).
                store.blockLifecycleOperation(tenantId, sessionId,
                        operationId, owner, claimed.claimGeneration(),
                        "session_close_writer_live",
                        Math.addExact(clock.millis(), delay), true);
            } else if (valid.get() && !cwdChange && staleBoot
                    && claimed.attemptCount() >= maxOperationRetries) {
                // The stale-view wait outlasts the budget only while the
                // Harness keeps restarting between attempts — each
                // generation error makes the connector adopt the live
                // generation, so a single restart costs one attempt — so
                // past the budget it is published the same way rather than
                // reading as a healthy pending retry. The recovery scan
                // still re-drives it, so the wait itself stays unbounded.
                store.blockLifecycleOperation(tenantId, sessionId,
                        operationId, owner, claimed.claimGeneration(),
                        "hosted_harness_generation_mismatch",
                        Math.addExact(clock.millis(), delay), true);
            } else if (valid.get() && (writerLive || staleBoot)) {
                store.retryOperation(tenantId, sessionId, operationId, owner,
                        claimed.claimGeneration(),
                        Math.addExact(clock.millis(), delay), true);
            } else if (valid.get()) {
                store.retryOperation(tenantId, sessionId, operationId, owner,
                        claimed.claimGeneration(), Math.addExact(clock.millis(), delay));
            }
            LOG.warn("Managed Session operation will retry tenant={}"
                            + " session={} operation={} retry={} delayMs={}"
                            + " failure={} {}",
                    tenantId, sessionId, operationId,
                    claimed.attemptCount() + 1, delay,
                    error.getClass().getSimpleName(), error.getMessage(),
                    error);
        } finally {
            renewal.cancel(false);
        }
    }

    // A permanent refusal is a verdict a writer stop cannot change, so it
    // never keys the writer wait: a non-retryable broker conflict, and the
    // daemon's own negotiation refusals — a capability digest mismatch and a
    // protocol error recur on every attempt until an operator realigns the
    // versions, and both are thrown before the Harness is asked to stop.
    // The two whitelisted codes are the whole writer-wait family:
    // workspace_lifecycle_writer_active is settle()'s own writer check, and
    // managed_session_writer_active is the retention retirement a delete of
    // a closed Session runs inside completeOperation; each is raised under
    // exactly the predicate hasLiveWriter reads, and writerLive stays gated
    // on a fresh writerStillLive(claimed) check regardless.
    private static boolean retryable(Throwable cause) {
        if (cause instanceof com.alibaba.qwen.code.managedagent.api.ApiException apiError
                && apiError.getStatus().is4xxClientError()) {
            return "workspace_lifecycle_writer_active".equals(apiError.getCode())
                    || "managed_session_writer_active".equals(apiError.getCode());
        }
        if (cause instanceof HostedHarnessCapabilityMismatchException
                || cause instanceof DaemonProtocolException) {
            return false;
        }
        return !(cause instanceof RuntimeBrokerException brokerError)
                || brokerError.isRetryable();
    }

    // A live journal writer blocks every delivered shape — settle()'s writer
    // check on an ACTIVE Session, and the retention retirement a delete of a
    // closed Session runs inside completeOperation — and in both cases the
    // operation can still succeed once that writer stops, so the budget never
    // terminates it. The gate keys on the writer itself, not on the status
    // the operation was admitted on. A check that itself fails is treated as
    // live rather than recorded as a failure.
    private boolean writerStillLive(OperationRecord operation) {
        try {
            return sessionStore.hasLiveWriter(operation.tenantId(),
                    operation.sessionId());
        } catch (RuntimeException error) {
            LOG.warn("Managed Session operation could not check the journal"
                            + " writer tenant={} session={} operation={}"
                            + " failure={}",
                    operation.tenantId(), operation.sessionId(),
                    operation.operationId(), error.getMessage());
            return true;
        }
    }

    // A delete of an already closed or archived bound Session makes zero
    // Runtime calls: the completed CLOSE is the cleanup authority, so the
    // settlement stays independent of revoked mounts. Both settle() and the
    // terminal arm honour this shape.
    private boolean closedSessionDeletion(OperationRecord operation) {
        return operation.kind() == OperationKind.DELETE
                && ("CLOSED".equals(operation.sessionStatusBefore())
                        || "ARCHIVED".equals(operation.sessionStatusBefore()));
    }

    private static boolean operationIsLifecycle(OperationRecord operation) {
        return operation.lifecycleProtocolVersion() == 1;
    }

    // A cwd change settles without Harness or worker involvement: the probe
    // is read-only, and the commit transaction re-checks every fact it
    // depends on, so a reclaim can rerun this branch idempotently.
    private void settleCwdChange(OperationRecord operation) {
        String tenantId = operation.tenantId();
        String sessionId = operation.sessionId();
        String operationId = operation.operationId();
        var session = store.requireSession(tenantId, sessionId);
        try {
            if (session.workspace() == null) {
                throw WorkspaceExecutionStore.unavailable();
            }
            runtimeWarmer.verifyWorkspaceCwdTarget(session.workspace(),
                    operation.targetCwdRelative());
        } catch (RuntimeBrokerException error) {
            // A transient probe failure is not the verdict the terminal
            // refusal promises: hand it to the delivery machine's retry
            // (capped in delay, bounded in count) instead of writing a
            // permanent failure — until the budget runs out, at which point
            // the typed terminal failure is exactly its verdict.
            if (error.isRetryable()) {
                if (operation.attemptCount() + 1
                        >= CWD_CHANGE_ATTEMPT_BUDGET) {
                    if (store.failCwdChangeOperation(tenantId, sessionId,
                            operationId, owner, operation.claimGeneration(),
                            error.getCode())) {
                        LOG.info("Managed Session cwd change failed after"
                                        + " the probe budget tenant={}"
                                        + " session={} operation={} code={}",
                                tenantId, sessionId, operationId,
                                error.getCode(), error);
                    }
                    return;
                }
                LOG.info("Managed Session cwd change probe deferred"
                                + " tenant={} session={} operation={}"
                                + " code={} {}", tenantId, sessionId,
                        operationId, error.getCode(),
                        error.getMessage(), error);
                throw error;
            }
            if (store.failCwdChangeOperation(tenantId, sessionId, operationId,
                    owner, operation.claimGeneration(), error.getCode())) {
                LOG.info("Managed Session cwd change refused tenant={}"
                                + " session={} operation={} code={}"
                                + " failure={} {}", tenantId, sessionId,
                        operationId, error.getCode(),
                        error.getClass().getSimpleName(), error.getMessage());
            } else {
                LOG.warn("Managed Session cwd change refusal lost its lease"
                                + " tenant={} session={} operation={} code={}",
                        tenantId, sessionId, operationId, error.getCode());
            }
            return;
        }
        CwdChangeOutcome outcome = store.completeCwdChangeOperation(
                tenantId, sessionId, operationId, owner,
                operation.claimGeneration());
        if (outcome == null) {
            LOG.warn("Managed Session operation was claimed by another"
                            + " worker tenant={} session={} operation={}",
                    tenantId, sessionId, operationId);
        } else if (!outcome.completed()) {
            LOG.info("Managed Session cwd change failed tenant={}"
                            + " session={} operation={} failure={}",
                    tenantId, sessionId, operationId, outcome.failureCode());
        }
    }

    // Returns whether the Harness that held the Session acknowledged closing
    // it. A Harness that never held it, or that replaced the one that did,
    // answers too, but its answer confirms nothing about the Session.
    private boolean settle(OperationRecord operation) {
        boolean harnessConfirmed = false;
        boolean bound = store.requireSession(operation.tenantId(), operation.sessionId()).workspace() != null;
        if (bound && closedSessionDeletion(operation)) {
            return false;
        }
        if (bound && operation.lifecycleProtocolVersion() == 1) {
            if (lifecycle == null || !runtimeWarmer.supportsWorkspaceClose()) {
                throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_close_identity_unverified");
            }
            if (lifecycle.recoverEffects(operation) == null) {
                if (!harness.supportsLifecycle()) {
                    throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_lifecycle_protocol_unavailable");
                }
                lifecycle.saveEffects(operation, harness.settleLifecycle(operation));
            }
            harness.detachLifecycle(operation);
            if (sessionStore.hasLiveWriter(operation.tenantId(), operation.sessionId())) {
                throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_lifecycle_writer_active");
            }
            runtimeWarmer.closeWorkspace(operation.tenantId(), operation.sessionId()).toCompletableFuture().join();
            return true;
        }
        if (bound) {
            if (!runtimeWarmer.supportsWorkspaceClose()) {
                throw new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(409,
                        "workspace_close_identity_unverified", "This instance cannot verify the original worker stop", false);
            }
            runtimeWarmer.requestWorkspaceClose(operation.tenantId(), operation.sessionId());
        }
        if ("ACTIVE".equals(operation.sessionStatusBefore())) {
            String holder = store.requireSession(operation.tenantId(),
                    operation.sessionId()).harnessBootId();
            if (harness.isAvailable()) {
                String answered = harness.closeSession(operation.tenantId(),
                        operation.sessionId());
                harnessConfirmed = holder != null && holder.equals(answered);
            } else if (holder != null && !bound) {
                throw new IllegalStateException(
                        "The Hosted Harness is required to close the Session");
            }
            // Only the Harness that holds the Session releases its writer;
            // another server's Harness answers without holding it, and a
            // restarted one leaves the old lease to expire.
            if (sessionStore.hasLiveWriter(operation.tenantId(),
                    operation.sessionId())) {
                throw new IllegalStateException(
                        "A Harness still holds the Session's journal writer");
            }
        }
        if (bound) {
            runtimeWarmer.closeWorkspace(operation.tenantId(), operation.sessionId()).toCompletableFuture().join();
        } else {
            runtimeWarmer.drain(operation.sessionId()).toCompletableFuture().join();
        }
        return harnessConfirmed;
    }
}
