package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.TaskCancelOutcome;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * H4f of #12827: delivers admitted task cancels to the task authority and
 * records each operation's own outcome. Every decision reads the task's
 * latest committed record first — the authority's durable statement,
 * mirrored in the transaction that committed it — never a wire answer:
 * <ul>
 * <li>a committed stop request completes the operation with a receipt,
 * whoever recorded it (requests coalesce);</li>
 * <li>a run that ended without one fails it with
 * {@code task_already_settled}: a terminal run freezes everything but its
 * delivery line, so the request can never land later;</li>
 * <li>a live run without one takes the stop request through the Hosted
 * Harness's child operation route, which commits it on the parent's
 * journal, and is read again;</li>
 * <li>a live background Shell or Monitor watch is stopped through the
 * Runtime Broker, whose worker answers only after the stop-marked finalize
 * settled the record: the record's own stop is the authority's statement,
 * a request revision for a Shell, the {@code stop_requested} settlement
 * for a Monitor, whose record carries no request;</li>
 * <li>a planned channel delivery takes its cancel through the Hosted
 * Harness's channel operation route, whose {@code cancelRequested} flag is
 * the request: a planned one settles cancelled with it, and one an adapter
 * claimed meanwhile keeps sending with the flag recorded;</li>
 * <li>an Automation run takes a turn-scoped request through the Hosted
 * Harness; its cancelled terminal record proves the stop, so its receipt
 * waits for settlement rather than trusting the request acknowledgment.</li>
 * </ul>
 * A delivery whose outcome stays unproven retries with the dispatch
 * backoff, bounded at {@link #ATTEMPT_BUDGET} claims; past it the
 * operation parks as {@code recovery_blocked} — acceptance unknown, never
 * delivered again — and only the {@link OperationReconciler} settles it,
 * from this class's {@link AcceptanceEvidence}, the record: a later stop
 * request (another cancel, the close cascade) completes it, an end
 * without one fails it. A parked cancel holds no lifecycle hostage. The
 * budget counts claims, not completed retries, and a live delivery
 * renews its lease, so a slow attempt is never re-claimed underneath
 * itself; one still running at its deadline ({@link #deadlineFor}) is
 * abandoned as an unproven outcome, so a send that never returns cannot
 * hold the claim, and the Session's operation slot, past the budget
 * either.
 */
@Component
public class TaskCancelCoordinator implements AcceptanceEvidence {
    private static final Logger LOG = LoggerFactory.getLogger(
            TaskCancelCoordinator.class);
    private static final int SCAN_LIMIT = 50;
    /** Claims before an unproven outcome parks (one claim per attempt). */
    static final int ATTEMPT_BUDGET = 16;
    /** How long a cancel parks before its task's record is read again. */
    static final Duration PARKED_RECHECK = OperationReconciler.RECHECK;
    /**
     * How long one attempt's send may run before the delivery stops
     * waiting for it, at least: well past a healthy attempt at the default
     * Harness timeouts (the attachment's load, perhaps behind another
     * caller's, and the child operation request, 30 s each). A longer
     * Harness request timeout raises it; see {@link #deadlineFor}.
     */
    static final Duration ATTEMPT_DEADLINE = Duration.ofMinutes(5);
    static final String ALREADY_SETTLED = "task_already_settled";
    static final String UNCONFIRMED = "task_cancel_unconfirmed";
    /** The kinds whose physical owner is a background process. */
    private static final Set<String> BACKGROUND_TASK_KINDS = Set.of(
            "background_shell", "monitor");

    private final AgentStateStore store;
    private final ManagedExtensionRecordStore records;
    private final HarnessConnector harness;
    private final RuntimeBrokerService broker;
    private final ExecutorService executor;
    private final Clock clock;
    private final ManagedAgentProperties.Dispatch dispatch;
    private final Duration attemptDeadline;
    private final String owner = UUID.randomUUID().toString();
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService renewals =
            Executors.newSingleThreadScheduledExecutor(task -> {
                Thread thread = new Thread(task, "task-cancel-renewal");
                thread.setDaemon(true);
                return thread;
            });

    @PreDestroy
    void stopRenewals() {
        renewals.shutdownNow();
    }

    @Autowired
    public TaskCancelCoordinator(AgentStateStore store,
            ManagedExtensionRecordStore records, HarnessConnector harness,
            ObjectProvider<RuntimeBrokerService> broker,
            ExecutorService executor, Clock clock,
            ManagedAgentProperties properties) {
        this(store, records, harness, broker.getIfAvailable(), executor,
                clock, properties,
                deadlineFor(properties.getHarness().getRequestTimeout()));
    }

    /**
     * Never below {@link #ATTEMPT_DEADLINE}, nor below four Harness
     * requests: an attempt may renegotiate the client, wait behind another
     * caller's attachment load, make its own, and send the child operation.
     */
    static Duration deadlineFor(Duration requestTimeout) {
        if (requestTimeout == null) {
            return ATTEMPT_DEADLINE;
        }
        Duration requests = requestTimeout.multipliedBy(4);
        return requests.compareTo(ATTEMPT_DEADLINE) > 0 ? requests
                : ATTEMPT_DEADLINE;
    }

    TaskCancelCoordinator(AgentStateStore store,
            ManagedExtensionRecordStore records, HarnessConnector harness,
            RuntimeBrokerService broker, ExecutorService executor,
            Clock clock, ManagedAgentProperties properties,
            Duration attemptDeadline) {
        this.store = store;
        this.records = records;
        this.harness = harness;
        this.broker = broker;
        this.executor = executor;
        this.clock = clock;
        this.dispatch = properties.getDispatch();
        this.attemptDeadline = attemptDeadline;
    }

    Duration attemptDeadline() {
        return attemptDeadline;
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
    public void recover() {
        for (OperationTarget target : store.findDeliverableTaskCancels(
                SCAN_LIMIT)) {
            dispatch(target.tenantId(), target.sessionId(),
                    target.operationId());
        }
    }

    @Override
    public String kind() {
        return OperationKind.TASK_CANCEL.name();
    }

    /** A parked cancel resolves only from the record; it is never re-sent. */
    @Override
    public Optional<AcceptanceVerdict> read(ParkedOperation parked) {
        OperationRecord operation = store.findOperation(parked.tenantId(),
                parked.sessionId(), parked.operationId()).orElse(null);
        // A guard, not an input: the verdict comes from the task's record.
        if (operation == null
                || !"RECOVERY_BLOCKED".equals(operation.state())) {
            return Optional.empty();
        }
        Verdict verdict = verdict(operation);
        if (verdict.live()) {
            return Optional.of(AcceptanceVerdict.unknown());
        }
        return Optional.of("completed".equals(verdict.outcome().status())
                ? AcceptanceVerdict.committed()
                : AcceptanceVerdict.notCommitted(
                        verdict.outcome().failureCode()));
    }

    /** What the task's committed record proves about a cancellation. */
    private record Verdict(TaskCancelOutcome outcome, TaskTarget target) {
        boolean live() {
            return outcome == null;
        }
    }

    private Verdict verdict(OperationRecord operation) {
        TaskTarget target = records.findTaskTarget(operation.tenantId(),
                operation.sessionId(), operation.taskId()).orElse(null);
        if (target == null) {
            return new Verdict(TaskCancelOutcome.failed("task_not_found"),
                    null);
        }
        if (!ManagedExtensionProjection.CANCELLABLE_TASK_KINDS.contains(
                target.kind())) {
            return new Verdict(TaskCancelOutcome.failed(
                    "task_action_unavailable"), target);
        }
        if ("automation_run".equals(target.kind())
                && "cancelled".equals(target.state())) {
            return new Verdict(TaskCancelOutcome.completed(), target);
        }
        // The stopReason clause only adds a Monitor's settlement: for a
        // child_run (child_agent, workflow, background_shell) the record
        // invariant "childRun stop_requested needs its stop request"
        // (ManagedExtensionRecords) makes it imply stopRequested.
        if (target.body().path("stopRequested").asBoolean(false)
                || target.body().path("cancelRequested").asBoolean(false)
                || "stop_requested".equals(
                        target.body().path("stopReason").textValue())) {
            return new Verdict(TaskCancelOutcome.completed(), target);
        }
        if (Set.of("completed", "failed", "cancelled")
                .contains(target.state())) {
            return new Verdict(TaskCancelOutcome.failed(ALREADY_SETTLED),
                    target);
        }
        return new Verdict(null, target);
    }

    private void deliver(String tenantId, String sessionId,
            String operationId) {
        OperationRecord claimed = store.claimOperation(tenantId, sessionId,
                operationId, owner, dispatch.getLeaseDuration()).orElse(null);
        if (claimed == null) {
            return;
        }
        long period = Math.max(1, dispatch.getLeaseDuration().toMillis() / 3);
        ScheduledFuture<?> renewal = renewals.scheduleWithFixedDelay(() -> {
            try {
                store.renewLifecycleOperation(tenantId, sessionId,
                        operationId, owner, claimed.claimGeneration(),
                        dispatch.getLeaseDuration());
            } catch (RuntimeException ignored) {
                // A lost lease fails the guarded settlement writes below.
            }
        }, period, period, TimeUnit.MILLISECONDS);
        try {
            deliverClaimed(claimed);
        } finally {
            renewal.cancel(false);
        }
    }

    private void deliverClaimed(OperationRecord claimed) {
        String tenantId = claimed.tenantId();
        String sessionId = claimed.sessionId();
        String operationId = claimed.operationId();
        Verdict verdict;
        try {
            verdict = verdict(claimed);
            if (verdict.live()
                    && claimed.claimGeneration() > ATTEMPT_BUDGET) {
                // Only claims that outlived their lease get here: never
                // send past the budget, park on the evidence at hand.
                retryOrPark(claimed, "the claim budget is spent");
                return;
            }
            if (verdict.live()) {
                sendWithinDeadline(claimed, verdict.target());
                verdict = verdict(claimed);
            }
        } catch (RuntimeException error) {
            // A refusal or an unknown transport outcome proves nothing on
            // its own: the record says whether the request landed.
            try {
                verdict = verdict(claimed);
            } catch (RuntimeException unreadable) {
                verdict = new Verdict(null, null);
            }
            if (verdict.live()) {
                String failure = error.getClass().getSimpleName() + ": "
                        + error.getMessage();
                if (runtimeNotHere(error)) {
                    // A Broker that holds no context for the Runtime Session
                    // (a fresh process before a turn or the close acquires
                    // it again) cannot stop the process on any retry: park
                    // now rather than hold the Session's operation slot,
                    // and with it the close, for the whole budget.
                    park(claimed, failure);
                } else {
                    retryOrPark(claimed, failure);
                }
                return;
            }
        }
        if (verdict.live()) {
            retryOrPark(claimed, "the stop request is not committed yet");
            return;
        }
        if (!store.settleTaskCancel(tenantId, sessionId, operationId, owner,
                claimed.claimGeneration(), verdict.outcome(), 0)) {
            LOG.warn("Task cancel was claimed by another worker tenant={}"
                    + " session={} operation={}", tenantId, sessionId,
                    operationId);
        }
    }

    /**
     * The send runs on its own thread so that one which never returns —
     * a client close wedged behind a reader on a half-open Harness stream
     * did — stays an unknown outcome instead of the claim's whole life.
     * An abandoned send may still land; the record judges it like any
     * lost reply, and the send logs how it ended. The send runs on the
     * executor the waiting delivery holds a thread of, so that executor
     * must stay unbounded (virtual-thread-per-task): on a bounded pool a
     * delivery could wait on its own send queued behind it.
     */
    private void sendWithinDeadline(OperationRecord operation,
            TaskTarget target) {
        AtomicBoolean abandoned = new AtomicBoolean();
        Future<?> sending = executor.submit(() -> {
            try {
                send(operation, target);
            } catch (RuntimeException error) {
                if (abandoned.get()) {
                    LOG.warn("Abandoned task cancel send failed"
                                    + " tenant={} session={} operation={}"
                                    + " claim={} failure={}",
                            operation.tenantId(), operation.sessionId(),
                            operation.operationId(),
                            operation.claimGeneration(),
                            error.getClass().getSimpleName() + ": "
                                    + error.getMessage(),
                            error);
                }
                throw error;
            }
            if (abandoned.get()) {
                LOG.warn("Abandoned task cancel send returned; the record"
                                + " decides its outcome tenant={} session={}"
                                + " operation={} claim={}",
                        operation.tenantId(), operation.sessionId(),
                        operation.operationId(),
                        operation.claimGeneration());
            }
        });
        try {
            sending.get(attemptDeadline.toMillis(), TimeUnit.MILLISECONDS);
        } catch (ExecutionException error) {
            if (error.getCause() instanceof RuntimeException cause) {
                throw cause;
            }
            if (error.getCause() instanceof Error cause) {
                throw cause;
            }
            throw new IllegalStateException(error.getCause());
        } catch (TimeoutException error) {
            abandoned.set(true);
            sending.cancel(true);
            LOG.warn("Task cancel delivery attempt abandoned after {}"
                            + " tenant={} session={} operation={} claim={}",
                    attemptDeadline, operation.tenantId(),
                    operation.sessionId(), operation.operationId(),
                    operation.claimGeneration());
            throw new IllegalStateException("The delivery attempt was"
                    + " still running after " + attemptDeadline, error);
        } catch (InterruptedException error) {
            abandoned.set(true);
            sending.cancel(true);
            Thread.currentThread().interrupt();
            throw new IllegalStateException(
                    "The delivery attempt was interrupted", error);
        }
    }

    /**
     * A child Session run's stop request onto the parent's journal, a
     * background process's stop through the Broker, or a delivery's cancel
     * onto its route Session's journal, or a stop of one Automation wake
     * Turn; all replay-safe.
     */
    private void send(OperationRecord operation, TaskTarget target) {
        if ("automation_run".equals(target.kind())) {
            harness.runAutomationOperation(operation.tenantId(),
                    operation.sessionId(), Map.of(
                            "operationId", attemptId(operation),
                            "kind", "cancel_run",
                            "automationRunId", target.recordId(),
                            "scheduleId", target.body().path("scheduleId").asText(),
                            "occurrenceKey", target.body().path("occurrenceKey").asText()));
            return;
        }
        if ("channel_delivery".equals(target.kind())) {
            harness.runChannelOperation(operation.tenantId(),
                    operation.sessionId(), Map.of(
                            "operationId", attemptId(operation),
                            "kind", "cancel_delivery",
                            "deliveryId", target.recordId()));
            return;
        }
        if (BACKGROUND_TASK_KINDS.contains(target.kind())) {
            if (broker == null) {
                throw new IllegalStateException(
                        "The Runtime Broker is not available");
            }
            CompletableFuture<?> stopping = broker.stopBackgroundProcess(
                    operation.tenantId(), operation.sessionId(),
                    target.recordId()).toCompletableFuture();
            // get(), not join(): the attempt deadline abandons a send with
            // an interrupt, which join() ignores, so a Broker stage that
            // never settles would hold this thread.
            try {
                stopping.get();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(
                        "The background process stop was interrupted", error);
            } catch (ExecutionException error) {
                throw new CompletionException(error.getCause());
            }
            return;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", attemptId(operation));
        body.put("kind", "cancel");
        body.put("childRunId", target.recordId());
        harness.runChildOperation(operation.tenantId(),
                operation.sessionId(), body);
    }

    private static String attemptId(OperationRecord operation) {
        return UUID.nameUUIDFromBytes(("qwen-task-cancel:\0"
                + operation.operationId() + "\0" + operation.attemptCount())
                .getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static boolean runtimeNotHere(Throwable error) {
        for (Throwable cause = error; cause != null;
                cause = cause.getCause()) {
            if (cause instanceof RuntimeBrokerException broker
                    && "runtime_session_not_found".equals(broker.getCode())) {
                return true;
            }
        }
        return false;
    }

    private void park(OperationRecord operation, String failure) {
        boolean parked = store.settleTaskCancel(operation.tenantId(),
                operation.sessionId(), operation.operationId(), owner,
                operation.claimGeneration(),
                TaskCancelOutcome.recoveryBlocked(UNCONFIRMED),
                Math.addExact(clock.millis(), PARKED_RECHECK.toMillis()));
        LOG.warn("Task cancel {} unconfirmed tenant={} session={}"
                        + " operation={} claims={} failure={}",
                parked ? "parks" : "lost its claim before parking",
                operation.tenantId(), operation.sessionId(),
                operation.operationId(), operation.claimGeneration(),
                failure);
    }

    private void retryOrPark(OperationRecord operation, String failure) {
        if (operation.claimGeneration() >= ATTEMPT_BUDGET) {
            park(operation, failure);
            return;
        }
        long delay = HarnessCoordinator.retryDelay(
                dispatch.getRetryInitialDelay(), dispatch.getRetryMaxDelay(),
                operation.attemptCount());
        store.retryOperation(operation.tenantId(), operation.sessionId(),
                operation.operationId(), owner, operation.claimGeneration(),
                Math.addExact(clock.millis(), delay));
        LOG.debug("Task cancel will retry operation={} failure={}",
                operation.operationId(), failure);
    }
}
