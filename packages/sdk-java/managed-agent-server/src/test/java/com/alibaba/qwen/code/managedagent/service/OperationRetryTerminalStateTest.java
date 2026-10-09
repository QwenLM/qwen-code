package com.alibaba.qwen.code.managedagent.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
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
import org.springframework.http.HttpStatus;

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
    private static final String TOOL_PROFILE = "hosted-workspace-files/1";

    // A live journal writer is the one settle blocker the budget must not
    // terminate: the close can still succeed once the writer stops, so the
    // operation keeps waiting rather than recording a failure. Past the
    // budget the wait is also published — the row reads recovery_blocked
    // with its code instead of a healthy pending retry — and the attempt is
    // recorded budget-exempt so the wait never consumes the budget the close
    // itself still has.
    @ParameterizedTest(name = "attemptCount = {0}, lifecycleProtocol = {1}")
    @CsvSource({"10, 0", "40, 0", "10, 1", "40, 1"})
    void lifecycleOperationKeepsWaitingPastTheBudgetWhileAWriterIsLive(
            int attemptCount, int lifecycleProtocol) {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-close", OperationKind.CLOSE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner", 1,
                attemptCount, null, null, null, null, 0, lifecycleProtocol);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, lifecycleProtocol == 1 ? BOUND_WORKSPACE : null,
                        "yolo", TOOL_PROFILE));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenReturn("boot-1");
        // Another live Harness keeps the Session's journal writer, so the
        // close cannot settle yet: settle() throws on every attempt.
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer,
                        CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        if (lifecycleProtocol == 1) {
            when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
            when(harness.supportsLifecycle()).thenReturn(true);
            coordinator.setWorkspaceLifecycleStore(mock(
                    com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.class));
        }
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq(lifecycleProtocol == 1 ? "workspace_lifecycle_writer_active"
                            : "session_close_writer_live"), anyLong(), eq(true));
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The writer wait must not consume the budget the close itself still
    // has: an operation that waited out a live writer past the budget is
    // rescheduled after the writer stops, not terminated on its first
    // unblocked failure (review round 6, R6-3).
    @Test
    void aCloseThatWaitedOutALiveWriterKeepsItsFullBudget() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = lifecycleOperation(11, 11);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-1", null, 0, 0, 1, 1, null, 1));
        when(harness.isAvailable()).thenReturn(true);
        // The writer is gone, but the Harness call itself still fails.
        when(harness.closeSession("tenant", "session"))
                .thenThrow(new IllegalStateException("harness unreachable"));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);

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

    // Java's view of the Harness is pinned to the boot its client was
    // constructed with, so a restarted Harness fails every call with a
    // generation error until Java restarts too. That failure is this
    // replica's stale view, not the close's own failure: the operation keeps
    // waiting past the budget instead of recording an unrecoverable
    // terminal (review round 6, R6-3) — but the wait is published, because
    // an unbounded wait that reads as a healthy pending retry is invisible
    // to the operator who has to restart this replica.
    @Test
    void aStaleHarnessViewPublishesItsWaitPastTheBudget() {
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
        when(harness.closeSession("tenant", "session")).thenThrow(
                mock(HostedHarnessGenerationException.class));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        mock(RuntimeWarmer.class),
                        CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            // Past the budget the stale-view wait is published like the
            // writer wait: recovery_blocked with its own code, still
            // budget-exempt so the wait itself stays unbounded.
            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("hosted_harness_generation_mismatch"), anyLong(),
                    eq(true));
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong(),
                    anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The overlap names the wait that actually bounds the close: a
    // generation error beside a live writer is the old boot's unexpired
    // lease, which the close does not wait on once this replica adopts the
    // new generation — so the published code is the generation mismatch,
    // not the writer wait (review R1-30).
    @Test
    void aStaleHarnessViewBesideALiveWriterPublishesTheGenerationMismatch() {
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
        when(harness.closeSession("tenant", "session")).thenThrow(
                mock(HostedHarnessGenerationException.class));
        // The old boot's writer lease has not expired yet.
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        mock(RuntimeWarmer.class),
                        CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("hosted_harness_generation_mismatch"), anyLong(),
                    eq(true));
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong(),
                    anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // Below the budget the same stale view is still a plain budget-exempt
    // reschedule: publication is what spending the budget buys, not the
    // first response to a generation error.
    @Test
    void aStaleHarnessViewReschedulesExemptlyBelowTheBudget() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = lifecycleOperation(9);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        "ACTIVE", "boot-1", null, 0, 0, 1, 1, null, 1));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session")).thenThrow(
                mock(HostedHarnessGenerationException.class));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(false);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        mock(RuntimeWarmer.class),
                        CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong(),
                    eq(true));
            verify(store, never()).blockLifecycleOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyString(), anyLong(), anyBoolean());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // A delete admitted on an ACTIVE Session waits on the live writer like
    // a close, and past the budget the wait is published the same way: the
    // row reads recovery_blocked with session_close_writer_live instead of
    // staying byte-identical to a healthy pending retry, and the recovery
    // scan re-drives it (review round 6, R6-2).
    @Test
    void anActiveSessionDeletePublishesTheWriterWaitPastTheBudget() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-delete", OperationKind.DELETE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner", 1, 10);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-delete"), anyString(), any(Duration.class)))
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
            coordinator.dispatch("tenant", "session", "op-delete");

            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-delete"), anyString(), eq(1L),
                    eq("session_close_writer_live"), anyLong(), eq(true));
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong(),
                    anyBoolean());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
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
    @ParameterizedTest
    @ValueSource(ints = {0, 1})
    void blockedLifecycleOperationTerminatesWithItsCodePreserved(
            int lifecycleProtocol) {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-close", OperationKind.CLOSE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner", 1,
                10, null, null, null, null, 0, lifecycleProtocol);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        // A bound Session whose warmer cannot verify the original worker's
        // stop: settle() throws workspace_close_identity_unverified, which
        // every attempt classifies as blocked. The refusal fires before the
        // Harness is asked to stop, so the Harness keeps the writer lease —
        // and a permanent refusal must terminate even while that writer is
        // live (review R1-30).
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

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

    // A permanent settle refusal raised while the Harness still holds the
    // Session's writer lease is not a writer wait: the refusal fires before
    // the Harness is asked to stop, so the writer stays live on every
    // attempt and a journal-only gate would re-block the operation forever.
    // The budget terminates it with the refusal's code (review R1-30).
    @Test
    void aPermanentSettleRefusalTerminatesWhileAWriterIsLive() {
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
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        doThrow(new RuntimeBrokerException(409,
                "workspace_close_identity_unverified",
                "Original worker needs recovery", false))
                .when(runtimeWarmer).requestWorkspaceClose("tenant",
                        "session");
        // The Harness was never asked to stop, so it keeps the writer.
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("workspace_close_identity_unverified"));
            verify(store, never()).completeOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyBoolean());
            verify(store, never()).blockLifecycleOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyString(), anyLong());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
            // The refused close never reached the Harness.
            verify(harness, never()).closeSession(anyString(), anyString());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The daemon's own permanent negotiation refusals are not writer waits
    // either: both are thrown before the Harness was asked to stop, so the
    // writer lease stays live on every attempt and a writer-keyed gate would
    // wait forever. The budget terminates them with their own codes (review
    // R1-30).
    @Test
    void aCapabilityMismatchTerminatesWhileAWriterIsLive() {
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
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        when(runtimeWarmer.closeWorkspace("tenant", "session"))
                .thenReturn(CompletableFuture.completedFuture(null));
        when(harness.isAvailable()).thenReturn(true);
        HostedHarnessCapabilityMismatchException mismatch =
                mock(HostedHarnessCapabilityMismatchException.class);
        when(mismatch.getCode()).thenReturn("managed_capability_mismatch");
        when(harness.closeSession("tenant", "session")).thenThrow(mismatch);
        // The Harness was never asked to stop, so it keeps the writer.
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("managed_capability_mismatch"));
            verify(store, never()).blockLifecycleOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyString(), anyLong(), anyBoolean());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong(),
                    anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The protocol refusal takes the same arm with the sibling coordinator's
    // code for it.
    @Test
    void aProtocolErrorTerminatesWhileAWriterIsLive() {
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
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        when(runtimeWarmer.closeWorkspace("tenant", "session"))
                .thenReturn(CompletableFuture.completedFuture(null));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.closeSession("tenant", "session"))
                .thenThrow(mock(DaemonProtocolException.class));
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("hosted_harness_protocol_error"));
            verify(store, never()).blockLifecycleOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyString(), anyLong(), anyBoolean());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong(),
                    anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // Below the budget a permanent refusal still retries plainly: the
    // attempts consume the budget — they are never budget-exempt writer
    // waits.
    @Test
    void aCapabilityMismatchConsumesTheBudgetBelowTheLimit() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = lifecycleOperation(9);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        when(harness.isAvailable()).thenReturn(true);
        HostedHarnessCapabilityMismatchException mismatch =
                mock(HostedHarnessCapabilityMismatchException.class);
        when(mismatch.getCode()).thenReturn("managed_capability_mismatch");
        when(harness.closeSession("tenant", "session")).thenThrow(mismatch);
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong());
            verify(store, never()).blockLifecycleOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyString(), anyLong(), anyBoolean());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
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
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
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

    // The terminal arm mirrors settle()'s protocol routing: a bound
    // protocol-v1 operation never takes the v0 drain route, because
    // requestHarnessDrain would flip the fence row to DRAINING without the
    // lifecycle store's claim checks. Only the workspace close runs; the
    // claim mirror is released by failOperation's terminal write (review
    // round 5, R5-3).
    @Test
    void boundV1SessionExhaustionSkipsTheV0DrainRequest() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-close", OperationKind.CLOSE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner", 1,
                10, null, null, null, null, 0, 1);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        when(harness.isAvailable()).thenReturn(true);
        // The v1 settle refuses permanently before any effects are saved:
        // this Harness speaks no lifecycle protocol.
        when(harness.supportsLifecycle()).thenReturn(false);
        when(runtimeWarmer.closeWorkspace("tenant", "session"))
                .thenReturn(CompletableFuture.completedFuture(null));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.setWorkspaceLifecycleStore(mock(
                com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.class));
        try {
            coordinator.dispatch("tenant", "session", "op-close");

            verify(runtimeWarmer, never()).requestWorkspaceClose(
                    anyString(), anyString());
            verify(runtimeWarmer).closeWorkspace("tenant", "session");
            verify(runtimeWarmer, never()).drain(anyString());
            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("workspace_lifecycle_protocol_unavailable"));
            verify(store, never()).completeOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyBoolean());
        } finally {
            coordinator.stopRenewals();
        }
    }

    // The retention retirement a delete of a closed Session runs inside
    // completeOperation refuses with managed_session_writer_active while a
    // journal writer is live — the same writer wait settle() reports as
    // workspace_lifecycle_writer_active, under its own code. The wait stays
    // budget-exempt and is published past the budget instead of being
    // charged as an ordinary failure (review round 5, R5-2).
    @Test
    void aClosedSessionDeleteWaitsOnTheRetirementWriterCode() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-delete", OperationKind.DELETE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "CLOSED", null, "owner", 1,
                10, null, null, null, null, 0, 0);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-delete"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "DELETING", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
        // The writer the retirement waits on is still live.
        when(sessionStore.hasLiveWriter("tenant", "session"))
                .thenReturn(true);
        doThrow(new ApiException(HttpStatus.CONFLICT,
                        "managed_session_writer_active",
                        "Session deletion is waiting for its writer to stop."))
                .when(store).completeOperation(eq("tenant"), eq("session"),
                        eq("op-delete"), anyString(), eq(1L), eq(false));

        SessionLifecycleCoordinator coordinator =
                new SessionLifecycleCoordinator(store, sessionStore, harness,
                        runtimeWarmer, CoordinatorTestSupport.directExecutor(),
                        Clock.systemUTC(), new ManagedAgentProperties());
        try {
            coordinator.dispatch("tenant", "session", "op-delete");

            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-delete"), anyString(), eq(1L),
                    eq("session_close_writer_live"), anyLong(), eq(true));
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong());
            verify(store, never()).retryOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyLong(),
                    anyBoolean());
            verify(store, never()).failOperation(anyString(), anyString(),
                    anyString(), anyString(), anyLong(), anyString());
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
                        BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
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

            // Past the budget the writer wait is published, and the shape is
            // one the recovery scan re-drives from BLOCKED.
            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-delete"), anyString(), eq(1L),
                    eq("session_close_writer_live"), anyLong(), eq(true));
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
                        BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
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

            // Treated as live, so past the budget the wait is published like
            // any writer wait.
            verify(store).blockLifecycleOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("session_close_writer_live"), anyLong(), eq(true));
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
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
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
    // recovery scan re-drives every blocked lifecycle shape, and a blocked
    // code can only come from settle()'s workspace-close path, which the
    // closed-Session delete never enters — so CLOSE is the shape that
    // exercises the fallback.
    @ParameterizedTest
    @ValueSource(ints = {0, 1})
    void blockedCloseFallsBackToBlockedWhenTheTerminalRecordFails(
            int lifecycleProtocol) {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-close", OperationKind.CLOSE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner", 1,
                10, null, null, null, null, 0, lifecycleProtocol);
        when(store.claimOperation(eq("tenant"), eq("session"),
                eq("op-close"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", null,
                        null, "ACTIVE", "boot-1", null, 0, 0, 0, 1, 1, null,
                        1, BOUND_WORKSPACE, "yolo", TOOL_PROFILE));
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

            verify(store).failOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L),
                    eq("workspace_close_identity_unverified"));
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

            // Within the budget the wait stays a plain pending retry, but
            // the attempt is recorded budget-exempt so it never consumes the
            // budget the close itself still has.
            verify(store).retryOperation(eq("tenant"), eq("session"),
                    eq("op-close"), anyString(), eq(1L), anyLong(),
                    eq(true));
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
        // The answer is recorded budget-exempt: the wait is the
        // projection's, so it must not consume the retry budget.
        verify(sessions).retryOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), eq(3L), anyLong(), eq(true));
        verify(actions, never()).complete(any(), anyString(),
                eq("action_response_delivery_failed"), any(), anyBoolean(),
                anyLong());
    }

    // A failure after the Harness answered is a Java-side store fault, not
    // a delivery failure: resolveAction returned 200 and only the
    // post-answer projection read threw, so the budget must keep retrying
    // rather than record action_response_delivery_failed for an answer the
    // Harness received (review round 5, R5-2).
    @ParameterizedTest(name = "attemptCount = {0}")
    @ValueSource(ints = {10, 40})
    void aPostAnswerProjectionFailureNeverTerminatesAsDeliveryFailed(
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
        // The pre-answer projection read shows "requested"; the post-answer
        // read throws once (a store fault after the 200); the catch's
        // re-inspection still reads "requested".
        when(actions.find("tenant", "session", "action-1")).thenReturn(
                Optional.of(new ManagedActionStore.Action("action-1",
                        "requested", body, null, null)))
                .thenThrow(new IllegalStateException("lock wait timeout"))
                .thenReturn(Optional.of(new ManagedActionStore.Action(
                        "action-1", "requested", body, null, null)));
        // harness.resolveAction returns normally: the Harness answered 200.

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(harness).resolveAction("tenant", "session", "action-1", body);
        verify(sessions).retryOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), eq(3L), anyLong(), eq(true));
        verify(actions, never()).complete(any(), anyString(),
                eq("action_response_delivery_failed"), any(), anyBoolean(),
                anyLong());
    }

    // The answered fact is durable in the row's budget-exempt watermark, not
    // a per-attempt local: when an earlier attempt was answered, a later
    // attempt whose Harness call fails is still waiting on the projection,
    // so it reschedules budget-exempt instead of recording a delivery
    // failure for a decision the Harness already committed (review round 7,
    // R7-3).
    @Test
    void aLaterFailureAfterAnAnsweredAttemptStaysBudgetExempt()
            throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        // attemptCount == budgetExemptAttempt == 10: every attempt so far
        // was budget-exempt, i.e. the Harness already answered.
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-action", OperationKind.ACTION_RESPONSE, "digest",
                "RUNNING", "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner",
                3, 10, null, null, null, null, 10, 0);
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
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        doThrow(unavailable).when(harness).resolveAction("tenant", "session",
                "action-1", body);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(sessions).retryOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), eq(3L), anyLong(), eq(true));
        verify(actions, never()).complete(any(), anyString(),
                eq("action_response_delivery_failed"), any(), anyBoolean(),
                anyLong());
    }

    // The exemption is bounded by the Action's own life. Once it expired
    // while still `requested`, no projection can make this delivery
    // observable any more, so waiting can no longer succeed — and since Java
    // keeps no expiry scanner, nothing else would ever end the row, which
    // would keep blocking every later lifecycle operation on the Session
    // through the open-operation barrier. It terminates with its own code
    // rather than action_response_delivery_failed, because the Harness did
    // answer, and as java_durable because no projection lets Java certify
    // what it committed.
    @Test
    void anAnsweredResponseTerminatesOnceItsActionExpired() throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        // attemptCount == budgetExemptAttempt == 10: the Harness answered an
        // earlier attempt, so the row is on the exempt path.
        OperationRecord claimed = new OperationRecord("tenant", "session",
                "op-action", OperationKind.ACTION_RESPONSE, "digest",
                "RUNNING", "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner",
                3, 10, null, null, null, null, 10, 0);
        JsonNode body = actionBody();
        when(sessions.claimOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(actions.response("tenant", "session", "op-action")).thenReturn(
                new ManagedActionStore.Response("action-1", body, null,
                        null));
        when(actions.find("tenant", "session", "action-1")).thenReturn(
                Optional.of(new ManagedActionStore.Action("action-1",
                        "requested", new ObjectMapper().readTree(
                                "{\"expiresAt\":1}"),
                        null, null)));
        DaemonHttpException unavailable = mock(DaemonHttpException.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        doThrow(unavailable).when(harness).resolveAction("tenant", "session",
                "action-1", body);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(actions).complete(eq(claimed), anyString(),
                eq("action_response_decision_expired"), isNull(), eq(false),
                anyLong());
        verify(actions, never()).complete(any(), anyString(),
                eq("action_response_delivery_failed"), any(), anyBoolean(),
                anyLong());
        verify(sessions, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong(), anyBoolean());
    }

    // A capability digest mismatch is a refusal to serve, not the Harness
    // acknowledging the response: the delivery completes terminally with the
    // mismatch code and stays java_durable (harnessConfirmed = false),
    // rather than returning to the outbox to retry a negotiation that will
    // mismatch again. The catch sits ahead of RuntimeException, so the
    // answered/projection machinery below never sees it.
    @Test
    void aCapabilityMismatchCompletesTerminallyWithoutHarnessConfirmation()
            throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(1);
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
        HostedHarnessCapabilityMismatchException mismatch =
                mock(HostedHarnessCapabilityMismatchException.class);
        when(mismatch.getCode()).thenReturn("managed_capability_mismatch");
        doThrow(mismatch).when(harness).resolveAction("tenant", "session",
                "action-1", body);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(actions).complete(eq(claimed), anyString(),
                eq("managed_capability_mismatch"), isNull(), eq(false),
                anyLong());
        verify(sessions, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong(), anyBoolean());
        verify(sessions, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong());
    }

    // A non-retryable workspace_unavailable completes the delivery with
    // the broker's own code and stays java_durable (harnessConfirmed =
    // false): the Workspace authority refused before the Harness was ever
    // asked, so the record must not claim a harness_confirmed admission
    // (review round 6, R6-1).
    @Test
    void aWorkspaceUnavailableCompletesTerminallyWithoutHarnessConfirmation()
            throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(1);
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
        doThrow(WorkspaceExecutionStore.unavailable()).when(harness)
                .resolveAction("tenant", "session", "action-1", body);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), new ManagedAgentProperties());
        coordinator.dispatch("tenant", "session", "op-action");

        verify(actions).complete(eq(claimed), anyString(),
                eq("workspace_unavailable"), isNull(), eq(false), anyLong());
        verify(sessions, never()).retryOperation(anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong(), anyBoolean());
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

    // The exempt count is a count, not a high-water mark: ten exempt waits
    // refund none of the ten charged attempts, so the row whose attempts are
    // half waits still has its terminal budget spent (review R2-1).
    @Test
    void exemptWaitsRefundNoAlreadyChargedAttempt() {
        AgentStateStore store = mock(AgentStateStore.class);
        ManagedSessionStore sessionStore = mock(ManagedSessionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        // Ten charged failures and ten exempt waits: the charged count alone
        // reaches the budget.
        OperationRecord claimed = lifecycleOperation(20, 10);
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
            verify(store, never()).blockLifecycleOperation(anyString(),
                    anyString(), anyString(), anyString(), anyLong(),
                    anyString(), anyLong(), anyBoolean());
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

    // resolveAction can outlast the claim's lease — a cold takeover load is
    // allowed far longer than a steady-state call — so the attempt renews
    // the lease on the dispatch cadence for the call's whole duration, and
    // the answered watermark write still lands afterwards (review R2-5).
    @Test
    void theOperationLeaseIsRenewedAcrossASlowResolveAction()
            throws Exception {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        HarnessConnector harness = mock(HarnessConnector.class);
        OperationRecord claimed = actionOperation(1);
        JsonNode body = actionBody();
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getDispatch().setLeaseDuration(Duration.ofMillis(30));
        when(sessions.claimOperation(eq("tenant"), eq("session"),
                eq("op-action"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(actions.response("tenant", "session", "op-action")).thenReturn(
                new ManagedActionStore.Response("action-1", body, null,
                        null));
        when(actions.find("tenant", "session", "action-1")).thenReturn(
                Optional.of(new ManagedActionStore.Action("action-1",
                        "requested", body, null, null)));
        // The Harness answers 200 after outlasting the 30ms lease.
        doAnswer(invocation -> {
            Thread.sleep(150);
            return null;
        }).when(harness).resolveAction("tenant", "session", "action-1", body);

        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, harness,
                CoordinatorTestSupport.directExecutor(),
                Clock.systemUTC(), properties);
        try {
            coordinator.dispatch("tenant", "session", "op-action");

            verify(sessions, atLeastOnce()).renewLifecycleOperation(
                    eq("tenant"), eq("session"), eq("op-action"), anyString(),
                    eq(3L), eq(Duration.ofMillis(30)));
            // The answer is still recorded budget-exempt afterwards.
            verify(sessions).retryOperation(eq("tenant"), eq("session"),
                    eq("op-action"), anyString(), eq(3L), anyLong(),
                    eq(true));
        } finally {
            coordinator.stopRenewals();
        }
    }

    private static JsonNode actionBody() throws Exception {
        return new ObjectMapper().readTree("{\"optionId\":\"allow\","
                + "\"inputRevision\":1,\"policyRevision\":{}}");
    }

    private static OperationRecord lifecycleOperation(int attemptCount) {
        return lifecycleOperation(attemptCount, 0);
    }

    private static OperationRecord lifecycleOperation(int attemptCount,
            int budgetExemptAttempt) {
        return new OperationRecord("tenant", "session", "op-close",
                OperationKind.CLOSE, "digest", "RUNNING", "JAVA_DURABLE",
                "LEASED", "ACTIVE", null, "owner", 1, attemptCount, null,
                null, null, null, budgetExemptAttempt, 0);
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
