package com.alibaba.qwen.code.managedagent.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Regression for issue #13182 finding 3: SessionLifecycleCoordinator and
 * ActionResponseCoordinator must converge an operation to a terminal state
 * after the bounded operation retry budget (maxOperationRetries, default 10)
 * instead of rescheduling any RuntimeException forever. A close that can
 * never settle (another live Harness keeps the journal writer) completes
 * unconfirmed; an action response whose resolution endpoint stays down
 * completes with a failure code.
 */
class OperationRetryTerminalStateTest {
    // 10 is exactly the spent budget; 40 is far past it.
    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {10, 40})
    void lifecycleOperationCompletesUnconfirmedAfterTheBudgetIsSpent(
            int attemptCount) {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = lifecycleOperation(attemptCount);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-1", null, 0, 0, 1, 1, null, 1));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenReturn("boot-1");
        // Another live Harness keeps the Session's journal writer, so the
        // close can never settle: settle() throws on every attempt.
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);
        when(runtimeWarmer.drain("session"))
                .thenReturn(CompletableFuture.completedFuture(null));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-close");

        // The terminal state still drains the Session's Runtime binding.
        verify(runtimeWarmer).drain("session");
        verify(store).completeOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), eq(1L), eq(false));
        verify(store, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong());
    }

    // The terminal state completes even when the best-effort drain itself
    // fails: the join's CompletionException must not escape past the
    // exhaustion arm, or the operation would never converge.
    @Test
    void lifecycleOperationCompletesUnconfirmedWhenTheTerminalDrainFails() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = lifecycleOperation(10);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-1", null, 0, 0, 1, 1, null, 1));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenReturn("boot-1");
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);
        when(runtimeWarmer.drain("session")).thenReturn(CompletableFuture
                .failedFuture(new RuntimeException("warmer down")));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-close");

        verify(store).completeOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), eq(1L), eq(false));
        verify(store, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong());
    }

    // 9 is the last retry inside the budget.
    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {1, 9})
    void lifecycleOperationStillRetriesWhileTheBudgetLasts(int attemptCount) {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = lifecycleOperation(attemptCount);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-1", null, 0, 0, 1, 1, null, 1));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenReturn("boot-1");
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        mock(RuntimeWarmer.class),
                        CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-close");

        verify(store).retryOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), eq(1L), anyLong());
        verify(store, never()).completeOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyBoolean());
    }

    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {10, 40})
    void actionResponseCompletesWithAFailureCodeAfterTheBudgetIsSpent(
            int attemptCount) throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(attemptCount);
        mockUnresolvedAction(sessions, actions, harness, claimed);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        // The Harness never answered, so the terminal record must not claim
        // a harness_confirmed admission.
        verify(actions).complete(eq(claimed), anyString(),
                eq("action_response_delivery_failed"), any(), eq(false),
                anyLong());
        verify(sessions, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong());
    }

    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {1, 9})
    void actionResponseStillRetriesWhileTheBudgetLasts(int attemptCount)
            throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(attemptCount);
        mockUnresolvedAction(sessions, actions, harness, claimed);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(sessions).retryOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), eq(3L), anyLong());
        verify(actions, never()).complete(any(), anyString(), any(), any(),
                anyBoolean(), anyLong());
    }

    // Both coordinators must read the configured budget, not a hardcoded 10.
    @ParameterizedTest(name = "attemptCount = {0}, completes = {1}")
    @CsvSource({"3, true", "2, false"})
    void lifecycleOperationHonoursTheConfiguredBudget(int attemptCount,
            boolean expectCompletion) {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = lifecycleOperation(attemptCount);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-1", null, 0, 0, 1, 1, null, 1));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenReturn("boot-1");
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);
        when(runtimeWarmer.drain("session"))
                .thenReturn(CompletableFuture.completedFuture(null));
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxOperationRetries(3);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), properties);
        coordinator.dispatch("tenant", "session", "op-close");

        if (expectCompletion) {
            verify(store).completeOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), eq(false));
        } else {
            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong());
            verify(store, never()).completeOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyBoolean());
        }
    }

    @ParameterizedTest(name = "attemptCount = {0}, completes = {1}")
    @CsvSource({"3, true", "2, false"})
    void actionResponseHonoursTheConfiguredBudget(int attemptCount,
            boolean expectCompletion) throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(attemptCount);
        mockUnresolvedAction(sessions, actions, harness, claimed);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxOperationRetries(3);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), properties);
        coordinator.dispatch("tenant", "session", "op-action");

        if (expectCompletion) {
            verify(actions).complete(eq(claimed), anyString(),
                    eq("action_response_delivery_failed"), any(), eq(false),
                    anyLong());
        } else {
            verify(sessions).retryOperation(eq("tenant"), eq("session"),
                    eq("op-action"), anyString(), eq(3L), anyLong());
            verify(actions, never()).complete(any(), anyString(), any(),
                    any(), anyBoolean(), anyLong());
        }
    }

    // The answered paths claim a harness confirmation: a 400 the Harness
    // returned, and a decision the projection shows it committed.
    @Test
    void aHarnessRefusalCompletesHarnessConfirmed() throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(0);
        JsonNode body = actionBody();
        when(sessions.claimOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(actions.response("tenant", "session", "op-action")).thenReturn(
                new ManagedActionStore.Response("action-1", body, null,
                        null));
        when(actions.find("tenant", "session", "action-1")).thenReturn(
                Optional.of(new ManagedActionStore.Action("action-1",
                        "requested", body, null, null)));
        DaemonHttpException rejected = mock(DaemonHttpException.class);
        when(rejected.getStatusCode()).thenReturn(400);
        doThrow(rejected).when(harness).resolveAction("tenant", "session",
                "action-1", body);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(actions).complete(eq(claimed), anyString(),
                eq("invalid_action_response"), any(), eq(true), anyLong());
    }

    @Test
    void aProjectedDecisionCompletesHarnessConfirmed() throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(0);
        JsonNode body = actionBody();
        when(sessions.claimOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(actions.response("tenant", "session", "op-action")).thenReturn(
                new ManagedActionStore.Response("action-1", body, null,
                        null));
        when(actions.find("tenant", "session", "action-1")).thenReturn(
                Optional.of(new ManagedActionStore.Action("action-1",
                        "decided", body, "rcpt-9",
                        ManagedActionStore.decisionDigest(body))));

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(actions).complete(eq(claimed), anyString(), any(),
                eq("rcpt-9"), eq(true), anyLong());
        verify(harness, never()).resolveAction(anyString(), anyString(),
                anyString(), any());
    }

    // The projection re-check precedes the budget check: a lost answer after
    // a committed decision must still complete with the decision, even when
    // the retry budget is spent.
    @Test
    void aCommittedDecisionWinsOverTheExhaustedBudget() throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(40);
        JsonNode body = actionBody();
        when(sessions.claimOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(actions.response("tenant", "session", "op-action")).thenReturn(
                new ManagedActionStore.Response("action-1", body, null,
                        null));
        // The delivery attempt throws after the Harness committed the
        // decision — the answer was only lost. The projection is still
        // "requested" before the attempt and "decided" at the catch-arm
        // re-read, so the delivery really happens.
        doThrow(new IllegalStateException("connection refused"))
                .when(harness).resolveAction("tenant", "session", "action-1",
                        body);
        when(actions.find("tenant", "session", "action-1")).thenReturn(
                Optional.of(new ManagedActionStore.Action("action-1",
                        "requested", body, null, null)),
                Optional.of(new ManagedActionStore.Action("action-1",
                        "decided", body, "rcpt-9",
                        ManagedActionStore.decisionDigest(body))));

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(harness).resolveAction("tenant", "session", "action-1", body);
        verify(actions).complete(eq(claimed), anyString(), isNull(),
                eq("rcpt-9"), eq(true), anyLong());
        verify(actions, never()).complete(any(), anyString(),
                eq("action_response_delivery_failed"), any(), anyBoolean(),
                anyLong());
    }

    private static JsonNode actionBody() throws Exception {
        return new ObjectMapper().readTree("{\"optionId\":\"allow\","
                + "\"inputRevision\":1,\"policyRevision\":{}}");
    }

    private static OperationRecord lifecycleOperation(int attemptCount) {
        return new OperationRecord("tenant", "session", "op-close",
                OperationKind.CLOSE, "digest", "RUNNING", "JAVA_DURABLE",
                "LEASED", "ACTIVE", null, "owner", 1, attemptCount);
    }

    private static OperationRecord actionOperation(int attemptCount) {
        return new OperationRecord("tenant", "session", "op-action",
                OperationKind.ACTION_RESPONSE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner", 3,
                attemptCount);
    }

    private static void mockUnresolvedAction(AgentStateStore sessions,
            ManagedActionStore actions, HarnessConnector harness,
            OperationRecord claimed) throws Exception {
        JsonNode body = new ObjectMapper().readTree("{\"optionId\":\"allow\","
                + "\"inputRevision\":1,\"policyRevision\":{}}");
        when(sessions.claimOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(actions.response("tenant", "session", "op-action")).thenReturn(
                new ManagedActionStore.Response("action-1", body, null,
                        null));
        when(actions.find("tenant", "session", "action-1")).thenReturn(
                Optional.of(new ManagedActionStore.Action("action-1",
                        "requested", body, null, null)));
        // The Hosted Harness resolution endpoint stays down.
        doThrow(new IllegalStateException("connection refused"))
                .when(harness).resolveAction("tenant", "session", "action-1",
                        body);
    }
}
