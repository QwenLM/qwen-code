package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.CwdChangeOutcome;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;

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
    // A settle that reached the Harness — the answered close, or the durable
    // effects receipt — is never recorded as one that did not, so the steps
    // that remain (the completion write, the workspace close) cannot join
    // the settle's own terminal arm. They still cannot wait forever: a
    // fault that outlives this larger multiple of the operation budget is
    // permanent for the caller, and the operation then terminates with
    // session_close_completion_unsettled, which says exactly what stayed
    // unsettled, instead of wedging the Session behind the open-operation
    // barrier forever (review round 9, R9-4).
    private static final int SETTLED_COMPLETION_BUDGET_FACTOR = 4;
    private final AgentStateStore store;
    private com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore lifecycle;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setWorkspaceLifecycleStore(com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore lifecycle) {
        this.lifecycle = lifecycle;
    }

    public boolean supportsWorkspaceLifecycle() {
        return supportsWorkspaceLifecycle("hosted-workspace-files/1");
    }

    public boolean supportsWorkspaceLifecycle(String profile) {
        return runtimeWarmer.supportsWorkspaceClose() && harness.supportsLifecycle(profile);
    }

    public boolean supportsWorkspaceLifecycle(SessionRecord session) {
        return session.workspace() != null && RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())
                && harness.supportsLifecycle(session.toolProfile());
    }

    private final ManagedSessionStore sessionStore;
    private final HarnessConnector harness;
    private final RuntimeWarmer runtimeWarmer;
    private final ChildResultRelayStore childScopes;
    private final ObjectMapper objectMapper;
    private final ChildLifecycleAdmissions childCloses;
    private final ManagedAgentService sessions;
    private final com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore childWorkspaces;
    private final ObjectProvider<RuntimeBrokerService> brokerProviders;
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
    static final Set<String> SETTLED_SESSION_STATES =
            Set.of("CLOSED", "ARCHIVED", "DELETED");

    public SessionLifecycleCoordinator(AgentStateStore store,
            ManagedSessionStore sessionStore, HarnessConnector harness,
            RuntimeWarmer runtimeWarmer, ChildResultRelayStore childScopes,
            ObjectMapper objectMapper,
            ChildLifecycleAdmissions childCloses,
            ManagedAgentService sessions,
            ObjectProvider<RuntimeBrokerService> brokerProviders,
            ExecutorService executor,
            Clock clock, ManagedAgentProperties properties) {
        this(store, sessionStore, harness, runtimeWarmer, childScopes,
                objectMapper, childCloses, sessions, brokerProviders,
                executor, clock, properties, null);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public SessionLifecycleCoordinator(AgentStateStore store,
            ManagedSessionStore sessionStore, HarnessConnector harness,
            RuntimeWarmer runtimeWarmer, ChildResultRelayStore childScopes,
            ObjectMapper objectMapper,
            ChildLifecycleAdmissions childCloses,
            ManagedAgentService sessions,
            ObjectProvider<RuntimeBrokerService> brokerProviders,
            ExecutorService executor,
            Clock clock, ManagedAgentProperties properties,
            com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore childWorkspaces) {
        this.childWorkspaces = childWorkspaces;
        this.store = store;
        this.sessionStore = sessionStore;
        this.harness = harness;
        this.runtimeWarmer = runtimeWarmer;
        this.childScopes = childScopes;
        this.objectMapper = objectMapper;
        this.childCloses = childCloses;
        this.sessions = sessions;
        this.brokerProviders = brokerProviders;
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
        // settle() reports its irreversible Harness-facing step out of band:
        // a settle that asked the Harness to stop but threw later must not
        // be recorded as one that never happened (review round 7, R7-2).
        var harnessSettled =
                new java.util.concurrent.atomic.AtomicBoolean(false);
        try {
            if (claimed.kind() == OperationKind.CWD_CHANGE) {
                settleCwdChange(claimed);
                return;
            }
            harnessConfirmed = settle(claimed, harnessSettled);
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
                if (brokerError.getCode().startsWith("workspace_lifecycle")
                        || "runtime_admission_closed".equals(brokerError.getCode())
                        || "workspace_close_execution_unsettled".equals(brokerError.getCode())) {
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
                blocked = cause instanceof com.alibaba.qwen.code.daemon.DaemonHttpException httpError
                        && httpError.getErrorCode() != null
                        && (httpError.getErrorCode().startsWith("workspace_lifecycle") || httpError.getErrorCode().startsWith("workspace_close")
                                || "runtime_admission_closed".equals(httpError.getErrorCode()))
                        ? httpError.getErrorCode() : "workspace_lifecycle_hooks_unsettled";
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
            // The writer is consulted on the fact, not behind the failure's
            // retryability: a permanent refusal thrown before the Harness
            // was asked to stop leaves the writer live, and the terminal arm
            // below must not release the Runtime binding under it even
            // though such a refusal is never a writer wait (review round 7,
            // R7-3). Only the exemption accounting keeps the conjunction.
            boolean writerLive = !cwdChange && writerStillLive(claimed);
            boolean exemptWait = writerLive && retryable(cause);
            boolean staleBoot =
                    cause instanceof HostedHarnessGenerationException;
            // The budget bounds every settle outcome that could have made
            // progress, blocked or not, and the terminal record keeps the
            // cause instead of certifying a completion that never settled.
            // A settle that DID reach the Harness — the answered close or
            // the durable effects receipt — is never recorded as one that
            // did not: the steps that remain get the larger settled budget,
            // and past it the terminal record carries
            // session_close_completion_unsettled, which says exactly what
            // stayed unsettled, instead of certifying the opposite or
            // retrying forever behind the open-operation barrier (review
            // round 7, R7-2; round 9, R9-4).
            boolean settleReachedHarness = harnessSettled.get();
            long adjustedAttempts =
                    claimed.attemptCount() - claimed.budgetExemptAttempt();
            boolean budgetSpent = settleReachedHarness
                    ? adjustedAttempts >= (long) maxOperationRetries
                            * SETTLED_COMPLETION_BUDGET_FACTOR
                    : adjustedAttempts >= maxOperationRetries;
            if (!cwdChange && budgetSpent && valid.get() && !exemptWait
                    && !staleBoot) {
                String terminalCode = settleReachedHarness
                        ? "session_close_completion_unsettled" : failureCode;
                if (writerLive) {
                    // Nothing is terminated and nothing is released under a
                    // live journal writer: the terminal record would stand
                    // while the release it owes never ran, stranded behind a
                    // row nothing re-drives (review round 9, R7-3). Publish
                    // the wait instead — budget-exempt, re-driven by the
                    // recovery scan, readable as recovery_blocked with the
                    // refusal's own code; once the writer stops the terminal
                    // arm fires for real.
                    LOG.warn("Managed Session operation waits on a live"
                                    + " journal writer tenant={} session={}"
                                    + " operation={} code={}",
                            tenantId, sessionId, operationId, failureCode);
                    store.blockLifecycleOperation(tenantId, sessionId,
                            operationId, owner, claimed.claimGeneration(),
                            failureCode,
                            Math.addExact(clock.millis(), delay), true);
                    return;
                }
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
                // A live journal writer never reaches here: the published
                // wait above already returned (review round 9, R7-3).
                try {
                    var session = store.requireSession(tenantId, sessionId);
                    boolean bound = session.workspace() != null;
                    if (bound && closedSessionDeletion(claimed)) {
                        // The completed CLOSE is the cleanup authority.
                    } else if (bound) {
                        if (RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())) {
                            if (!operationIsLifecycle(claimed)) {
                                runtimeWarmer.requestWorkspaceClose(tenantId,
                                        sessionId);
                            }
                            // A v1 operation never takes the v0 drain route:
                            // requestHarnessDrain would flip the fence row to
                            // DRAINING without the lifecycle store's claim
                            // checks. The close below proceeds only when the
                            // settle path already flipped the fence to
                            // DRAINING — a fence still LIFECYCLE_ONLY refuses
                            // it, and failOperation's terminal write below
                            // clears the dead operation's claim on the mirror
                            // without minting that authorization (R5-5).
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
                            terminalCode)) {
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
                        exemptWait || staleBoot);
            } else if (valid.get() && exemptWait && !staleBoot
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
            } else if (valid.get() && (exemptWait || staleBoot)) {
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
        return com.alibaba.qwen.code.managedagent.store.WorkspaceToolProfiles.lifecycleProtocol(operation.lifecycleProtocolVersion());
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
    private boolean settle(OperationRecord operation,
            java.util.concurrent.atomic.AtomicBoolean harnessSettled) {
        if (operation.lifecycleProtocolVersion() < 0 || operation.lifecycleProtocolVersion() > 2) {
            throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_lifecycle_protocol_unavailable");
        }
        boolean harnessConfirmed = false;
        var session = store.requireSession(operation.tenantId(), operation.sessionId());
        boolean bound = session.workspace() != null;
        if (bound && closedSessionDeletion(operation)) {
            return false;
        }
        if (operation.kind() == OperationKind.CLOSE
                || operation.kind() == OperationKind.DELETE) {
            cascadeChildScopes(operation);
        }
        if (bound && operationIsLifecycle(operation)) {
            if (lifecycle == null || !RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())) {
                throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_close_identity_unverified");
            }
            lifecycle.requireSettledExecutions(operation);
            JsonNode effects = lifecycle.recoverEffects(operation);
            if (effects == null) {
                if (!harness.supportsLifecycle(session.toolProfile())) {
                    throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_lifecycle_protocol_unavailable");
                }
                try {
                    effects = harness.settleLifecycle(operation);
                } catch (com.alibaba.qwen.code.daemon.HostedHarnessSettleAnsweredException answered) {
                    // The Harness answered the settle but Java could not
                    // process the receipt — the latch still sets: a later
                    // failure of this attempt is not "the settle never
                    // happened" (review round 11, R7-2). A pre-send
                    // DaemonProtocolException (e.g. the protocol-1 refusal)
                    // never carries the marker and stays unlatched.
                    harnessSettled.set(true);
                    throw answered;
                }
                // The Harness was asked to stop and answered: even when the
                // receipt write below refuses, the settle did reach the
                // Harness and a later failure of this attempt is not "the
                // settle never happened" (review round 9, R7-2).
                harnessSettled.set(true);
                lifecycle.saveEffects(operation, effects);
            } else {
                // A receipt a prior attempt saved from the Harness is
                // durable proof it reached the Harness; a neverInitialized
                // receipt was synthesized and persisted by the store itself
                // for a Session the Harness never booted, with zero Harness
                // contact (review round 11, R11-2), and a storeSynthesized
                // one is the store's own journal-derived build for a booted
                // Session whose settle likewise never reached the Harness
                // (review round 14, R14-2).
                harnessSettled.set(!effects.path("neverInitialized").asBoolean(false)
                        && !effects.path("storeSynthesized").asBoolean(false));
            }
            if (operation.lifecycleProtocolVersion() == 2
                    && !effects.path("neverInitialized").asBoolean()) {
                String profile = session.toolProfile();
                try {
                    harness.prepareLifecycleResources(operation);
                    if (com.alibaba.qwen.code.managedagent.store.WorkspaceToolProfiles.SHELL.equals(profile)) {
                        runtimeWarmer.drainWorkspaceResources(operation.tenantId(), operation.sessionId(),
                                com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.authority(operation))
                                .toCompletableFuture().join();
                    }
                    harness.settleLifecycleResources(operation);
                    runtimeWarmer.drainWorkspaceResources(operation.tenantId(), operation.sessionId(),
                            com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.authority(operation))
                            .toCompletableFuture().join();
                } catch (RuntimeException unsettled) {
                    if (!(unsettled instanceof com.alibaba.qwen.code.daemon.DaemonException)
                            || unsettled instanceof com.alibaba.qwen.code.daemon.HostedHarnessGenerationException) {
                        throw unsettled;
                    }
                    if (unsettled instanceof com.alibaba.qwen.code.daemon.DaemonHttpException http
                            && (http.getErrorCode() != null && (http.getErrorCode().startsWith("workspace_lifecycle_claim")
                                    || http.getErrorCode().startsWith("workspace_lifecycle_authorization")
                                    || http.getErrorCode().startsWith("workspace_close")
                                            && !(com.alibaba.qwen.code.managedagent.store.WorkspaceToolProfiles.MCP.equals(profile)
                                                    && "workspace_close_identity_unverified".equals(http.getErrorCode()))
                                    || "runtime_admission_closed".equals(http.getErrorCode())))) {
                        throw unsettled;
                    }
                    if (com.alibaba.qwen.code.managedagent.store.WorkspaceToolProfiles.MCP.equals(profile)) {
                        runtimeWarmer.recoverStoppedWorkspaceResources(operation.tenantId(), operation.sessionId(),
                                com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.authority(operation))
                                .toCompletableFuture().join();
                    } else {
                        throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_lifecycle_resources_unsettled");
                    }
                }
            }
            if (operation.lifecycleProtocolVersion() == 2) {
                lifecycle.verifyOutputContents(operation);
                lifecycle.verifyResources(operation);
            }
            harness.detachLifecycle(operation);
            if (sessionStore.hasLiveWriter(operation.tenantId(), operation.sessionId())) {
                throw com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.blocked("workspace_lifecycle_writer_active");
            }
            runtimeWarmer.closeWorkspace(operation.tenantId(), operation.sessionId()).toCompletableFuture().join();
            return true;
        }
        if (bound) {
            if (!RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace())) {
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
                // The Harness was asked and answered: even when another
                // server's Harness replied (confirming nothing about the
                // Session), the close was delivered — a later failure of
                // this attempt is not "the settle never happened".
                harnessSettled.set(true);
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

    /** A child run body's dispatch facts, as the record proves them. */
    private record ScopeEvidence(String childSessionId, String dispatchId,
            String runtimeBindingId, String runtimeGeneration) {
    }

    private static String jsonText(JsonNode node) {
        return node == null || node.isNull() ? null : node.asText();
    }

    /**
     * #13753 I2: a worktree child's Workspace is discarded with it. The
     * request is durable and runs once the child Session is closed, so the
     * parent's close never waits for the discard to run; a refusal meaning
     * the row already settled (merged, discarded, a merge already running)
     * owes nothing. False only when the request itself is owed.
     */
    private boolean discardChildWorkspace(String tenantId, String sessionId,
            String childRunId) {
        if (childWorkspaces == null) {
            return true;
        }
        try {
            if (childWorkspaces.find(tenantId, sessionId, childRunId) == null) {
                return true;
            }
            childWorkspaces.requestFinish(tenantId, sessionId, childRunId,
                    com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.DISCARD,
                    clock.millis());
            return true;
        } catch (com.alibaba.qwen.code.managedagent.api.ApiException refused) {
            if (java.util.Set.of("child_workspace_conflict",
                    "child_workspace_finishing", "child_workspace_not_found")
                    .contains(refused.getCode())) {
                return true;
            }
            LOG.warn("Managed Session close cascade's child Workspace"
                            + " discard faltered tenant={} session={}"
                            + " childRun={} — debt owed; failure={}",
                    tenantId, sessionId, childRunId, refused.getMessage());
            return false;
        } catch (RuntimeException error) {
            LOG.warn("Managed Session close cascade's child Workspace"
                            + " discard faltered tenant={} session={}"
                            + " childRun={} — debt owed; failure={}",
                    tenantId, sessionId, childRunId, error.getMessage());
            return false;
        }
    }

    /**
     * H4b close cascade (reference design §12): after the admission
     * barriers seal new work and before the Harness closes, every
     * non-terminal child run of the closing Session takes its durable stop
     * request, its child Session closes through its own Session lifecycle —
     * recursively, since each child's own close runs this same step for
     * its children — and its terminal revision commits. A run whose body
     * never learned the child Session id consults the relay ledger and
     * then the committed lineage row, so a child created but not yet
     * attached is still found; such a child's dispatch and attach are
     * replayed from its proven evidence before the settling revision,
     * whose parse requires a valid chain. The physical
     * effect never waits on the parent's journal: a reachable child
     * closes even while its stop-request and terminal revisions falter.
     * Nothing here rewrites an unproven end as cancelled: a child the
     * Harness cannot reach has no settled evidence to record, so the whole
     * close operation re-arms through the dispatch retry with its debt
     * owed, instead of settling on suspicion.
     */

    private void cascadeChildScopes(OperationRecord operation) {
        String tenantId = operation.tenantId();
        String sessionId = operation.sessionId();
        boolean journalDebt = false;
        for (ChildResultRelayStore.LiveScope scope : childScopes
                .findLiveScopes(tenantId, sessionId)) {
            ScopeEvidence body;
            try {
                String text = childScopes.readResource(tenantId, sessionId,
                        scope.recordResourceId());
                if (text == null) {
                    body = new ScopeEvidence(null, null, null, null);
                } else {
                    JsonNode record = objectMapper.readTree(text);
                    JsonNode run = record.get("run");
                    JsonNode runtime = run == null ? null : run.get(
                            "runtime");
                    body = new ScopeEvidence(
                            jsonText(record.get("childSessionId")),
                            run == null ? null : jsonText(
                                    run.get("dispatchId")),
                            runtime == null ? null : jsonText(
                                    runtime.get("runtimeBindingId")),
                            runtime == null ? null : jsonText(
                                    runtime.get("generation")));
                }
            } catch (Exception error) {
                throw new IllegalStateException(
                        "Child scope evidence is unreadable", error);
            }
            String creationKey = null;
            String childSessionId = body.childSessionId();
            if (childSessionId == null) {
                // The child may exist while its attach revision has not
                // committed (the create→attach window): the relay ledger
                // names the child Session, so an unstarted verdict rests
                // on evidence, never on the body's gap.
                ChildResultRelayStore.RelayRow ledger = childScopes.find(
                        tenantId, sessionId, scope.childRunId());
                if (ledger != null && ledger.childSessionId() != null) {
                    childSessionId = ledger.childSessionId();
                    creationKey = ledger.creationKey();
                }
                if (childSessionId == null) {
                    // Strongest disproving evidence: creation stamps the
                    // child's own lineage row before the relay records its
                    // answer, so a window where both the body and the
                    // ledger lack the id still identifies the child.
                    childSessionId = childScopes.findLineageChild(tenantId,
                            sessionId, scope.childRunId());
                }
            }
            boolean recordReady = body.childSessionId() != null;
            boolean provablyUnstarted = false;
            if (childSessionId != null && !recordReady) {
                // The started call binds evidence, never a lease's
                // memory: a creation key is an attempt id, not a start,
                // and a READY binding's absence says nothing — a retired
                // (RELEASED/LOST) binding still proves the dispatch it
                // once was, and the child Session's own dispatched Turn
                // is proof all by itself (the G3 pair: a submission mark
                // or a harness epoch — a Turn whose admission never
                // landed is a pre-admission failure and proves nothing).
                // A start is proven by the body's committed dispatch
                // facts, by a binding row in ANY state, or by that Turn;
                // with none of the three the never-started pairing is
                // the honest one. The SDK's refusal and transport-
                // ambiguous throws are plain RuntimeExceptions
                // (DaemonHttpException,
                // MutationOutcomeUnknownException): a journal-side
                // failure owes its revision, but must never skip the
                // child's own physical close behind it.
                RuntimeBindingRecord binding = findBinding(tenantId,
                        childSessionId);
                ChildResultRelayStore.TurnLine childTurn = childScopes
                        .latestTurn(tenantId, childSessionId);
                if (body.runtimeBindingId() == null
                        && body.dispatchId() == null && binding == null
                        && (childTurn == null || !childTurn.dispatched())) {
                    // Nothing to replay and nothing that ever ran: the
                    // only honest read of the create→attach window is
                    // that the creation never attached. The run settles
                    // `started: false` on its evidence, not on a leaded
                    // row re-armed forever on behalf of proof it lacks.
                    provablyUnstarted = true;
                } else {
                    try {
                        repairChildRecord(operation, scope.childRunId(),
                                body, childSessionId, creationKey, binding);
                        recordReady = true;
                    } catch (RuntimeException unfixed) {
                        journalDebt = true;
                        LOG.warn("Managed Session close cascade cannot"
                                        + " rebuild a child's record"
                                        + " tenant={} session={}"
                                        + " childRun={} child={} — debt"
                                        + " owed; failure={}",
                                tenantId, sessionId, scope.childRunId(),
                                childSessionId, unfixed.getMessage());
                    }
                }
            }
            boolean stopRequestCommitted = false;
            Map<String, Object> cancel = new LinkedHashMap<>();
            cancel.put("operationId", UUID.randomUUID().toString());
            cancel.put("kind", "cancel");
            cancel.put("childRunId", scope.childRunId());
            try {
                runLifecycleChildOperation(operation, cancel);
                stopRequestCommitted = true;
            } catch (RuntimeException error) {
                journalDebt = true;
                LOG.warn("Managed Session close cascade's stop request"
                                + " faltered tenant={} session={}"
                                + " childRun={} — the child still closes,"
                                + " debt owed; failure={}", tenantId,
                        sessionId, scope.childRunId(), error.getMessage());
            }
            boolean discardOwed = !discardChildWorkspace(tenantId, sessionId,
                    scope.childRunId());
            if (discardOwed) {
                journalDebt = true;
            }
            if (childSessionId != null) {
                String status = childScopes.sessionStatus(tenantId,
                        childSessionId);
                if (status == null
                        || !SETTLED_SESSION_STATES.contains(status)) {
                    // #13875: the stop request above only records intent —
                    // nothing on this path ended the child's work, so the
                    // child close refused on the active Turn and the parent
                    // close re-armed until the Turn's natural end (up to
                    // the Harness Turn deadline). Cancel a live Turn
                    // through the same keyed cancel the relay's stop arm
                    // uses, then owe the re-arm: the child close still
                    // refuses while the Turn runs, so the next pass admits
                    // it once the Turn settled. A replayed cancel is a
                    // no-op, and a Turn that ended naturally keeps its
                    // outcome — the cancel never lands on it. Two guards
                    // keep the stop's own ordering: the stops run only
                    // once the stop request is durable, or a relay that
                    // captured the parent ACTIVE could read the cancelled
                    // Turn as child_failed; and a queued message route
                    // stops before the Turn cancel, whose own load can
                    // start the child's wake pump on those inputs.
                    ChildResultRelayStore.TurnLine childTurn =
                            stopRequestCommitted ? childScopes.latestTurn(
                                    tenantId, childSessionId) : null;
                    if (childTurn != null && ("ACCEPTED".equals(
                            childTurn.status())
                            || "RUNNING".equals(childTurn.status())
                            || "CANCELLING".equals(childTurn.status()))) {
                        try {
                            RuntimeException stopFailure = null;
                            if (childScopes.hasSessionMessages(tenantId,
                                    childSessionId)
                                    && childScopes.journalTurns(tenantId,
                                            childSessionId)
                                                    .pendingMessageInputs()
                                            > 0) {
                                Map<String, Object> stop =
                                        new LinkedHashMap<>();
                                stop.put("operationId",
                                        UUID.randomUUID().toString());
                                stop.put("kind", "stop");
                                try {
                                    harness.runMessageOperation(tenantId,
                                            childSessionId, stop);
                                } catch (DaemonHttpException error) {
                                    // A child waiting on its recovery or
                                    // closing takes no stop yet: the retry
                                    // asks again, as on the relay's arm.
                                    if (!"hosted_turn_recovery_required"
                                            .equals(error.getErrorCode())
                                            && !"hosted_session_closing"
                                                    .equals(error
                                                            .getErrorCode())) {
                                        stopFailure = error;
                                    }
                                } catch (RuntimeException error) {
                                    stopFailure = error;
                                }
                            }
                            if (stopFailure != null) {
                                throw stopFailure;
                            }
                            // A CANCELLING Turn owns its outcome: never
                            // re-driven, only looked at again next pass.
                            if (!"CANCELLING".equals(childTurn.status())) {
                                sessions.cancelChildTurn(tenantId, sessionId,
                                        childSessionId, scope.childRunId(),
                                        childTurn.turnId());
                            }
                        } catch (RuntimeException error) {
                            LOG.warn("Managed Session close cascade's"
                                            + " child stop faltered"
                                            + " tenant={} session={}"
                                            + " childRun={} child={} — debt"
                                            + " owed; failure={}",
                                    tenantId, sessionId, scope.childRunId(),
                                    childSessionId, error.getMessage());
                        }
                        journalDebt = true;
                        continue;
                    }
                    // A host that cannot close Workspace Sessions answers
                    // nothing here — the relay's split: the admission
                    // would refuse as `workspace_unavailable`, and one
                    // unclassifiable throw in the delivery retry runs the
                    // parent's operation forever outside the typed gate.
                    // Settle below takes its existing
                    // `workspace_close_identity_unverified` way instead,
                    // and the re-arm walks this branch again only after
                    // the capability returns.
                    if (!childCloses.closeSupported()) {
                        LOG.info("Managed Session close cascade skips the"
                                        + " child close admission on a"
                                        + " close-incapable host tenant={}"
                                        + " session={} childRun={}"
                                        + " child={}",
                                tenantId, sessionId, scope.childRunId(),
                                childSessionId);
                        continue;
                    }
                    // The child closes through its own Session lifecycle:
                    // an admission is idempotent under the run's key, and
                    // an active Turn or a missing Runtime lane refuses —
                    // every outcome here is owed work, never a settled
                    // one, so the close re-arms instead of committing a
                    // close_scope proof for a close that never ran.
                    try {
                        OperationAdmission admitted = childCloses
                                .admitChildClose(tenantId, sessionId,
                                        childSessionId, scope.childRunId());
                        if (!"COMPLETED".equals(
                                admitted.operation().state())) {
                            dispatch(tenantId, childSessionId,
                                    admitted.operation().operationId());
                        }
                    } catch (RuntimeException error) {
                        LOG.warn("Managed Session close cascade's child"
                                        + " close admission faltered"
                                        + " tenant={} session={}"
                                        + " childRun={} child={} — debt"
                                        + " owed; failure={}", tenantId,
                                sessionId, scope.childRunId(),
                                childSessionId, error.getMessage());
                    }
                    LOG.info("Managed Session close cascade owes the child"
                                    + " Session's lifecycle close tenant={}"
                                    + " session={} childRun={} child={}",
                            tenantId, sessionId, scope.childRunId(),
                            childSessionId);
                    journalDebt = true;
                    continue;
                }
            }
            if (discardOwed) {
                // The settled run would leave the live scopes the re-armed
                // close walks, and its discard with them (#13753 I2).
                continue;
            }
            Map<String, Object> closeScope = new LinkedHashMap<>();
            closeScope.put("operationId", UUID.randomUUID().toString());
            closeScope.put("kind", "close_scope");
            closeScope.put("childRunId", scope.childRunId());
            if (childSessionId != null && !recordReady
                    && !provablyUnstarted) {
                // The settleCancelled parse accepts only a chain whose
                // attach committed: the debt above keeps the close owed
                // instead of committing a revision no parser reads.
                continue;
            }
            closeScope.put("started", childSessionId != null && recordReady);
            if (childSessionId != null && !recordReady) {
                // A minted, never-started child dies named: the settling
                // revision carries its Session so the lineage's own close
                // story is never lost with the body's gap.
                closeScope.put("childSessionId", childSessionId);
            }
            try {
                runLifecycleChildOperation(operation, closeScope);
            } catch (RuntimeException error) {
                journalDebt = true;
                LOG.warn("Managed Session close cascade's terminal"
                                + " revision faltered tenant={} session={}"
                                + " childRun={} — debt owed; failure={}",
                        tenantId, sessionId, scope.childRunId(),
                        error.getMessage());
            }
            LOG.info("Managed Session close cascade settled a child scope"
                            + " tenant={} session={} childRun={} child={}",
                    tenantId, sessionId, scope.childRunId(),
                    childSessionId == null ? "unstarted" : childSessionId);
        }
        if (journalDebt) {
            throw new IllegalStateException(
                    "Child cascade journal debt: the stop or terminal"
                            + " revisions are owed");
        }
    }

    /**
     * Rebuilds a run's dispatch/attach chain through the child's proven
     * evidence — its own committed dispatch facts, or the physical
     * binding row it once drove (any state: a retired binding's identity
     * is what the dispatch committed, warmth is never required here) —
     * so the settling revision commits over valid record transitions.
     * Every operation is idempotent: a patched attempt replays its
     * receipt instead of widening evidence.
     */
    private void repairChildRecord(OperationRecord parent, String childRunId,
            ScopeEvidence body, String childSessionId, String creationKey,
            RuntimeBindingRecord binding) {
        String runtimeBindingId = body.runtimeBindingId();
        String generation = body.runtimeGeneration();
        if (runtimeBindingId == null || generation == null) {
            if (binding == null) {
                throw new IllegalStateException(
                        "child Runtime binding is not visible");
            }
            runtimeBindingId = binding.getBindingId();
            generation = Long.toString(binding.getGeneration());
        }
        String dispatchId = body.dispatchId() != null ? body.dispatchId()
                : creationKey != null ? creationKey
                : ManagedAgentService.childCreationKey(parent.sessionId(),
                        childRunId);
        Map<String, Object> dispatch = new LinkedHashMap<>();
        dispatch.put("operationId", UUID.randomUUID().toString());
        dispatch.put("kind", "dispatch_started");
        dispatch.put("childRunId", childRunId);
        dispatch.put("dispatchId", dispatchId);
        dispatch.put("runtimeBindingId", runtimeBindingId);
        dispatch.put("generation", generation);
        runLifecycleChildOperation(parent, dispatch);
        Map<String, Object> attach = new LinkedHashMap<>();
        attach.put("operationId", UUID.randomUUID().toString());
        attach.put("kind", "attach");
        attach.put("childRunId", childRunId);
        attach.put("childSessionId", childSessionId);
        runLifecycleChildOperation(parent, attach);
    }

    /** A lifecycle-protocol parent owns the journal its child updates
     * live under: the operation's own claim (operationId +
     * claimGeneration + the lifecycle kind) tags every child operation so
     * the LIFECYCLE_ONLY fence recognizes its own pre-effects cleanup
     * instead of mistaking it for foreign ordinary work. Ordinary parents
     * keep the ordinary admission exactly as before. Package-visible so
     * tests pin the tagging contract directly. */
    void runLifecycleChildOperation(OperationRecord parent,
            Map<String, Object> childBody) {
        if (operationIsLifecycle(parent)) {
            childBody.put("authority", Map.of(
                    "operationId", parent.operationId(),
                    "claimGeneration", parent.claimGeneration(),
                    "kind", parent.kind() == OperationKind.CLOSE
                            ? "close" : "delete"));
        }
        harness.runChildOperation(parent.tenantId(), parent.sessionId(),
                childBody);
    }

    /** The newest binding row proving a child's dispatch identity, in
     * ANY state — or null when no Runtime Broker is wired (legacy
     * deployment shapes) or no row ever stood. A retired row still
     * proves the dispatch it once was; warmth is a separate question
     * the relay answers READY-only. */
    private RuntimeBindingRecord findBinding(String tenantId,
            String sessionId) {
        RuntimeBrokerService broker = brokerProviders == null ? null
                : brokerProviders.getIfAvailable();
        return broker == null ? null
                : broker.findLatestBindingByHarnessSessionAnyState(tenantId,
                        sessionId);
    }
}
