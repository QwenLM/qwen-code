package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RuntimeExecutionDispatcherTest {
    @Test
    @Timeout(15)
    void concurrentDispatchesShareReservationWhileClaimIsPending() throws Exception {
        var fixture = new Fixture();
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var failure = new AtomicReference<Throwable>();
        when(fixture.executions.claimDispatch("execution", "broker", Fixture.LEASE)).thenAnswer(call -> {
            entered.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS), "claim was not released");
            return fixture.prepared;
        });
        Thread first = Thread.ofPlatform().start(() -> {
            try {
                fixture.dispatcher.beginDispatch(fixture.context, fixture.prepared);
            } catch (Throwable error) {
                failure.set(error);
            }
        });
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS), "dispatch never reached its claim");
            assertFalse(fixture.dispatcher.isInvoking("execution"));
            fixture.dispatcher.beginDispatch(fixture.context, fixture.prepared);
            verify(fixture.executions).claimDispatch("execution", "broker", Fixture.LEASE);
            verify(fixture.transport, never()).execute(any(), any(), any());
            release.countDown();
            first.join(2000);
            assertFalse(first.isAlive());
            assertNull(failure.get());
            assertTrue(fixture.dispatcher.isInvoking("execution"));
            verify(fixture.transport).execute(fixture.lease, fixture.session, Fixture.REFERENCE);
        } finally {
            release.countDown();
            first.join(2000);
            fixture.answer.complete(Fixture.RESULT);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void invocationMembershipIsRemovedBeforeOutcomePersistence(boolean failed) {
        var fixture = new Fixture();
        var invokingAtPersistence = new AtomicBoolean(true);
        if (failed) {
            doAnswer(call -> {
                invokingAtPersistence.set(fixture.dispatcher.isInvoking("execution"));
                return null;
            }).when(fixture.state).markUnknown(fixture.executing);
        } else {
            doAnswer(call -> {
                invokingAtPersistence.set(fixture.dispatcher.isInvoking("execution"));
                return null;
            }).when(fixture.state).settleExecution(fixture.executing, Fixture.RESULT);
        }
        fixture.dispatcher.beginDispatch(fixture.context, fixture.prepared);
        assertTrue(fixture.dispatcher.isInvoking("execution"));
        if (failed) {
            fixture.answer.completeExceptionally(new IllegalStateException("worker unavailable"));
            verify(fixture.state).markUnknown(fixture.executing);
            verify(fixture.state, never()).settleExecution(any(), any());
        } else {
            fixture.answer.complete(Fixture.RESULT);
            verify(fixture.state).settleExecution(fixture.executing, Fixture.RESULT);
            verify(fixture.state).settleUnstartedBackgroundSiblings("execution", Fixture.RESULT);
            verify(fixture.state, never()).markUnknown(any());
        }
        assertFalse(invokingAtPersistence.get(), "persistence observed a completed invocation as running");
        assertFalse(fixture.dispatcher.isInvoking("execution"));
        verify(fixture.renewal).cancel(false);
    }

    @Test
    void synchronousClaimFailureReleasesReservationForRetry() {
        var fixture = new Fixture();
        when(fixture.executions.claimDispatch("execution", "broker", Fixture.LEASE))
                .thenThrow(new IllegalStateException("repository unavailable"))
                .thenReturn(fixture.prepared);
        var failure = assertThrows(RuntimeBrokerException.class,
                () -> fixture.dispatcher.beginDispatch(fixture.context, fixture.prepared));
        assertEquals("runtime_execution_dispatch_failed", failure.getCode());
        assertFalse(fixture.dispatcher.isInvoking("execution"));
        fixture.dispatcher.beginDispatch(fixture.context, fixture.prepared);
        verify(fixture.executions, times(2)).claimDispatch("execution", "broker", Fixture.LEASE);
        verify(fixture.transport).execute(fixture.lease, fixture.session, Fixture.REFERENCE);
        assertTrue(fixture.dispatcher.isInvoking("execution"));
        fixture.answer.complete(Fixture.RESULT);
    }

    @Test
    void cancellingReservationsKeepsPhysicalInvocationAndBorrowedResources() {
        var fixture = new Fixture();
        fixture.dispatcher.beginDispatch(fixture.context, fixture.prepared);
        fixture.dispatcher.cancelPendingOperations();
        assertFalse(fixture.answer.isCancelled());
        assertTrue(fixture.dispatcher.isInvoking("execution"));
        assertFalse(fixture.closed.get());
        verify(fixture.scheduler, never()).shutdown();
        verify(fixture.scheduler, never()).shutdownNow();
        verify(fixture.renewalScheduler, never()).shutdown();
        verify(fixture.renewalScheduler, never()).shutdownNow();
        verify(fixture.provisioner, never()).close();
        fixture.answer.complete(Fixture.RESULT);
        assertFalse(fixture.dispatcher.isInvoking("execution"));
        verify(fixture.state).settleExecution(fixture.executing, Fixture.RESULT);
        verify(fixture.renewal).cancel(false);
    }

    @Test
    void workspaceSharedAcknowledgementToleratesANullIsolationKey() {
        // R1-25: a workspace-isolated binding carries a null isolationKey by
        // construction. The acknowledgement identity check must skip the
        // session-equality arm for shared bindings (ownership still rests on
        // belongsTo + bindingId + generation + scope) instead of throwing an
        // NPE before acknowledgeV2 ever runs.
        var fixture = new Fixture();
        var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace");
        var request = new RuntimeProvisionRequest(scope, null,
                com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE,
                "workspace");
        when(fixture.binding.getRequest()).thenReturn(request);
        when(fixture.binding.getLease()).thenReturn(fixture.lease);
        when(fixture.binding.getBindingId()).thenReturn("binding");
        when(fixture.binding.getGeneration()).thenReturn(7L);
        when(fixture.session.getScope()).thenReturn(scope);
        var record = mock(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord.class);
        when(record.getSession()).thenReturn(fixture.session);
        when(fixture.sessions.findById(scope, "runtime")).thenReturn(record);
        var execution = mock(ToolExecutionRecord.class);
        var reference = Map.<String, Object>of("sessionId", "runtime", "promptId", "prompt",
                "callId", "call", "argsDigest", "digest", "dispatchMode", "deferred");
        when(execution.isSettled()).thenReturn(true);
        when(execution.getResult()).thenReturn(Map.<String, Object>of("executionStatus", "success"));
        when(execution.getReference()).thenReturn(reference);
        when(execution.belongsTo(record)).thenReturn(true);
        when(execution.getBindingId()).thenReturn("binding");
        when(execution.getRuntimeGeneration()).thenReturn(7L);
        when(execution.getRuntimeSessionId()).thenReturn("runtime");
        when(execution.getHarnessSessionId()).thenReturn("harness");
        when(fixture.transport.acknowledgeV2(fixture.lease, fixture.session, reference))
                .thenReturn(CompletableFuture.completedFuture(null));

        fixture.dispatcher.acknowledgePersistedTools(fixture.binding, execution)
                .toCompletableFuture().join();

        verify(fixture.transport).acknowledgeV2(fixture.lease, fixture.session, reference);
    }

    @Test
    @Timeout(15)
    @SuppressWarnings("unchecked")
    void sharedDispatchWaitBacksOffAndAnswersConflictAtTheDeadline() throws Exception {
        var registry = mock(RuntimeBindingRegistry.class);
        var bindings = mock(RuntimeBindingRepository.class);
        var sessions = mock(RuntimeSessionRepository.class);
        var executions = mock(ToolExecutionRepository.class);
        var scheduler = mock(ScheduledExecutorService.class);
        var context = mock(SessionContext.class);
        var binding = mock(RuntimeBindingRecord.class);
        var session = mock(RuntimeSession.class);
        var prepared = mock(ToolExecutionRecord.class);
        var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace");
        var request = new RuntimeProvisionRequest(scope, null,
                com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE,
                "workspace");
        when(binding.getRequest()).thenReturn(request);
        when(context.binding()).thenReturn(binding);
        when(context.session()).thenReturn(session);
        when(session.getScope()).thenReturn(scope);
        when(session.getHarnessSessionId()).thenReturn("harness");
        when(prepared.getExecutionCallId()).thenReturn("execution");
        when(prepared.getState()).thenReturn(ToolExecutionRecord.State.PREPARED);
        when(prepared.sameIdentity(prepared)).thenReturn(true);
        when(prepared.getReference()).thenReturn(Map.of("sessionId", "runtime", "dispatchMode", "deferred"));
        when(executions.findByExecutionCallId("execution")).thenReturn(prepared);
        when(executions.claimValidatedDispatch(eq("execution"), eq("broker"), any(Duration.class), any()))
                .thenReturn(null);
        var now = new AtomicReference<>(Instant.parse("2026-11-01T00:00:00Z"));
        var clock = new Clock() {
            @Override
            public java.time.ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(java.time.ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return now.get();
            }
        };
        var delays = new java.util.ArrayList<Long>();
        var ticks = new java.util.ArrayList<Runnable>();
        when(scheduler.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS))).thenAnswer(call -> {
            ticks.add(call.getArgument(0));
            delays.add(call.getArgument(1));
            return mock(ScheduledFuture.class);
        });
        var dispatcher = new RuntimeExecutionDispatcher(registry, mock(RuntimeExecutionState.class), bindings,
                sessions, executions, mock(RuntimeProvisioner.class), mock(RuntimeTransport.class),
                mock(RuntimePublicationVerifier.class), "broker", Duration.ofSeconds(60),
                Duration.ofSeconds(10), clock, scheduler, mock(ScheduledExecutorService.class),
                new AtomicBoolean());
        dispatcher.beginDispatch(context, prepared, Map.of("toolName", "read_file", "input", Map.of()), null,
                com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload.of("digest", "read_file"));
        var field = RuntimeExecutionDispatcher.class.getDeclaredField("dispatches");
        field.setAccessible(true);
        var dispatches = (java.util.concurrent.ConcurrentMap<String, CompletableFuture<Void>>) field.get(dispatcher);
        var queued = dispatches.get("execution");
        assertNotNull(queued);

        // The occupant never settles: the wait must back off instead of
        // hammering the coordination thread at a fixed interval.
        for (int index = 0; index < 8; index++) {
            assertFalse(queued.isDone());
            ticks.get(ticks.size() - 1).run();
        }
        assertEquals(250L, delays.get(0));
        assertEquals(100L, delays.get(1));
        assertEquals(200L, delays.get(2));
        assertEquals(400L, delays.get(3));
        assertEquals(2000L, delays.get(delays.size() - 1));
        assertFalse(queued.isDone());

        // Past the deadline the next tick answers a conflict instead of
        // rescheduling forever.
        now.set(now.get().plus(Duration.ofSeconds(11)));
        int scheduled = ticks.size();
        ticks.get(ticks.size() - 1).run();
        assertEquals(scheduled, ticks.size());
        var error = assertThrows(java.util.concurrent.ExecutionException.class,
                () -> queued.get(1, TimeUnit.SECONDS));
        assertTrue(error.getCause() instanceof RuntimeBrokerException);
        assertEquals("runtime_execution_conflict", ((RuntimeBrokerException) error.getCause()).getCode());
    }

    private static final class Fixture {
        private static final Duration LEASE = Duration.ofSeconds(60);
        private static final Map<String, Object> REFERENCE = Map.of("sessionId", "runtime");
        private static final Map<String, Object> RESULT = Map.of("executionStatus", "success");

        private final RuntimeExecutionState state = mock(RuntimeExecutionState.class);
        private final ToolExecutionRepository executions = mock(ToolExecutionRepository.class);
        private final RuntimeProvisioner provisioner = mock(RuntimeProvisioner.class);
        private final RuntimeTransport transport = mock(RuntimeTransport.class);
        private final ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        private final ScheduledExecutorService renewalScheduler = mock(ScheduledExecutorService.class);
        private final ScheduledFuture<?> renewal = mock(ScheduledFuture.class);
        private final AtomicBoolean closed = new AtomicBoolean();
        private final SessionContext context = mock(SessionContext.class);
        private final RuntimeSession session = mock(RuntimeSession.class);
        private final RuntimeLease lease = mock(RuntimeLease.class);
        private final RuntimeBindingRecord binding = mock(RuntimeBindingRecord.class);
        private final RuntimeSessionRepository sessions = mock(RuntimeSessionRepository.class);
        private final ToolExecutionRecord prepared = mock(ToolExecutionRecord.class);
        private final ToolExecutionRecord executing = mock(ToolExecutionRecord.class);
        private final CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();
        private final RuntimeExecutionDispatcher dispatcher;

        private Fixture() {
            var registry = mock(RuntimeBindingRegistry.class);
            var bindings = mock(RuntimeBindingRepository.class);
            var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                    WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            when(binding.getRequest()).thenReturn(new RuntimeProvisionRequest(scope, "harness", "local"));
            when(context.binding()).thenReturn(binding);
            when(context.session()).thenReturn(session);
            when(context.lease()).thenReturn(lease);
            when(session.getScope()).thenReturn(scope);
            when(session.getHarnessSessionId()).thenReturn("harness");
            for (var record : new ToolExecutionRecord[] {prepared, executing}) {
                when(record.getExecutionCallId()).thenReturn("execution");
                when(record.getReference()).thenReturn(REFERENCE);
                when(record.getDispatchOwner()).thenReturn("broker");
                when(record.getDispatchGeneration()).thenReturn(7L);
            }
            when(prepared.getState()).thenReturn(ToolExecutionRecord.State.DISPATCHING);
            when(executing.getState()).thenReturn(ToolExecutionRecord.State.EXECUTING);
            when(executions.claimDispatch("execution", "broker", LEASE)).thenReturn(prepared);
            when(bindings.authorizeDispatch(sessions, executions, prepared, "broker", 7L)).thenReturn(executing);
            when(provisioner.isUsable(lease)).thenReturn(true);
            when(transport.execute(lease, session, REFERENCE)).thenReturn(answer);
            when(renewalScheduler.scheduleWithFixedDelay(any(Runnable.class), anyLong(), anyLong(),
                    eq(TimeUnit.MILLISECONDS))).thenAnswer(call -> renewal);
            dispatcher = new RuntimeExecutionDispatcher(registry, state, bindings, sessions, executions,
                    provisioner, transport, mock(RuntimePublicationVerifier.class), "broker", LEASE,
                    Duration.ofMinutes(30), Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC),
                    scheduler, renewalScheduler, closed);
        }
    }
}
