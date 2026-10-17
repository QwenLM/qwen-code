package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * D7-2: one rule settles every acceptance-unknown operation, and only from
 * its kind's evidence. A parked operation is never claimed or sent again.
 */
class OperationReconcilerTest {
    private static final String TENANT = "tenant";
    private static final String SESSION = "session";
    private static final String CANCEL = "op_cancel";
    private static final String INPUT = "op_input";
    private static final String TASK = "task_" + "a".repeat(64);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long RECHECK_AT =
            1_000 + OperationReconciler.RECHECK.toMillis();
    private static final ParkedOperation PARKED_CANCEL = new ParkedOperation(
            TENANT, SESSION, CANCEL, "TASK_CANCEL");
    private static final ParkedOperation PARKED_INPUT = new ParkedOperation(
            TENANT, SESSION, INPUT, "SUBMIT_INPUT");
    private static final ParkedOperation PARKED_TITLE = new ParkedOperation(
            TENANT, SESSION, "rename:3", "RENAME");

    private AgentStateStore store;
    private ManagedExtensionRecordStore records;
    private HarnessConnector harness;
    private RuntimeBrokerService broker;
    private OperationReconciler reconciler;
    private final AtomicReference<TaskTarget> target = new AtomicReference<>();

    @BeforeEach
    void setUp() {
        store = mock(AgentStateStore.class);
        records = mock(ManagedExtensionRecordStore.class);
        harness = mock(HarnessConnector.class);
        broker = mock(RuntimeBrokerService.class);
        when(records.findTaskTarget(TENANT, SESSION, TASK))
                .thenAnswer(ignored -> Optional.ofNullable(target.get()));
        when(store.findOperation(TENANT, SESSION, CANCEL)).thenReturn(
                Optional.of(parked(CANCEL, OperationKind.TASK_CANCEL)));
        when(store.findOperation(TENANT, SESSION, INPUT)).thenReturn(
                Optional.of(parked(INPUT, OperationKind.SUBMIT_INPUT)));
        when(store.settleParkedOperation(any(), any(), anyLong()))
                .thenReturn(true);
        Clock clock = Clock.fixed(Instant.ofEpochMilli(1_000),
                ZoneOffset.UTC);
        TaskCancelCoordinator cancels = new TaskCancelCoordinator(store,
                records, harness, brokers(),
                Executors.newVirtualThreadPerTaskExecutor(), clock,
                new ManagedAgentProperties());
        reconciler = new OperationReconciler(store,
                List.of(cancels, new TurnInputEvidence(store),
                        new RenameEvidence(store)), DIRECT,
                clock);
    }

    @Test
    void aParkedCancelResolvesOnlyFromEvidence() {
        when(store.findParkedOperations(anyInt()))
                .thenReturn(List.of(PARKED_CANCEL));
        target.set(childRun("running", false));
        reconciler.reconcile();
        // Still unproven: parked again, never sent.
        verify(store).settleParkedOperation(PARKED_CANCEL,
                AcceptanceVerdict.unknown(), RECHECK_AT);
        // The close cascade recorded a stop since: the parked cancel's
        // request is recorded too.
        target.set(childRun("running", true));
        reconciler.reconcile();
        verify(store).settleParkedOperation(PARKED_CANCEL,
                AcceptanceVerdict.committed(), RECHECK_AT);
        assertNothingSent();
    }

    @Test
    void aParkedCancelWhoseTaskEndedWithoutAStopFails() {
        when(store.findParkedOperations(anyInt()))
                .thenReturn(List.of(PARKED_CANCEL));
        target.set(childRun("completed", false));
        reconciler.reconcile();
        verify(store).settleParkedOperation(PARKED_CANCEL,
                AcceptanceVerdict.notCommitted("task_already_settled"),
                RECHECK_AT);
        assertNothingSent();
    }

    // An unreadable record must not pin a parked operation at the head of
    // the page: it is parked again for a whole recheck.
    @Test
    void aReconciliationThatFailsWaitsAWholeRecheck() {
        when(store.findParkedOperations(anyInt()))
                .thenReturn(List.of(PARKED_CANCEL));
        when(records.findTaskTarget(TENANT, SESSION, TASK))
                .thenThrow(new IllegalStateException("resource gone"));
        reconciler.reconcile();
        verify(store).settleParkedOperation(PARKED_CANCEL,
                AcceptanceVerdict.unknown(), RECHECK_AT);
        assertNothingSent();
    }

