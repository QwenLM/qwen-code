package com.alibaba.qwen.code.managedagent.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessSessionRefusedException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.InOrder;

/**
 * Regression for issue #13182 finding 2: once submissionAttempted is
 * recorded, a Turn stuck on transient Harness failures must converge to a
 * terminal failure after the bounded post-admission retry budget
 * (maxPostAdmissionRetries, default 10) instead of rescheduling without any
 * bound.
 */
class AdmittedTurnRetryTerminalStateTest {
    // 10 is exactly the spent budget; 42 is far past it.
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {10, 42})
    void admittedTurnFailsAfterThePostAdmissionRetryBudgetIsSpent(
            int retryCount) {
        Dispatched dispatched = dispatchTransientFailure(retryCount);
        AgentStateStore store = dispatched.store();

        // A distinct code from pre-admission exhaustion: the Turn may have
        // been admitted, so blind retry is not safe. The terminal record is
        // preceded by a best-effort cancel of the admitted Turn through the
        // Session's bound Harness — after failTurn clears the dispatch
        // owner, nothing could ever reach the admitted Turn again (review
        // round 5, R5-3).
        InOrder order = inOrder(store, dispatched.harness());
        order.verify(dispatched.harness()).cancel("tenant", "session");
        order.verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_unavailable_after_admission"),
                anyString());
        verify(store, never()).scheduleTurnRetry(anyString(), anyString(),
                anyString(), anyString(), anyLong());
    }

    // 9 is the last retry inside the budget; 6 is already past the
    // pre-admission budget (5) but comfortably inside the post-admission one.
    @ParameterizedTest(name = "retryCount = {0}")
    @ValueSource(ints = {6, 9})
    void admittedTurnStillRetriesWhileThePostAdmissionBudgetLasts(
            int retryCount) {
        AgentStateStore store = dispatchTransientFailure(retryCount).store();

        verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyLong());
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
            verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                    anyString(),
                    eq("hosted_harness_unavailable_after_admission"),
                    anyString());
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong());
        }
    }

    // The RuntimeBrokerException arm funnels into the same post-admission
    // budget: once the Turn may have been admitted, even a non-retryable
    // broker failure is retried while the budget lasts and terminates the
    // Turn once the budget is spent — keeping the broker's own failure code
    // rather than blaming the Harness.
    @ParameterizedTest(name = "retryCount = {0}, fails = {1}")
    @CsvSource({"10, true", "9, false"})
    void brokerFailuresHonourThePostAdmissionBudget(int retryCount,
            boolean expectFailure) {
        AgentStateStore store = dispatchTransientFailure(retryCount,
                new ManagedAgentProperties(),
                WorkspaceExecutionStore.unavailable()).store();

        if (expectFailure) {
            verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), eq("workspace_unavailable"), anyString());
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong());
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
            verify(store).failTurn(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), eq("managed_session_open_failed"),
                    anyString());
        } else {
            verify(store).scheduleTurnRetry(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), anyLong());
        }
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
        AgentStateStore store = mock(AgentStateStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        TurnRecord claimed = new TurnRecord("tenant", "session", "turn",
                "11111111-1111-4111-8111-111111111111",
                List.of(Map.of("type", "text", "text", "recover")),
                "sha256:" + "a".repeat(64), "RUNNING", true, null, null,
                "previous-owner", Long.MAX_VALUE, retryCount, null, null,
                null, 1, 1, null, 1);
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"),
                anyString(), any(Duration.class)))
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
        return new Dispatched(store, harness);
    }

    private record Dispatched(AgentStateStore store,
            HarnessConnector harness) {
    }
}
