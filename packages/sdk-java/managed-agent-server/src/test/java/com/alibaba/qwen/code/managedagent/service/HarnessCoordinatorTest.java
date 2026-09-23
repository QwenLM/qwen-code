package com.alibaba.qwen.code.managedagent.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
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
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

class HarnessCoordinatorTest {
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
        verify(store, never()).retractContinuationOutput(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString());
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
        return new TurnRecord(tenantId, sessionId, turnId, promptId,
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", true, eventEpoch,
                lastEventId, "previous-owner", Long.MAX_VALUE, null, null,
                1, 1, null, 1);
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
