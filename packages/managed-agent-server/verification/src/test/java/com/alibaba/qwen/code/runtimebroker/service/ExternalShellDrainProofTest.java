package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.ExecutionReconciliation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The two routes that could settle the external foreground-Shell lane without
 * its drain (#15512 slice C): cancelling a Shell in flight, and reconciling one
 * whose outcome went unknown.
 *
 * <p>Both read a settled answer that names the worker's <em>local</em> manifest.
 * Absorbing it records a result whose bytes never reached the control plane,
 * makes the publication permanently unproducible, and lets the close release
 * storage — so both must refuse while the publication is unfinished, and both
 * must accept it once the drain has finished.
 */
class ExternalShellDrainProofTest {
    @Test
    @Timeout(15)
    void cancellingAShellInFlightStillAbortsItButRefusesToSettleAnUndrainedCapture() {
        var fixture = new Fixture();
        fixture.cancelAnswer = Map.of("state", "settled", "result", fixture.workerEnvelope());
        var cancelled = fixture.cancellation.cancelExecution("harness", "runtime", "execution")
                .toCompletableFuture().join();

        // The physical abort is not gated: leaving the process running would
        // be worse. Only the settle is fenced.
        assertTrue(fixture.events.contains("cancel"));
        assertNull(fixture.settled.get(), "An undrained capture must not settle from a cancel answer");
        assertTrue(cancelled.isCancelRequested());
        assertFalse(cancelled.isSettled());
    }

    @Test
    @Timeout(15)
    void cancellingAShellWhoseDrainAlreadyFinishedSettlesThePublishedEnvelope() {
        var fixture = new Fixture();
        fixture.finished = true;
        fixture.cancelAnswer = Map.of("state", "settled", "result", fixture.workerEnvelope());
        fixture.cancellation.cancelExecution("harness", "runtime", "execution")
                .toCompletableFuture().join();

        // Even here the settled result is the control plane's rebuilt envelope:
        // the Harness compares it against `/finished` verbatim, and the
        // worker's copy names its own private manifest.
        assertEquals(fixture.publishedEnvelope(), fixture.settled.get());
        assertEquals("control-plane-manifest", capture(fixture.settled.get()).get("manifest"));
    }

    @Test
    @Timeout(15)
    void cancellingAShellThatNeverStartedSettlesTheWorkersNotStartedAnswer() {
        var fixture = new Fixture();
        // No process ran, so no channel holds bytes and the publication stays
        // unfinished forever. The not-started answer is the turn's real
        // outcome and must not be fenced.
        var unstarted = new java.util.LinkedHashMap<String, Object>();
        unstarted.put("executionStatus", "not_started");
        unstarted.put("responseParts", List.of());
        unstarted.put("capture", null);
        fixture.cancelAnswer = Map.of("state", "settled", "result", unstarted);
        fixture.cancellation.cancelExecution("harness", "runtime", "execution")
                .toCompletableFuture().join();

        assertEquals("not_started", fixture.settled.get().get("executionStatus"));
    }

    @Test
    @Timeout(15)
    void reconcilingAnUndrainedShellRefusesBeforeAskingTheWorkerForItsStatus() {
        var fixture = new Fixture(ToolExecutionRecord.State.UNKNOWN);
        // `doAnswer` avoids the stubbing-time `thenAnswer` invocation that
        // `when(...).thenReturn(...)` would trigger on a mock already stubbed
        // with `thenAnswer`, so the events list reflects the production call
        // order.
        doAnswer(call -> {
            fixture.events.add("status");
            return CompletableFuture.completedFuture(
                    Map.of("state", "settled", "result", fixture.workerEnvelope()));
        }).when(fixture.transport).statusV3(any(), any(), any(), any(Long.class));
        var reconciled = fixture.reconciler
                .reconcileInContext(fixture.context, fixture.requested, true)
                .toCompletableFuture().join();
        assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED, reconciled.getOutcome());
        assertEquals(List.of("finished", "status"), fixture.events);
        assertNull(fixture.settled.get(), "A started call's worker answer must never settle this lane");
    }

    @Test
    @Timeout(15)
    void reconcilingAShellWhoseDrainAlreadyFinishedSettlesTheDurableEnvelope() {
        var fixture = new Fixture(ToolExecutionRecord.State.UNKNOWN);
        fixture.finished = true;
        var reconciled = fixture.reconciler
                .reconcileInContext(fixture.context, fixture.requested, true)
                .toCompletableFuture().join();

        // The finished publication already is the outcome, so the settle needs
        // no worker lookup at all: the worker's status could only name its own
        // local manifest, which is not what this record may settle with.
        assertEquals(ExecutionReconciliation.Outcome.RESOLVED, reconciled.getOutcome());
        assertEquals(fixture.publishedEnvelope(), reconciled.getRecord().getResult());
        assertEquals(List.of("finished"), fixture.events);
    }

    @Test
    @Timeout(15)
    void reconcilingAShellTheWorkerProvesNeverStartedSettlesWithoutAnyPublication() {
        var fixture = new Fixture(ToolExecutionRecord.State.UNKNOWN);
        // A drain that never began leaves no publication and never will. The
        // worker's own not-started answer carries no capture and no bytes, so
        // fencing it would strand the record UNKNOWN for ever and the close
        // could never be proven either way.
        var unstarted = new java.util.LinkedHashMap<String, Object>();
        unstarted.put("executionStatus", "not_started");
        unstarted.put("responseParts", List.of());
        unstarted.put("capture", null);
        when(fixture.transport.statusV3(fixture.lease, fixture.session,
                fixture.requested.getReference(), 0L))
                .thenReturn(CompletableFuture.completedFuture(
                        Map.of("state", "settled", "result", unstarted)));
        var reconciled = fixture.reconciler
                .reconcileInContext(fixture.context, fixture.requested, true)
                .toCompletableFuture().join();

        assertEquals(ExecutionReconciliation.Outcome.RESOLVED, reconciled.getOutcome());
        assertEquals("not_started", reconciled.getRecord().getResult().get("executionStatus"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> capture(Map<String, Object> envelope) {
        return (Map<String, Object>) envelope.get("capture");
    }

    /**
     * One EXECUTING external Shell with a live claim and a READY Session, wired
     * to both the cancellation and the reconciliation route. The publication
     * verifier is the only collaborator these cases vary: whether the drain has
     * finished is exactly what decides the outcome.
     */
    private static final class Fixture {
        private static final Duration LEASE = Duration.ofSeconds(60);
        private static final Instant START = Instant.parse("2026-11-01T00:00:00Z");
        private static final Map<String, Object> REFERENCE = Map.of(
                "sessionId", "runtime", "promptId", "turn", "callId", "call",
                "argsDigest", "sha256:" + "a".repeat(64),
                "dispatchMode", "deferred_v3", "publicationId", "publication",
                "payloadDigest", "sha256:" + "b".repeat(64));

        private final List<String> events = new ArrayList<>();
        private final AtomicReference<Map<String, Object>> settled = new AtomicReference<>();
        private boolean finished;
        private Map<String, Object> cancelAnswer = Map.of("state", "cancel_requested");

        private final RuntimeLease lease = mock(RuntimeLease.class);
        private final RuntimeBindingRecord binding = mock(RuntimeBindingRecord.class);
        private final SessionContext context = mock(SessionContext.class);
        private final ToolExecutionRepository executions = mock(ToolExecutionRepository.class);
        private final RuntimeTransport transport = mock(RuntimeTransport.class);
        private final RuntimeProvisioner provisioner = mock(RuntimeProvisioner.class);
        private final RuntimeExecutionState state = mock(RuntimeExecutionState.class);
        private final RuntimeBindingRegistry registry = mock(RuntimeBindingRegistry.class);
        private final ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        private final Clock clock = Clock.fixed(START, ZoneOffset.UTC);
        private final RuntimeScope scope = new RuntimeScope("tenant", "storage", "1", "/workspace",
                WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST, "session");
        private final RuntimeSession session = new RuntimeSession("harness", "runtime", "bootstrap", scope);
        private final ToolExecutionRecord requested;
        private final RuntimeExecutionCancellation cancellation;
        private final RuntimeExecutionReconciler reconciler;

        private Fixture() {
            this(ToolExecutionRecord.State.EXECUTING);
        }

        private Fixture(ToolExecutionRecord.State rowState) {
            var bindings = mock(RuntimeBindingRepository.class);
            var sessions = mock(RuntimeSessionRepository.class);
            var closed = new AtomicBoolean();
            // A claim this process still holds, so the cancel falls through to
            // the physical abort instead of fencing a lapsed claim.
            requested = row("execution", "key", "binding", 1,
                    rowState, rowState == ToolExecutionRecord.State.EXECUTING);
            var cancelled = row("execution", "key", "binding", 1,
                    ToolExecutionRecord.State.CANCEL_REQUESTED, true);
            var record = new RuntimeSessionRecord(session, "binding", 1,
                    RuntimeSessionRecord.State.READY, 1, START);
            when(binding.getRequest()).thenReturn(new RuntimeProvisionRequest(
                    scope, "harness", "external-workspace", "storage"));
            when(binding.getBindingId()).thenReturn("binding");
            when(binding.getGeneration()).thenReturn(1L);
            when(binding.getState()).thenReturn(RuntimeBindingRecord.State.READY);
            when(binding.getLease()).thenReturn(lease);
            when(bindings.findById("binding")).thenReturn(binding);
            when(sessions.findById(scope, "runtime")).thenReturn(record);
            when(context.binding()).thenReturn(binding);
            when(context.session()).thenReturn(session);
            when(context.lease()).thenReturn(lease);
            when(executions.findByExecutionCallId("execution")).thenReturn(requested);
            when(executions.requestCancel("execution", 3)).thenReturn(cancelled);
            when(executions.claimDispatch("execution", "broker", LEASE)).thenReturn(cancelled);
            when(executions.resolveUnsettled(any(), any(), any())).thenAnswer(call ->
                    requested.resolveUnsettled(call.getArgument(1), call.getArgument(2)));
            when(provisioner.isUsable(lease)).thenReturn(true);
            when(registry.requireReadySession("harness", "runtime"))
                    .thenReturn(CompletableFuture.completedFuture(context));
            when(registry.requireReadySessionRecord(context)).thenReturn(record);
            when(registry.hasBinding("binding")).thenReturn(true);
            when(state.requireExecution(context, "execution")).thenReturn(requested);
            // The repository still holds this broker's live claim, so the
            // fence hands the CANCEL_REQUESTED row back and the cancel falls
            // through to the physical abort instead of settling from here.
            when(state.fenceLapsedClaim(any())).thenReturn(cancelled);
            when(state.requireOwnership("harness", "runtime", "execution"))
                    .thenReturn(new RuntimeExecutionState.OwnedExecution(requested, null, null));
            when(state.unknownWhenAdmissionClosed(any(), any(), any(), any()))
                    .thenAnswer(call -> call.getArgument(0));
            doAnswer(call -> {
                settled.set(call.getArgument(1));
                return null;
            }).when(state).settleExecution(any(), any());
            when(transport.cancelV3(lease, session, REFERENCE)).thenAnswer(call -> {
                events.add("cancel");
                return CompletableFuture.completedFuture(cancelAnswer);
            });
            when(transport.statusV3(any(), any(), any(), org.mockito.ArgumentMatchers.anyLong()))
                    .thenAnswer(call -> {
                        events.add("status");
                        return CompletableFuture.completedFuture(Map.of("state", "executing"));
                    });
            var verifier = verifier();
            var dispatcher = new RuntimeExecutionDispatcher(registry, state, bindings, sessions,
                    executions, provisioner, transport, verifier, "broker", LEASE,
                    Duration.ofMinutes(30), clock, scheduler, scheduler, closed);
            cancellation = new RuntimeExecutionCancellation(registry, state, executions, transport,
                    verifier, dispatcher, scheduler, LEASE, closed);
            reconciler = new RuntimeExecutionReconciler(registry, state, executions, provisioner,
                    transport, verifier, LEASE, clock, scheduler, closed,
                    new ExecutionObservationCooldown(clock, scheduler));
        }

        private static ToolExecutionRecord row(String id, String key, String bindingId,
                long generation, ToolExecutionRecord.State state, boolean cancelRequested) {
            boolean unknown = state == ToolExecutionRecord.State.UNKNOWN;
            return new ToolExecutionRecord(id, key, bindingId, generation,
                    "harness", "runtime", "turn", "call", "sha256:" + "b".repeat(64), REFERENCE,
                    state, null, null, 0, cancelRequested,
                    "broker", START.plus(LEASE), 7, 3, null, null, null,
                    unknown ? null : 7L, unknown ? null : 2L);
        }

        /** The worker's own settled envelope: its manifest ref is worker-local. */
        private Map<String, Object> workerEnvelope() {
            return Map.of("executionStatus", "cancelled", "responseParts", List.of(),
                    "capture", Map.of("captureStatus", "complete", "manifest", "worker-manifest"));
        }

        /** The control plane's rebuilt envelope, which the drain finished with. */
        private Map<String, Object> publishedEnvelope() {
            return Map.of("executionStatus", "cancelled", "responseParts", List.of(),
                    "capture", Map.of("captureStatus", "complete",
                            "manifest", "control-plane-manifest"));
        }

        private RuntimePublicationVerifier verifier() {
            return new RuntimePublicationVerifier() {
                public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                        String publicationId, String token) {
                    throw new AssertionError("Neither route re-verifies a grant");
                }

                public Map<String, Object> finished(ToolExecutionRecord execution) {
                    events.add("finished");
                    return finished ? publishedEnvelope() : null;
                }
            };
        }
    }
}
