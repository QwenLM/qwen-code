package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
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
    private final ManagedSessionStore sessionStore;
    private final HarnessConnector harness;
    private final RuntimeWarmer runtimeWarmer;
    private final ExecutorService executor;
    private final Clock clock;
    private final Duration leaseDuration;
    private final Duration retryInitialDelay;
    private final Duration retryMaxDelay;
    private final String owner = UUID.randomUUID().toString();
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
        try {
            boolean harnessConfirmed = settle(claimed);
            if (!store.completeOperation(tenantId, sessionId, operationId,
                    owner, claimed.claimGeneration(), harnessConfirmed)) {
                LOG.warn("Managed Session operation was claimed by another"
                                + " worker tenant={} session={} operation={}",
                        tenantId, sessionId, operationId);
            }
        } catch (HostedHarnessCapabilityMismatchException error) {
            // A Harness whose capability digest no longer matches will
            // still mismatch on every future negotiation, so complete
            // terminally with the truth in the record instead of retrying
            // forever — the one retry behavior this operation exists to
            // bound.
            LOG.warn("Managed Session operation completed terminally"
                            + " tenant={} session={} operation={} code={}",
                    tenantId, sessionId, operationId, error.getCode());
            store.completeOperation(tenantId, sessionId, operationId,
                    owner, claimed.claimGeneration(), false);
        } catch (RuntimeException error) {
            long delay = HarnessCoordinator.retryDelay(retryInitialDelay,
                    retryMaxDelay, claimed.attemptCount());
            store.retryOperation(tenantId, sessionId, operationId, owner,
                    claimed.claimGeneration(),
                    Math.addExact(clock.millis(), delay));
            LOG.warn("Managed Session operation will retry tenant={}"
                            + " session={} operation={} retry={} delayMs={}"
                            + " failure={} {}",
                    tenantId, sessionId, operationId,
                    claimed.attemptCount() + 1, delay,
                    error.getClass().getSimpleName(), error.getMessage());
        }
    }

    // Returns whether the Harness that held the Session acknowledged closing
    // it. A Harness that never held it, or that replaced the one that did,
    // answers too, but its answer confirms nothing about the Session.
    private boolean settle(OperationRecord operation) {
        boolean harnessConfirmed = false;
        if ("ACTIVE".equals(operation.sessionStatusBefore())) {
            String holder = store.requireSession(operation.tenantId(),
                    operation.sessionId()).harnessBootId();
            if (harness.isAvailable()) {
                String answered = harness.closeSession(operation.tenantId(),
                        operation.sessionId());
                harnessConfirmed = holder != null && holder.equals(answered);
            } else if (holder != null) {
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
        runtimeWarmer.drain(operation.sessionId()).toCompletableFuture()
                .join();
        return harnessConfirmed;
    }
}
