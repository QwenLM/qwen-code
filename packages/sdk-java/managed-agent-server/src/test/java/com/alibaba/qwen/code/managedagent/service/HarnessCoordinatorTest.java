package com.alibaba.qwen.code.managedagent.service;

import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import static org.mockito.Mockito.atLeast;
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
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
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
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.harness.HostedHarnessRecoveryDeclinedException;
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

    // A permanent transport failure meets the pre-admission budget even on
    // a bound Session — only the writer lease's own code use the
    // lease-window exemption, never any other failure kind (its takeover
    // arm now lives beside durableRecoveryRequired409MeetsRetryBudget).
    @Test
    void boundSessionMeetsRetryBudgetExceptOnWriterConflict() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new RuntimeException("connect refused"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // A lease-shaped 409 exempts only on a bound Session; on an unbound
    // one the wait names no predecessor's lease and meets the budget.
    @Test
    void unboundSessionMeetsRetryBudgetOnLeaseBounded409() {
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(conflict.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        AgentStateStore store = dispatchWithCreateOrLoadFailure(conflict,
                false, 5);
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
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

    // A configuration-shaped 409 (its code is durable, no lease semantics)
    // meets the pre-admission budget even on a bound Session.
    @Test
    void boundSessionMeetsRetryBudgetOnConfiguration409() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(conflict.getErrorCode())
                .thenReturn("hosted_tool_profile_conflict");
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(conflict);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // `hosted_session_already_attached` reads like a transient conflict but
    // is permanent: the daemon drops an attachment only on an explicit
    // detach or delete, and this control plane never detaches. A Spring
    // restart against a surviving Harness must end the Turn, not spin.
    @Test
    void boundSessionMeetsRetryBudgetOnAlreadyAttached409() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        DaemonHttpException attached = mock(DaemonHttpException.class);
        when(attached.getStatusCode()).thenReturn(409);
        when(attached.getErrorCode())
                .thenReturn("hosted_session_already_attached");
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(attached);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // `managed_session_writer_conflict` is the only wait that ends on its
    // own when the fenced predecessor's lease lapses, so a bound Session's
    // recovery attach escapes the pre-admission budget on that code.
    @Test
    void boundSessionEscapesRetryBudgetOnWriterConflict409() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(conflict.getErrorCode())
                .thenReturn("managed_session_writer_conflict");
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(conflict);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The exemption is keyed on the lease's own wire code only: a durable
    // refusal arriving as hosted_turn_recovery_required is NOT a
    // lease-shaped wait, so it meets the pre-admission budget like every
    // other body shape — exempting it wedged these Turns.
    @Test
    void durableRecoveryRequired409MeetsRetryBudget() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        DaemonHttpException durable = mock(DaemonHttpException.class);
        when(durable.getStatusCode()).thenReturn(409);
        when(durable.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(durable);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // A codeless error body must never take the contains() NPE hostage:
    // getErrorCode() is null by contract, and the Turn meets the budget
    // instead of dying in a claim/NPE/release loop with no terminal state.
    @Test
    void codeless503MeetsRetryBudgetWithoutNpe() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        DaemonHttpException badGateway = mock(DaemonHttpException.class);
        when(badGateway.getStatusCode()).thenReturn(503);
        when(badGateway.getErrorCode()).thenReturn(null);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(badGateway);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // An approval wait is bounded by the approval timeout, never by a
    // durable verdict: a decline with this reason stays retriable — the
    // Turn must not die while the Action is still requested.
    @Test
    void awaitActionDeclineStaysRetriableWhileActionRequested() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        // submissionAttempted = true: the wait the retry beats the human
        // over happens after admission, where the budget is bypassed.
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-1", 3, "RUNNING", true, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException(
                        "await_action"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The daemon now answers a cancellation-only takeover plain when the
    // parked Turn needs no Runtime bookkeeping: declining would have
    // written the user's CANCEL as a harness failure (R5-36).
    @Test
    void cancellingTurnWithPlainRecoverCancelsNotFails() {
        String promptId = "11111111-1111-4111-8111-111111111111";
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", promptId,
                "epoch-old", 4, "CANCELLING");
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        // Inapplicable on the wire: a plain Attachment with no recovery —
        // and bindHarness deliberately UNFALSE: the real store denies the
        // CAS on boot-old != boot-new, which is exactly the wedge R4a
        // reported (generation_mismatch was stamped while the cancel was
        // never issued). The cancel arm must not ask for a bind at all.
        when(harness.recoverManagedRuntime("tenant", "session", true))
                .thenReturn(new Attachment("boot-new", null, 4L,
                        "epoch-old"));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        when(harness.stream("tenant", "session", 4, "epoch-old"))
                .thenReturn(cancelledStream(promptId));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness).cancel("tenant", "session");
        verify(harness, times(1)).cancel(anyString(), anyString());
        verify(harness, never()).cancelManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).bindHarness(anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(store, never()).withdrawSubmissionAttempted(anyString(),
                anyString(), anyString(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(),
                eq("managed_runtime_recovery_blocked"));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(),
                eq("hosted_harness_generation_mismatch"));
    }

    // An epoch-posted Turn landing on a plain attach has nothing to rebind
    // through — and bindHarness provably refuses that shape. Moving the
    // Session's generation first with its own CAS is the only adoption
    // that does not false-terminal the Turn (R8-1).
    @Test
    void plainAttachAfterAdoptionRebindsBeforeItSubmits() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-old", 3, "RUNNING", true, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        SessionRecord bound = new SessionRecord("tenant", "session",
                "qwen-code", null, "ACTIVE", "boot-old", null, 0, 0, 1, 1,
                null, 1);
        when(store.requireSession("tenant", "session")).thenReturn(bound);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 3L,
                        "epoch-old"));
        when(store.bindRecoveredHarness(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        when(harness.stream("tenant", "session", 3, "epoch-old"))
                .thenReturn(cancelledStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).bindRecoveredHarness(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("boot-old"), eq("boot-new"));
        verify(store, atLeast(2)).requireSession("tenant", "session");
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(),
                eq("hosted_harness_generation_mismatch"));
        verify(harness, never()).cancel(anyString(), anyString());
    }

    // The plain attach minted its own epoch: the follow-up SSE must stream
    // the adopted generation's epoch, not the claimed one (R8-1'). The
    // watermark does NOT ride the migration to the attach's journal tail
    // (lastEventId=5): anything the prior generation committed but never
    // delivered — including this Turn's own turn.settled — would be skipped
    // forever, and nothing left can produce another terminal event (R10-3).
    // The stream opens at the consumed watermark 3 and replays the tail.
    @Test
    void plainAttachMovesTheStreamEpochToTheAdoptedGeneration() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-old", 3, "RUNNING", true, 5);
        TurnRecord adopted = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 3, "RUNNING", true, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        SessionRecord bound = new SessionRecord("tenant", "session",
                "qwen-code", null, "ACTIVE", "boot-old", null, 0, 0, 1, 1,
                null, 1);
        when(store.requireSession("tenant", "session")).thenReturn(bound);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        when(store.bindRecoveredHarness(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("boot-old"), eq("boot-new")))
                .thenReturn(true);
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed), Optional.of(adopted),
                        Optional.of(adopted));
        when(harness.stream("tenant", "session", 3, "epoch-new"))
                .thenReturn(cancelledStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).recordRecoveryAdmission(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("epoch-old"), eq("epoch-old"), eq("epoch-new"),
                eq(3L));
        verify(harness).stream("tenant", "session", 3, "epoch-new");
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A CANCELLING Turn under a plain attach cancels at the attach's epoch:
    // the SSE that follows streams the adopted epoch, not the claimed one
    // (R8-1'). The watermark again stays at the consumed 4 rather than
    // jumping to the attach's tail 5, so a committed-but-undelivered
    // turn.settled in the tail still replays (R10-3).
    @Test
    void cancelOnAttachStreamsTheAdoptedEpoch() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-old", 4, "CANCELLING");
        TurnRecord adopted = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 4, "CANCELLING");
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", true))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(adopted));
        when(harness.stream("tenant", "session", 4, "epoch-new"))
                .thenReturn(cancelledStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness).cancel("tenant", "session");
        verify(store).recordRecoveryAdmission(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("epoch-old"), isNull(), eq("epoch-new"),
                eq(4L));
        verify(harness).stream("tenant", "session", 4, "epoch-new");
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A plain cancel that honestly refuses (no live Turn on the freshly
    // attached Session, the parked Turn's owner died with its generation)
    // is not retried into the same no-op: the arm adopts the attach epoch
    // and streams instead — the replay surfaces the parked Action whose
    // durable resolution a later redispatch settles as the cancel (R10-3).
    @Test
    void cancelRefusedOnAttachStillStreamsTheAdoptedEpoch() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-old", 4, "CANCELLING");
        TurnRecord adopted = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 4, "CANCELLING");
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", true))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        DaemonHttpException noLiveTurn = mock(DaemonHttpException.class);
        when(noLiveTurn.getStatusCode()).thenReturn(409);
        when(noLiveTurn.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        doThrow(noLiveTurn).when(harness).cancel("tenant", "session");
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(adopted));
        when(harness.stream("tenant", "session", 4, "epoch-new"))
                .thenReturn(cancelledStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // Exactly one cancel attempt, no silent re-issue afterwards.
        verify(harness, times(1)).cancel("tenant", "session");
        verify(store).recordRecoveryAdmission(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("epoch-old"), isNull(), eq("epoch-new"),
                eq(4L));
        verify(harness).stream("tenant", "session", 4, "epoch-new");
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // The admitted-coordination sibling of the arm above: the Turn sits on
    // a live plain attach (an approval died with the old generation), so
    // the plain cancel is the coded refusal — and retrying that same
    // cancel forever settles nothing (the round-9 wedge). The coordinator
    // must send the cancellation takeover load over the same attachment;
    // a plain-settled park (no Runtime recovery to report) needs no
    // admission, and the already-running stream lands the settle.
    @Test
    void cancelRefusedOnAdmittedTurnDrivesTheTakeoverLoad() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord cancelling = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 4, "CANCELLING");
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(cancelling));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-new", null, 0, 0, 1, 1, null, 1));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        DaemonHttpException refused = mock(DaemonHttpException.class);
        when(refused.getStatusCode()).thenReturn(409);
        when(refused.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        doThrow(refused).when(harness).cancel("tenant", "session");
        when(harness.recoverManagedCancellation("tenant", "session"))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.cancel("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // Exactly one plain cancel attempt, then the takeover load — never
        // the same no-op cancel again, and nothing is failed.
        verify(harness, times(1)).cancel("tenant", "session");
        verify(harness).recoverManagedCancellation("tenant", "session");
        verify(harness, never()).cancelManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // Same refusal, but the takeover load reports a recovered Runtime
    // park: the cancellation admission for its checkpoint goes out over
    // the same attachment too.
    @Test
    void cancelRefusedOnAdmittedTurnAdmitsTheRecoveredCancel() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord cancelling = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 4, "CANCELLING");
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(cancelling));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-new", null, 0, 0, 1, 1, null, 1));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        DaemonHttpException refused = mock(DaemonHttpException.class);
        when(refused.getStatusCode()).thenReturn(409);
        when(refused.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        doThrow(refused).when(harness).cancel("tenant", "session");
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.isCancellationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-1");
        when(recovery.getActivationId()).thenReturn("activation-1");
        when(harness.recoverManagedCancellation("tenant", "session"))
                .thenReturn(new Attachment("boot-new", recovery, 5L,
                        "epoch-new"));
        when(harness.cancelManagedRuntime("tenant", "session", "prompt",
                "checkpoint-1", "activation-1"))
                .thenReturn(new Admission(5, "epoch-new"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.cancel("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness, times(1)).cancel("tenant", "session");
        verify(harness).recoverManagedCancellation("tenant", "session");
        verify(harness).cancelManagedRuntime("tenant", "session", "prompt",
                "checkpoint-1", "activation-1");
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The coded refusal paces its takeover loads per Turn:
    // cancelAdmittedTurn reruns on every ~500ms lease-renewal tick, and a
    // wedged requested wait must not pay ~4 requests/s of daemon work for
    // it (the round-10 hot loop). Within the interval only the cheap
    // plain cancel retries; the next paced window forces the load again.
    @Test
    void cancelRefusedOnAdmittedTurnPacesTheTakeoverLoads() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        java.util.concurrent.atomic.AtomicLong now =
                new java.util.concurrent.atomic.AtomicLong(1_000_000L);
        Clock clock = mock(Clock.class);
        when(clock.millis()).thenAnswer(invocation -> now.get());
        TurnRecord cancelling = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 4, "CANCELLING");
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(cancelling));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-new", null, 0, 0, 1, 1, null, 1));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        DaemonHttpException refused = mock(DaemonHttpException.class);
        when(refused.getStatusCode()).thenReturn(409);
        when(refused.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        doThrow(refused).when(harness).cancel("tenant", "session");
        when(harness.recoverManagedCancellation("tenant", "session"))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), clock, new ManagedAgentProperties());
        try {
            coordinator.cancel("tenant", "session", "turn");
            // The next ~500ms tick meets the same coded refusal — and
            // pays only the cheap plain cancel for it.
            now.addAndGet(500);
            coordinator.cancel("tenant", "session", "turn");
            // The paced window over, the load is forced once more: a wait
            // that ended meanwhile settles without burning the tick.
            now.addAndGet(4_600);
            coordinator.cancel("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness, times(3)).cancel("tenant", "session");
        verify(harness, times(2)).recoverManagedCancellation("tenant",
                "session");
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // Only the coded park refusal earns the takeover load: any other
    // cancel failure stays on the lease-renewal retry, so a transient
    // daemon answer never mints one.
    @Test
    void cancelRefusedWithAnyOtherAnswerAwaitsLeaseRenewal() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord cancelling = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 4, "CANCELLING");
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(cancelling));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-new", null, 0, 0, 1, 1, null, 1));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        DaemonHttpException refused = mock(DaemonHttpException.class);
        when(refused.getStatusCode()).thenReturn(409);
        when(refused.getErrorCode())
                .thenReturn("hosted_prompt_recovery_required");
        doThrow(refused).when(harness).cancel("tenant", "session");
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.cancel("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness, times(1)).cancel("tenant", "session");
        verify(harness, never()).recoverManagedCancellation(anyString(),
                anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A lost G1 admission whose 202 never landed leaves the mark without an
    // epoch; the adopted generation's resubmit meets the coded 409. The
    // code proves the daemon durably holds THIS prompt unsettled, so the
    // arm adopts the attach's epoch with the consumed watermark kept and
    // streams — the replay surfaces the parked Turn (R10-4) — instead of
    // re-marking and re-POSTing the identical refusal forever.
    @Test
    void duplicateAdmissionAdoptsTheEpochAndStreamsTheParkedTurn() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 0);
        TurnRecord adopted = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 0, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        // The Session still carries an EARLIER Turn's epoch: the adoption
        // must expect the Turn's epoch (null — the lost reply) and the
        // Session's epoch (epoch-0) as the two different values they are.
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", "epoch-0", 0, 0, 1, 1, null,
                        1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(false, true);
        when(store.withdrawSubmissionAttempted(eq("tenant"), eq("session"),
                eq("turn"), anyString())).thenReturn(true);
        DaemonHttpException duplicate = mock(DaemonHttpException.class);
        when(duplicate.getStatusCode()).thenReturn(409);
        when(duplicate.getErrorCode())
                .thenReturn("hosted_prompt_recovery_required");
        when(harness.submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString())).thenThrow(duplicate);
        // Read order: the withdraw arm's post-withdraw recheck, the
        // pre-submit read (still epoch-less — the first generation's lost
        // reply is what this arm bridges), then the post-adoption read.
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed), Optional.of(claimed),
                        Optional.of(adopted));
        when(harness.stream("tenant", "session", 0, "epoch-new"))
                .thenReturn(cancelledStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // One withdraw, one submit, no second attempt — then the epoch is
        // adopted from the attach with the consumed watermark (0) kept,
        // and the stream replays the parked Turn's journal.
        verify(store, times(1)).withdrawSubmissionAttempted(eq("tenant"),
                eq("session"), eq("turn"), anyString());
        verify(harness, times(1)).submit(eq("tenant"), eq("session"),
                eq("prompt"), any(), anyString());
        verify(store).recordRecoveryAdmission(eq("tenant"), eq("session"),
                eq("turn"), anyString(), isNull(), eq("epoch-0"),
                eq("epoch-new"), eq(0L));
        verify(store, never()).recordAdmission(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyLong());
        verify(harness).stream("tenant", "session", 0, "epoch-new");
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // The same coded 409 without a prior mark names a different Turn's
    // unsettled input on the Session, not this Turn's lost admission — no
    // adoption may be forged from it. The mark this pass recorded is not an
    // admission, so the failure meets the pre-admission retry budget like
    // any refusal before admission; at exhaustion the recorded code is the
    // daemon's own (R10-4's honest failure).
    @Test
    void duplicateAdmissionWithoutPriorMarkMeetsTheRetryBudget() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        DaemonHttpException duplicate = mock(DaemonHttpException.class);
        when(duplicate.getStatusCode()).thenReturn(409);
        when(duplicate.getErrorCode())
                .thenReturn("hosted_prompt_recovery_required");
        when(harness.submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString())).thenThrow(duplicate);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store, never()).recordRecoveryAdmission(anyString(),
                anyString(), anyString(), anyString(), any(), any(),
                anyString(), anyLong());
        verify(store, never()).recordAdmission(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyLong());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_prompt_recovery_required"),
                anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // The session-level wedge code names SOMEONE ELSE's parked Turn, not
    // this one's lost admission — no adoption may be forged from it even
    // with the mark standing (R11-1). It is also a pre-admission failure:
    // the epoch-null Turn provably admitted nothing, so the budget fires
    // and the exhaustion records the wedge's own code, not the generic
    // unavailable.
    @Test
    void sessionBusyRefusalMeetsTheRetryBudgetWithoutBridging() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 5L,
                        "epoch-new"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        DaemonHttpException busy = mock(DaemonHttpException.class);
        when(busy.getStatusCode()).thenReturn(409);
        when(busy.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        when(harness.submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString())).thenThrow(busy);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store, never()).recordRecoveryAdmission(anyString(),
                anyString(), anyString(), anyString(), any(), anyString(),
                any(), anyLong());
        verify(store, never()).recordAdmission(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyLong());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_turn_recovery_required"),
                anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // The withdrawal is a CAS: losing it (the mark is gone, or the lease
    // was lost) must end the Turn terminally rather than resubmit a prompt
    // another owner may already have admitted.
    @Test
    void lostWithdrawalCasFailsTheTurnTerminally() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 0L,
                        "epoch-new"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(false);
        when(store.withdrawSubmissionAttempted(eq("tenant"), eq("session"),
                eq("turn"), anyString())).thenReturn(false);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // The CAS is load-bearing: it must be attempted exactly once, and
        // the rebind must NOT happen after it was lost — re-submitting
        // would double-admit a prompt the journal may already hold.
        InOrder order = inOrder(store, harness);
        order.verify(store).bindHarness(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("boot-new"));
        order.verify(store).withdrawSubmissionAttempted(eq("tenant"),
                eq("session"), eq("turn"), anyString());
        verify(store, times(1)).bindHarness(anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_generation_mismatch"),
                anyString());
        verify(harness, never()).submit(anyString(), anyString(),
                anyString(), any(), anyString());
    }

    // An unbound Session has no prior generation whose lease bounds the
    // wait, so even a generation exception meets the pre-admission budget.
    @Test
    void unboundSessionMeetsRetryBudgetOnGenerationException() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", null, null, 0, 0, 1, 1, null, 1));
        when(harness.createOrLoad("tenant", "session", false)).thenThrow(
                mock(HostedHarnessGenerationException.class));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // The decline reason is remote-supplied, so the terminal message stays
    // inside managed_agent_turn.error_message VARCHAR(2048) no matter how
    // long the body's reason runs.
    @Test
    void recoveryDeclineReasonIsBoundedToTheErrorColumn() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException(
                        "x".repeat(4000)));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("managed_runtime_recovery_blocked"),
                argThat(message -> message.length() <= 2048));
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // A cancelled Turn whose never-admitted mark was withdrawn is exactly
    // the case the early gate fast-cancels: it must not be re-dispatched
    // into a live execution at the adopted generation first.
    @Test
    void withdrawnCancellationIsFastCancelledNotResubmitted() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 0);
        // The cancel lands after the claim: only the re-read row shows it,
        // so this pins the decision on fresh state rather than on `claimed`.
        TurnRecord cancelledAfterClaim = turn("tenant", "session", "turn",
                "prompt", null, 0, "CANCELLING", false, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 0L,
                        "epoch-new"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(false);
        when(store.withdrawSubmissionAttempted(eq("tenant"), eq("session"),
                eq("turn"), anyString())).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(cancelledAfterClaim));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        InOrder order = inOrder(store, harness);
        order.verify(store).bindHarness(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("boot-new"));
        order.verify(store).withdrawSubmissionAttempted(eq("tenant"),
                eq("session"), eq("turn"), anyString());
        order.verify(store).cancelBeforeAdmission(eq("tenant"),
                eq("session"), eq("turn"), anyString());
        verify(harness, never()).submit(anyString(), anyString(),
                anyString(), any(), anyString());
        verify(store, never()).markSubmissionAttempted(anyString(),
                anyString(), anyString(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // G3: a Harness process generation change is adopted, not failed. The
    // retry is exempt from the pre-admission budget (claimed here at its
    // cap of 5): the wait is bounded by the prior generation's lease, and
    // the next attempt re-attaches through the takeover load.
    @Test
    void adoptsNextHarnessGenerationInsteadOfFailing() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        HostedHarnessGenerationException mismatch =
                mock(HostedHarnessGenerationException.class);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(mismatch);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A takeover refusal that cannot change under retry ends the Turn with
    // the existing blocked code instead of parking it forever.
    @Test
    void declinedTakeoverEndsTurnAsRecoveryBlocked() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException(
                        "shell_in_flight"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("managed_runtime_recovery_blocked"),
                argThat(message -> message.contains("shell_in_flight")));
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // G3: a Turn marked by a generation that never admitted it withdraws the
    // mark so the adopted generation may bind and submit it. The journal's
    // commandId idempotency absorbs a lost old-generation admission.
    @Test
    void withdrawsSubmissionMarkAndSubmitsOnAdoptedGeneration() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 0);
        TurnRecord admitted = turn("tenant", "session", "turn", "prompt",
                "epoch-new", 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 0L,
                        "epoch-new"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(false, true);
        when(store.withdrawSubmissionAttempted(eq("tenant"), eq("session"),
                eq("turn"), anyString())).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                // Three reads: the withdraw branch re-reads the status, the
                // post-bind read must still see no epoch so the submit runs,
                // then the post-admission read sees the admitted row.
                .thenReturn(Optional.of(claimed), Optional.of(claimed),
                        Optional.of(admitted));
        when(harness.submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString())).thenReturn(new Admission(5,
                        "epoch-new"));
        when(harness.stream("tenant", "session", 5, "epoch-new"))
                .thenReturn(terminalStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        InOrder order = inOrder(store, harness);
        order.verify(store).bindHarness(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("boot-new"));
        order.verify(store).withdrawSubmissionAttempted(eq("tenant"),
                eq("session"), eq("turn"), anyString());
        order.verify(store).bindHarness(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("boot-new"));
        order.verify(store).markSubmissionAttempted(eq("tenant"),
                eq("session"), eq("turn"), anyString());
        order.verify(harness).submit(eq("tenant"), eq("session"),
                eq("prompt"), any(), anyString());
        verify(store).recordHarnessEvents(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("epoch-new"), any());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).bindRecoveredHarness(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
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
                "epoch-new", 7, "CANCELLING");

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
        when(harness.stream(tenantId, sessionId, 7, "epoch-new"))
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
                eq("epoch-old"), eq("epoch-new"), eq(7L));
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
                "epoch-new", 0, "CANCELLING");

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
        when(harness.stream(tenantId, sessionId, 0, "epoch-new"))
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
                eq(turnId), anyString(), eq(null), eq(null), eq("epoch-new"),
                eq(0L));
        verify(harness).stream(tenantId, sessionId, 0, "epoch-new");
        verify(harness).cancelManagedRuntime(tenantId, sessionId, promptId,
                "checkpoint-1", "activation-1");
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
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
                anyString(), anyString(), anyString(), anyString(),
                anyString(), anyLong());
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
        when(harness.stream(tenantId, sessionId, 7, "epoch-new"))
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
                eq("epoch-old"), eq("epoch-new"), eq(7L));
        recoveryOrder.verify(harness).continueManagedRuntime(tenantId,
                sessionId, promptId, "checkpoint-1", "activation-1");
        recoveryOrder.verify(store).recordRecoveryAdmission(eq(tenantId),
                eq(sessionId), eq(turnId), anyString(), eq("epoch-new"),
                eq("epoch-new"), eq("epoch-new"), eq(0L));
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
        when(harness.stream(tenantId, sessionId, 7, "epoch-new"))
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
                anyString(), anyString(), anyLong());
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
                anyString(), anyString(), anyLong());
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
