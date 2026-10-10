package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.TaskCancelOutcome;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * H4f delivery: every outcome is read from the task's committed record,
 * never from the wire answer, and an unproven delivery parks after its
 * budget instead of holding the Session's operation slot forever.
 */
class TaskCancelCoordinatorTest {
    private static final String TENANT = "tenant";
    private static final String SESSION = "session";
    private static final String OPERATION = "op_1";
    private static final String TASK = "task_" + "a".repeat(64);
    private static final ObjectMapper JSON = new ObjectMapper();

    private AgentStateStore store;
    private ManagedExtensionRecordStore records;
    private HarnessConnector harness;
    private TaskCancelCoordinator coordinator;
    private final List<Map<String, Object>> sent = new CopyOnWriteArrayList<>();
    private final AtomicReference<TaskTarget> target = new AtomicReference<>();
    private final AtomicReference<RuntimeException> harnessFailure =
            new AtomicReference<>();
    private final AtomicReference<TaskTarget> afterSend =
            new AtomicReference<>();
    private int attempts;

    @BeforeEach
    void setUp() {
        store = mock(AgentStateStore.class);
        records = mock(ManagedExtensionRecordStore.class);
        harness = mock(HarnessConnector.class);
        doAnswer(args -> {
            sent.add(Map.copyOf(args.getArgument(2)));
            if (harnessFailure.get() != null) {
                throw harnessFailure.get();
            }
            if (afterSend.get() != null) {
                target.set(afterSend.get());
            }
            return null;
        }).when(harness).runChildOperation(eq(TENANT), eq(SESSION), any());
        when(records.findTaskTarget(TENANT, SESSION, TASK))
                .thenAnswer(ignored -> Optional.ofNullable(target.get()));
        when(store.claimOperation(eq(TENANT), eq(SESSION), eq(OPERATION),
                anyString(), any())).thenAnswer(ignored ->
                        Optional.of(operation("RUNNING", attempts)));
        when(store.settleTaskCancel(anyString(), anyString(), anyString(),
                any(), anyLong(), any(), anyLong())).thenReturn(true);
        coordinator = new TaskCancelCoordinator(store, records, harness,
                new DirectExecutor(),
                Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC),
                new ManagedAgentProperties());
    }

    @Test
    void aLiveRunTakesTheStopRequestAndCompletesFromTheRecord() {
        target.set(childRun("running", false));
        afterSend.set(childRun("running", true));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).hasSize(1);
        assertThat(sent.getFirst()).containsEntry("kind", "cancel")
                .containsEntry("childRunId", "run-1");
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    @Test
    void aStopAlreadyRecordedCoalescesWithoutDelivery() {
        // The close cascade or another cancel recorded it first.
        target.set(childRun("running", true));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
        // A run that settled after its stop request keeps the request, so
        // the cancel was recorded whatever settled the run after it.
        target.set(childRun("completed", true));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(store, org.mockito.Mockito.times(2)).settleTaskCancel(
                eq(TENANT), eq(SESSION), eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
        verify(store, never()).settleTaskCancel(anyString(), anyString(),
                anyString(), any(), anyLong(),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                anyLong());
    }

    @Test
    void aRunThatEndedWithoutAStopFailsDefinitively() {
        target.set(childRun("completed", false));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                eq(0L));
    }

    @Test
    void aRefusalIsJudgedByTheRecordNotTheWire() {
        // The authority refused because the run settled meanwhile: a
        // natural completion that won the race keeps its outcome.
        target.set(childRun("running", false));
        harnessFailure.set(new IllegalStateException("409"));
        doAnswer(args -> {
            target.set(childRun("completed", false));
            throw harnessFailure.get();
        }).when(harness).runChildOperation(eq(TENANT), eq(SESSION), any());
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                eq(0L));
        // A lost reply after the commit landed completes it instead.
        target.set(childRun("running", false));
        doAnswer(args -> {
            target.set(childRun("running", true));
            throw new IllegalStateException("reply lost");
        }).when(harness).runChildOperation(eq(TENANT), eq(SESSION), any());
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    @Test
    void anUnprovenDeliveryRetriesThenParks() {
        target.set(childRun("running", false));
        harnessFailure.set(new IllegalStateException("harness down"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).retryOperation(eq(TENANT), eq(SESSION), eq(OPERATION),
                anyString(), eq(1L), anyLong());
        verify(store, never()).settleTaskCancel(anyString(), anyString(),
                anyString(), any(), anyLong(), any(), anyLong());
        attempts = TaskCancelCoordinator.ATTEMPT_BUDGET - 1;
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(),
                eq((long) TaskCancelCoordinator.ATTEMPT_BUDGET),
                eq(TaskCancelOutcome.recoveryBlocked(
                        "task_cancel_unconfirmed")),
                eq(1_000 + TaskCancelCoordinator.PARKED_RECHECK.toMillis()));
    }

    // A claim that outlived its lease never counted a retry, so the
    // budget counts claims: one past it parks on the record alone.
    @Test
    void aClaimPastTheBudgetParksWithoutSending() {
        target.set(childRun("running", false));
        attempts = TaskCancelCoordinator.ATTEMPT_BUDGET;
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(),
                eq((long) TaskCancelCoordinator.ATTEMPT_BUDGET + 1),
                eq(TaskCancelOutcome.recoveryBlocked(
                        "task_cancel_unconfirmed")), anyLong());
        // The record still decides first: a stop recorded meanwhile
        // completes it even past the budget.
        target.set(childRun("running", true));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(),
                eq((long) TaskCancelCoordinator.ATTEMPT_BUDGET + 1),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    // A delivery that outlasts its lease keeps it, so no other worker
    // re-claims the operation underneath the hanging send.
    @Test
    void aSlowDeliveryRenewsItsLease() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setLeaseDuration(
                java.time.Duration.ofMillis(30));
        coordinator = new TaskCancelCoordinator(store, records, harness,
                new DirectExecutor(),
                Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC),
                properties);
        target.set(childRun("running", false));
        doAnswer(args -> {
            Thread.sleep(200);
            target.set(childRun("running", true));
            return null;
        }).when(harness).runChildOperation(eq(TENANT), eq(SESSION), any());
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store, org.mockito.Mockito.atLeastOnce())
                .renewLifecycleOperation(eq(TENANT), eq(SESSION),
                        eq(OPERATION), anyString(), eq(1L),
                        eq(java.time.Duration.ofMillis(30)));
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    // An unreadable record must not pin a parked cancel at the head of
    // the page: it is parked again for a whole recheck.
    @Test
    void aParkedReconciliationThatFailsWaitsAWholeRecheck() {
        when(store.findParkedTaskCancels(anyInt()))
                .thenReturn(List.of(new OperationTarget(TENANT, SESSION,
                        OPERATION)));
        when(store.findOperation(TENANT, SESSION, OPERATION))
                .thenReturn(Optional.of(operation("RECOVERY_BLOCKED", 16)));
        when(records.findTaskTarget(TENANT, SESSION, TASK))
                .thenThrow(new IllegalStateException("resource gone"));
        coordinator.recover();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), isNull(), eq(0L),
                eq(TaskCancelOutcome.recoveryBlocked(
                        "task_cancel_unconfirmed")),
                eq(1_000 + TaskCancelCoordinator.PARKED_RECHECK.toMillis()));
        assertThat(sent).isEmpty();
    }

    @Test
    void aTaskWithoutACancelPathFailsWithoutDelivery() {
        target.set(new TaskTarget("monitor_run", "monitor-1", "monitor",
                "running", 1, JSON.createObjectNode()));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_action_unavailable")),
                eq(0L));
    }

    @Test
    void aParkedCancelResolvesOnlyFromEvidence() {
        when(store.findParkedTaskCancels(anyInt()))
                .thenReturn(List.of(new OperationTarget(TENANT, SESSION,
                        OPERATION)));
        when(store.findOperation(TENANT, SESSION, OPERATION))
                .thenReturn(Optional.of(operation("RECOVERY_BLOCKED", 16)));
        target.set(childRun("running", false));
        coordinator.recover();
        // Still unproven: re-parked, never re-sent.
        assertThat(sent).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), isNull(), eq(0L),
                eq(TaskCancelOutcome.recoveryBlocked(
                        "task_cancel_unconfirmed")), anyLong());
        // The close cascade recorded a stop since: the parked cancel's
        // request is recorded too.
        target.set(childRun("running", true));
        coordinator.recover();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), isNull(), eq(0L),
                eq(TaskCancelOutcome.completed()), anyLong());
        assertThat(sent).isEmpty();
    }

    private static int anyInt() {
        return org.mockito.ArgumentMatchers.anyInt();
    }

    private static TaskTarget childRun(String state, boolean stopRequested) {
        return new TaskTarget("child_run", "run-1", "child_agent", state, 3,
                JSON.createObjectNode().put("kind", "child_agent")
                        .put("stopRequested", stopRequested));
    }

    private static OperationRecord operation(String state, int attempts) {
        return new OperationRecord(TENANT, SESSION, OPERATION,
                OperationKind.TASK_CANCEL, "digest", state, "JAVA_DURABLE",
                "RUNNING".equals(state) ? "LEASED" : "BLOCKED", "ACTIVE",
                null, "owner", attempts + 1, attempts, null, null, null,
                null, 0, null, TASK);
    }

    private static final class DirectExecutor
            extends AbstractExecutorService {
        @Override
        public void execute(Runnable command) {
            command.run();
        }

        @Override
        public void shutdown() {
        }

        @Override
        public List<Runnable> shutdownNow() {
            return List.of();
        }

        @Override
        public boolean isShutdown() {
            return false;
        }

        @Override
        public boolean isTerminated() {
            return false;
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return true;
        }
    }
}