    // A Turn input reads the Session journal through the store, and the
    // same rule settles it: the Harness is never asked again.
    @Test
    void aParkedInputSettlesFromTheJournalOnly() {
        when(store.findParkedOperations(anyInt()))
                .thenReturn(List.of(PARKED_INPUT));
        when(store.turnInputAcceptance(TENANT, SESSION, INPUT))
                .thenReturn(AcceptanceVerdict.unknown(),
                        AcceptanceVerdict.committed());
        reconciler.reconcile();
        verify(store).settleParkedOperation(PARKED_INPUT,
                AcceptanceVerdict.unknown(), RECHECK_AT);
        reconciler.reconcile();
        verify(store).settleParkedOperation(PARKED_INPUT,
                AcceptanceVerdict.committed(), RECHECK_AT);
        assertNothingSent();
    }

    // A parked title keeps its claim for its own late reply, so the generic
    // settle, which only takes unclaimed rows, would never match it: the
    // title settles through its own store call, from the journal only.
    @Test
    void aParkedTitleSettlesThroughItsOwnSettle() {
        when(store.findParkedOperations(anyInt()))
                .thenReturn(List.of(PARKED_TITLE));
        when(store.renameAcceptance(PARKED_TITLE)).thenReturn(
                Optional.of(AcceptanceVerdict.unknown()),
                Optional.of(AcceptanceVerdict.committed()), Optional.empty());
        reconciler.reconcile();
        verify(store).settleParkedRename(PARKED_TITLE,
                AcceptanceVerdict.unknown(), RECHECK_AT);
        reconciler.reconcile();
        verify(store).settleParkedRename(PARKED_TITLE,
                AcceptanceVerdict.committed(), RECHECK_AT);
        // Settled since the scan: nothing is recorded.
        reconciler.reconcile();
        verify(store, never()).settleParkedOperation(any(), any(), anyLong());
        verify(store, never()).deliverableRenames(anyLong());
        verify(store, never()).claimRename(any(), any(), any());
        assertNothingSent();
    }

    // The settle's own guard keeps a row that left the parked state, but
    // the reconciler does not even read evidence for one.
    @Test
    void aRowNoLongerParkedIsLeftAlone() {
        when(store.findParkedOperations(anyInt()))
                .thenReturn(List.of(PARKED_INPUT));
        when(store.findOperation(TENANT, SESSION, INPUT)).thenReturn(
                Optional.of(operation(INPUT, OperationKind.SUBMIT_INPUT,
                        "COMPLETED")));
        reconciler.reconcile();
        verify(store, never()).turnInputAcceptance(any(), any(), any());
        verify(store, never()).settleParkedOperation(any(), any(),
                anyLong());
    }

