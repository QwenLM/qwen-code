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
 * the dispatch backoff until it succeeds, so an operation never completes
 * before these steps.
 */
@Component
public class SessionLifecycleCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(
            SessionLifecycleCoordinator.class);
    private static final int SCAN_LIMIT = 50;
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
            String blocked = null;
            if (cause instanceof com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException brokerError) {
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

    private static boolean operationIsLifecycle(OperationRecord operation) {
        return operation.lifecycleProtocolVersion() == 1;
    }

    // Returns whether the Harness that held the Session acknowledged closing
    // it. A Harness that never held it, or that replaced the one that did,
    // answers too, but its answer confirms nothing about the Session.
    private boolean settle(OperationRecord operation) {
        boolean harnessConfirmed = false;
        boolean bound = store.requireSession(operation.tenantId(), operation.sessionId()).workspace() != null;
        if (bound && operation.kind() == OperationKind.DELETE
                && ("CLOSED".equals(operation.sessionStatusBefore()) || "ARCHIVED".equals(operation.sessionStatusBefore()))) {
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
