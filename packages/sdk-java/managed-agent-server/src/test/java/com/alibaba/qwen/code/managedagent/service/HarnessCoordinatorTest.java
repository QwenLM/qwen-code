package com.alibaba.qwen.code.managedagent.service;

import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.after;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.daemon.HarnessSessionRefusedException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.InOrder;

class HarnessCoordinatorTest {
    @Test
    void recoveredBoundTurnFailsBeforeAnyLegacyHarnessCall() {
        String tenantId = "tenant-bound";
        String sessionId = "session-bound";
        String turnId = "turn-bound";
        ContextBinding binding = new ContextBinding(tenantId, "ws-a", 1,
                "storage-a", ".", "config-a", 1);
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, null, "ACTIVE", null, null, 0,
                0, 0, 1, 1, null, 1, binding, "yolo", "hosted-workspace-files/1");
        for (String status : List.of("ACCEPTED", "CANCELLING")) {
            AgentStateStore store = mock(AgentStateStore.class);
            HarnessConnector harness = mock(HarnessConnector.class);
            RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
            TurnRecord claimed = turn(tenantId, sessionId, turnId,
                    "11111111-1111-4111-8111-111111111111", null, 0,
                    status, false, 0);
            when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                    anyString(), any(Duration.class)))
                    .thenReturn(Optional.of(claimed));
            when(store.requireSession(tenantId, sessionId))
                    .thenReturn(session);
            HarnessCoordinator coordinator = new HarnessCoordinator(store,
                    harness, new HarnessEventProjector(), runtimeWarmer,
                    directExecutor(), Clock.systemUTC(),
                    new ManagedAgentProperties());
            try {
                coordinator.dispatch(tenantId, sessionId, turnId);
            } finally {
                coordinator.close();
            }
            verify(store).failTurn(eq(tenantId), eq(sessionId), eq(turnId),
                    anyString(), eq("workspace_unavailable"), anyString());
            verify(harness).isWorkspaceFilesAvailable();
            verifyNoMoreInteractions(harness);
            verifyNoInteractions(runtimeWarmer);
        }
    }

    // Before submission, the only RuntimeBrokerException that reaches the
    // coordinator is WorkspaceExecutionStore.unavailable() (409,
    // workspace_unavailable, not retryable), raised by the connector's
    // authorization in createOrLoad. Broker lease contention (workspace_busy)
    // is raised inside the Broker's tool-execution transport and is consumed
    // there: it ends the turn as a turn_error event and never reaches this arm.
    @ParameterizedTest
    @ValueSource(ints = {0, 5})
    void failsOnWorkspaceAuthorizationRefusalBeforeSubmission(int retryCount) {
        RuntimeBrokerException refusal = WorkspaceExecutionStore.unavailable();
        AgentStateStore store = dispatchWithCreateOrLoadFailure(refusal,
                false, retryCount);
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("workspace_unavailable"),
                eq(refusal.getMessage()));
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // A claim that already recorded a submission attempt may have been
    // admitted, so even a permanent authorization refusal must not end it
    // before the pre-admission retry budget (retryCount 5 would otherwise be
    // terminal, see failsPreAdmissionTurnAfterRetryBudgetIsExhausted).
    @Test
    void retriesWorkspaceAuthorizationRefusalAfterARecordedSubmission() {
        AgentStateStore store = dispatchWithCreateOrLoadFailure(
                WorkspaceExecutionStore.unavailable(), true, 5);
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // Defensive coverage only: no current producer reaches the coordinator
    // with a retryable RuntimeBrokerException before submission. This pins
    // the isRetryable() clause so a future retryable refusal is retried, not
    // failed; it does not model Broker lease contention.
    @Test
    void retriesARetryableBrokerRefusalBeforeSubmissionDefensively() {
        AgentStateStore store = dispatchWithCreateOrLoadFailure(
                new RuntimeBrokerException(409, "defensive_retryable",
                        "Retryable refusal with no current producer.", true),
                false, 0);
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // Pins the 409 cell of the DaemonHttpException arm: a conflict the Harness
    // itself reports (hosted_turn_active, hosted_prompt_conflict,
    // hosted_event_epoch_mismatch, ...) is transient, so it is retried rather
    // than failed. A create-time 409 never reaches here: the connector answers
    // it by loading the existing authority.
    @Test
    void retriesAConflictReportedByTheHarness() {
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        AgentStateStore store = dispatchWithCreateOrLoadFailure(conflict,
                false, 0);
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A permanent Harness rejection ends the Turn even after a recorded
    // submission, where the pre-admission retry budget cannot end it. The code
    // distinguishes this arm from retry exhaustion (hosted_harness_unavailable).
    @Test
    void failsAPermanentHarnessRejectionAfterSubmission() {
        DaemonHttpException rejected = mock(DaemonHttpException.class);
        when(rejected.getStatusCode()).thenReturn(400);
        AgentStateStore store = dispatchWithCreateOrLoadFailure(rejected,
                true, 5);
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_rejected"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // A 5xx from the Harness or a proxy is transient, so a Turn whose
    // submission may have been admitted is retried, not failed.
    @Test
    void retriesATransientHarnessFailureAfterSubmission() {
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        AgentStateStore store = dispatchWithCreateOrLoadFailure(unavailable,
                true, 5);
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // Issue #13320: a load refused with a machine-readable code (e.g. a
    // journal newer than the Harness reader in a mixed fleet) still retries
    // — a compatible Harness may take over — but the refusal code, not
    // hosted_harness_unavailable, is what the terminal failure records once
    // the pre-admission budget runs out.
    @Test
    void retriesANamedLoadRefusalBeforeTheBudgetRunsOut() {
        HarnessSessionRefusedException refusal = mock(
                HarnessSessionRefusedException.class);
        when(refusal.getCode()).thenReturn("managed_session_open_failed");
        AgentStateStore store = dispatchWithCreateOrLoadFailure(refusal,
                false, 0);
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    @Test
    void recordsTheLoadRefusalCodeWhenRetriesRunOut() {
        HarnessSessionRefusedException refusal = mock(
                HarnessSessionRefusedException.class);
        when(refusal.getCode()).thenReturn("managed_session_open_failed");
        AgentStateStore store = dispatchWithCreateOrLoadFailure(refusal,
                false, 5);
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("managed_session_open_failed"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    private AgentStateStore dispatchWithCreateOrLoadFailure(
            RuntimeException failure, boolean submitted, int retryCount) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, submitted, retryCount);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                        new ContextBinding("tenant", "ws-a", 1,
                                "storage-a", ".", "config-a", 1), "yolo", "hosted-workspace-files/1"));
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.createOrLoad("tenant", "session", false))
                .thenThrow(failure);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness, never()).submit(anyString(), anyString(), anyString(),
                any(), anyString());
        return store;
    }

    @Test
    void boundCancellationWaitsForTheWorkspaceOptIn() {
        AgentStateStore store = boundCancellingStore();
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer warmer = mock(RuntimeWarmer.class);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), warmer, directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.cancel("tenant", "session", "turn");
            verify(store).requireSession("tenant", "session");
            verify(harness).isWorkspaceFilesAvailable();
            verifyNoMoreInteractions(harness);
            verifyNoInteractions(warmer);
        } finally {
            coordinator.close();
        }
    }

    @Test
    void cancelsABoundTurnThroughTheHarnessWithTheWorkspaceOptIn() {
        AgentStateStore store = boundCancellingStore();
        HarnessConnector harness = mock(HarnessConnector.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot"))).thenReturn(true);
        HarnessCoordinator coordinator = coordinator(store, harness);
        try {
            coordinator.cancel("tenant", "session", "turn");
            // The admitted Turn's boot is already bound, so the cancel never
            // attaches: an attach re-runs the Workspace authorization, which
            // a revoked grant or a draining Workspace would refuse.
            verify(harness, never()).createOrLoad(anyString(), anyString(),
                    anyBoolean());
            verify(harness, never()).createOrLoad(anyString(), anyString(),
                    anyBoolean(), anyBoolean());
            verify(harness).cancel("tenant", "session");
        } finally {
            coordinator.close();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"accepted", "retry", "lease-lost", "completed"})
    void runningOwnerObservesCancellationAfterStreamingStarts(String mode)
            throws Exception {
        AgentStateStore store = boundCancellingStore();
        TurnRecord running = turn("tenant", "session", "turn", "prompt",
                "epoch", 1);
        AtomicReference<TurnRecord> current = new AtomicReference<>(running);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(running));
        when(store.findTurn("tenant", "session", "turn"))
                .thenAnswer(invocation -> Optional.of(current.get()));
        when(store.renewTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(!"lease-lost".equals(mode));
        HarnessConnector harness = mock(HarnessConnector.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot"))).thenReturn(true);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot"));
        CountDownLatch streaming = new CountDownLatch(1);
        CountDownLatch cancelled = new CountDownLatch(1);
        SourceStream stream = mock(SourceStream.class);
        when(stream.eventEpoch()).thenReturn("epoch");
        when(stream.next()).thenAnswer(invocation -> {
            cancelled.await();
            return new SourceEvent(2L, "turn_complete",
                    Map.of("stopReason", "cancelled"), "prompt", Map.of());
        }).thenReturn(null);
        when(harness.stream("tenant", "session", 1, "epoch"))
                .thenAnswer(invocation -> {
                    streaming.countDown();
                    return stream;
                });
        AtomicBoolean loseDelivery = new AtomicBoolean("retry".equals(mode));
        doAnswer(invocation -> {
            if (loseDelivery.getAndSet(false))
                throw new IllegalStateException("lost");
            current.set(turn("tenant", "session", "turn", "prompt",
                    "epoch", 2, "CANCELLED"));
            cancelled.countDown();
            return null;
        }).when(harness).cancel("tenant", "session");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setLeaseRenewInterval(Duration.ofMillis(20));
        ExecutorService executor = Executors.newCachedThreadPool();
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                executor, Clock.systemUTC(), properties);
        try {
            coordinator.dispatch("tenant", "session", "turn");
            assertTrue(streaming.await(2, TimeUnit.SECONDS));
            // Another API replica persists this state without calling the
            // running owner's coordinator directly.
            current.set(turn("tenant", "session", "turn", "prompt",
                    "epoch", 1, "completed".equals(mode)
                            ? "COMPLETED" : "CANCELLING"));
            verify(store, timeout(2_000).atLeastOnce()).renewTurn(eq("tenant"),
                    eq("session"), eq("turn"), anyString(),
                    any(Duration.class));
            if ("accepted".equals(mode) || "retry".equals(mode)) {
                assertTrue(cancelled.await(2, TimeUnit.SECONDS));
                verify(harness, timeout(2_000).times(
                        "retry".equals(mode) ? 2 : 1))
                        .cancel("tenant", "session");
            } else {
                verify(harness, after(200).never()).cancel(anyString(),
                        anyString());
            }
        } finally {
            cancelled.countDown();
            coordinator.close();
            executor.shutdownNow();
        }
    }

    private static HarnessCoordinator coordinator(AgentStateStore store,
            HarnessConnector harness) {
        return new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
    }

    private static AgentStateStore boundCancellingStore() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findTurn("tenant", "session", "turn")).thenReturn(Optional.of(
                turn("tenant", "session", "turn", "prompt", "epoch", 1,
                        "CANCELLING")));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot", "epoch", 1, 1, 0, 1, 1, null, 1,
                        new ContextBinding("tenant", "ws-a", 1,
                                "storage-a", ".", "config-a", 1), "yolo", "hosted-workspace-files/1"));
        return store;
    }

    @Test
    void cancelsKnownSettledRecoveredRuntimeAndStreamsCancellation() {
        String tenantId = "tenant-recovery-cancel";
        String sessionId = "session-recovery-cancel";
        String turnId = "turn-recovery-cancel";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-old", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-old", 7, "CANCELLING");
        TurnRecord recovered = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 4, "CANCELLING");

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isCancellationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(true);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, true))
                .thenReturn(new Attachment("boot-new", recovery, 2L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed), Optional.of(recovered));
        when(harness.cancelManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(4, "epoch-new"));
        when(harness.stream(tenantId, sessionId, 4, "epoch-new"))
                .thenReturn(cancelledStream(promptId));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(harness).cancelManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1");
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).cancel(anyString(), anyString());
        verify(runtimeWarmer, never()).warm(anyString());
        verify(store, never()).appendPublicEventIfAbsent(eq(tenantId),
                eq(sessionId), eq(turnId), eq("environment.provisioning"),
                any(), eq(false), anyString());
        InOrder recoveryOrder = inOrder(store, harness);
        recoveryOrder.verify(store).recordRecoveryAdmission(eq(tenantId),
                eq(sessionId), eq(turnId), anyString(), eq("epoch-old"),
                eq("epoch-new"), eq(2L));
        recoveryOrder.verify(harness).cancelManagedRuntime(tenantId,
                sessionId, promptId, "checkpoint-1", "activation-1");
        verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"),
                argThat(events -> {
                    HarnessEvent event = events.get(0);
                    return event.projection() != null
                            && "turn.cancelled".equals(
                                    event.projection().type())
                            && "CANCELLED".equals(
                                    event.projection().terminalStatus());
                }));
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void cancelsInitialResultsReadyRecoveryAndStreamsCancellation() {
        String tenantId = "tenant-results-ready-cancel";
        String sessionId = "session-results-ready-cancel";
        String turnId = "turn-results-ready-cancel";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", null, 0,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                null, 0, "CANCELLING");
        TurnRecord recovered = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 4, "CANCELLING");

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isCancellationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, true))
                .thenReturn(new Attachment("boot-new", recovery, 2L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed), Optional.of(recovered));
        when(harness.cancelManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(4, "epoch-new"));
        when(harness.stream(tenantId, sessionId, 4, "epoch-new"))
                .thenReturn(cancelledStream(promptId));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(store).recordRecoveryAdmission(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq(null), eq("epoch-new"), eq(2L));
        verify(harness).cancelManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1");
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness).stream(tenantId, sessionId, 4, "epoch-new");
        verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"),
                argThat(events -> "turn.cancelled".equals(
                        events.get(0).projection().type())));
    }

    @Test
    void cancelsSameEpochInitialResultsReadyFromStoredPreOperationCursor() {
        String tenantId = "tenant-results-ready-same-epoch";
        String sessionId = "session-results-ready-same-epoch";
        String turnId = "turn-results-ready-same-epoch";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-new", "epoch-new", 2,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 2, "CANCELLING");

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isCancellationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, true))
                .thenReturn(new Attachment("boot-new", recovery, 5L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-new"), eq("boot-new")))
                .thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed));
        when(harness.cancelManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(2, "epoch-new"));
        when(harness.stream(tenantId, sessionId, 2, "epoch-new"))
                .thenReturn(cancelledStream(promptId));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(harness).cancelManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1");
        verify(store, never()).recordRecoveryAdmission(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString(), anyLong());
        verify(harness).stream(tenantId, sessionId, 2, "epoch-new");
        verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"),
                argThat(events -> "turn.cancelled".equals(
                        events.get(0).projection().type())));
    }

    @Test
    void blocksUnknownRecoveredRuntimeCancellationWithoutForgingTerminal() {
        String tenantId = "tenant-recovery-unknown";
        String sessionId = "session-recovery-unknown";
        String turnId = "turn-recovery-unknown";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-old", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-old", 7, "CANCELLING");

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(true);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, true))
                .thenReturn(new Attachment("boot-new", recovery, 2L,
                        "epoch-new"));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(store).failTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), eq("managed_runtime_recovery_blocked"),
                anyString());
        verify(harness, never()).cancelManagedRuntime(anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).cancel(anyString(), anyString());
        verify(harness, never()).stream(anyString(), anyString(), anyLong(),
                anyString());
        verify(store, never()).recordHarnessEvents(anyString(), anyString(),
                anyString(), anyString(), anyString(), any());
    }

    @Test
    void continuesRecoveredRuntimeWithoutReplayingThePrompt() {
        String tenantId = "tenant-recovery";
        String sessionId = "session-recovery";
        String turnId = "turn-recovery";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-old", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-old", 7);
        TurnRecord recovered = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 0);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isContinuationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", recovery, 0L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed), Optional.of(recovered));
        when(harness.continueManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(0, "epoch-new"));
        when(harness.stream(tenantId, sessionId, 0, "epoch-new"))
                .thenReturn(terminalStream(promptId));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(harness, never()).submit(anyString(), anyString(), anyString(),
                any(), anyString());
        InOrder recoveryOrder = inOrder(store, harness);
        recoveryOrder.verify(store).recordRecoveryAdmission(eq(tenantId),
                eq(sessionId), eq(turnId), anyString(), eq("epoch-old"),
                eq("epoch-new"), eq(0L));
        recoveryOrder.verify(harness).continueManagedRuntime(tenantId,
                sessionId, promptId, "checkpoint-1", "activation-1");
        recoveryOrder.verify(store).recordRecoveryAdmission(eq(tenantId),
                eq(sessionId), eq(turnId), anyString(), eq("epoch-new"),
                eq("epoch-new"), eq(0L));
        verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"), any());
        verify(store, never()).releaseTurnLease(eq(tenantId), eq(sessionId),
                eq(turnId), anyString());
        verify(store).retractContinuationOutput(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("epoch-old"));
    }

    @Test
    void retractsAdmittedContinuationTextBeforeReplacingTheStream() {
        String tenantId = "tenant-recovery";
        String sessionId = "session-recovery";
        String turnId = "turn-recovery";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-old", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-old", 7);
        TurnRecord recovered = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 0);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isContinuationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", recovery, 0L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed), Optional.of(recovered));
        when(harness.continueManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(0, "epoch-new"));
        when(harness.stream(tenantId, sessionId, 0, "epoch-new"))
                .thenReturn(terminalStream(promptId));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        InOrder recoveryOrder = inOrder(store, harness);
        recoveryOrder.verify(store).retractContinuationOutput(eq(tenantId),
                eq(sessionId), eq(turnId), anyString(), eq("boot-old"),
                eq("epoch-old"));
        recoveryOrder.verify(harness).continueManagedRuntime(tenantId,
                sessionId, promptId, "checkpoint-1", "activation-1");
    }

    @Test
    void schedulesPersistentBackoffForTransientFailure() {
        String tenantId = "tenant-retry";
        String sessionId = "session-retry";
        String turnId = "turn-retry";
        TurnRecord claimed = turn(tenantId, sessionId, turnId,
                "11111111-1111-4111-8111-111111111111", null, 0, false,
                2);
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.requireSession(tenantId, sessionId))
                .thenThrow(new IllegalStateException("database unavailable"));
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setRetryInitialDelay(Duration.ofSeconds(2));
        properties.getDispatch().setRetryMaxDelay(Duration.ofSeconds(30));
        Clock clock = Clock.fixed(Instant.ofEpochMilli(10_000), ZoneOffset.UTC);

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                clock, properties);
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(store).scheduleTurnRetry(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq(18_000L));
        verify(store, never()).releaseTurnLease(eq(tenantId), eq(sessionId),
                eq(turnId), anyString());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // Protects the post-submission uncertainty invariant: once submit may
    // have been admitted, neither a lost response nor a permanent Workspace
    // refusal ends the Turn, even with the pre-admission retry budget spent.
    // The refusal row is not redundant with the generic catch: deleting the
    // RuntimeBrokerException arm keeps it green by design, so the negative
    // control is weakening that arm's guard to drop !submissionAttempted,
    // which would make this row terminal.
    @ParameterizedTest(name = "workspace refusal = {0}")
    @ValueSource(booleans = {false, true})
    void neverTerminatesOnceSubmissionMayHaveBeenAdmitted(
            boolean workspaceRefusal) {
        String tenantId = "tenant-retry-submitted";
        String sessionId = "session-retry-submitted";
        String turnId = "turn-retry-submitted";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", null, null, 0,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                null, 0, false, 5);
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(store.bindHarness(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed));
        when(harness.createOrLoad(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", null, null, null));
        when(harness.submit(eq(tenantId), eq(sessionId), eq(promptId), any(),
                anyString())).thenThrow(
                        workspaceRefusal ? WorkspaceExecutionStore.unavailable()
                                : new IllegalStateException("response lost"));
        when(runtimeWarmer.isEnabled()).thenReturn(false);

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(store).markSubmissionAttempted(eq(tenantId), eq(sessionId),
                eq(turnId), anyString());
        verify(store).scheduleTurnRetry(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void failsPreAdmissionTurnAfterRetryBudgetIsExhausted() {
        String tenantId = "tenant-retry";
        String sessionId = "session-retry";
        String turnId = "turn-retry";
        TurnRecord claimed = turn(tenantId, sessionId, turnId,
                "11111111-1111-4111-8111-111111111111", null, 0, false,
                5);
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.requireSession(tenantId, sessionId))
                .thenThrow(new IllegalStateException("database unavailable"));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(store).failTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
        verify(store, never()).releaseTurnLease(eq(tenantId), eq(sessionId),
                eq(turnId), anyString());
    }

    @Test
    void rejectsRecoveredRuntimeWithoutAnEventWatermark() {
        String tenantId = "tenant-recovery";
        String sessionId = "session-recovery";
        String turnId = "turn-recovery";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-old", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-old", 7);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isContinuationReady()).thenReturn(true);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", recovery));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(store).failTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), eq("managed_runtime_recovery_watermark_missing"),
                anyString());
        verify(store, never()).bindRecoveredHarness(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).submit(anyString(), anyString(), anyString(),
                any(), anyString());
    }

    @Test
    void failsTurnWhenARecoveredRuntimeIsNotReadyForContinuation() {
        String tenantId = "tenant-recovery-not-ready";
        String sessionId = "session-recovery-not-ready";
        String turnId = "turn-recovery-not-ready";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-old", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-old", 7);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isContinuationReady()).thenReturn(false);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", recovery));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        // A recovered-but-not-ready execution must fail terminally with the
        // fence's own code, not drive a second execution.
        verify(store).failTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), eq("managed_runtime_recovery_incomplete"),
                anyString());
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).submit(anyString(), anyString(), anyString(),
                any(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    @Test
    void failsTerminallyWhenTheRecoveredGenerationMoved() {
        String tenantId = "tenant-recovery-generation";
        String sessionId = "session-recovery-generation";
        String turnId = "turn-recovery-generation";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-old", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-old", 7);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isContinuationReady()).thenReturn(true);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", recovery, 9L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(false);

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        // A generation mismatch is terminal, not retryable: another owner
        // may already hold the stopped Turn's effects.
        verify(store).failTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(),
                eq("hosted_harness_recovery_generation_mismatch"),
                anyString());
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).cancelManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    @Test
    void retriesTheTurnWhenTheRecoveryWatermarkMoved() {
        String tenantId = "tenant-recovery-watermark";
        String sessionId = "session-recovery-watermark";
        String turnId = "turn-recovery-watermark";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-new", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 7);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isContinuationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", recovery, 9L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed));
        // The continuation answers under a different epoch than the
        // takeover advertised: drive must stop here, not double-execute.
        when(harness.continueManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(9, "epoch-moved"));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }
        verify(store).scheduleTurnRetry(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), anyLong());
        verify(store, never()).recordRecoveryAdmission(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString(), anyLong());
        verify(harness, times(1)).continueManagedRuntime(tenantId, sessionId,
                promptId, "checkpoint-1", "activation-1");
        verify(harness, never()).submit(anyString(), anyString(), anyString(),
                any(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void retriesTheTurnWhenTheRecoveredWatermarkRegresses() {
        String tenantId = "tenant-recovery-regression";
        String sessionId = "session-recovery-regression";
        String turnId = "turn-recovery-regression";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-old", "epoch-new", 7,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 7);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(false);
        when(recovery.isContinuationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", recovery, 9L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed));
        // The continuation answers on the takeover's epoch but from a lower
        // watermark: the epoch comparison cannot see the backward step, so
        // only the lastEventId operand can stop this drive before the
        // regressed cursor is persisted.
        when(harness.continueManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(7, "epoch-new"));

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }
        verify(store).scheduleTurnRetry(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), anyLong());
        verify(store, never()).recordRecoveryAdmission(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString(), anyLong());
        verify(harness, times(1)).continueManagedRuntime(tenantId, sessionId,
                promptId, "checkpoint-1", "activation-1");
        verify(harness, never()).submit(anyString(), anyString(), anyString(),
                any(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // A restarted model attempt retracts the prefix it published (#13319):
    // the deltas it covers are flushed before the store blanks their range,
    // and the cursor passes the retraction event itself.
    @Test
    void retractsInBandRetryOutputBeforeRecordingTheReplay() {
        String tenantId = "tenant-inband-retract";
        String sessionId = "session-inband-retract";
        String turnId = "turn-inband-retract";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-new", "epoch-new", 2,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 2);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", null, 2L, "epoch-new"));
        when(store.bindHarness(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed));
        List<SourceEvent> frames = List.of(
                new SourceEvent(3L, "session_update", Map.of("update",
                        Map.of("sessionUpdate", "agent_message_chunk",
                                "content", Map.of("type", "text",
                                        "text", "orphaned "))),
                        promptId, Map.of()),
                // A second delta stays batched (it is not the first visible
                // text), so only a correct flush-before-retract records it
                // ahead of the retraction.
                new SourceEvent(4L, "session_update", Map.of("update",
                        Map.of("sessionUpdate", "agent_message_chunk",
                                "content", Map.of("type", "text",
                                        "text", "prefix"))),
                        promptId, Map.of()),
                new SourceEvent(5L, "message_retracted",
                        Map.of("turnId", turnId, "messageId", "message-1",
                                "fromSequence", 3),
                        promptId, Map.of()),
                new SourceEvent(6L, "session_update", Map.of("update",
                        Map.of("sessionUpdate", "agent_message_chunk",
                                "content", Map.of("type", "text",
                                        "text", "recovered"))),
                        promptId, Map.of()),
                new SourceEvent(7L, "turn_complete",
                        Map.of("stopReason", "end_turn"), promptId,
                        Map.of()));
        when(harness.stream(tenantId, sessionId, 2, "epoch-new"))
                .thenReturn(new SourceStream() {
                    private int index;

                    @Override
                    public String eventEpoch() {
                        return "epoch-new";
                    }

                    @Override
                    public SourceEvent next() {
                        return index < frames.size() ? frames.get(index++)
                                : null;
                    }

                    @Override
                    public void close() {
                    }
                });

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }
        InOrder order = inOrder(store);
        // The orphaned deltas are recorded before the retraction they fall
        // under: the first as the first visible text, the second by the
        // branch's flush. The replay's delta is recorded after it.
        order.verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"),
                argThat(events -> events.size() == 1
                        && events.get(0).sourceId() == 3L));
        order.verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"),
                argThat(events -> events.size() == 1
                        && events.get(0).sourceId() == 4L));
        order.verify(store).retractHarnessTurnOutput(eq(tenantId),
                eq(sessionId), eq(turnId), anyString(), eq("epoch-new"),
                eq(3L), eq(5L));
        order.verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"),
                argThat(events -> events.size() == 1
                        && events.get(0).sourceId() == 6L));
        order.verify(store).recordHarnessEvents(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), eq("epoch-new"),
                argThat(events -> events.size() == 1
                        && "turn.completed".equals(
                                events.get(0).projection().type())));
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // A retraction without a usable fromSequence fails closed: the Turn is
    // retried, never silently completed over a prefix that stays published.
    @Test
    void refusesAMalformedRetractionEvent() {
        String tenantId = "tenant-inband-retract-bad";
        String sessionId = "session-inband-retract-bad";
        String turnId = "turn-inband-retract-bad";
        String promptId = "11111111-1111-4111-8111-111111111111";
        SessionRecord session = new SessionRecord(tenantId, sessionId,
                "qwen-code", null, "ACTIVE", "boot-new", "epoch-new", 2,
                0, 1, 1, null, 1);
        TurnRecord claimed = turn(tenantId, sessionId, turnId, promptId,
                "epoch-new", 2);

        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        ExecutorService executor = directExecutor();
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.recoverManagedRuntime(tenantId, sessionId, false))
                .thenReturn(new Attachment("boot-new", null, 2L, "epoch-new"));
        when(store.bindHarness(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn(tenantId, sessionId, turnId))
                .thenReturn(Optional.of(claimed));
        when(harness.stream(tenantId, sessionId, 2, "epoch-new"))
                .thenReturn(new SourceStream() {
                    private boolean emitted;

                    @Override
                    public String eventEpoch() {
                        return "epoch-new";
                    }

                    @Override
                    public SourceEvent next() {
                        if (emitted) {
                            return null;
                        }
                        emitted = true;
                        return new SourceEvent(3L, "message_retracted",
                                Map.of("turnId", turnId, "messageId",
                                        "message-1"),
                                promptId, Map.of());
                    }

                    @Override
                    public void close() {
                    }
                });

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch(tenantId, sessionId, turnId);
        } finally {
            coordinator.close();
        }

        verify(store, never()).retractHarnessTurnOutput(anyString(),
                anyString(), anyString(), anyString(), anyString(), anyLong(),
                anyLong());
        verify(store, never()).recordHarnessEvents(anyString(), anyString(),
                anyString(), anyString(), anyString(),
                argThat(events -> events.stream().anyMatch(
                        event -> event.projection() != null
                                && event.projection().terminal())));
        verify(store).scheduleTurnRetry(eq(tenantId), eq(sessionId),
                eq(turnId), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    private static TurnRecord turn(String tenantId, String sessionId,
            String turnId, String promptId, String eventEpoch,
            long lastEventId) {
        return turn(tenantId, sessionId, turnId, promptId, eventEpoch,
                lastEventId, true, 0);
    }

    private static TurnRecord turn(String tenantId, String sessionId,
            String turnId, String promptId, String eventEpoch,
            long lastEventId, boolean submissionAttempted, int retryCount) {
        return turn(tenantId, sessionId, turnId, promptId, eventEpoch,
                lastEventId, "RUNNING", submissionAttempted, retryCount);
    }

    private static TurnRecord turn(String tenantId, String sessionId,
            String turnId, String promptId, String eventEpoch,
            long lastEventId, String status) {
        return turn(tenantId, sessionId, turnId, promptId, eventEpoch,
                lastEventId, status, true, 0);
    }

    private static TurnRecord turn(String tenantId, String sessionId,
            String turnId, String promptId, String eventEpoch,
            long lastEventId, String status, boolean submissionAttempted,
            int retryCount) {
        return new TurnRecord(tenantId, sessionId, turnId, promptId,
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), status, submissionAttempted,
                eventEpoch, lastEventId, "previous-owner", Long.MAX_VALUE,
                retryCount, null, null, null, 1, 1, null, 1);
    }

    private static SourceStream cancelledStream(String promptId) {
        return new SourceStream() {
            private boolean emitted;

            @Override
            public String eventEpoch() {
                return "epoch-new";
            }

            @Override
            public SourceEvent next() {
                if (emitted) {
                    return null;
                }
                emitted = true;
                return new SourceEvent(5L, "turn_complete",
                        Map.of("stopReason", "cancelled"), promptId,
                        Map.of());
            }

            @Override
            public void close() {
            }
        };
    }

    private static SourceStream terminalStream(String promptId) {
        return new SourceStream() {
            private boolean emitted;

            @Override
            public String eventEpoch() {
                return "epoch-new";
            }

            @Override
            public SourceEvent next() {
                if (emitted) {
                    return null;
                }
                emitted = true;
                return new SourceEvent(1L, "turn_complete",
                        Map.of("stopReason", "end_turn"), promptId,
                        Map.of());
            }

            @Override
            public void close() {
            }
        };
    }

    private static ExecutorService directExecutor() {
        ExecutorService executor = mock(ExecutorService.class);
        Future<?> future = mock(Future.class);
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(executor).execute(any(Runnable.class));
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return future;
        }).when(executor).submit(any(Runnable.class));
        return executor;
    }
}
