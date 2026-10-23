package com.alibaba.qwen.code.managedagent.session;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore.TaskTarget;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore.TaskCancelOutcome;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

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
    private RuntimeBrokerService broker;
    private TaskCancelCoordinator coordinator;
    private final List<Map<String, Object>> sent = new CopyOnWriteArrayList<>();
    private final AtomicReference<TaskTarget> target = new AtomicReference<>();
    private final AtomicReference<RuntimeException> harnessFailure =
            new AtomicReference<>();
    private final AtomicReference<TaskTarget> afterSend =
            new AtomicReference<>();
    private int attempts;
    private final Logger coordinatorLog =
            (Logger) LoggerFactory.getLogger(TaskCancelCoordinator.class);
    private final ListAppender<ILoggingEvent> logged = new ListAppender<>();

    @AfterEach
    void detachLog() {
        coordinatorLog.detachAppender(logged);
    }

    @BeforeEach
    void setUp() {
        logged.start();
        coordinatorLog.addAppender(logged);
        store = mock(AgentStateStore.class);
        records = mock(ManagedExtensionRecordStore.class);
        harness = mock(HarnessConnector.class);
        broker = mock(RuntimeBrokerService.class);
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
                brokers(), new DirectExecutor(),
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
                brokers(), new DirectExecutor(),
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

    // A send that never returns (a client close wedged behind a reader on
    // a half-open Harness stream, which no interrupt reaches) must not
    // hold the claim, renewing its lease, for good: the delivery stops
    // waiting at the attempt deadline, so the claim retries and, at the
    // budget, parks like any other unproven outcome.
    @Test
    void aSendThatNeverReturnsIsAbandonedAtTheAttemptDeadline()
            throws Exception {
        ExecutorService executor = Executors.newCachedThreadPool();
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch interrupted = new CountDownLatch(1);
        try {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getDispatch().setLeaseDuration(Duration.ofMillis(30));
            coordinator = new TaskCancelCoordinator(store, records, harness,
                    broker, executor,
                    Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC),
                    properties, Duration.ofMillis(300));
            target.set(childRun("running", false));
            doAnswer(args -> {
                sent.add(Map.copyOf(args.getArgument(2)));
                while (release.getCount() > 0) {
                    try {
                        release.await();
                    } catch (InterruptedException ignored) {
                        interrupted.countDown();
                    }
                }
                return null;
            }).when(harness).runChildOperation(eq(TENANT), eq(SESSION),
                    any());
            coordinator.dispatch(TENANT, SESSION, OPERATION);
            verify(store, timeout(10_000)).retryOperation(eq(TENANT),
                    eq(SESSION), eq(OPERATION), anyString(), eq(1L),
                    anyLong());
            assertThat(sent).hasSize(1);
            assertThat(interrupted.await(10, TimeUnit.SECONDS)).isTrue();
            // The abandoned claim stops renewing its lease: the count
            // settles once the delivery returns, where it renewed every
            // 10 ms while the send ran.
            assertThat(renewals()).isPositive();
            long settled = settledRenewals();
            Thread.sleep(150);
            assertThat(renewals()).isEqualTo(settled);
            verify(store, never()).settleTaskCancel(anyString(), anyString(),
                    anyString(), any(), anyLong(), any(), anyLong());

            attempts = TaskCancelCoordinator.ATTEMPT_BUDGET - 1;
            coordinator.dispatch(TENANT, SESSION, OPERATION);
            verify(store, timeout(10_000)).settleTaskCancel(eq(TENANT),
                    eq(SESSION), eq(OPERATION), anyString(),
                    eq((long) TaskCancelCoordinator.ATTEMPT_BUDGET),
                    eq(TaskCancelOutcome.recoveryBlocked(
                            "task_cancel_unconfirmed")),
                    eq(1_000 + TaskCancelCoordinator.PARKED_RECHECK
                            .toMillis()));
            assertThat(sent).hasSize(2);

            // Released, each abandoned send says how it ended.
            release.countDown();
            ILoggingEvent returned = awaitLog(
                    "Abandoned task cancel send returned");
            assertThat(returned.getFormattedMessage()).contains(
                    "tenant=tenant", "session=session", "operation=op_1");
        } finally {
            release.countDown();
            executor.shutdownNow();
        }
    }

    // A send that fails after it was abandoned logs the failure with its
    // cause chain, where the interrupt that abandoned it shows.
    @Test
    void anAbandonedSendThatFailsLateLogsItsCause() throws Exception {
        ExecutorService executor = Executors.newCachedThreadPool();
        CountDownLatch release = new CountDownLatch(1);
        try {
            coordinator = new TaskCancelCoordinator(store, records, harness,
                    broker, executor,
                    Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC),
                    new ManagedAgentProperties(), Duration.ofMillis(200));
            target.set(childRun("running", false));
            doAnswer(args -> {
                awaitIgnoringInterrupts(release);
                throw new IllegalStateException("late refusal",
                        new InterruptedException());
            }).when(harness).runChildOperation(eq(TENANT), eq(SESSION),
                    any());
            coordinator.dispatch(TENANT, SESSION, OPERATION);
            verify(store, timeout(10_000)).retryOperation(eq(TENANT),
                    eq(SESSION), eq(OPERATION), anyString(), eq(1L),
                    anyLong());
            release.countDown();
            ILoggingEvent failed = awaitLog(
                    "Abandoned task cancel send failed");
            assertThat(failed.getFormattedMessage()).contains(
                    "operation=op_1", "IllegalStateException: late refusal");
            assertThat(failed.getThrowableProxy()).isNotNull();
            assertThat(failed.getThrowableProxy().getCause().getClassName())
                    .isEqualTo(InterruptedException.class.getName());
        } finally {
            release.countDown();
            executor.shutdownNow();
        }
    }

    // An interrupted delivery abandons its send the same way: the send
    // still logs how it ended.
    @Test
    void anInterruptedDeliveryAbandonsItsSendToo() throws Exception {
        ExecutorService executor = Executors.newCachedThreadPool();
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch sending = new CountDownLatch(1);
        AtomicReference<Thread> delivery = new AtomicReference<>();
        try {
            coordinator = new TaskCancelCoordinator(store, records, harness,
                    broker, executor,
                    Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC),
                    new ManagedAgentProperties(), Duration.ofMinutes(1));
            when(store.claimOperation(eq(TENANT), eq(SESSION), eq(OPERATION),
                    anyString(), any())).thenAnswer(ignored -> {
                        delivery.set(Thread.currentThread());
                        return Optional.of(operation("RUNNING", attempts));
                    });
            target.set(childRun("running", false));
            doAnswer(args -> {
                sending.countDown();
                awaitIgnoringInterrupts(release);
                return null;
            }).when(harness).runChildOperation(eq(TENANT), eq(SESSION),
                    any());
            coordinator.dispatch(TENANT, SESSION, OPERATION);
            assertThat(sending.await(10, TimeUnit.SECONDS)).isTrue();
            delivery.get().interrupt();
            verify(store, timeout(10_000)).retryOperation(eq(TENANT),
                    eq(SESSION), eq(OPERATION), anyString(), eq(1L),
                    anyLong());
            release.countDown();
            assertThat(awaitLog("Abandoned task cancel send returned")
                    .getFormattedMessage()).contains("operation=op_1");
        } finally {
            release.countDown();
            executor.shutdownNow();
        }
    }

    private ILoggingEvent awaitLog(String prefix) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            List<ILoggingEvent> events;
            // Appends hold the appender's monitor; copy under it too.
            synchronized (logged) {
                events = new java.util.ArrayList<>(logged.list);
            }
            for (ILoggingEvent event : events) {
                if (event.getFormattedMessage().startsWith(prefix)) {
                    return event;
                }
            }
            Thread.sleep(10);
        }
        throw new AssertionError("no log starting with: " + prefix);
    }

    // Like the real wedge (a lock wait), the held send ignores interrupts.
    private static void awaitIgnoringInterrupts(CountDownLatch release) {
        while (release.getCount() > 0) {
            try {
                release.await();
            } catch (InterruptedException ignored) {
                // keep holding
            }
        }
    }

    // A Harness configured with longer requests raises the deadline; it
    // never drops below the floor.
    @Test
    void theAttemptDeadlineCoversFourHarnessRequests() {
        assertThat(coordinator.attemptDeadline())
                .isEqualTo(TaskCancelCoordinator.ATTEMPT_DEADLINE);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setRequestTimeout(Duration.ofMinutes(2));
        assertThat(new TaskCancelCoordinator(store, records, harness,
                brokers(), new DirectExecutor(), Clock.systemUTC(),
                properties)
                .attemptDeadline()).isEqualTo(Duration.ofMinutes(8));
        assertThat(TaskCancelCoordinator.deadlineFor(null))
                .isEqualTo(TaskCancelCoordinator.ATTEMPT_DEADLINE);
    }

    private long settledRenewals() throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        long before;
        do {
            before = renewals();
            Thread.sleep(100);
        } while (renewals() != before && System.nanoTime() < deadline);
        return before;
    }

    private long renewals() {
        return mockingDetails(store).getInvocations().stream()
                .filter(call -> call.getMethod().getName()
                        .equals("renewLifecycleOperation"))
                .count();
    }

    @Test
    void aTaskWithoutACancelPathFailsWithoutDelivery() {
        target.set(new TaskTarget("unknown", "unknown-1",
                "unknown", "running", 1, JSON.createObjectNode()));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        assertThat(mockingDetails(broker).getInvocations()).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_action_unavailable")),
                eq(0L));
    }

    private TaskTarget automationRun(String state) {
        return new TaskTarget("automation_run", "arun_" + "1".repeat(64),
                "automation_run", state, 2, JSON.createObjectNode()
                        .put("scheduleId", "asch_" + "1".repeat(32))
                        .put("occurrenceKey", "manual:original"));
    }

    private void automationSend() {
        when(harness.runAutomationOperation(eq(TENANT), eq(SESSION), any()))
                .thenAnswer(args -> {
                    sent.add(Map.copyOf(args.getArgument(2)));
                    if (afterSend.get() != null) {
                        target.set(afterSend.get());
                    }
                    if (harnessFailure.get() != null) {
                        throw harnessFailure.get();
                    }
                    return Map.of("state", "settled");
                });
    }

    @Test
    void anAutomationCancelTargetsOnlyItsOriginalOccurrence() {
        automationSend();
        target.set(automationRun("running"));
        afterSend.set(automationRun("cancelled"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).hasSize(1);
        assertThat(sent.getFirst()).containsEntry("kind", "cancel_run")
                .containsEntry("automationRunId", "arun_" + "1".repeat(64))
                .containsEntry("scheduleId", "asch_" + "1".repeat(32))
                .containsEntry("occurrenceKey", "manual:original");
        verify(harness, never()).runChildOperation(any(), any(), any());
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION), eq(OPERATION),
                anyString(), eq(1L), eq(TaskCancelOutcome.completed()), eq(0L));
    }

    @Test
    void anAutomationCancelReadsCommittedProofEvenWhenTheReplyWasLost() {
        automationSend();
        target.set(automationRun("running"));
        afterSend.set(automationRun("cancelled"));
        harnessFailure.set(new IllegalStateException("reply lost"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION), eq(OPERATION),
                anyString(), eq(1L), eq(TaskCancelOutcome.completed()), eq(0L));
    }

    @Test
    void anAutomationAcknowledgmentAloneIsNotCancellationProof() {
        automationSend();
        target.set(automationRun("running"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store, never()).settleTaskCancel(any(), any(), any(), any(),
                anyLong(), eq(TaskCancelOutcome.completed()), anyLong());
    }

    @Test
    void aNaturallySettledAutomationKeepsItsOutcome() {
        automationSend();
        target.set(automationRun("running"));
        afterSend.set(automationRun("completed"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION), eq(OPERATION),
                anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")), eq(0L));
    }

    @Test
    void aParkedAutomationCancelReconcilesWithoutDelivery() {
        ParkedOperation parked = new ParkedOperation(TENANT, SESSION,
                OPERATION, "TASK_CANCEL");
        when(store.findOperation(TENANT, SESSION, OPERATION))
                .thenReturn(Optional.of(operation("RECOVERY_BLOCKED", 16)));
        target.set(automationRun("running"));
        assertThat(coordinator.read(parked).orElseThrow())
                .isEqualTo(AcceptanceVerdict.unknown());
        target.set(automationRun("cancelled"));
        assertThat(coordinator.read(parked).orElseThrow())
                .isEqualTo(AcceptanceVerdict.committed());
        assertThat(sent).isEmpty();
        verify(harness, never()).runAutomationOperation(any(), any(), any());
    }

    // H4f-b: a workflow run rides the same record-first delivery — the
    // kind gate admits it and every outcome is read from its record.
    @Test
    void aLiveWorkflowRunTakesTheStopRequestAndCompletesFromTheRecord() {
        target.set(workflowRun("running", false));
        afterSend.set(workflowRun("running", true));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).hasSize(1);
        assertThat(sent.getFirst()).containsEntry("kind", "cancel")
                .containsEntry("childRunId", "run-1");
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    @Test
    void aWorkflowStopAlreadyRecordedCoalescesWithoutDelivery() {
        target.set(workflowRun("running", true));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    @Test
    void aWorkflowRunThatEndedWithoutAStopFailsDefinitively() {
        target.set(workflowRun("completed", false));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                eq(0L));
    }

    // H4f-c: a background process is stopped through the Broker, never
    // the child operation route, and the record its stop-marked end
    // settled is the only outcome that counts.
    @Test
    void aLiveBackgroundShellIsStoppedThroughTheBroker() {
        target.set(shellRun("running", false, null));
        stopThen(shellRun("cancelled", true, "stop_requested"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        verify(broker).stopBackgroundProcess(TENANT, SESSION, "shell-1");
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    // A Monitor's record carries no stop request: its stop_requested
    // settlement is the statement that the stop was recorded.
    @Test
    void aMonitorCompletesFromItsStopRequestedSettlement() {
        target.set(monitorRun("running", null));
        stopThen(monitorRun("cancelled", "stop_requested"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(broker).stopBackgroundProcess(TENANT, SESSION, "monitor-1");
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    // A natural end the stop's own status read found first wins: the
    // record ended without a stop, so the cancel can never land.
    @Test
    void aBackgroundProcessThatEndedFirstKeepsItsOutcome() {
        target.set(shellRun("running", false, null));
        stopThen(shellRun("completed", false, "exited"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                eq(0L));
        target.set(monitorRun("completed", "idle_timeout"));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(broker, never()).stopBackgroundProcess(TENANT, SESSION,
                "monitor-1");
        verify(store, org.mockito.Mockito.times(2)).settleTaskCancel(
                eq(TENANT), eq(SESSION), eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                eq(0L));
    }

    // An unproven stop (the worker could not prove the end) or a missing
    // Broker proves nothing: the record is read again and the delivery
    // retries on the budget.
    @Test
    void anUnprovenBackgroundStopRetriesFromTheRecord() {
        target.set(monitorRun("running", null));
        when(broker.stopBackgroundProcess(TENANT, SESSION, "monitor-1"))
                .thenReturn(java.util.concurrent.CompletableFuture
                        .failedFuture(new IllegalStateException(
                                "the worker answered unknown")));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).retryOperation(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L), anyLong());
        verify(store, never()).settleTaskCancel(anyString(), anyString(),
                anyString(), any(), anyLong(), any(), anyLong());
        coordinator = new TaskCancelCoordinator(store, records, harness,
                null, new DirectExecutor(),
                Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC),
                new ManagedAgentProperties(), Duration.ofMinutes(1));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store, org.mockito.Mockito.times(2)).retryOperation(
                eq(TENANT), eq(SESSION), eq(OPERATION), anyString(), eq(1L),
                anyLong());
    }

    // A Broker stop that never settles is abandoned at the attempt
    // deadline like any send: the interrupt reaches the wait on the stage,
    // so the send's thread is given back instead of held until it settles.
    @Test
    void anAbandonedBackgroundStopGivesItsThreadBack() throws Exception {
        ExecutorService executor = Executors.newCachedThreadPool();
        try {
            coordinator = new TaskCancelCoordinator(store, records, harness,
                    broker, executor,
                    Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC),
                    new ManagedAgentProperties(), Duration.ofMillis(200));
            target.set(shellRun("running", false, null));
            when(broker.stopBackgroundProcess(TENANT, SESSION, "shell-1"))
                    .thenReturn(new java.util.concurrent.CompletableFuture<>());
            coordinator.dispatch(TENANT, SESSION, OPERATION);
            verify(store, timeout(10_000)).retryOperation(eq(TENANT),
                    eq(SESSION), eq(OPERATION), anyString(), eq(1L),
                    anyLong());
            assertThat(awaitLog("Abandoned task cancel send failed")
                    .getFormattedMessage()).contains("operation=op_1",
                            "The background process stop was interrupted");
        } finally {
            executor.shutdownNow();
        }
    }

    // #13746 F3: a pending delivery takes its cancel through its route
    // Session's channel operation route; its cancelRequested flag is the
    // request the outcome is read from.
    @Test
    void aPendingDeliveryTakesItsCancelThroughTheChannelRoute() {
        List<Map<String, Object>> channel = new CopyOnWriteArrayList<>();
        when(harness.runChannelOperation(eq(TENANT), eq(SESSION), any()))
                .thenAnswer(args -> {
                    channel.add(Map.copyOf(args.getArgument(2)));
                    target.set(delivery("cancelled", true));
                    return Map.of();
                });
        target.set(delivery("pending", false));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        assertThat(sent).isEmpty();
        assertThat(channel).hasSize(1);
        assertThat(channel.getFirst()).containsEntry("kind", "cancel_delivery")
                .containsEntry("deliveryId", "delivery-1")
                .containsKey("operationId");
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
    }

    // An adapter that claimed it first keeps sending it: the request is
    // recorded and the delivery keeps its natural outcome; one that was
    // delivered without a request fails the cancel definitively.
    @Test
    void aDeliveryClaimedFirstKeepsItsOutcome() {
        when(harness.runChannelOperation(eq(TENANT), eq(SESSION), any()))
                .thenAnswer(args -> {
                    target.set(delivery("running", true));
                    return Map.of();
                });
        target.set(delivery("pending", false));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.completed()), eq(0L));
        target.set(delivery("completed", false));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(harness).runChannelOperation(eq(TENANT), eq(SESSION), any());
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                eq(0L));
    }

    // The channel route re-runs the route Session's Workspace authority on
    // every operation, a cached attachment included: while its creator
    // lacks the execution grant the cancel sends nothing, retries and
    // parks. Parked, it is never sent again, so a delivery an adapter sent
    // after the grant returned fails it from the record.
    @Test
    void aDeliveryCancelTheRouteRefusesParksAndSettlesFromTheRecord() {
        when(harness.runChannelOperation(eq(TENANT), eq(SESSION), any()))
                .thenThrow(WorkspaceExecutionStore.unavailable());
        target.set(delivery("pending", false));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).retryOperation(eq(TENANT), eq(SESSION), eq(OPERATION),
                anyString(), eq(1L), anyLong());
        attempts = TaskCancelCoordinator.ATTEMPT_BUDGET - 1;
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(),
                eq((long) TaskCancelCoordinator.ATTEMPT_BUDGET),
                eq(TaskCancelOutcome.recoveryBlocked(
                        "task_cancel_unconfirmed")),
                eq(1_000 + TaskCancelCoordinator.PARKED_RECHECK.toMillis()));

        // Parked, only the reconciler (D7-2) reads it, from the record.
        ParkedOperation parked = new ParkedOperation(TENANT, SESSION,
                OPERATION, "TASK_CANCEL");
        when(store.findParkedOperations(
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(parked));
        when(store.findOperation(TENANT, SESSION, OPERATION))
                .thenReturn(Optional.of(operation("RECOVERY_BLOCKED", 16)));
        OperationReconciler reconciler = new OperationReconciler(store,
                List.of(coordinator), new DirectExecutor(),
                Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC));
        reconciler.reconcile();
        verify(store).settleParkedOperation(eq(parked),
                eq(AcceptanceVerdict.unknown()), anyLong());
        target.set(delivery("completed", false));
        reconciler.reconcile();
        verify(store).settleParkedOperation(eq(parked),
                eq(AcceptanceVerdict.notCommitted("task_already_settled")),
                anyLong());
        verify(harness, org.mockito.Mockito.times(2)).runChannelOperation(
                eq(TENANT), eq(SESSION), any());
    }

    // A Broker process that holds no context for the Runtime Session (a
    // fresh one before a turn or the close acquires it again) cannot stop
    // the process on any retry: the cancel parks at once, so it stops
    // holding the Session's operation slot and the close goes ahead.
    @Test
    void aStopTheBrokerCannotReachHereParksAtOnce() {
        target.set(shellRun("running", false, null));
        when(broker.stopBackgroundProcess(TENANT, SESSION, "shell-1"))
                .thenReturn(java.util.concurrent.CompletableFuture
                        .failedFuture(new com.alibaba.qwen.code.runtimebroker
                                .RuntimeBrokerException(404,
                                        "runtime_session_not_found",
                                        "Runtime Session is not active in"
                                                + " this Broker process",
                                        false)));
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.recoveryBlocked(
                        "task_cancel_unconfirmed")), anyLong());
        verify(store, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong());
    }

    // The record is read again before the park: a process that ended
    // while the unreachable stop was tried settles the cancel instead.
    @Test
    void anUnreachableStopOverAnEndedProcessSettlesFromTheRecord() {
        target.set(shellRun("running", false, null));
        when(broker.stopBackgroundProcess(TENANT, SESSION, "shell-1"))
                .thenAnswer(ignored -> {
                    target.set(shellRun("completed", false, "exited"));
                    return java.util.concurrent.CompletableFuture
                            .failedFuture(new com.alibaba.qwen.code
                                    .runtimebroker.RuntimeBrokerException(
                                            404, "runtime_session_not_found",
                                            "Runtime Session is not active"
                                                    + " in this Broker process",
                                            false));
                });
        coordinator.dispatch(TENANT, SESSION, OPERATION);
        verify(broker).stopBackgroundProcess(TENANT, SESSION, "shell-1");
        verify(store).settleTaskCancel(eq(TENANT), eq(SESSION),
                eq(OPERATION), anyString(), eq(1L),
                eq(TaskCancelOutcome.failed("task_already_settled")),
                eq(0L));
        verify(store, never()).settleTaskCancel(anyString(), anyString(),
                anyString(), any(), anyLong(),
                eq(TaskCancelOutcome.recoveryBlocked(
                        "task_cancel_unconfirmed")), anyLong());
    }

    @SuppressWarnings("unchecked")
    private ObjectProvider<RuntimeBrokerService> brokers() {
        ObjectProvider<RuntimeBrokerService> provider =
                mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(broker);
        return provider;
    }

    private static TaskTarget childRun(String state, boolean stopRequested) {
        return new TaskTarget("child_run", "run-1", "child_agent", state, 3,
                JSON.createObjectNode().put("kind", "child_agent")
                        .put("stopRequested", stopRequested));
    }

    private void stopThen(TaskTarget after) {
        when(broker.stopBackgroundProcess(eq(TENANT), eq(SESSION),
                anyString())).thenAnswer(ignored -> {
                    target.set(after);
                    return java.util.concurrent.CompletableFuture
                            .completedFuture(null);
                });
    }

    private static TaskTarget shellRun(String state, boolean stopRequested,
            String stopReason) {
        return new TaskTarget("child_run", "shell-1", "background_shell",
                state, 3, JSON.createObjectNode().put("kind", "shell")
                        .put("stopRequested", stopRequested)
                        .put("stopReason", stopReason));
    }

    private static TaskTarget monitorRun(String state, String stopReason) {
        return new TaskTarget("monitor_run", "monitor-1", "monitor", state,
                3, JSON.createObjectNode().put("monitorId", "monitor-1")
                        .put("stopReason", stopReason));
    }

    private static TaskTarget delivery(String state,
            boolean cancelRequested) {
        return new TaskTarget("channel_delivery", "delivery-1",
                "channel_delivery", state, 3, JSON.createObjectNode()
                        .put("deliveryId", "delivery-1")
                        .put("cancelRequested", cancelRequested));
    }

    private static TaskTarget workflowRun(String state,
            boolean stopRequested) {
        return new TaskTarget("child_run", "run-1", "workflow", state, 3,
                JSON.createObjectNode().put("kind", "workflow")
                        .put("stopRequested", stopRequested));
    }

    private static OperationRecord operation(String state, int attempts) {
        return new OperationRecord(TENANT, SESSION, OPERATION,
                OperationKind.TASK_CANCEL, "digest", state, "JAVA_DURABLE",
                "RUNNING".equals(state) ? "LEASED" : "BLOCKED", "ACTIVE",
                null, "owner", attempts + 1, attempts, null, null, null,
                null, 0, 0, null, TASK);
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
