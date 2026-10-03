package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
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
 * Delivers admitted close and delete operations. An operation admitted on an
 * active Session closes it in the Hosted Harness and waits until no Harness
 * holds the Session's journal writer; every operation then drains the
 * Session's Runtime binding and completes. A failed attempt is retried with
 * the dispatch backoff; once the retry budget is spent the operation reaches
 * a terminal failure that keeps the failure code and leaves the Session in
 * its pending status, rather than retrying forever or certifying a settle
 * that never happened. The one exception is a live journal writer: the close
 * can still succeed once it stops, so the operation keeps waiting.
 */
@Component
public class SessionLifecycleCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(
            SessionLifecycleCoordinator.class);
    private static final int SCAN_LIMIT = 50;
    private final AgentStateStore store;
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
        try {
            boolean harnessConfirmed = settle(claimed);
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
            if (cause instanceof com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException brokerError) {
                failureCode = brokerError.getCode();
                if ("workspace_close_execution_unsettled".equals(brokerError.getCode())) {
                    blocked = brokerError.getCode();
                } else if ("workspace_close_identity_unverified".equals(brokerError.getCode())
                        || "runtime_broker_recovery_blocked".equals(brokerError.getCode())) {
                    blocked = "workspace_close_identity_unverified";
                }
            }
            // The budget bounds every settle outcome, blocked or not, and
            // the terminal record keeps the cause instead of certifying a
            // completion that never settled. A live journal writer is the
            // one exception: the close can still succeed once it stops, so
            // the operation keeps waiting rather than recording a failure.
            if (claimed.attemptCount() >= maxOperationRetries && valid.get()
                    && !writerStillLive(claimed)) {
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
                            runtimeWarmer.requestWorkspaceClose(tenantId,
                                    sessionId);
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
                    // than leave the operation wedged on a spent lease. The
                    // blocked reschedule is restricted to the shapes the
                    // recovery scan re-drives from BLOCKED (CLOSE, and a
                    // DELETE admitted on a closed Session); every other
                    // shape goes back to PENDING, which is always re-driven.
                    // A blocked code can only arise from settle()'s
                    // workspace-close path, which the closed-Session delete
                    // never enters, so CLOSE is the only shape that needs it
                    // here.
                    LOG.warn("Managed Session operation terminal record"
                                    + " failed; rescheduling tenant={}"
                                    + " session={} operation={} failure={}",
                            tenantId, sessionId, operationId,
                            writeError.getMessage());
                    if (valid.get()) {
                        if (blocked != null
                                && claimed.kind() == OperationKind.CLOSE) {
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
                        claimed.claimGeneration(), blocked, Math.addExact(clock.millis(), delay));
            } else if (valid.get()) {
                store.retryOperation(tenantId, sessionId, operationId, owner,
                        claimed.claimGeneration(), Math.addExact(clock.millis(), delay));
            }
            LOG.warn("Managed Session operation will retry tenant={}"
                            + " session={} operation={} retry={} delayMs={}"
                            + " failure={} {}",
                    tenantId, sessionId, operationId,
                    claimed.attemptCount() + 1, delay,
                    error.getClass().getSimpleName(), error.getMessage());
        } finally {
            renewal.cancel(false);
        }
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

    // Returns whether the Harness that held the Session acknowledged closing
    // it. A Harness that never held it, or that replaced the one that did,
    // answers too, but its answer confirms nothing about the Session.
    private boolean settle(OperationRecord operation) {
        boolean harnessConfirmed = false;
        boolean bound = store.requireSession(operation.tenantId(), operation.sessionId()).workspace() != null;
        if (bound && closedSessionDeletion(operation)) {
            return false;
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
