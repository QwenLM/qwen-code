package com.alibaba.qwen.code.managedagent.service;

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
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Delivers admitted close, delete and cwd-change operations. An operation
 * admitted on an active Session closes it in the Hosted Harness and waits
 * until no Harness holds the Session's journal writer; a close or delete
 * then drains the Session's Runtime binding and completes, and a failed
 * attempt is retried with the dispatch backoff until it succeeds, so one of
 * those operations never completes before these steps. A cwd change is
 * settled without Harness or worker involvement — a read-only mount probe
 * and one revision-CAS commit. A structural probe refusal or a moved fact
 * is a terminal failure that is never retried; a momentary probe failure
 * retries through the same dispatch backoff, bounded at
 * {@link #CWD_CHANGE_ATTEMPT_BUDGET} attempts — a fault that outlives the
 * budget settles with the typed terminal failure instead of wedging the
 * Session behind the admission barriers forever, and a refusal that
 * exhausts it leaves the Session unchanged and executable.
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
    private final ManagedSessionStore sessionStore;
    private final HarnessConnector harness;
    private final RuntimeWarmer runtimeWarmer;
    private final ChildResultRelayStore childScopes;
    private final ObjectMapper objectMapper;
    private final RequestDigests digests;
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
    static final Set<String> SETTLED_SESSION_STATES =
            Set.of("CLOSED", "ARCHIVED", "DELETED");

    public SessionLifecycleCoordinator(AgentStateStore store,
            ManagedSessionStore sessionStore, HarnessConnector harness,
            RuntimeWarmer runtimeWarmer, ChildResultRelayStore childScopes,
            ObjectMapper objectMapper, RequestDigests digests,
            ExecutorService executor,
            Clock clock, ManagedAgentProperties properties) {
        this.store = store;
        this.sessionStore = sessionStore;
        this.harness = harness;
        this.runtimeWarmer = runtimeWarmer;
        this.childScopes = childScopes;
        this.objectMapper = objectMapper;
        this.digests = digests;
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
            if (claimed.kind() == OperationKind.CWD_CHANGE) {
                settleCwdChange(claimed);
                return;
            }
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
            // A capability digest mismatch lands here too: nothing may be
            // completed honestly (completing unconfirmed would flip the
            // session while skipping the drain and record a clean row),
            // so the reason-loud retry below is deliberately the end of
            // the line until an operator realigns the versions.
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
                    error.getClass().getSimpleName(), error.getMessage(),
                    error);
        } finally {
            renewal.cancel(false);
        }
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
        if (bound && operation.kind() == OperationKind.DELETE
                && ("CLOSED".equals(operation.sessionStatusBefore()) || "ARCHIVED".equals(operation.sessionStatusBefore()))) {
            return false;
        }
        if (operation.kind() == OperationKind.CLOSE
                || operation.kind() == OperationKind.DELETE) {
            cascadeChildScopes(operation);
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

    /**
     * H4b close cascade (reference design §12): after the admission
     * barriers seal new work and before the Harness closes, every
     * non-terminal child run of the closing Session takes its durable stop
     * request, its child Session closes through its own Session lifecycle —
     * recursively, since each child's own close runs this same step for
     * its children — and its terminal revision commits. A run whose body
     * never learned the child Session id consults the relay ledger, so a
     * child created but not yet attached is still found. The physical
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
            String childSessionId = null;
            try {
                String body = childScopes.readResource(tenantId,
                        scope.recordResourceId());
                if (body != null) {
                    JsonNode record = objectMapper.readTree(body);
                    JsonNode value = record.get("childSessionId");
                    if (value != null && !value.isNull()) {
                        childSessionId = value.asText();
                    }
                }
            } catch (Exception error) {
                throw new IllegalStateException(
                        "Child scope evidence is unreadable", error);
            }
            if (childSessionId == null) {
                // The child may exist while its attach revision has not
                // committed (the create→attach window): the relay ledger
                // names the child Session, so an unstarted verdict rests
                // on evidence, never on the body's gap.
                ChildResultRelayStore.RelayRow ledger = childScopes.find(
                        tenantId, sessionId, scope.childRunId());
                if (ledger != null && ledger.childSessionId() != null) {
                    childSessionId = ledger.childSessionId();
                }
            }
            Map<String, Object> cancel = new LinkedHashMap<>();
            cancel.put("operationId", UUID.randomUUID().toString());
            cancel.put("kind", "cancel");
            cancel.put("childRunId", scope.childRunId());
            try {
                harness.runChildOperation(tenantId, sessionId, cancel);
            } catch (RuntimeException error) {
                journalDebt = true;
                LOG.warn("Managed Session close cascade's stop request"
                                + " faltered tenant={} session={}"
                                + " childRun={} — the child still closes,"
                                + " debt owed; failure={}", tenantId,
                        sessionId, scope.childRunId(), error.getMessage());
            }
            if (childSessionId != null) {
                String status = childScopes.sessionStatus(tenantId,
                        childSessionId);
                if (status == null
                        || !SETTLED_SESSION_STATES.contains(status)) {
                    // The child closes through its own Session lifecycle:
                    // an admission is idempotent under the run's key, and
                    // an active Turn or a missing Runtime lane refuses —
                    // every outcome here is owed work, never a settled
                    // one, so the close re-arms instead of committing a
                    // close_scope proof for a close that never ran.
                    try {
                        OperationAdmission admitted =
                                admitChildClose(operation, childSessionId,
                                        scope.childRunId());
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
            Map<String, Object> closeScope = new LinkedHashMap<>();
            closeScope.put("operationId", UUID.randomUUID().toString());
            closeScope.put("kind", "close_scope");
            closeScope.put("childRunId", scope.childRunId());
            closeScope.put("started", childSessionId != null);
            try {
                harness.runChildOperation(tenantId, sessionId, closeScope);
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

    private OperationAdmission admitChildClose(OperationRecord parent,
            String childSessionId, String childRunId) {
        String actor = "child:" + parent.sessionId();
        return store.beginWorkspaceLifecycle(parent.tenantId(),
                childSessionId, OperationKind.CLOSE, actor,
                digests.digest(Map.of("actorId", actor)),
                "child-close-" + childRunId,
                digests.digest(Map.of("sessionId", childSessionId,
                        "operation", "CLOSE_SESSION")),
                runtimeWarmer != null && runtimeWarmer.supportsWorkspaceClose());
    }
}
