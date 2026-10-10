package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.TaskCancelOutcome;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

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
 * journal, and is read again.</li>
 * </ul>
 * A delivery whose outcome stays unproven retries with the dispatch
 * backoff, bounded at {@link #ATTEMPT_BUDGET} claims; past it the
 * operation parks as {@code recovery_blocked} — acceptance unknown, never
 * delivered again — and only reconciles from the record: a later stop
 * request (another cancel, the close cascade) completes it, an end
 * without one fails it. A parked cancel holds no lifecycle hostage. The
 * budget counts claims, not completed retries, and a live delivery
 * renews its lease, so an attempt that hangs past the lease can neither
 * be re-claimed underneath itself nor escape the budget.
 */
@Component
public class TaskCancelCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(
            TaskCancelCoordinator.class);
    private static final int SCAN_LIMIT = 50;
    /** Claims before an unproven outcome parks (one claim per attempt). */
    static final int ATTEMPT_BUDGET = 16;
    /** How often a parked cancel re-reads its task's record. */
    static final Duration PARKED_RECHECK = Duration.ofMinutes(5);
    static final String ALREADY_SETTLED = "task_already_settled";
    static final String UNCONFIRMED = "task_cancel_unconfirmed";

    private final AgentStateStore store;
    private final ManagedExtensionRecordStore records;
    private final HarnessConnector harness;
    private final ExecutorService executor;
    private final Clock clock;
    private final ManagedAgentProperties.Dispatch dispatch;
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

    public TaskCancelCoordinator(AgentStateStore store,
            ManagedExtensionRecordStore records, HarnessConnector harness,
            ExecutorService executor, Clock clock,
            ManagedAgentProperties properties) {
        this.store = store;
        this.records = records;
        this.harness = harness;
        this.executor = executor;
        this.clock = clock;
        this.dispatch = properties.getDispatch();
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
        for (OperationTarget target : store.findParkedTaskCancels(
                SCAN_LIMIT)) {
            try {
                reconcileParked(target);
            } catch (RuntimeException error) {
                // An unreadable record must not pin the parked row at the
                // head of the page: it waits a whole recheck like any
                // other unproven one.
                LOG.warn("Parked task cancel reconciliation failed tenant={}"
                                + " session={} operation={} failure={}",
                        target.tenantId(), target.sessionId(),
                        target.operationId(), error.getMessage());
                try {
                    store.settleTaskCancel(target.tenantId(),
                            target.sessionId(), target.operationId(), null,
                            0, TaskCancelOutcome.recoveryBlocked(UNCONFIRMED),
                            Math.addExact(clock.millis(),
                                    PARKED_RECHECK.toMillis()));
                } catch (RuntimeException ignored) {
                    // The next scan retries the whole reconciliation.
                }
            }
        }
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
        if (target.body().path("stopRequested").asBoolean(false)) {
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
                send(claimed, verdict.target());
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
                retryOrPark(claimed, error.getClass().getSimpleName() + ": "
                        + error.getMessage());
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

    /** The stop request onto the parent's journal; replay-safe there. */
    private void send(OperationRecord operation, TaskTarget target) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", UUID.nameUUIDFromBytes(("qwen-task-cancel:\0"
                + operation.operationId() + "\0" + operation.attemptCount())
                .getBytes(StandardCharsets.UTF_8)).toString());
        body.put("kind", "cancel");
        body.put("childRunId", target.recordId());
        harness.runChildOperation(operation.tenantId(),
                operation.sessionId(), body);
    }

    private void retryOrPark(OperationRecord operation, String failure) {
        if (operation.claimGeneration() >= ATTEMPT_BUDGET) {
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

    /** A parked cancel resolves only from evidence; it is never re-sent. */
    private void reconcileParked(OperationTarget target) {
        OperationRecord operation = store.findOperation(target.tenantId(),
                target.sessionId(), target.operationId()).orElse(null);
        if (operation == null
                || !"RECOVERY_BLOCKED".equals(operation.state())) {
            return;
        }
        Verdict verdict = verdict(operation);
        store.settleTaskCancel(operation.tenantId(), operation.sessionId(),
                operation.operationId(), null, 0,
                verdict.live() ? TaskCancelOutcome.recoveryBlocked(UNCONFIRMED)
                        : verdict.outcome(),
                Math.addExact(clock.millis(), PARKED_RECHECK.toMillis()));
    }
}
