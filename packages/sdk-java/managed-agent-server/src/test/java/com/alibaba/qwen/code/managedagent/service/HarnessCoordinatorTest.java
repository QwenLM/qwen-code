package com.alibaba.qwen.code.managedagent.service;

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
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
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
import org.mockito.InOrder;

class HarnessCoordinatorTest {
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
        when(recovery.getPhase()).thenReturn("await_runtime");
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(true);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.createOrLoad(tenantId, sessionId, true, true))
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
        when(recovery.getPhase()).thenReturn("results_ready");
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.createOrLoad(tenantId, sessionId, true, true))
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
        when(recovery.getPhase()).thenReturn("results_ready");
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.createOrLoad(tenantId, sessionId, true, true))
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
        when(harness.createOrLoad(tenantId, sessionId, true, true))
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
        when(harness.createOrLoad(tenantId, sessionId, true))
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
        when(recovery.isContinuationAdmitted()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(store.claimTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession(tenantId, sessionId)).thenReturn(session);
        when(harness.createOrLoad(tenantId, sessionId, true))
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

    @Test
    void doesNotExhaustAfterSubmissionMayHaveBeenAdmitted() {
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
                        new IllegalStateException("response lost"));
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
        when(harness.createOrLoad(tenantId, sessionId, true))
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
