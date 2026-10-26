package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HarnessSessionRefusedException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeWarmer;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Regression for issue #13182 finding 2: once submissionAttempted is
 * recorded, a Turn stuck on transient Harness failures must converge to a
 * cancellation-only recovery after the bounded post-admission retry budget
 * (maxPostAdmissionRetries, default 10). Native settlement remains necessary
 * before the Workspace Turn can become terminal.
 */
class AdmittedTurnRetryTerminalStateTest {
    // 10 is exactly the spent budget; 42 is far past it.
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {10, 42})
    void admittedWorkspaceTurnParksAfterThePostAdmissionRetryBudgetIsSpent(
            int retryCount) {
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        Dispatched dispatched = dispatchTransientFailure(retryCount,
                new ManagedAgentProperties(), unavailable, "epoch-1");
        AgentStateStore store = dispatched.store();

        verifyParked(store, "hosted_harness_unavailable_after_admission");
        verify(dispatched.harness()).recoverManagedFailureCancellation(eq("tenant"),
                eq("session"), eq("turn"), anyString(), eq("11111111-1111-4111-8111-111111111111"));
    }

    // The cancel carries no Turn identity — the daemon aborts whichever Turn
    // the Session is running — so a Turn holding only a submission mark
    // must not trigger it: the mark can belong to a Turn the daemon refused
    // while another Turn is live on the Session, and cancelling then aborts
    // that Turn (review round 6, R6-3). Missing proof keeps this Turn parked.
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {10, 42})
    void aLostAdmissionDoesNotPermitASessionScopedCancel(
            int retryCount) {
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        Dispatched dispatched = dispatchTransientFailure(retryCount,
                new ManagedAgentProperties(), unavailable);
        AgentStateStore store = dispatched.store();

        verify(dispatched.harness(), never()).cancel(anyString(),
                anyString());
        verifyParked(store, "hosted_harness_unavailable_after_admission");
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
        verify(dispatched.harness(), never()).cancelOriginalTurn(anyString(), anyString(), anyString());
    }

    // The named recovery refusals never reach the post-admission budget this
    // class is named for: dispatch strips the submission mark for
    // hosted_prompt_recovery_required, and for hosted_turn_recovery_required
    // when the claimed record carries no epoch — the shape
    // dispatchTransientFailure builds — so retryCount = 5 exhausts the
    // PRE-admission budget (default 5) and its named-code branch records the
    // daemon's own verdict in the cancellation-only diagnostic. The durable
    // submission mark still requires native proof before terminal state;
    // no session-scoped cancel is safe without a recorded admission.
    @ParameterizedTest(name = "refusalCode = {0}")
    @ValueSource(strings = {"hosted_turn_recovery_required",
            "hosted_prompt_recovery_required"})
    void namedRecoveryRefusalsKeepTheirCodeWhileAwaitingNativeEvidence(
            String refusalCode) {
        DaemonHttpException refusal = mock(DaemonHttpException.class);
        when(refusal.getStatusCode()).thenReturn(409);
        when(refusal.getErrorCode()).thenReturn(refusalCode);
        Dispatched dispatched = dispatchTransientFailure(5,
                new ManagedAgentProperties(), refusal);
        AgentStateStore store = dispatched.store();

        verify(dispatched.harness(), never()).cancel(anyString(),
                anyString());
        verifyParked(store, refusalCode);
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
        verify(dispatched.harness(), never()).cancelOriginalTurn(anyString(), anyString(), anyString());
    }

    // The cancel gate on a terminal pre-admission fail reads the re-read
    // record, not the claim-time one: an admission that landed after the
    // claim — the mark and its recorded epoch alike — is exactly what the
    // terminal fail must reconcile first, and a gate reading the claim-time
    // record would miss it (review R4-1; the epoch gate itself is R6-3's).
    @Test
    void aSubmissionMarkedAfterTheClaimStillRequiresNativeSettlement() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(store.markTurnFailureRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
        when(store.parkTurnForRuntimeRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyLong())).thenReturn(true);
        when(harness.recoverManagedFailureCancellation(anyString(), anyString(),
                anyString(), anyString(), eq("11111111-1111-4111-8111-111111111111"))).thenReturn(new Attachment("boot-1"));
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "11111111-1111-4111-8111-111111111111",
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", false, null, null,
                "previous-owner", Long.MAX_VALUE, 5, 5, 0, null, null,
                null, 1, 1, null, 1);
        // The durable record advanced past the claim: the submission and its
        // recorded admission landed between the claim and the failure.
        TurnRecord current = new TurnRecord("tenant", "session", "turn",
                "11111111-1111-4111-8111-111111111111",
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-1", 5L,
                "previous-owner", Long.MAX_VALUE, 5, 5, 0, null, null,
                null, 1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(current));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, new ContextBinding("tenant", "ws-a", 1,
                                "storage-a", ".", "config-a", 1), "yolo",
                        "hosted-workspace-files/1"));
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(unavailable);
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-1"))).thenReturn(true);

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(),
                mock(RuntimeWarmer.class),
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }

        verifyParked(store, "hosted_harness_unavailable");
        verify(harness).recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("11111111-1111-4111-8111-111111111111"));
        verify(harness).cancelOriginalTurn("tenant", "session", "11111111-1111-4111-8111-111111111111");
        verify(harness, never()).cancel(anyString(), anyString());
    }

    // 9 is the last retry inside the budget; 6 is already past the
    // pre-admission budget (5) but comfortably inside the post-admission one.
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {6, 9})
    void admittedTurnStillRetriesWhileThePostAdmissionBudgetLasts(
            int retryCount) {
        AgentStateStore store = dispatchTransientFailure(retryCount).store();

        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // The coordinator must read the configured budget, not a hardcoded 10.
    @ParameterizedTest(name = "budget = {0}, retryCount = {1}, fails = {2}")
    @CsvSource({"7, 7, true", "7, 6, false"})
    void honoursTheConfiguredPostAdmissionBudget(int budget, int retryCount,
            boolean expectFailure) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxPostAdmissionRetries(budget);
        AgentStateStore store = dispatchTransientFailure(retryCount,
                properties).store();

        if (expectFailure) {
            verifyParked(store, "hosted_harness_unavailable_after_admission");
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong(), eq(false));
        }
    }

    // The RuntimeBrokerException arm funnels into the same post-admission
    // budget: once the Turn may have been admitted, even a non-retryable
    // broker failure is retried while the budget lasts and parks for native
    // evidence once it is spent, preserving the broker's own failure code.
    @ParameterizedTest(name = "retryCount = {0}, fails = {1}")
    @CsvSource({"10, true", "9, false"})
    void brokerFailuresHonourThePostAdmissionBudget(int retryCount,
            boolean expectFailure) {
        AgentStateStore store = dispatchTransientFailure(retryCount,
                new ManagedAgentProperties(),
                WorkspaceExecutionStore.unavailable()).store();

        if (expectFailure) {
            verifyParked(store, "workspace_unavailable");
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong(), eq(false));
        }
    }

    // A named load refusal keeps its own code through this budget too. The
    // refusal is fail-closed and already named, so the generic
    // after-admission code would blame Harness availability for a Session
    // the Harness deliberately refused to open — issue #13320's
    // mixed-version takeover, re-driven after an earlier attempt submitted.
    @ParameterizedTest(name = "retryCount = {0}, fails = {1}")
    @CsvSource({"10, true", "9, false"})
    void namedLoadRefusalsHonourThePostAdmissionBudget(int retryCount,
            boolean expectFailure) {
        HarnessSessionRefusedException refusal = mock(
                HarnessSessionRefusedException.class);
        when(refusal.getCode()).thenReturn("managed_session_open_failed");
        AgentStateStore store = dispatchTransientFailure(retryCount,
                new ManagedAgentProperties(), refusal).store();

        if (expectFailure) {
            verifyParked(store, "managed_session_open_failed");
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong(), eq(false));
        }
    }

    // A lease-bounded 409 on the takeover attach is the wait the exemption
    // exists to protect: the predecessor still holds its journal writer
    // lease, so the conflict is bounded by that lease and must retry past
    // the post-admission budget instead of terminally failing (and
    // cancelling) a Turn whose execution may still be live (review R2-6).
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {10, 42})
    void aLeaseBoundedWriterConflictStillRetriesPastThePostAdmissionBudget(
            int retryCount) {
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(conflict.getErrorCode())
                .thenReturn("managed_session_writer_conflict");
        AgentStateStore store = dispatchTransientFailure(retryCount,
                new ManagedAgentProperties(), conflict).store();

        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(true));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    // A generation change on a bound Session is the other exempt caller: one
    // change is bounded by the prior generation's lease, so an admitted Turn
    // whose earlier failures were all generation waits still retries past
    // the post-admission budget instead of being cancelled and failed
    // (review round 3, R3-3). 39 is the last run below the churn cap
    // (4 × the post-admission budget of 10).
    @ParameterizedTest(name = "consecutive exempt failures = {0}")
    @ValueSource(ints = {10, 39})
    void aGenerationChangeStillRetriesPastThePostAdmissionBudget(
            int failures) {
        Dispatched dispatched = dispatchTransientFailure(failures, failures,
                new ManagedAgentProperties(),
                mock(HostedHarnessGenerationException.class), "epoch-1");

        verify(dispatched.store()).scheduleTurnRetry(eq("tenant"),
                eq("session"), eq("turn"), anyString(), anyLong(), eq(true));
        verify(dispatched.store(), never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(dispatched.harness(), never()).cancel(anyString(), anyString());
    }

    // A Harness that restarts between every attempt keeps throwing the
    // generation change, and the exemption alone would retry the Turn
    // forever with nothing to tell it from a healthy retry. Once its run
    // without journaled progress reaches the churn cap the exemption lapses:
    // the admitted Turn enters cancellation-only recovery with the
    // post-admission unavailable diagnostic (review round 3, R3-6).
    @ParameterizedTest(name = "consecutive exempt failures = {0}")
    @ValueSource(ints = {40, 57})
    void aGenerationChurnPastTheCapParksTheAdmittedTurn(int failures) {
        Dispatched dispatched = dispatchTransientFailure(failures, failures,
                new ManagedAgentProperties(),
                mock(HostedHarnessGenerationException.class), "epoch-1");
        AgentStateStore store = dispatched.store();

        verifyParked(store, "hosted_harness_unavailable_after_admission");
        verify(dispatched.harness()).recoverManagedFailureCancellation(eq("tenant"),
                eq("session"), eq("turn"), anyString(), eq("11111111-1111-4111-8111-111111111111"));
    }

    // Zero budgets are a supported "no retries" policy, but the exempt
    // waits keep their exemption under it, and a generation change is one
    // of them: the cap floors the budget to one, so an admitted Turn still
    // re-attaches across one change and parks after four without progress
    // (review round 1, R1-1).
    @ParameterizedTest(name = "consecutive exempt failures = {0}")
    @CsvSource({"0, false", "3, false", "4, true"})
    void aZeroBudgetStillAdoptsAGenerationChange(int failures,
            boolean terminal) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxPreAdmissionRetries(0);
        properties.getDispatch().setMaxPostAdmissionRetries(0);
        properties.getDispatch().setMaxOperationRetries(0);
        Dispatched dispatched = dispatchTransientFailure(failures, failures,
                properties, mock(HostedHarnessGenerationException.class),
                "epoch-1");
        AgentStateStore store = dispatched.store();

        if (terminal) {
            verifyParked(store, "hosted_harness_unavailable_after_admission");
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong(), eq(true));
            verify(store, never()).failTurn(anyString(), anyString(),
                    anyString(), anyString(), anyString(), anyString());
            verify(dispatched.harness(), never()).cancel(anyString(),
                    anyString());
        }
    }

    // The budget counts consecutive failures without journaled progress: a
    // Turn at the budget whose delivery admitted and journaled new events
    // since the last failure reschedules instead of terminating — the fenced
    // cursor updates reset the counter, so the terminal decision must read
    // the fresh record, not the claim-time one (review round 6, R6-1).
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {10, 42})
    void admittedTurnAtTheBudgetStillRetriesAfterJournaledProgress(
            int retryCount) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(store.markTurnFailureRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
        when(store.parkTurnForRuntimeRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyLong())).thenReturn(true);
        when(harness.recoverManagedFailureCancellation(anyString(), anyString(),
                anyString(), anyString(), eq("11111111-1111-4111-8111-111111111111"))).thenReturn(new Attachment("boot-1"));
        String promptId = "11111111-1111-4111-8111-111111111111";
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                promptId,
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-1", 5L,
                "previous-owner", Long.MAX_VALUE, retryCount, retryCount, 0,
                null, null, null, 1, 1, null, 1);
        TurnRecord progressed = new TurnRecord("tenant", "session", "turn",
                promptId,
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", true, "epoch-1", 6L,
                "previous-owner", Long.MAX_VALUE, retryCount, 0, 0, null, null,
                null, 1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, new ContextBinding("tenant", "ws-a", 1,
                                "storage-a", ".", "config-a", 1), "yolo",
                        "hosted-workspace-files/1"));
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenReturn(new Attachment("boot-1"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-1"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed), Optional.of(progressed));
        // One journaled event, then the stream drops before a terminal one.
        when(harness.stream("tenant", "session", 5L, "epoch-1"))
                .thenReturn(new SourceStream() {
                    private boolean emitted;

                    @Override
                    public String eventEpoch() {
                        return "epoch-1";
                    }

                    @Override
                    public SourceEvent next() {
                        if (emitted) {
                            return null;
                        }
                        emitted = true;
                        return new SourceEvent(6L, "debug", Map.of(),
                                promptId, Map.of());
                    }

                    @Override
                    public void close() {
                    }
                });

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(),
                mock(RuntimeWarmer.class),
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }

        verify(store).recordHarnessEvents(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("epoch-1"), any());
        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong(), eq(false));
        verify(store, never()).failTurn(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).cancel(anyString(), anyString());
    }

    // A malformed submit reply leaves admission unknown. The persisted mark
    // cannot safely be withdrawn, and session-scoped cancellation must wait
    // for evidence identifying the original input.
    @Test
    void aProtocolErrorWithoutARecordedAdmissionSkipsTheCancel() {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(store.markTurnFailureRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
        when(store.parkTurnForRuntimeRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyLong())).thenReturn(true);
        when(harness.recoverManagedFailureCancellation(anyString(), anyString(),
                anyString(), anyString(), eq("11111111-1111-4111-8111-111111111111"))).thenReturn(new Attachment("boot-1"));
        String promptId = "11111111-1111-4111-8111-111111111111";
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                promptId,
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", false, null, null,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null,
                null, 1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null,
                        1, new ContextBinding("tenant", "ws-a", 1,
                                "storage-a", ".", "config-a", 1), "yolo",
                        "hosted-workspace-files/1"));
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.createOrLoad("tenant", "session", false))
                .thenReturn(new Attachment("boot-1"));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-1"))).thenReturn(true);
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        DaemonProtocolException protocolError = mock(
                DaemonProtocolException.class);
        TurnRecord attempted = new TurnRecord("tenant", "session", "turn", promptId,
                claimed.input(), claimed.payloadDigest(), "RUNNING", true, null, null,
                "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null, 1, 1, null, 1);
        when(harness.submit(eq("tenant"), eq("session"), eq(promptId),
                any(), anyString())).thenAnswer(invocation -> {
                    when(store.findTurn("tenant", "session", "turn"))
                            .thenReturn(Optional.of(attempted));
                    throw protocolError;
                });

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(),
                mock(RuntimeWarmer.class),
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }

        verify(store).markSubmissionAttempted(eq("tenant"), eq("session"),
                eq("turn"), anyString());
        verify(harness, never()).cancel(anyString(), anyString());
        verifyParked(store, "hosted_harness_protocol_error");
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
        verify(harness, never()).cancelOriginalTurn(anyString(), anyString(), anyString());
    }

    private static void verifyParked(AgentStateStore store, String code) {
        verify(store).markTurnFailureRecovery(eq("tenant"), eq("session"), eq("turn"),
                anyString(), argThat(message -> message.startsWith(code + ":")));
        verify(store).parkTurnForRuntimeRecovery(eq("tenant"), eq("session"), eq("turn"),
                anyString(), anyString(), anyLong());
        verify(store, never()).failTurn(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyBoolean());
    }

    private static Dispatched dispatchTransientFailure(int retryCount) {
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        return dispatchTransientFailure(retryCount,
                new ManagedAgentProperties(), unavailable);
    }

    private static Dispatched dispatchTransientFailure(int retryCount,
            ManagedAgentProperties properties) {
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        return dispatchTransientFailure(retryCount, properties, unavailable);
    }

    private static Dispatched dispatchTransientFailure(int retryCount,
            ManagedAgentProperties properties, RuntimeException failure) {
        return dispatchTransientFailure(retryCount, properties, failure,
                null);
    }

    // admittedEpoch is the admission the Harness recorded for the Turn, or
    // null for a Turn that only ever attempted a submission.
    private static Dispatched dispatchTransientFailure(int retryCount,
            ManagedAgentProperties properties, RuntimeException failure,
            String admittedEpoch) {
        return dispatchTransientFailure(retryCount, 0, properties, failure,
                admittedEpoch);
    }

    // budgetExemptFailures is how many of the retryCount consecutive
    // failures were exempt waits.
    private static Dispatched dispatchTransientFailure(int retryCount,
            int budgetExemptFailures, ManagedAgentProperties properties,
            RuntimeException failure, String admittedEpoch) {
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(store.markTurnFailureRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString())).thenReturn(true);
        when(store.parkTurnForRuntimeRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyLong())).thenReturn(true);
        when(harness.recoverManagedFailureCancellation(anyString(), anyString(),
                anyString(), anyString(), eq("11111111-1111-4111-8111-111111111111"))).thenReturn(new Attachment("boot-1"));
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "11111111-1111-4111-8111-111111111111",
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", true, admittedEpoch,
                null, "previous-owner", Long.MAX_VALUE, retryCount,
                retryCount, budgetExemptFailures, null, null, null, 1, 1,
                null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        // The re-read behind the retry budget and the cancel gate both see
        // the claimed record.
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed));
        // The Session is bound to a Harness from the admission that
        // submitted the Turn, so coordination re-attaches through it and
        // the post-admission terminal can cancel through it.
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, new ContextBinding("tenant", "ws-a", 1,
                                "storage-a", ".", "config-a", 1), "yolo",
                        "hosted-workspace-files/1"));
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.recoverManagedRuntime("tenant", "session", false))
                .thenThrow(failure);
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("boot-1"))).thenReturn(true);

        HarnessCoordinator coordinator = new HarnessCoordinator(store,
                harness, new HarnessEventProjector(),
                mock(RuntimeWarmer.class),
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), properties);
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
        verify(harness, never()).cancel(anyString(), anyString());
        verify(harness, never()).recoverManagedFailureCancellation(anyString(), anyString(), anyString(), anyString());
        return new Dispatched(store, harness);
    }

    private record Dispatched(AgentStateStore store,
            HarnessConnector harness) {
    }
}
