package com.alibaba.qwen.code.managedagent.session;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.daemon.HarnessSessionRefusedException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.daemon.HostedHarnessStreamIdleException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.harness.HarnessDisabledException;
import com.alibaba.qwen.code.managedagent.harness.HostedHarnessRecoveryDeclinedException;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.model.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeWarmer;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.InOrder;
import org.slf4j.LoggerFactory;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.after;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class HarnessCoordinatorTest {
    // Pins the fail-fast validation of the dispatch retry budgets: any
    // negative budget — and a post-admission budget below the
    // pre-admission one, which would silently strip late-admitted turns of
    // their retries — is a startup error.
    @ParameterizedTest(name = "pre = {0}, post = {1}, operations = {2}")
    @CsvSource({"-1, 10, 10", "5, -1, 10", "5, 10, -1"})
    void rejectsInvalidDispatchRetryBudgets(int pre, int post,
            int operations) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxPreAdmissionRetries(pre);
        properties.getDispatch().setMaxPostAdmissionRetries(post);
        properties.getDispatch().setMaxOperationRetries(operations);
        assertThrows(IllegalStateException.class, () ->
                new HarnessCoordinator(mock(AgentStateStore.class),
                        mock(HarnessConnector.class),
                        new HarnessEventProjector(), mock(RuntimeWarmer.class),
                        directExecutor(), Clock.systemUTC(), properties));
    }

    // The cross-field guard rejects a configuration that was legal before
    // the budgets existed, so its message must name the offending pair and
    // both values — an operator deploying onto an external config gets no
    // other pointer.
    @Test
    void rejectsAPostAdmissionBudgetBelowThePreAdmissionOne() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxPreAdmissionRetries(5);
        properties.getDispatch().setMaxPostAdmissionRetries(4);
        properties.getDispatch().setMaxOperationRetries(10);
        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> new HarnessCoordinator(mock(AgentStateStore.class),
                        mock(HarnessConnector.class),
                        new HarnessEventProjector(), mock(RuntimeWarmer.class),
                        directExecutor(), Clock.systemUTC(), properties));
        org.assertj.core.api.Assertions.assertThat(error.getMessage())
                .contains("max-pre-admission-retries=5")
                .contains("max-post-admission-retries=4");
    }

    // Positive control for the ordering guard: equal budgets are a
    // legitimate "no extra retries after admission" policy, and zero budgets
    // disable retries entirely.
    @ParameterizedTest(name = "pre = {0}, post = {1}, operations = {2}")
    @CsvSource({"5, 5, 10", "0, 0, 0"})
    void acceptsValidDispatchRetryBudgets(int pre, int post, int operations) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxPreAdmissionRetries(pre);
        properties.getDispatch().setMaxPostAdmissionRetries(post);
        properties.getDispatch().setMaxOperationRetries(operations);
        new HarnessCoordinator(mock(AgentStateStore.class),
                mock(HarnessConnector.class), new HarnessEventProjector(),
                mock(RuntimeWarmer.class), directExecutor(),
                Clock.systemUTC(), properties).close();
    }

    @Test
    void sessionCreateWarmWarmsTheSessionWithoutAPublicEvent() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(runtimeWarmer.isEnabled()).thenReturn(true);
        when(runtimeWarmer.warm("session"))
                .thenReturn(CompletableFuture.completedFuture(null));
        ExecutorService executor = directExecutor();
        HarnessCoordinator coordinator = sessionCreateWarmCoordinator(store,
                harness, runtimeWarmer, executor, true);
        try {
            coordinator.warmSession("tenant", "session");
        } finally {
            coordinator.close();
        }
        verify(executor).execute(any(Runnable.class));
        verify(runtimeWarmer).warm("session");
        verifyNoInteractions(store);
    }

    @ParameterizedTest(name = "setting = {0}, warmer = {1}, files = {2}")
    @CsvSource({"false, true, true", "true, false, true", "true, true, false"})
    void sessionCreateWarmIsSkippedUnlessEveryGateIsOpen(boolean setting,
            boolean warmerEnabled, boolean filesAvailable) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(filesAvailable);
        when(runtimeWarmer.isEnabled()).thenReturn(warmerEnabled);
        HarnessCoordinator coordinator = sessionCreateWarmCoordinator(store,
                harness, runtimeWarmer, directExecutor(), setting);
        try {
            coordinator.warmSession("tenant", "session");
        } finally {
            coordinator.close();
        }
        verify(runtimeWarmer, never()).warm(anyString());
        verifyNoInteractions(store);
    }

    @ParameterizedTest(name = "thrown = {0}")
    @ValueSource(booleans = {true, false})
    void aFailedSessionCreateWarmIsLoggedWithoutAPublicEvent(boolean thrown) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(runtimeWarmer.isEnabled()).thenReturn(true);
        IllegalStateException failure = new IllegalStateException("down");
        if (thrown) {
            when(runtimeWarmer.warm("session")).thenThrow(failure);
        } else {
            when(runtimeWarmer.warm("session"))
                    .thenReturn(CompletableFuture.failedFuture(failure));
        }
        ch.qos.logback.classic.Logger coordinatorLog =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(HarnessCoordinator.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        coordinatorLog.addAppender(logged);
        HarnessCoordinator coordinator = sessionCreateWarmCoordinator(store,
                harness, runtimeWarmer, directExecutor(), true);
        try {
            coordinator.warmSession("tenant", "session");
        } finally {
            coordinator.close();
            coordinatorLog.detachAppender(logged);
            logged.stop();
        }
        assertThat(logged.list).anySatisfy(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage())
                    .contains("create warm failed")
                    .contains("session=session");
        });
        verifyNoInteractions(store);
    }

    private static HarnessCoordinator sessionCreateWarmCoordinator(
            AgentStateStore store, HarnessConnector harness,
            RuntimeWarmer runtimeWarmer, ExecutorService executor,
            boolean sessionCreateWarm) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setSessionCreateWarm(sessionCreateWarm);
        return new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, executor,
                Clock.systemUTC(), properties);
    }

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
                    status, true, 0);
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
            verify(store, never()).deferTurnRetry(anyString(), anyString(),
                    anyString(), anyString(), anyLong());
            verify(harness).isWorkspaceFilesAvailable();
            verifyNoMoreInteractions(harness);
            verifyNoInteractions(runtimeWarmer);
        }
    }

    // The CANCELLING cell of the files gate: it sits above the cancel fast
    // path, so a never-submitted bound Turn being cancelled parks like an
    // ACCEPTED one — deferred, never cancelBeforeAdmission — and the cancel
    // is honoured once the files return.
    @Test
    void defersABoundCancellationWhileWorkspaceFilesAreUnavailable() {
        SessionRecord session = boundSessionRecord();
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        TurnRecord claimed = turn("tenant", "session", "turn",
                "11111111-1111-4111-8111-111111111111", null, 0, "CANCELLING",
                false, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(session);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(false);
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
            verify(store).deferTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong());
            verify(store, never()).cancelBeforeAdmission(anyString(),
                    anyString(), anyString(), anyString());
            verify(store, never()).failTurn(anyString(), anyString(),
                    anyString(), anyString(), anyString(), anyString());

            when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).cancelBeforeAdmission(eq("tenant"), eq("session"),
                eq("turn"), anyString());
    }

    // Before any submission a Workspace-files outage holds the Turn like a
    // Harness outage: a replay may already have answered 202 for it, and the
    // availability-gated sweep re-offers it once the files are back.
    @Test
    void defersABoundTurnWhileWorkspaceFilesAreUnavailable() {
        SessionRecord session = boundSessionRecord();
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        TurnRecord claimed = turn("tenant", "session", "turn",
                "11111111-1111-4111-8111-111111111111", null, 0, "ACCEPTED",
                false, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(session);
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).deferTurnRetry(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(harness).isWorkspaceFilesAvailable();
        verifyNoMoreInteractions(harness);
        verifyNoInteractions(runtimeWarmer);
    }

    // The hold is bounded by the pre-admission budget: a Workspace-files
    // outage that outlasts it terminates with an actionable code instead of
    // an eternal ACCEPTED.
    @Test
    void failsABoundTurnAfterTheWorkspaceOutageBudgetIsExhausted() {
        SessionRecord session = boundSessionRecord();
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        TurnRecord claimed = turn("tenant", "session", "turn",
                "11111111-1111-4111-8111-111111111111", null, 0, "ACCEPTED",
                false, 5);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(session);
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("workspace_unavailable"), anyString());
        verify(store, never()).deferTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
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
                false, retryCount,
                boundSessionRecord());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("workspace_unavailable"),
                eq(refusal.getMessage()));
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // An outage defers instead of terminally failing: a replay answered 202
    // relies on this hold. The Harness-disabled arm is not budget-bounded —
    // the sweep and the replay dispatch both gate on isAvailable(), so the
    // first defer parks the Turn with its retry count frozen until
    // availability returns; failsAfterTheHarnessOutageBudgetIsExhausted
    // reaches the budget branch only because it drives coordinator.dispatch
    // directly, past both gates. The Session is unbound: the only
    // HarnessDisabledException producer also answers
    // isWorkspaceFilesAvailable() false, so a bound Session meets the files
    // gate first (defersABoundTurnWhileWorkspaceFilesAreUnavailable) and
    // never reaches createOrLoad.
    @Test
    void defersWhileTheHarnessIsDisabled() {
        AgentStateStore store = dispatchWithCreateOrLoadFailure(
                disabledHarnessFailure(), false, 0,
                unboundSessionRecord());
        verify(store).deferTurnRetry(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyLong());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // Past the pre-admission budget the same outage ends the Turn with an
    // actionable code instead of holding it ACCEPTED forever.
    @Test
    void failsAfterTheHarnessOutageBudgetIsExhausted() {
        AgentStateStore store = dispatchWithCreateOrLoadFailure(
                disabledHarnessFailure(), false, 5,
                unboundSessionRecord());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).deferTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // The outage deferral reads the same charged budget as every other
    // pre-admission retry: exempt waits (a predecessor's lease-bounded
    // conflict) do not count, so a Turn that already waited out five of
    // them still defers instead of failing on its first outage.
    @Test
    void harnessOutageDeferralDoesNotChargeBudgetExemptWaits() {
        TurnRecord base = turn("tenant", "session", "turn", "prompt", null, 0,
                false, 5);
        TurnRecord claimed = new TurnRecord(base.tenantId(),
                base.sessionId(), base.turnId(), base.promptId(),
                base.input(), base.payloadDigest(), base.status(),
                base.submissionAttempted(), base.harnessEventEpoch(),
                base.harnessLastEventId(), base.dispatchOwner(),
                base.dispatchLeaseUntil(), 5, 5, 5, base.retryAfter(),
                base.errorCode(), base.errorMessage(), base.createdAt(),
                base.updatedAt(), base.completedAt(), base.version());
        AgentStateStore store = dispatchWithCreateOrLoadFailure(
                disabledHarnessFailure(), claimed, unboundSessionRecord());
        verify(store).deferTurnRetry(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // The outage signal comes from the real connector: if the disabled
    // connector ever throws something else, this test — and the deferral
    // path it drives — turns red instead of silently shifting the load.
    private static HarnessDisabledException disabledHarnessFailure() {
        try {
            new UnavailableHarnessConnector().createOrLoad("tenant",
                    "session", false);
            throw new AssertionError("the disabled connector must throw");
        } catch (HarnessDisabledException error) {
            return error;
        }
    }

    // A claim that already recorded a submission attempt may have been
    // admitted, so even a permanent authorization refusal must not end it
    // before the pre-admission retry budget (retryCount 5 would otherwise be
    // terminal, see failsPreAdmissionTurnAfterRetryBudgetIsExhausted).
    @Test
    void retriesWorkspaceAuthorizationRefusalAfterARecordedSubmission() {
        AgentStateStore store = dispatchWithCreateOrLoadFailure(
                WorkspaceExecutionStore.unavailable(), true, 5,
                boundSessionRecord());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
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
                false, 0,
                boundSessionRecord());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
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
                false, 0,
                boundSessionRecord());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
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
                true, 5,
                boundSessionRecord());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_rejected"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // The outage-exhaustion log replaces the branch log it suppresses, so
    // it must carry that branch's failure label and its throwable — the only
    // error the path emits.
    @Test
    void logsTheFailureLabelWhenTheOutageBudgetRunsOut() {
        ch.qos.logback.classic.Logger coordinatorLog =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(
                        HarnessCoordinator.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        coordinatorLog.addAppender(logged);
        try {
            dispatchWithCreateOrLoadFailure(
                    new HarnessDisabledException("disabled"), false, 5,
                    unboundSessionRecord());
        } finally {
            coordinatorLog.detachAppender(logged);
        }
        assertThat(logged.list).anySatisfy(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.ERROR);
            assertThat(event.getFormattedMessage())
                    .contains("failure=HarnessDisabledException");
            assertThat(event.getThrowableProxy()).isNotNull();
        });
    }

    // A 5xx from the Harness or a proxy is transient, so a Turn whose
    // submission may have been admitted is retried, not failed.
    @Test
    void retriesATransientHarnessFailureAfterSubmission() {
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        AgentStateStore store = dispatchWithCreateOrLoadFailure(unavailable,
                true, 5,
                boundSessionRecord());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                false, 5,
                boundSessionRecord());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
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
                false, 0,
                boundSessionRecord());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    @Test
    void recordsTheLoadRefusalCodeWhenRetriesRunOut() {
        HarnessSessionRefusedException refusal = mock(
                HarnessSessionRefusedException.class);
        when(refusal.getCode()).thenReturn("managed_session_open_failed");
        AgentStateStore store = dispatchWithCreateOrLoadFailure(refusal,
                false, 5,
                boundSessionRecord());
        verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("managed_session_open_failed"), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // Issue #14387: a workflow Turn runs deterministically in-process under
    // node:vm, and a Harness crash leaves no witness to its in-process
    // subagents. The recovery must never re-drive it: the takeover load's
    // parked snapshot would be continued — re-running the script and
    // re-dispatching the subagents, spending the work twice while the
    // first run's outcome stayed unobserved. The drive instead marks the
    // Turn durably and ends without settling it; the child result relay
    // reads the code off the Turn line and settles the record blocked.
    // Found by the FG10d fault gate.
    @Test
    void neverRedrivesAWorkflowTurnOnARecoveryPath() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        // A workflow Turn that was being driven on a Harness that died:
        // bound session (harnessBootId set), the Turn's input carries the
        // workflow_launch block, it was submitted and admitted, and the
        // takeover load on the new generation parks a recovery snapshot
        // whose continue would re-run the script.
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-old", 1L,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", recovery, 1L,
                        "epoch-new"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // The continuation that would re-run the script never fires; the
        // Turn is marked for the relay and never settled as if observed.
        verify(store).markTurnRecoveryBlocked(eq("tenant"), eq("session"),
                eq("turn"), anyString(),
                eq(AgentStateStore.WORKFLOW_RECOVERY_BLOCKED),
                anyString());
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The #14387 refusal keys on the recovery path alone. A workflow
    // Turn's first launch rides an unbound Session — harness_boot_id is
    // written only by the first attach (ManagedAgentStore.bindHarness; the
    // creation INSERT has no such column) — so the refusal cannot fire and
    // the launch is driven like any other Turn's.
    @Test
    void drivesAWorkflowTurnsFirstLaunchOnAnUnboundSession() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", false, null, null,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                unboundSessionRecord());
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-new"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        when(harness.createOrLoad("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, null, null));
        when(harness.submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString()))
                .thenThrow(new IllegalStateException("response lost"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // The launch was driven: attached through createOrLoad (never the
        // takeover load) and submitted to the Harness.
        verify(harness).createOrLoad("tenant", "session", false);
        verify(harness).submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString());
        verify(harness, never()).recoverManagedRuntime(anyString(),
                anyString(), anyBoolean());
    }

    // The #14387 refusal may only bite an unwitnessed re-execution. A
    // transient stream drop re-claims the admitted workflow Turn with the
    // Harness healthy: the same boot answers the recovery attach from its
    // cache and the drive is observation-only — no submit, no continue,
    // just the stream resumed (the P1 review finding on #14461).
    @Test
    void resumesTheStreamOfAHealthyWorkflowTurnOnTheSameBoot() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-old", 3L,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-old", null, 3L,
                        "epoch-old"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-old"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        when(harness.stream("tenant", "session", 3, "epoch-old"))
                .thenReturn(cancelledStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness).stream("tenant", "session", 3, "epoch-old");
        verify(harness, never()).submit(anyString(), anyString(),
                anyString(), any(), anyString());
        verify(harness, never()).continueManagedRuntime(anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A workflow Turn whose submission went out on a generation that was
    // then lost — never recording an admission — may have been admitted by
    // the dead generation (R10-4): re-submitting on the replacement
    // generation re-runs the script unwitnessed. The refusal marks the
    // Turn instead, even when the takeover load parked nothing (no
    // recovery snapshot, plain re-attach arm). The generation change is
    // the evidence: the attach's boot differs from the Session's.
    @Test
    void neverResubmitsAWorkflowTurnWhoseAdmissionWasLostWithTheGeneration() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, null, null,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", null, 0L,
                        "epoch-new"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).markTurnRecoveryBlocked(eq("tenant"), eq("session"),
                eq("turn"), anyString(),
                eq(AgentStateStore.WORKFLOW_RECOVERY_BLOCKED),
                anyString());
        verify(harness, never()).submit(anyString(), anyString(),
                anyString(), any(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The same shape on the SAME live boot is not a loss: the submit
    // response was lost but the Harness is healthy, so re-submitting the
    // same prompt id and payload is an admission replay the daemon
    // dedupes, not a second workflow execution (P1 review finding on
    // #14461 — require evidence of generation loss before refusing).
    @Test
    void replaysALostSubmitAdmissionOnTheSameLiveBoot() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, null, null,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        TurnRecord admitted = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-boot",
                5L, "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null,
                null, 1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-old", null, 0L,
                        "epoch-boot"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-old"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed), Optional.of(admitted));
        when(harness.submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString()))
                .thenReturn(new Admission(5, "epoch-boot"));
        when(harness.stream("tenant", "session", 5, "epoch-boot"))
                .thenReturn(cancelledStream("prompt"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // The replay drives: submitted again (the daemon dedupes it), the
        // stream resumes at the adopted watermark — and never parked.
        verify(harness).submit(eq("tenant"), eq("session"), eq("prompt"),
                any(), anyString());
        verify(harness).stream("tenant", "session", 5, "epoch-boot");
        verify(store, never()).markTurnRecoveryBlocked(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A takeover load can refuse before returning any snapshot: the
    // decline is terminal for a workflow Turn — the in-process executor
    // died with the generation — so it parks blocked, never FAILED as if
    // its outcome were observed (P1 review finding on #14461).
    @Test
    void blocksAWorkflowTurnWhenTheTakeoverLoadDeclines() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-old", 1L,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException(
                        "model_start"));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).markTurnRecoveryBlocked(eq("tenant"), eq("session"),
                eq("turn"), anyString(),
                eq(AgentStateStore.WORKFLOW_RECOVERY_BLOCKED),
                anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The retriable takeover refusal is terminal in effect for a workflow
    // Turn — retrying never re-creates the lost generation's in-process
    // executor — so it parks blocked instead of retrying into a
    // budget-exhausted FAILED (P1 review finding on #14461).
    @Test
    void blocksAWorkflowTurnWhenTheTakeoverLoadRefuses() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-old", 1L,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        DaemonHttpException refused = mock(DaemonHttpException.class);
        when(refused.getStatusCode()).thenReturn(409);
        when(refused.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        when(refused.getBodyField("reason")).thenReturn("takeover_unrecovered");
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(refused);
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).markTurnRecoveryBlocked(eq("tenant"), eq("session"),
                eq("turn"), anyString(),
                eq(AgentStateStore.WORKFLOW_RECOVERY_BLOCKED),
                anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // The same coded refusal with a transient reason (a restore read
    // hiccup, not a lost generation) is NOT evidence the workflow cannot
    // be observed — a completed result may already sit journaled behind
    // it. The Turn keeps retrying instead of parking blocked (P1 review
    // finding on #14461: keep transient restore errors out of the
    // workflow-loss verdict).
    @Test
    void retriesAWorkflowTurnWhenTheTakeoverRefusalIsTransient() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-old", 1L,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null,
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        DaemonHttpException refused = mock(DaemonHttpException.class);
        when(refused.getStatusCode()).thenReturn(409);
        when(refused.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        when(refused.getBodyField("reason"))
                .thenReturn("restore_verification_failed");
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(refused);
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // The transient refusal retries — the Turn is never parked
        // blocked and never settled as if observed.
        verify(store, never()).markTurnRecoveryBlocked(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), anyBoolean());
    }

    // A CANCELLING workflow Turn whose takeover load declines keeps the
    // cancel's bounded path: the block sites never write the mark for it
    // — the mark cannot park a CANCELLING row (findDispatchable re-admits
    // it by design), so writing it would re-open the claim-refuse-release
    // spin this fix exists to close (P1 review finding on #14461).
    @Test
    void aCancellingWorkflowTurnKeepsItsBoundedPathWhenTheTakeoverDeclines() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "CANCELLING", true, "epoch-old",
                1L, "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null,
                null, 1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", true))
                .thenThrow(new HostedHarnessRecoveryDeclinedException(
                        "model_start"));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // The cancel keeps its bounded retry path — the mark that cannot
        // park a CANCELLING row is never written, and no terminal is forged.
        verify(store, never()).markTurnRecoveryBlocked(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(true));
    }

    // The same guard on the coded 409 arm: a CANCELLING workflow Turn
    // keeps its bounded retry, never the mark.
    @Test
    void aCancellingWorkflowTurnKeepsItsBoundedPathWhenTheTakeoverRefuses() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "CANCELLING", true, "epoch-old",
                1L, "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null,
                null, 1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        DaemonHttpException refused = mock(DaemonHttpException.class);
        when(refused.getStatusCode()).thenReturn(409);
        when(refused.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        when(refused.getBodyField("reason")).thenReturn("takeover_unrecovered");
        when(harness.recoverManagedRuntime("tenant", "session", true))
                .thenThrow(refused);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store, never()).markTurnRecoveryBlocked(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), anyBoolean());
    }

    // A mark lost to its lease CAS still ends the drive, but never
    // silently: the lost durable guard leaves a searchable warning (review
    // finding on #14461).
    @Test
    void warnsWhenTheRecoveryBlockedMarkIsLostToALeaseCas() {
        ch.qos.logback.classic.Logger coordinatorLog =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(
                        HarnessCoordinator.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        coordinatorLog.addAppender(logged);
        try {
            AgentStateStore store = mock(AgentStateStore.class);
            HarnessConnector harness = mock(HarnessConnector.class);
            RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
            when(runtimeWarmer.isEnabled()).thenReturn(false);
            TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                    "prompt",
                    List.of(Map.of("type", "workflow_launch", "script",
                            "return 1;")),
                    "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-old",
                    1L, "previous-owner", Long.MAX_VALUE, 0, 0, 0, null,
                    null, null, 1, 1, null, 1);
            when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), any(Duration.class)))
                    .thenReturn(Optional.of(claimed));
            when(store.requireSession("tenant", "session")).thenReturn(
                    new SessionRecord("tenant", "session", "qwen-code", null,
                            "ACTIVE", "boot-old", null, 0, 0, 1, 1, null,
                            1));
            HarnessRuntimeRecovery recovery =
                    mock(HarnessRuntimeRecovery.class);
            when(harness.recoverManagedRuntime("tenant", "session", false))
                    .thenReturn(new Attachment("boot-new", recovery, 1L,
                            "epoch-new"));
            // The lease lapsed between the attach and the mark: the fenced
            // CAS misses.
            when(store.markTurnRecoveryBlocked(anyString(), anyString(),
                    anyString(), anyString(), anyString(), anyString()))
                    .thenReturn(false);
            HarnessCoordinator coordinator = new HarnessCoordinator(store,
                    harness, new HarnessEventProjector(), runtimeWarmer,
                    directExecutor(), Clock.systemUTC(),
                    new ManagedAgentProperties());
            try {
                coordinator.dispatch("tenant", "session", "turn");
            } finally {
                coordinator.close();
            }
            verify(store).markTurnRecoveryBlocked(eq("tenant"),
                    eq("session"), eq("turn"), anyString(),
                    eq(AgentStateStore.WORKFLOW_RECOVERY_BLOCKED),
                    anyString());
            assertThat(logged.list).anySatisfy(event -> {
                assertThat(event.getLevel()).isEqualTo(Level.WARN);
                assertThat(event.getFormattedMessage())
                        .contains("recovery-blocked mark lost");
            });
        } finally {
            coordinatorLog.detachAppender(logged);
        }
    }

    // Once refused, the durable mark ends every later re-claim before any
    // attach: the scan stays a cheap claim-skip-release until the child
    // Session's close settles the Turn.
    @Test
    void aMarkedWorkflowTurnEndsItsDriveBeforeAnyAttach() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt",
                List.of(Map.of("type", "workflow_launch", "script",
                        "return 1;")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-old", 1L,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null,
                AgentStateStore.WORKFLOW_RECOVERY_BLOCKED,
                "The Harness generation running this workflow was lost.",
                1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verifyNoInteractions(harness);
        verify(store, never()).markTurnRecoveryBlocked(anyString(),
                anyString(), anyString(), anyString(), anyString(),
                anyString());
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
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
                eq("turn"), anyString(), anyLong(), eq(true));
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
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // The transient-window code clears under the daemon's own wake pump:
    // a Turn whose wait already spent the whole budget on it survives a
    // wake park behind the window refusal, exactly because the durable
    // meaning stayed behind on the old code.
    @Test
    void transientRecoveryWindow409SurvivesASpentRetryBudget() {
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
                .thenReturn(new Attachment("boot-new", null, 4L,
                        "epoch-new"));
        when(store.bindHarness(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        DaemonHttpException window = mock(DaemonHttpException.class);
        when(window.getStatusCode()).thenReturn(409);
        when(window.getErrorCode())
                .thenReturn("hosted_turn_recovery_in_progress");
        when(harness.submit(eq("tenant"), eq("session"), anyString(),
                any(), anyString())).thenThrow(window);
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
                eq("turn"), anyString(), anyLong(), eq(true));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
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
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // An approval wait is bounded by the approval timeout, never by a
    // durable verdict: a decline with this reason stays retriable — the
    // Turn must not die while the Action is still requested. 10 is exactly
    // the spent post-admission budget and 42 is far past it: no constant
    // retry budget tracks the 1s-to-24h operator-settable approval timeout,
    // so the wait is exempt (review R3-9).
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {5, 10, 42})
    void awaitActionDeclineStaysRetriableWhileActionRequested(
            int retryCount) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        // submissionAttempted = true: the wait the retry beats the human
        // over happens after admission, where the budget is bypassed.
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-1", 3, "RUNNING", true, retryCount);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        // Keep the terminal path's reconcile observable: without the
        // exemption the post-admission budget arm cancels through the bound
        // Harness before recording the terminal failure.
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-old"))).thenReturn(true);
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
                eq("turn"), anyString(), anyLong(), eq(true));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).cancel(anyString(), anyString());
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    // The decline reason is remote-supplied, so the terminal message stays
    // inside managed_agent_turn.error_message VARCHAR(2048) no matter how
    // long the body's reason runs.
    @Test
    void recoveryDeclineReasonIsBoundedToTheErrorColumn() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.failRecoveryBlockedTurn(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
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
        verify(store).failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(),
                argThat(message -> message.length() <= 2048));
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
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
                eq("turn"), anyString(), anyLong(), eq(true));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The generation exemption is bounded before admission too: a Harness
    // that restarts between every attempt would otherwise keep a Turn that
    // never reached it retrying forever. 19 consecutive exempt failures is
    // the last run below the churn cap (4 × the pre-admission budget of 5)
    // and still retries exempt; at the cap the Turn fails with the
    // pre-admission unavailable code (review round 3, R3-6). The cap reads
    // consecutive_failures, not budget_exempt_failures: a run of 20 with
    // four charged failures in it is at the cap although only 16 of its
    // waits were exempt. A zero budget is floored to one, so its cap is 4
    // and the first change still re-attaches (review round 1, R1-1, R1-6).
    @ParameterizedTest(name = "budget {0}, consecutive {1}, exempt {2}")
    @CsvSource({"5, 19, 19, false", "5, 20, 20, true", "5, 33, 33, true",
            "5, 20, 16, true", "0, 0, 0, false", "0, 3, 3, false",
            "0, 4, 4, true"})
    void boundsTheGenerationExemptionBeforeAdmission(int budget,
            int consecutiveFailures, int budgetExemptFailures,
            boolean terminal) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "prompt", List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", false, null, 0L,
                "previous-owner", Long.MAX_VALUE, consecutiveFailures,
                consecutiveFailures, budgetExemptFailures, null, null, null,
                1, 1, null, 1);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxPreAdmissionRetries(budget);
        if (budget == 0) {
            properties.getDispatch().setMaxPostAdmissionRetries(0);
            properties.getDispatch().setMaxOperationRetries(0);
        }
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(mock(HostedHarnessGenerationException.class));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(), properties);
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        if (terminal) {
            verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), eq("hosted_harness_unavailable"), anyString());
            verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong(), eq(true));
            verify(store, never()).failTurn(anyString(), anyString(),
                    anyString(), anyString(), anyString(), anyString());
        }
    }

    // Missing admission acknowledgement does not prove this prompt never ran.
    // Retain its cancellation entry rather than orphaning native input.
    @Test
    void declinedTakeoverWithoutAcknowledgementRemainsCancellable() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-old", null, 0, 0, 0, 1, 1, null, 1,
                        new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1),
                        "default", "hosted-workspace-shell/1"));
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
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
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyLong(), eq(true));
        verify(harness, never()).cancel(anyString(), anyString());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void unsupportedLegacyRecoveryDoesNotUseNativeCancellationBudget(boolean admitted) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "legacy-turn", "legacy-prompt",
                admitted ? "epoch-old" : null, admitted ? 4 : 0, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("legacy-turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "legacy-turn"))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException("model_start"));
        when(store.failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("legacy-turn"),
                anyString(), anyString())).thenReturn(true);
        if (admitted) {
            when(store.bindHarness(eq("tenant"), eq("session"), eq("legacy-turn"),
                    anyString(), eq("boot-old"))).thenReturn(true);
            DaemonHttpException parked = mock(DaemonHttpException.class);
            when(parked.getStatusCode()).thenReturn(409);
            when(parked.getErrorCode()).thenReturn("hosted_turn_recovery_required");
            doThrow(parked).when(harness).cancel("tenant", "session");
            when(harness.recoverManagedCancellation("tenant", "session"))
                    .thenThrow(new HostedHarnessRecoveryDeclinedException("model_start"));
        }
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "legacy-turn");
        } finally {
            coordinator.close();
        }
        verify(store).failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("legacy-turn"),
                anyString(), argThat(message -> message.contains("model_start")));
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyBoolean());
        verify(store, never()).releaseTurnLease(anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
        if (admitted) {
            verify(harness).cancel("tenant", "session");
            verify(harness).recoverManagedCancellation("tenant", "session");
        } else {
            verify(harness, never()).cancel(anyString(), anyString());
        }
    }

    @Test
    void settlesUnadmittedCancellationWithoutContactingHarness() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "CANCELLING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(store.cancelUnadmittedTurn(eq("tenant"), eq("session"), eq("turn"), anyString()))
                .thenReturn(true);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(store).cancelUnadmittedTurn(eq("tenant"), eq("session"), eq("turn"), anyString());
        verify(store, never()).cancelBeforeAdmission(anyString(), anyString(), anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyBoolean());
        verify(store, never()).releaseTurnLease(anyString(), anyString(), anyString(), anyString());
        verifyNoInteractions(harness, runtimeWarmer);
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-admission", "failure-takeover", "cancel-takeover",
            "unknown-cancellation"})
    void unsettledRecoveryRetryDoesNotLogTerminalFailure(String lane) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        boolean unknownCancellation = "unknown-cancellation".equals(lane);
        boolean missingAdmission = "missing-admission".equals(lane) || unknownCancellation;
        boolean workspaceFailure = "failure-takeover".equals(lane);
        boolean cancelling = unknownCancellation || "cancel-takeover".equals(lane);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                missingAdmission ? null : "epoch-old", missingAdmission ? 0 : 4,
                cancelling ? "CANCELLING" : "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        SessionRecord session = new SessionRecord("tenant", "session", "qwen-code", null,
                null, "ACTIVE", "boot-old", "epoch-old", 4, 4, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1),
                "default", "hosted-workspace-shell/1");
        when(store.requireSession("tenant", "session")).thenReturn(session);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        if (unknownCancellation) {
            HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
            when(recovery.hasUnknownOutcome()).thenReturn(true);
            when(harness.recoverManagedRuntime("tenant", "session", true))
                    .thenReturn(new Attachment("boot-new", recovery, 4L, "epoch-new"));
        } else {
            when(harness.recoverManagedRuntime("tenant", "session", cancelling))
                    .thenThrow(new HostedHarnessRecoveryDeclinedException("shell_in_flight"));
        }
        if (workspaceFailure) {
            when(harness.recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                    eq("turn"), anyString()))
                    .thenThrow(new HostedHarnessRecoveryDeclinedException("generation_gone"));
        } else if (!missingAdmission) {
            when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), eq("boot-old"))).thenReturn(true);
            DaemonHttpException parked = mock(DaemonHttpException.class);
            when(parked.getStatusCode()).thenReturn(409);
            when(parked.getErrorCode()).thenReturn("hosted_turn_recovery_required");
            doThrow(parked).when(harness).cancel("tenant", "session");
            when(harness.recoverManagedCancellation("tenant", "session"))
                    .thenThrow(new HostedHarnessRecoveryDeclinedException("generation_gone"));
        }
        ch.qos.logback.classic.Logger coordinatorLog =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(HarnessCoordinator.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        coordinatorLog.addAppender(logged);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
            coordinatorLog.detachAppender(logged);
            logged.stop();
        }
        // A deterministic takeover decline keeps its existing bounded
        // retry; only the unknown gate parks (D7-2 decision 10). A
        // CANCELLING Turn keeps that same bounded retry lane.
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyLong(), eq(true));
        verify(store, never()).parkTurnForRuntimeRecovery(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(store, never()).failRecoveryBlockedTurn(anyString(), anyString(), anyString(),
                anyString(), anyString());
        verify(store, never()).releaseTurnLease(anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
        if (unknownCancellation) {
            verify(store).cancelUnadmittedTurn(eq("tenant"), eq("session"), eq("turn"), anyString());
        } else {
            verify(store, never()).cancelUnadmittedTurn(anyString(), anyString(), anyString(), anyString());
        }
        assertThat(logged.list).noneSatisfy(event ->
                assertThat(event.getFormattedMessage()).contains("Managed Turn failed terminally"));
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void terminalFailureLogRequiresSuccessfulTerminalWrite(boolean written) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException("generation_gone"));
        ch.qos.logback.classic.Logger coordinatorLog =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(HarnessCoordinator.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        coordinatorLog.addAppender(logged);
        doAnswer(invocation -> {
            assertThat(logged.list).isEmpty();
            return written;
        }).when(store).failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyString());
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
            coordinatorLog.detachAppender(logged);
            logged.stop();
        }
        verify(store).failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyBoolean());
        verify(store, times(written ? 0 : 1)).releaseTurnLease(anyString(), anyString(),
                anyString(), anyString());
        assertThat(logged.list).hasSize(written ? 1 : 0);
        if (written) {
            ILoggingEvent event = logged.list.getFirst();
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage()).contains("Managed Turn failed terminally");
            assertThat(event.getThrowableProxy()).isNotNull();
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void legacyRecoveryFailureStillAttemptsCancellationTakeover(
            boolean cancellationFails) {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.failRecoveryBlockedTurn(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-old", 4, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-old"))).thenReturn(true);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException(
                        "model_start"));
        DaemonHttpException parked = mock(DaemonHttpException.class);
        when(parked.getStatusCode()).thenReturn(409);
        when(parked.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        doThrow(parked).when(harness).cancel("tenant", "session");
        when(harness.recoverManagedCancellation("tenant", "session"))
                .thenReturn(new Attachment("boot-new", null, 4L,
                        "epoch-old"));
        if (cancellationFails) {
            when(harness.recoverManagedCancellation("tenant", "session"))
                    .thenThrow(new IllegalStateException("Runtime unavailable"));
        }
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer,
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        InOrder order = inOrder(harness, store);
        order.verify(harness).cancel("tenant", "session");
        order.verify(harness).recoverManagedCancellation("tenant", "session");
        order.verify(store).failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), argThat(message -> message.contains("model_start")));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyBoolean());
        verify(harness, never()).submit(anyString(), anyString(),
                anyString(), any(), anyString());
    }

    @ParameterizedTest
    @CsvSource({"RUNNING,false", "RUNNING,true", "CANCELLING,false"})
    void workspaceRecoveryFailureUsesTheMatchingCancellationAuthority(
            String turnStatus, boolean cancellationFails) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        TurnRecord claimed = turn("tenant", "session", "turn", "original-prompt",
                "epoch-old", 4, turnStatus, true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn")).thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-old", "epoch-old", 4, 4, 0, 1, 1, null, 1,
                        new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1),
                        "default", "hosted-workspace-shell/1"));
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(new HostedHarnessRecoveryDeclinedException("shell_in_flight"));
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.isCancellationReady()).thenReturn(true);
        when(recovery.getCheckpointId()).thenReturn("original-checkpoint");
        when(recovery.getActivationId()).thenReturn("original-activation");
        when(harness.recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString())).thenReturn(new Attachment("boot-new", recovery, 4L, "epoch-new"));
        boolean cancelling = "CANCELLING".equals(turnStatus);
        if (cancelling) {
            HarnessRuntimeRecovery blocked = mock(HarnessRuntimeRecovery.class);
            when(blocked.hasUnknownOutcome()).thenReturn(true);
            when(harness.recoverManagedRuntime("tenant", "session", true))
                    .thenReturn(new Attachment("boot-new", blocked, 4L, "epoch-new"));
            when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), eq("boot-old"))).thenReturn(true);
            DaemonHttpException parked = mock(DaemonHttpException.class);
            when(parked.getStatusCode()).thenReturn(409);
            when(parked.getErrorCode()).thenReturn("hosted_turn_recovery_required");
            doThrow(parked).when(harness).cancel("tenant", "session");
            when(harness.recoverManagedCancellation("tenant", "session"))
                    .thenReturn(new Attachment("boot-new", recovery, 4L, "epoch-new"));
        }
        if (cancellationFails) {
            doThrow(new IllegalStateException("Stop is not observed"))
                    .when(harness).cancelManagedRuntime("tenant", "session", "original-prompt",
                            "original-checkpoint", "original-activation");
        }
        when(store.failRecoveryBlockedTurn(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        InOrder order = inOrder(store, harness);
        if (cancelling) {
            order.verify(harness).cancel("tenant", "session");
            order.verify(harness).recoverManagedCancellation("tenant", "session");
            verify(harness, never()).recoverManagedFailureCancellation(anyString(), anyString(),
                    anyString(), anyString());
        } else {
            order.verify(harness).recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                    eq("turn"), anyString());
            verify(harness, never()).cancel(anyString(), anyString());
            verify(harness, never()).recoverManagedCancellation(anyString(), anyString());
        }
        order.verify(harness).cancelManagedRuntime("tenant", "session", "original-prompt",
                "original-checkpoint", "original-activation");
        if (cancellationFails) {
            verify(store, never()).failRecoveryBlockedTurn(anyString(), anyString(), anyString(),
                    anyString(), anyString());
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), anyLong(), eq(true));
        } else if (cancelling) {
            // A pending cancel is never written FAILED; it keeps the cancel
            // lane's bounded retry so the cancel route can settle it.
            order.verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong(), eq(true));
            verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                    anyString(), anyString(), anyString());
            verify(store, never()).failRecoveryBlockedTurn(anyString(), anyString(), anyString(),
                    anyString(), anyString());
        } else {
            order.verify(store).failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), argThat(message -> message.contains("shell_in_flight")));
        }
        if (!cancelling) {
            verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                    anyString(), anyString(), anyString());
        }
        verify(harness, never()).continueManagedRuntime(anyString(), anyString(), anyString(),
                anyString(), anyString());
    }

    @Test
    void parksARuntimeRecoveryThatCannotBeProvedInsteadOfRetryingIt() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        TurnRecord claimed = turn("tenant", "session", "turn", "original-prompt",
                "epoch-old", 4, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn")).thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(workspaceSession());
        HarnessRuntimeRecovery unknown = mock(HarnessRuntimeRecovery.class);
        when(unknown.hasUnknownOutcome()).thenReturn(true);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-new", unknown, 4L, "epoch-new"));
        HarnessRuntimeRecovery blocked = mock(HarnessRuntimeRecovery.class);
        when(blocked.isCancellationReady()).thenReturn(false);
        when(harness.recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString()))
                .thenReturn(new Attachment("boot-new", blocked, 4L, "epoch-new"));
        when(store.parkTurnForRuntimeRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString(), anyLong())).thenReturn(true);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        // The Turn stays active on its own park code; it is never terminally
        // failed and never enters the budget-exempt retry lane.
        verify(store).parkTurnForRuntimeRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString(), anyLong());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
        verify(store, never()).failRecoveryBlockedTurn(anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void rechecksAParkedRuntimeRecoveryWithAFreshCancellationLoad() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(harness.isAvailable()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.findDispatchable(anyLong(), eq(50))).thenReturn(List.of());
        when(store.findRuntimeRecoveryParked(anyLong(), eq(50)))
                .thenReturn(List.of(new DispatchTarget("tenant", "session", "turn")));
        TurnRecord claimed = turn("tenant", "session", "turn", "original-prompt",
                "epoch-old", 4, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn")).thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(workspaceSession());
        HarnessRuntimeRecovery blocked = mock(HarnessRuntimeRecovery.class);
        when(blocked.isCancellationReady()).thenReturn(false);
        when(harness.recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString()))
                .thenReturn(new Attachment("boot-new", blocked, 4L, "epoch-new"));
        when(store.parkTurnForRuntimeRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString(), anyLong())).thenReturn(true);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.recoverExpiredTurns();
        } finally {
            coordinator.close();
        }
        // The recheck discards the cached snapshot and asks the Broker again;
        // an outcome still unproved parks the Turn for the next cadence.
        verify(harness).discardManagedRecovery("tenant", "session");
        verify(harness).recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString());
        verify(store).parkTurnForRuntimeRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString(), anyLong());
        verify(store, never()).failRecoveryBlockedTurn(anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void settlesAParkedRuntimeRecoveryOnceItsCancellationIsReady() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(harness.isAvailable()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.findDispatchable(anyLong(), eq(50))).thenReturn(List.of());
        when(store.findRuntimeRecoveryParked(anyLong(), eq(50)))
                .thenReturn(List.of(new DispatchTarget("tenant", "session", "turn")));
        TurnRecord claimed = turn("tenant", "session", "turn", "original-prompt",
                "epoch-old", 4, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn")).thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(workspaceSession());
        HarnessRuntimeRecovery ready = mock(HarnessRuntimeRecovery.class);
        when(ready.isCancellationReady()).thenReturn(true);
        when(ready.getCheckpointId()).thenReturn("checkpoint");
        when(ready.getActivationId()).thenReturn("activation");
        when(harness.recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString()))
                .thenReturn(new Attachment("boot-new", ready, 4L, "epoch-new"));
        when(harness.cancelManagedRuntime("tenant", "session", "original-prompt",
                "checkpoint", "activation")).thenReturn(new Admission(5L, "epoch-new"));
        when(store.failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyString())).thenReturn(true);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.recoverExpiredTurns();
        } finally {
            coordinator.close();
        }
        verify(harness).discardManagedRecovery("tenant", "session");
        verify(harness).cancelManagedRuntime("tenant", "session", "original-prompt",
                "checkpoint", "activation");
        verify(store).failRecoveryBlockedTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyString());
        verify(store, never()).parkTurnForRuntimeRecovery(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyLong());
    }

    @Test
    void leavesAConcurrentUserCancelToTheCancellationLane() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(harness.isAvailable()).thenReturn(true);
        when(store.findDispatchable(anyLong(), eq(50))).thenReturn(List.of());
        when(store.findRuntimeRecoveryParked(anyLong(), eq(50)))
                .thenReturn(List.of(new DispatchTarget("tenant", "session", "turn")));
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                "epoch-old", 4, "CANCELLING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class))).thenReturn(Optional.of(claimed));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), runtimeWarmer, directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.recoverExpiredTurns();
        } finally {
            coordinator.close();
        }
        // The cancel that raced the recheck keeps the cancellation lane: the
        // lease is released and the recovery path is never entered.
        verify(store).releaseTurnLease(eq("tenant"), eq("session"), eq("turn"),
                anyString());
        verify(harness, never()).discardManagedRecovery(anyString(), anyString());
        verify(harness, never()).recoverManagedFailureCancellation(anyString(), anyString(),
                anyString(), anyString());
        verify(store, never()).parkTurnForRuntimeRecovery(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    private static SessionRecord workspaceSession() {
        return new SessionRecord("tenant", "session", "qwen-code", null,
                null, "ACTIVE", "boot-old", "epoch-old", 4, 4, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1),
                "default", "hosted-workspace-shell/1");
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

    // The bound and unbound shapes differ only in the SessionRecord: the
    // unbound shape is the one that can drive the isHarnessDisabled arm in
    // production.
    private static SessionRecord boundSessionRecord() {
        return new SessionRecord("tenant", "session", "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "ws-a", 1, "storage-a", ".",
                        "config-a", 1), "yolo", "hosted-workspace-files/1");
    }

    private static SessionRecord unboundSessionRecord() {
        return new SessionRecord("tenant", "session", "qwen-code", null,
                "ACTIVE", null, null, 0, 0, 0, 0, null, 1);
    }

    // The files-availability stub stays bound-only: the files gate
    // short-circuits on workspace == null, so an unbound stub would be dead
    // code under strict stubs.
    private AgentStateStore dispatchWithCreateOrLoadFailure(
            RuntimeException failure, boolean submitted, int retryCount,
            SessionRecord session) {
        return dispatchWithCreateOrLoadFailure(failure, turn("tenant",
                "session", "turn", "prompt", null, 0, submitted, retryCount),
                session);
    }

    private AgentStateStore dispatchWithCreateOrLoadFailure(
            RuntimeException failure, TurnRecord claimed,
            SessionRecord session) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(session);
        if (session.workspace() != null) {
            when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        }
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
            if (loseDelivery.getAndSet(false)) {
                throw new IllegalStateException("lost");
            }
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

    // #14135: a half-open stream ends with the typed idle outcome. That is a
    // transient stream failure: the admitted Turn waits for a retry that
    // re-attaches, and the silence alone never settles or cancels it.
    @Test
    void anIdleStreamRetriesTheAdmittedTurnWithoutSettlingIt() {
        AgentStateStore store = boundCancellingStore();
        TurnRecord running = turn("tenant", "session", "turn", "prompt",
                "epoch", 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(running));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(running));
        HarnessConnector harness = mock(HarnessConnector.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot"))).thenReturn(true);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot"));
        SourceStream stream = mock(SourceStream.class);
        when(stream.eventEpoch()).thenReturn("epoch");
        when(stream.next()).thenThrow(
                mock(HostedHarnessStreamIdleException.class));
        when(harness.stream("tenant", "session", 1, "epoch"))
                .thenReturn(stream);
        ch.qos.logback.classic.Logger coordinatorLog =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(
                        HarnessCoordinator.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        coordinatorLog.addAppender(logged);
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
            coordinatorLog.detachAppender(logged);
        }
        verify(stream).close();
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).cancel(anyString(), anyString());
        // Operators tell the liveness timeout from a reset socket or a
        // server that ended the stream by the failure the retry names.
        assertThat(logged.list).anySatisfy(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage())
                    .contains("will retry")
                    .contains("failure=HostedHarnessStreamIdleException");
        });
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

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void cancelsSameEpochInitialResultsReadyFromStoredPreOperationCursor(
            boolean unknownOutcome) {
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
        when(recovery.hasUnknownOutcome()).thenReturn(unknownOutcome);
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

        // The pending cancel keeps its bounded retry; no terminal is forged.
        verify(store).scheduleTurnRetry(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), anyLong(), eq(true));
        verify(store, never()).failTurn(eq(tenantId), eq(sessionId), eq(turnId),
                anyString(), anyString(), anyString());
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
                eq(turnId), anyString(), eq(18_000L), eq(false));
        verify(store, never()).releaseTurnLease(eq(tenantId), eq(sessionId),
                eq(turnId), anyString());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // Protects the post-submission uncertainty invariant: once submit may
    // have been admitted, neither a lost response nor a permanent Workspace
    // refusal ends the Turn while its post-admission retry budget lasts
    // (retryCount 5 is past the pre-admission budget but below the
    // post-admission one; exhaustion is covered by
    // AdmittedTurnRetryTerminalStateTest). The refusal row is not redundant
    // with the generic catch: deleting the RuntimeBrokerException arm keeps
    // it green by design, so the negative control is weakening that arm's
    // guard to drop !submissionAttempted, which would make this row
    // terminal.
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
                eq(turnId), anyString(), anyLong(), eq(false));
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                anyString(), anyString(), anyLong(), anyBoolean());
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
                eq(turnId), anyString(), anyLong(), eq(false));
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
                eq(turnId), anyString(), anyLong(), eq(false));
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
                eq(turnId), anyString(), anyLong(), eq(false));
        verify(store, never()).failTurn(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // The reconcile gate on a terminal fail must read the row, not the
    // claim-time record: a prior owner's admission that landed after the
    // claim leaves the claim-time flag false while the row shows the mark
    // and its epoch, and an immediate-terminal route must reconcile that
    // execution before clearing the dispatch owner exactly like the
    // budget-exhaustion route does (review round 12, R12-3; the epoch
    // precondition itself is R6-3's).
    @Test
    void terminalFailReconcilesAnAdmissionPostedAfterTheClaim() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.isEnabled()).thenReturn(false);
        TurnRecord claimed = turn("tenant", "session", "turn", "prompt",
                null, 0, "RUNNING", false, 0);
        // The durable record advanced past the claim: the submission and
        // its recorded admission landed between the claim and the attach.
        TurnRecord admitted = turn("tenant", "session", "turn", "prompt",
                "epoch-1", 3, "RUNNING", true, 0);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-old", null, 0, 0, 1, 1, null, 1));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(admitted));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-old"))).thenReturn(true);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(mock(DaemonProtocolException.class));
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
        order.verify(harness).cancel("tenant", "session");
        order.verify(store).failTurn(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("hosted_harness_protocol_error"),
                anyString());
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
                retryCount, retryCount, 0, null, null, null, 1, 1, null, 1);
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

    @Test
    void rejectsInvalidLeaseRenewConfiguration() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        ManagedAgentProperties zeroRenew = new ManagedAgentProperties();
        zeroRenew.getDispatch().setLeaseRenewInterval(Duration.ZERO);
        // A zero renew interval used to die on the worker thread holding
        // the claimed turn; a renew >= duration kept losing the lease at
        // the first renewal and read as hosted_harness_unavailable.
        assertThatThrownBy(() -> new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(), zeroRenew))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lease");

        ManagedAgentProperties inverted = new ManagedAgentProperties();
        inverted.getDispatch().setLeaseDuration(Duration.ofSeconds(10));
        inverted.getDispatch().setLeaseRenewInterval(Duration.ofSeconds(10));
        assertThatThrownBy(() -> new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(), inverted))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lease");

        // A sub-millisecond renew is positive, so only validating the
        // truncated millis rejects it; the scheduler would otherwise receive
        // period 0 and die on the worker thread holding the claimed turn.
        ManagedAgentProperties subMillis = new ManagedAgentProperties();
        subMillis.getDispatch()
                .setLeaseRenewInterval(Duration.ofNanos(999_999));
        assertThatThrownBy(() -> new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(), subMillis))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lease");

        // With the default 60 s duration a negative renew passes the
        // renew >= duration comparison, so only the renew-side bound rejects
        // it.
        ManagedAgentProperties negativeRenew = new ManagedAgentProperties();
        negativeRenew.getDispatch()
                .setLeaseRenewInterval(Duration.ofSeconds(-1));
        assertThatThrownBy(() -> new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(), negativeRenew))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lease");

        // A renew just under the duration orders below it but leaves no
        // margin for the renewal's own execution.
        ManagedAgentProperties tightRenew = new ManagedAgentProperties();
        tightRenew.getDispatch().setLeaseRenewInterval(Duration.ofSeconds(59));
        assertThatThrownBy(() -> new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(), tightRenew))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lease");

        // A sub-millisecond pair whose truncated margin is zero: both sides
        // round to 1 ms, so the renewal period equals the lease on the
        // scheduler's clock.
        ManagedAgentProperties zeroMargin = new ManagedAgentProperties();
        zeroMargin.getDispatch().setLeaseDuration(Duration.ofNanos(1_900_000));
        zeroMargin.getDispatch()
                .setLeaseRenewInterval(Duration.ofNanos(1_500_000));
        assertThatThrownBy(() -> new HarnessCoordinator(store, harness,
                new HarnessEventProjector(), mock(RuntimeWarmer.class),
                directExecutor(), Clock.systemUTC(), zeroMargin))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lease");

        // The defaults (60 s lease / 20 s renew) keep passing.
        new HarnessCoordinator(store, harness, new HarnessEventProjector(),
                mock(RuntimeWarmer.class), directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties()).close();
    }

    private static ExecutorService directExecutor() {
        return CoordinatorTestSupport.directExecutor();
    }
}