    // A kind outside any Session lists its own parked rows and settles with
    // effects of its own, also when its evidence cannot be read; the Session
    // store's settle never touches it.
    @Test
    void aKindOutsideAnySessionScansAndSettlesThroughItsSource() {
        ParkedOperation landed = new ParkedOperation(TENANT, null, "wop_1",
                "WORKSPACE_CREATE");
        ParkedOperation unreadable = new ParkedOperation(TENANT, null,
                "wop_2", "WORKSPACE_CREATE");
        List<String> settled = new java.util.ArrayList<>();
        AcceptanceEvidence source = new AcceptanceEvidence() {
            @Override
            public String kind() {
                return "WORKSPACE_CREATE";
            }

            @Override
            public Optional<AcceptanceVerdict> read(ParkedOperation parked) {
                if (parked.equals(unreadable)) {
                    throw new IllegalStateException("node unreachable");
                }
                return Optional.of(AcceptanceVerdict.committed());
            }

            @Override
            public boolean settle(AgentStateStore ignored,
                    ParkedOperation parked, AcceptanceVerdict verdict,
                    long retryAt) {
                settled.add(parked.operationId() + ":"
                        + verdict.acceptance() + "@" + retryAt);
                return true;
            }

            @Override
            public List<ParkedOperation> parked(int limit) {
                return List.of(landed, unreadable);
            }
        };
        new OperationReconciler(store, List.of(source), DIRECT,
                Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC))
                .reconcile();
        assertThat(settled).containsExactly("wop_1:COMMITTED@" + RECHECK_AT,
                "wop_2:UNKNOWN@" + RECHECK_AT);
        verify(store, never()).settleParkedOperation(any(), any(),
                anyLong());
    }

    // Review of #14456: evidence may block (an SSH probe waits up to a
    // minute on its node), yet the scan runs on the scheduler every other
    // coordinator's recovery shares. The scan only hands rows out, so the
    // next task on that single thread runs while the probe is still blocked,
    // and a row being reconciled is not handed out twice.
    @Test
    void aBlockedEvidenceReadNeverHoldsTheSharedScheduler()
            throws Exception {
        ParkedOperation registration = new ParkedOperation(TENANT, null,
                "wop_1", "WORKSPACE_CREATE");
        java.util.concurrent.CountDownLatch probing =
                new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release =
                new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger reads =
                new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.CountDownLatch settled =
                new java.util.concurrent.CountDownLatch(1);
        AcceptanceEvidence slowNode = new AcceptanceEvidence() {
            @Override
            public String kind() {
                return "WORKSPACE_CREATE";
            }

            @Override
            public Optional<AcceptanceVerdict> read(ParkedOperation parked) {
                reads.incrementAndGet();
                probing.countDown();
                try {
                    release.await();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
                return Optional.of(AcceptanceVerdict.committed());
            }

            @Override
            public boolean settle(AgentStateStore ignored,
                    ParkedOperation parked, AcceptanceVerdict verdict,
                    long retryAt) {
                settled.countDown();
                return true;
            }

            @Override
            public List<ParkedOperation> parked(int limit) {
                return List.of(registration);
            }
        };
        var executor = Executors.newVirtualThreadPerTaskExecutor();
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            OperationReconciler slow = new OperationReconciler(store,
                    List.of(slowNode), executor, Clock.systemUTC());
            scheduler.execute(slow::reconcile);
            assertThat(probing.await(10, java.util.concurrent.TimeUnit.SECONDS))
                    .isTrue();
            java.util.concurrent.CountDownLatch otherTick =
                    new java.util.concurrent.CountDownLatch(1);
            scheduler.execute(otherTick::countDown);
            assertThat(otherTick.await(10, java.util.concurrent.TimeUnit.SECONDS))
                    .isTrue();
            scheduler.submit(slow::reconcile).get(10,
                    java.util.concurrent.TimeUnit.SECONDS);
            assertThat(reads).hasValue(1);
            assertThat(settled.getCount()).isEqualTo(1);
            release.countDown();
            assertThat(settled.await(10, java.util.concurrent.TimeUnit.SECONDS))
                    .isTrue();
        } finally {
            release.countDown();
            scheduler.shutdownNow();
            executor.shutdownNow();
        }
    }

    @Test
    void oneKindHasOneEvidenceSource() {
        TurnInputEvidence input = new TurnInputEvidence(store);
        assertThatThrownBy(() -> new OperationReconciler(store,
                List.of(input, new TurnInputEvidence(store)), DIRECT,
                Clock.systemUTC()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SUBMIT_INPUT");
    }

    private void assertNothingSent() {
        assertThat(mockingDetails(harness).getInvocations()).isEmpty();
        assertThat(mockingDetails(broker).getInvocations()).isEmpty();
        verify(store, never()).claimOperation(any(), any(), any(), any(),
                any());
        verify(store, never()).settleTaskCancel(any(), any(), any(), any(),
                anyLong(), any(), eq(0L));
    }

    private static OperationRecord parked(String operationId,
            OperationKind kind) {
        return operation(operationId, kind, "RECOVERY_BLOCKED");
    }

    private static OperationRecord operation(String operationId,
            OperationKind kind, String state) {
        return new OperationRecord(TENANT, SESSION, operationId, kind,
                "digest", state, "JAVA_DURABLE", "BLOCKED", "ACTIVE", null,
                null, 16, 16, null, null, null, null, 0, 0, null,
                kind == OperationKind.TASK_CANCEL ? TASK : null);
    }

    private static TaskTarget childRun(String state, boolean stopRequested) {
        return new TaskTarget("child_run", "run-1", "child_agent", state, 3,
                JSON.createObjectNode().put("kind", "child_agent")
                        .put("stopRequested", stopRequested));
    }

    @SuppressWarnings("unchecked")
    private ObjectProvider<RuntimeBrokerService> brokers() {
        ObjectProvider<RuntimeBrokerService> provider =
                mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(broker);
        return provider;
    }

    /** Runs each reconciliation on the calling thread. */
    private static final java.util.concurrent.ExecutorService DIRECT =
            new java.util.concurrent.AbstractExecutorService() {
                @Override
                public void execute(Runnable task) {
                    task.run();
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
                public boolean awaitTermination(long timeout,
                        java.util.concurrent.TimeUnit unit) {
                    return true;
                }
            };
}
