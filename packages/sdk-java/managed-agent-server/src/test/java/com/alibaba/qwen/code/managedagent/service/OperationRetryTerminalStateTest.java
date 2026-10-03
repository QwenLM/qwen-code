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
import static org.mockito.Mockito.times;
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
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
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
 * instead of rescheduling any RuntimeException forever. A lifecycle
 * operation whose settle can never succeed terminates as FAILED with the
 * failure code kept (the Session keeps its pending status; nothing
 * certifies a completion) — except while a live Harness still holds the
 * journal writer, where the close can still succeed; an action response
 * whose resolution endpoint stays down completes with a failure code.
 */
class OperationRetryTerminalStateTest {
    private static final ContextBinding BOUND_WORKSPACE =
            new ContextBinding("tenant", "workspace", 1, "storage", ".",
                    "config-ref", 1);

    // A live journal writer is the one settle blocker the budget must not
    // terminate: the close can still succeed once the writer stops, so the
    // operation keeps waiting rather than recording a failure.
    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {10, 40})
    void lifecycleOperationKeepsWaitingPastTheBudgetWhileAWriterIsLive(
            int attemptCount) {
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
        // Another live Harness keeps the Session's journal writer, so the
        // close cannot settle yet: settle() throws on every attempt.
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        mock(RuntimeWarmer.class),
                        CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // 10 is exactly the spent budget; 40 is far past it. With no live
    // writer the settle can never succeed, so the operation terminates as
    // FAILED with the cause recorded — the Session is not flipped and no
    // completion event is appended.
    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {10, 40})
    void lifecycleOperationTerminatesWithAFailureCodeAfterTheBudgetIsSpent(
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
        // The writer is already gone and the Harness call itself keeps
        // failing — a settle the operation can never complete.
        when(harness.closeSession("tenant", "session"))
                .thenThrow(new IllegalStateException("harness unreachable"));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        when(runtimeWarmer.drain("session"))
                .thenReturn(CompletableFuture.completedFuture(null));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            // The terminal state still drains the Session's Runtime binding.
            verify(runtimeWarmer).drain("session");
            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("session_lifecycle_delivery_failed"));
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // A blocked close keeps its failure code through the terminal record
    // rather than being erased by a completion write.
    @Test
    void blockedLifecycleOperationTerminatesWithItsCodePreserved() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = lifecycleOperation(10);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        // A bound Session whose warmer cannot verify the original worker's
        // stop: settle() throws workspace_close_identity_unverified, which
        // every attempt classifies as blocked.
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("workspace_close_identity_unverified"));
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
            verify(store, never()).blockLifecycleOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyString(), anyLong());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
            // A bound Session is never drained through the unbound path.
            verify(runtimeWarmer, never()).drain(anyString());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The terminal arm mirrors settle()'s bound routing: a bound Session's
    // Runtime binding is released through the workspace close pair, never
    // through the unbound drain.
    @Test
    void boundSessionExhaustionRoutesThroughTheWorkspaceClose() {
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
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenReturn("boot-1");
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        // The original binding is still in use, so the workspace close
        // keeps refusing — the settle failure the budget cannot fix.
        when(runtimeWarmer.closeWorkspace("tenant", "session"))
                .thenReturn(CompletableFuture.failedFuture(
                        new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(
                                409, "runtime_close_claim_pending",
                                "Original binding is still in use", false)));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(runtimeWarmer, times(2)).requestWorkspaceClose("tenant",
                    "session");
            verify(runtimeWarmer, times(2)).closeWorkspace("tenant",
                    "session");
            verify(runtimeWarmer, never()).drain(anyString());
            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("runtime_close_claim_pending"));
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The terminal state is still recorded when the best-effort drain
    // itself fails: the join's CompletionException must not escape past the
    // exhaustion arm, or the operation would never converge.
    @Test
    void lifecycleOperationTerminatesWhenTheTerminalDrainFails() {
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
        when(harness.closeSession("tenant", "session"))
                .thenThrow(new IllegalStateException("harness unreachable"));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        when(runtimeWarmer.drain("session")).thenReturn(CompletableFuture
                .failedFuture(new RuntimeException("warmer down")));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("session_lifecycle_delivery_failed"));
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The terminal record is itself a store write that can fail: the
    // operation must fall back to the retry path rather than escaping the
    // delivery loop past the finally into the executor's uncaught handler.
    @Test
    void lifecycleOperationReschedulesWhenTheTerminalRecordFails() {
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
        when(harness.closeSession("tenant", "session"))
                .thenThrow(new IllegalStateException("harness unreachable"));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        when(runtimeWarmer.drain("session"))
                .thenReturn(CompletableFuture.completedFuture(null));
        doThrow(new IllegalStateException("database unavailable"))
                .when(store).failOperation(eq("tenant"), eq("session"),
                        eq("op-close"), anyString(), eq(1L), anyString());

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // A delete of an already closed bound Session whose retention
    // retirement keeps refusing (a residual live writer) must also keep
    // waiting past the budget — both because the writer gate keys on the
    // writer itself rather than the admitted status, and because settle()
    // returned for this shape, so the completion write is simply retried.
    @Test
    void deleteOfAClosedSessionKeepsWaitingWhileAWriterIsLive() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-delete", OperationKind.DELETE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "CLOSED", null, "owner", 1, 10);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-delete"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "CLOSED", null, null, 0, 0, 0, 1, 1, null, 1,
                        BOUND_WORKSPACE));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);
        // completeOperation's retention retirement refuses while the
        // residual writer holds the journal.
        when(store.completeOperation(eq("tenant"), eq("session"),
                eq("op-delete"), anyString(), eq(1L), anyBoolean()))
                .thenThrow(new IllegalStateException(
                        "Session deletion is waiting for its writer to"
                                + " stop."));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-delete");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-delete"), anyString(), eq(1L), anyLong());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
            // The closed-Session delete shape makes zero Runtime calls, in
            // settle() and in the terminal arm alike.
            verify(runtimeWarmer, never()).drain(anyString());
            verify(runtimeWarmer, never()).requestWorkspaceClose(anyString(),
                    anyString());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // A delete of an already closed bound Session settles with zero Runtime
    // calls (the completed CLOSE is the cleanup authority), so settle always
    // returns for this shape — and a completion-write failure therefore
    // retries instead of terminating: the terminal record would claim a
    // settle failure for a shape whose settle is a no-op success. No Runtime
    // call happens on either path.
    @Test
    void closedSessionDeleteRetriesACompletionWriteFailureWithoutTouchingTheRuntime() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-delete", OperationKind.DELETE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "CLOSED", null, "owner", 1, 10);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-delete"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "CLOSED", null, null, 0, 0, 0, 1, 1, null, 1,
                        BOUND_WORKSPACE));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        // This replica could close the workspace — and still must not, for
        // this shape.
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        // A non-writer completion-write failure: the retirement lost its
        // race with another operation.
        when(store.completeOperation(eq("tenant"), eq("session"),
                eq("op-delete"), anyString(), eq(1L), anyBoolean()))
                .thenThrow(new IllegalStateException(
                        "Session was retired by another operation"));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-delete");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-delete"), anyString(), eq(1L), anyLong());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
            verify(runtimeWarmer, never()).drain(anyString());
            verify(runtimeWarmer, never()).requestWorkspaceClose(anyString(),
                    anyString());
            verify(runtimeWarmer, never()).closeWorkspace(anyString(),
                    anyString());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // A writer check that itself fails is treated as live: the operation
    // keeps waiting rather than recording a failure it cannot verify.
    @Test
    void lifecycleOperationKeepsWaitingWhenTheWriterCheckFails() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = lifecycleOperation(10);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-1", null, 0, 0, 1, 1, null, 1));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session"))
                .thenThrow(new IllegalStateException("harness unreachable"));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenThrow(new IllegalStateException("lock wait timeout"));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        mock(RuntimeWarmer.class),
                        CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The terminal arm records a settle that never happened — so it must
    // not fire when settle() DID complete and only the completion write
    // failed: that attempt is retried (settle is idempotent), and the
    // recorded terminal never claims a delivery failure for a close that
    // actually settled.
    @Test
    void aFailedCompletionWriteAfterASuccessfulSettleRetries() {
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
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenReturn("boot-1");
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        when(runtimeWarmer.closeWorkspace("tenant", "session"))
                .thenReturn(CompletableFuture.completedFuture(null));
        // settle() completed; only the durable completion write fails.
        when(store.completeOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), eq(1L), anyBoolean()))
                .thenThrow(new IllegalStateException(
                        "Session session is CLOSED during its CLOSE"
                                + " operation"));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The terminal-record fallback keeps the blocked shape for a CLOSE. The
    // recovery scan re-drives BLOCKED rows for CLOSE and for a DELETE
    // admitted on a closed Session, but a blocked code can only come from
    // settle()'s workspace-close path, which the closed-Session delete never
    // enters — so CLOSE is the only shape that needs the blocked fallback.
    @Test
    void blockedCloseFallsBackToBlockedWhenTheTerminalRecordFails() {
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
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        doThrow(new IllegalStateException("database unavailable"))
                .when(store).failOperation(eq("tenant"), eq("session"),
                        eq("op-close"), anyString(), eq(1L), anyString());

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("workspace_close_identity_unverified"), anyLong());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
        } finally {
            coordinator.stopRenewals();
        }
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
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong());
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
        } finally {
            coordinator.stopRenewals();
        }
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

    // A 200 from the Harness means the decision is committed and only
    // Java's projection lags: the budget must never record that shape as a
    // delivery failure — it keeps retrying until the projection heals or
    // the Action's own end state settles it.
    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {10, 40})
    void anAnsweredButUnprojectedDecisionNeverTerminatesAsDeliveryFailed(
            int attemptCount) throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(attemptCount);
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
        // harness.resolveAction returns normally: the Harness answered 200.

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(harness).resolveAction("tenant", "session", "action-1", body);
        verify(sessions).retryOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), eq(3L), anyLong());
        verify(actions, never()).complete(any(), anyString(),
                eq("action_response_delivery_failed"), any(), anyBoolean(),
                anyLong());
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
    @ParameterizedTest(name = "attemptCount = {0}, terminates = {1}")
    @CsvSource({"3, true", "2, false"})
    void lifecycleOperationHonoursTheConfiguredBudget(int attemptCount,
            boolean expectTermination) {
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
        when(harness.closeSession("tenant", "session"))
                .thenThrow(new IllegalStateException("harness unreachable"));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);
        when(runtimeWarmer.drain("session"))
                .thenReturn(CompletableFuture.completedFuture(null));
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setMaxOperationRetries(3);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), properties);
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            if (expectTermination) {
                verify(store).failOperation(eq("tenant"), eq("session"),
                        eq("op-close"), anyString(), eq(1L), anyString());
            } else {
                verify(store).retryOperation(eq("tenant"), eq("session"),
                        eq("op-close"), anyString(), eq(1L), anyLong());
                verify(store, never()).failOperation(anyString(), anyString(),
                        anyString(), anyString(), anyLong(), anyString());
            }
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
        } finally {
            coordinator.stopRenewals();
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
