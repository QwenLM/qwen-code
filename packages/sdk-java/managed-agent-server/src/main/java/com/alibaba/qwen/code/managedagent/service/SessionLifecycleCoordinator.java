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
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
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
import org.springframework.beans.factory.ObjectProvider;
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
    private final ChildResultRelayStore childScopes;
    private final ObjectMapper objectMapper;
    private final ChildLifecycleAdmissions childCloses;
    private final ObjectProvider<RuntimeBrokerService> brokerProviders;
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
            ObjectMapper objectMapper,
            ChildLifecycleAdmissions childCloses,
            ObjectProvider<RuntimeBrokerService> brokerProviders,
            ExecutorService executor,
            Clock clock, ManagedAgentProperties properties) {
        this.store = store;
        this.sessionStore = sessionStore;
        this.harness = harness;
        this.runtimeWarmer = runtimeWarmer;
        this.childScopes = childScopes;
        this.objectMapper = objectMapper;
        this.childCloses = childCloses;
        this.brokerProviders = brokerProviders;
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
                    error.getClass().getSimpleName(), error.getMessage(),
                    error);
        } finally {
            renewal.cancel(false);
        }
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
        if (bound && operation.kind() == OperationKind.DELETE
                && ("CLOSED".equals(operation.sessionStatusBefore()) || "ARCHIVED".equals(operation.sessionStatusBefore()))) {
            return false;
        }
        if (operation.kind() == OperationKind.CLOSE
                || operation.kind() == OperationKind.DELETE) {
            cascadeChildScopes(operation);
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

    /** A child run body's dispatch facts, as the record proves them. */
    private record ScopeEvidence(String childSessionId, String dispatchId,
            String runtimeBindingId, String runtimeGeneration) {
    }

    private static String jsonText(JsonNode node) {
        return node == null || node.isNull() ? null : node.asText();
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
                String text = childScopes.readResource(tenantId,
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
                // The close_scope settlement parses only with the child
                // Session recorded through valid transitions: dispatch and
                // attach replay the child's proven identity — the body's
                // own committed dispatch facts when present, or the
                // physical Runtime binding the child warms with. The SDK's
                // refusal and transport-ambiguous throws are plain
                // RuntimeExceptions (DaemonHttpException,
                // MutationOutcomeUnknownException): a journal-side failure
                // owes its revision, but must never skip the child's own
                // physical close behind it.
                if (body.runtimeBindingId() == null && creationKey == null
                        && findBinding(tenantId, childSessionId) == null) {
                    // Nothing to replay: no dispatch facts committed, no
                    // physical binding the child could have warmed from —
                    // the only honest read of the create→attach window is
                    // that the creation never attached. The run settles
                    // `started: false` on its evidence, not on a leaded
                    // row re-armed forever on behalf of proof it lacks.
                    provablyUnstarted = true;
                } else {
                    try {
                        repairChildRecord(operation, scope.childRunId(),
                                body, childSessionId, creationKey);
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
            Map<String, Object> cancel = new LinkedHashMap<>();
            cancel.put("operationId", UUID.randomUUID().toString());
            cancel.put("kind", "cancel");
            cancel.put("childRunId", scope.childRunId());
            try {
                runLifecycleChildOperation(operation, cancel);
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
     * evidence — its own committed dispatch facts, or the physical Runtime
     * binding the child warms with — so the settling revision commits over
     * valid record transitions. Every operation is idempotent: a patched
     * attempt replays its receipt instead of widening evidence.
     */
    private void repairChildRecord(OperationRecord parent, String childRunId,
            ScopeEvidence body, String childSessionId, String creationKey) {
        String runtimeBindingId = body.runtimeBindingId();
        String generation = body.runtimeGeneration();
        if (runtimeBindingId == null || generation == null) {
            RuntimeBindingRecord binding = findBinding(parent.tenantId(),
                    childSessionId);
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
        if (parent.lifecycleProtocolVersion() == 1) {
            childBody.put("authority", Map.of(
                    "operationId", parent.operationId(),
                    "claimGeneration", parent.claimGeneration(),
                    "kind", parent.kind() == OperationKind.CLOSE
                            ? "close" : "delete"));
        }
        harness.runChildOperation(parent.tenantId(), parent.sessionId(),
                childBody);
    }

    /** The physical Runtime binding proving a child's dispatch identity,
     * or null when no Runtime Broker is wired (legacy deployment shapes). */
    private RuntimeBindingRecord findBinding(String tenantId,
            String sessionId) {
        RuntimeBrokerService broker = brokerProviders == null ? null
                : brokerProviders.getIfAvailable();
        return broker == null ? null
                : broker.findLatestBindingByHarnessSession(tenantId,
                        sessionId);
    }
}
