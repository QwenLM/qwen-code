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
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
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
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RuntimeExecutionDispatcherTest {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void measuredAcknowledgementHonorsTheSessionOwnerOnSharedWorkspace(boolean foreignOwner) {
        var fixture = new Fixture();
        var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST, "workspace");
        var request = new RuntimeProvisionRequest(scope, null, "local-process", "storage");
        when(fixture.binding.getRequest()).thenReturn(request);
        when(fixture.binding.getLease()).thenReturn(fixture.lease);
        when(fixture.binding.getBindingId()).thenReturn("binding");
        when(fixture.binding.getGeneration()).thenReturn(1L);
        var session = new RuntimeSession(foreignOwner ? "other-harness" : "harness", "runtime", "bootstrap", scope);
        when(fixture.sessions.findById(scope, "runtime")).thenReturn(new RuntimeSessionRecord(session,
                "binding", 1, RuntimeSessionRecord.State.READY, 0, Instant.now()));
        Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "turn", "callId", "call",
                "argsDigest", "sha256:" + "a".repeat(64), "resultProtocol", 4);
        var result = Map.<String, Object>of("executionStatus", "success", "responseParts", java.util.List.of());
        var execution = new ToolExecutionRecord("execution", "idempotency", "binding", 1,
                "harness", "runtime", "turn", "call", "sha256:" + "a".repeat(64), reference,
                ToolExecutionRecord.State.SETTLED, "success", result, 1, false, null, null, 0, 0, Instant.now());
        when(fixture.transport.acknowledgeV4(fixture.lease, session, reference, result, null))
                .thenReturn(CompletableFuture.completedFuture(null));
        var acknowledged = fixture.dispatcher.acknowledgePersistedTools(fixture.binding, execution).toCompletableFuture();
        if (foreignOwner) {
            var failure = assertThrows(java.util.concurrent.CompletionException.class, acknowledged::join);
            assertTrue(failure.getCause() instanceof RuntimeBrokerException);
            verify(fixture.transport, never()).acknowledgeV4(any(), any(), any(), any(), any());
        } else {
            acknowledged.join();
            verify(fixture.transport).acknowledgeV4(fixture.lease, session, reference, result, null);
        }
    }

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
        // The dispatch future is write-only (consumed solely by
        // cancelPendingOperations), so the conflict above never reaches the
        // caller on its own. The refusal must also be written through the
        // record: the stranded PREPARED execution is settled not_started with a
        // dispatch_timeout error, so the record the caller polls carries the
        // refusal instead of hanging PREPARED with no dispatch owner.
        verify(executions).settlePrepared(eq(prepared), argThat(result ->
                "not_started".equals(result.get("executionStatus"))
                        && result.get("error") instanceof Map<?, ?> refusal
                        && "dispatch_timeout".equals(refusal.get("type"))),
                any(Instant.class));
    }

    @Test
    void anExceptionalSharedDispatchExitSettlesTheStrandedPreparedRecord() throws Exception {
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
        var ticks = new java.util.ArrayList<Runnable>();
        when(scheduler.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS))).thenAnswer(call -> {
            ticks.add(call.getArgument(0));
            return mock(ScheduledFuture.class);
        });
        var dispatcher = new RuntimeExecutionDispatcher(registry, mock(RuntimeExecutionState.class), bindings,
                sessions, executions, mock(RuntimeProvisioner.class), mock(RuntimeTransport.class),
                mock(RuntimePublicationVerifier.class), "broker", Duration.ofSeconds(60),
                Duration.ofSeconds(10), Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC),
                scheduler, mock(ScheduledExecutorService.class), new AtomicBoolean());
        dispatcher.beginDispatch(context, prepared, Map.of("toolName", "read_file", "input", Map.of()), null,
                com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload.of("digest", "read_file"));
        var field = RuntimeExecutionDispatcher.class.getDeclaredField("dispatches");
        field.setAccessible(true);
        var dispatches = (java.util.concurrent.ConcurrentMap<String, CompletableFuture<Void>>) field.get(dispatcher);
        var queued = dispatches.get("execution");
        assertNotNull(queued);
        // The admission gate passes at beginDispatch and fails inside the
        // wait, so the exceptional exit under test is the tick's own.
        org.mockito.Mockito.doThrow(new RuntimeBrokerException(409,
                "runtime_binding_not_ready", "Binding is not ready.", false))
                .when(bindings).requireHarnessAdmission(eq(request), eq(scope),
                        eq("harness"), org.mockito.ArgumentMatchers.isNull());
        ticks.getFirst().run();
        var error = assertThrows(java.util.concurrent.ExecutionException.class,
                () -> queued.get(1, TimeUnit.SECONDS));
        assertEquals("runtime_binding_not_ready",
                ((RuntimeBrokerException) error.getCause()).getCode());
        // The write-only future never surfaces this refusal to the caller, so
        // the stranded PREPARED row must settle here — otherwise it hangs the
        // caller's poll and fences the binding's release forever.
        verify(executions).settlePrepared(eq(prepared), argThat(result ->
                "not_started".equals(result.get("executionStatus"))
                        && result.get("error") instanceof Map<?, ?> refusal
                        && "dispatch_failed".equals(refusal.get("type"))),
                any(Instant.class));
    }

    // A store read that fails while the shared dispatch waits is transient:
    // the claim is retried under the same deadline instead of settling the
    // PREPARED row, which would fail a dispatch another attempt can still
    // drive.
    @Test
    void aRetryableStoreFailureReschedulesTheWaitInsteadOfSettlingTheRecord()
            throws Exception {
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
        var ticks = new java.util.ArrayList<Runnable>();
        when(scheduler.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS))).thenAnswer(call -> {
            ticks.add(call.getArgument(0));
            return mock(ScheduledFuture.class);
        });
        var now = new AtomicReference<>(Instant.parse("2026-11-01T00:00:00Z"));
        var mutableClock = new Clock() {
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
        var dispatcher = new RuntimeExecutionDispatcher(registry, mock(RuntimeExecutionState.class), bindings,
                sessions, executions, mock(RuntimeProvisioner.class), mock(RuntimeTransport.class),
                mock(RuntimePublicationVerifier.class), "broker", Duration.ofSeconds(60),
                Duration.ofSeconds(10), mutableClock,
                scheduler, mock(ScheduledExecutorService.class), new AtomicBoolean());
        dispatcher.beginDispatch(context, prepared, Map.of("toolName", "read_file", "input", Map.of()), null,
                com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload.of("digest", "read_file"));
        var field = RuntimeExecutionDispatcher.class.getDeclaredField("dispatches");
        field.setAccessible(true);
        var dispatches = (java.util.concurrent.ConcurrentMap<String, CompletableFuture<Void>>) field.get(dispatcher);
        var queued = dispatches.get("execution");
        assertNotNull(queued);
        when(executions.claimValidatedDispatch(eq("execution"), eq("broker"),
                any(Duration.class), any())).thenThrow(new com.alibaba.qwen.code.runtimebroker.StoreFailureException(
                        "lock wait timeout exceeded",
                        new java.sql.SQLException("timeout")));
        ticks.getFirst().run();
        verify(executions, never()).settlePrepared(any(), any(), any());
        assertFalse(queued.isDone());
        assertEquals(2, ticks.size());
        // Still inside the same deadline: the next attempt retries too rather
        // than answering the caller a terminal failure.
        ticks.get(1).run();
        verify(executions, never()).settlePrepared(any(), any(), any());
        assertFalse(queued.isDone());
        assertEquals(3, ticks.size());
        // The deadline is the retry's ceiling too: once the window closes the
        // next tick stops retrying and answers the same timeout refusal the
        // occupied-slot path uses, settling the row it can no longer dispatch.
        now.set(now.get().plus(Duration.ofSeconds(11)));
        ticks.get(2).run();
        assertEquals(3, ticks.size());
        verify(executions).settlePrepared(eq(prepared), argThat(result ->
                "not_started".equals(result.get("executionStatus"))
                        && result.get("error") instanceof Map<?, ?> refusal
                        && "dispatch_timeout".equals(refusal.get("type"))),
                any(Instant.class));
        var error = assertThrows(java.util.concurrent.ExecutionException.class,
                () -> queued.get(1, TimeUnit.SECONDS));
        assertTrue(error.getCause() instanceof RuntimeBrokerException);
        assertEquals("runtime_execution_conflict",
                ((RuntimeBrokerException) error.getCause()).getCode());
        dispatcher.cancelPendingOperations();
        scheduler.shutdownNow();
    }

    // The wait's success exit: by the next tick another attempt already moved
    // the row out of PREPARED, so the wait completes instead of rescheduling
    // and deregisters its awaiting entry. Without it the caller's request
    // would hang until the deadline even though the slot is free.
    @Test
    @Timeout(15)
    @SuppressWarnings("unchecked")
    void aRowReleasedByAnotherAttemptCompletesTheWaitAndLeavesTheAwaitingSet()
            throws Exception {
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
        var ticks = new java.util.ArrayList<Runnable>();
        when(scheduler.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS))).thenAnswer(call -> {
            ticks.add(call.getArgument(0));
            return mock(ScheduledFuture.class);
        });
        var dispatcher = new RuntimeExecutionDispatcher(registry, mock(RuntimeExecutionState.class), bindings,
                sessions, executions, mock(RuntimeProvisioner.class), mock(RuntimeTransport.class),
                mock(RuntimePublicationVerifier.class), "broker", Duration.ofSeconds(60),
                Duration.ofSeconds(10), Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC),
                scheduler, mock(ScheduledExecutorService.class), new AtomicBoolean());
        dispatcher.beginDispatch(context, prepared, Map.of("toolName", "read_file", "input", Map.of()), null,
                com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload.of("digest", "read_file"));
        var field = RuntimeExecutionDispatcher.class.getDeclaredField("dispatches");
        field.setAccessible(true);
        var dispatches = (java.util.concurrent.ConcurrentMap<String, CompletableFuture<Void>>) field.get(dispatcher);
        var queued = dispatches.get("execution");
        assertNotNull(queued);
        var awaitingField = RuntimeExecutionDispatcher.class.getDeclaredField("awaiting");
        awaitingField.setAccessible(true);
        var awaiting = (java.util.Map<String, ?>) awaitingField.get(dispatcher);
        assertTrue(awaiting.containsKey("execution"));

        // Still occupied: another tick is scheduled and the caller keeps
        // waiting.
        ticks.getFirst().run();
        assertFalse(queued.isDone());
        assertTrue(awaiting.containsKey("execution"));
        assertEquals(2, ticks.size());

        // The occupant finishes elsewhere; the row is no longer PREPARED, so
        // this tick is the wait's successful exit.
        var released = mock(ToolExecutionRecord.class);
        when(released.getState()).thenReturn(ToolExecutionRecord.State.EXECUTING);
        when(executions.findByExecutionCallId("execution")).thenReturn(released);
        ticks.get(1).run();
        queued.get(1, TimeUnit.SECONDS);
        assertFalse(awaiting.containsKey("execution"));
        assertEquals(2, ticks.size());
        verify(executions, never()).settlePrepared(any(), any(), any());
    }

    // The initial schedule is the one exit the tick's own catch cannot cover:
    // a dispatch that lost the race to RuntimeBrokerService.close() (scheduler
    // shut down after the null claim) must still settle its PREPARED row, or
    // the record stays active and fences the binding's release forever.
    @Test
    void aRejectedInitialScheduleSettlesTheStrandedPreparedRecord() {
        var registry = mock(RuntimeBindingRegistry.class);
        var bindings = mock(RuntimeBindingRepository.class);
        var sessions = mock(RuntimeSessionRepository.class);
        var executions = mock(ToolExecutionRepository.class);
        var scheduler = new java.util.concurrent.ScheduledThreadPoolExecutor(1);
        scheduler.shutdownNow();
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
        var dispatcher = new RuntimeExecutionDispatcher(registry, mock(RuntimeExecutionState.class), bindings,
                sessions, executions, mock(RuntimeProvisioner.class), mock(RuntimeTransport.class),
                mock(RuntimePublicationVerifier.class), "broker", Duration.ofSeconds(60),
                Duration.ofSeconds(10), Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC),
                scheduler, mock(ScheduledExecutorService.class), new AtomicBoolean());
        var failure = assertThrows(RuntimeBrokerException.class, () -> dispatcher.beginDispatch(
                context, prepared, Map.of("toolName", "read_file", "input", Map.of()), null,
                com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload.of("digest", "read_file")));
        // The caller still observes the rejection; only the stranded row is
        // settled first.
        assertEquals("runtime_execution_dispatch_failed", failure.getCode());
        assertTrue(failure.getCause() instanceof java.util.concurrent.RejectedExecutionException);
        verify(executions).settlePrepared(eq(prepared), argThat(result ->
                "not_started".equals(result.get("executionStatus"))
                        && result.get("error") instanceof Map<?, ?> refusal
                        && "dispatch_failed".equals(refusal.get("type"))),
                any(Instant.class));
    }

    // R4-6 second exit: the schedule is accepted, then close() shuts the
    // executor down and discards the queued tick. The wait must still settle
    // its PREPARED row and end, or the row stays active forever.
    @Test
    void aShutdownAfterTheInitialScheduleSettlesTheStrandedPreparedRecord() throws Exception {
        var registry = mock(RuntimeBindingRegistry.class);
        var bindings = mock(RuntimeBindingRepository.class);
        var sessions = mock(RuntimeSessionRepository.class);
        var executions = mock(ToolExecutionRepository.class);
        var scheduler = new java.util.concurrent.ScheduledThreadPoolExecutor(1);
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
        var dispatcher = new RuntimeExecutionDispatcher(registry, mock(RuntimeExecutionState.class), bindings,
                sessions, executions, mock(RuntimeProvisioner.class), mock(RuntimeTransport.class),
                mock(RuntimePublicationVerifier.class), "broker", Duration.ofSeconds(60),
                Duration.ofSeconds(10), Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC),
                scheduler, mock(ScheduledExecutorService.class), new AtomicBoolean());
        dispatcher.beginDispatch(context, prepared, Map.of("toolName", "read_file", "input", Map.of()), null,
                com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload.of("digest", "read_file"));
        // close(): the dispatch wait is settled and ended before the executor
        // discards the queued tick.
        dispatcher.cancelPendingOperations();
        scheduler.shutdownNow();
        verify(executions).settlePrepared(eq(prepared), argThat(result ->
                "not_started".equals(result.get("executionStatus"))
                        && result.get("error") instanceof Map<?, ?> refusal
                        && "dispatch_failed".equals(refusal.get("type"))),
                any(Instant.class));
        var field = RuntimeExecutionDispatcher.class.getDeclaredField("dispatches");
        field.setAccessible(true);
        var dispatches = (java.util.concurrent.ConcurrentMap<String, CompletableFuture<Void>>) field.get(dispatcher);
        assertTrue(dispatches.isEmpty());
    }

    private static final class Fixture {
        private static final Duration LEASE = Duration.ofSeconds(60);
        private static final Map<String, Object> REFERENCE = Map.of("sessionId", "runtime");
        private static final Map<String, Object> RESULT = Map.of("executionStatus", "success");

        private final RuntimeExecutionState state = mock(RuntimeExecutionState.class);
        private final ToolExecutionRepository executions = mock(ToolExecutionRepository.class);
        private final RuntimeProvisioner provisioner = mock(RuntimeProvisioner.class);
        private final RuntimeTransport transport = mock(RuntimeTransport.class);
        private final RuntimeSessionRepository sessions = mock(RuntimeSessionRepository.class);
        private final RuntimeBindingRecord binding = mock(RuntimeBindingRecord.class);
        private final ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        private final ScheduledExecutorService renewalScheduler = mock(ScheduledExecutorService.class);
        private final ScheduledFuture<?> renewal = mock(ScheduledFuture.class);
        private final RuntimePublicationVerifier verifier = mock(RuntimePublicationVerifier.class);
        private final AtomicBoolean closed = new AtomicBoolean();
        private final SessionContext context = mock(SessionContext.class);
        private final RuntimeSession session = mock(RuntimeSession.class);
        private final RuntimeLease lease = mock(RuntimeLease.class);
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
                    provisioner, transport, verifier, "broker", LEASE,
                    Duration.ofMinutes(30), Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC),
                    scheduler, renewalScheduler, closed);
        }
    }

    @Test
    void anExternalShellDispatchPassesTheFilesGate() {
        dispatchExternalShell(Map.of("command", "printf hi"));
    }

    @Test
    void anExplicitForegroundMarkerDoesNotRefuseTheExternalShellDispatch() {
        // The control plane validates `is_background` as any boolean and keeps
        // the key, so a foreground command can carry an explicit `false`.
        // Judging the key's presence settled a runnable command as
        // workspace_tool_unsupported instead of dispatching it.
        dispatchExternalShell(Map.of("command", "pwd", "is_background", false));
    }

    private void dispatchExternalShell(Map<String, Object> input) {
        var fixture = new Fixture();
        // Bind the external Shell placement: same provisioner, session
        // isolation and storage identity as files, but the Shell digest.
        var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, "harness", "external-workspace", "workspace");
        when(fixture.binding.getRequest()).thenReturn(request);
        when(fixture.binding.getBindingId()).thenReturn("binding");
        when(fixture.binding.getGeneration()).thenReturn(1L);
        when(fixture.prepared.isCancelRequested()).thenReturn(false);
        // The test premise: the placement is admitted as an external Shell.
        assertTrue(WorkspaceExecutionProfile.isExternalWorkspaceRequest(request),
                "The request must be an external Workspace");
        assertTrue(WorkspaceExecutionProfile.isExternalShellRequest(request),
                "The request must be an external Shell");
        // A Tool v3 Shell dispatch carries the publication grant and names
        // run_shell_command — the exact shape the files gate used to refuse.
        Map<String, Object> reference = Map.of("sessionId", "runtime", "promptId", "turn",
                "callId", "call", "argsDigest", "sha256:" + "a".repeat(64),
                "dispatchMode", "deferred_v3");
        when(fixture.prepared.getReference()).thenReturn(reference);
        Map<String, Object> payload = Map.of("toolName", "run_shell_command",
                "input", input);
        // The capture map the dispatcher derives from the grant's binding.
        var grant = new com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant(
                "pub-1", "token", "http://127.0.0.1:1",
                Map.of("sessionKey", Map.of("tenantId", "tenant", "sessionId", "runtime"),
                        "turnId", "turn", "executionCallId", "execution", "bindingGeneration", 1L),
                System.currentTimeMillis() + 60_000);
        // The Broker opens the worker's own capture channel for this lane; a
        // missing producer is refused before the dispatch, so the fixture must
        // answer one. The channel ID feeds the drain, which this not-started
        // settle never reaches.
        var producer = mock(com.alibaba.qwen.code.runtimebroker.spi.ExternalShellPublication.class);
        when(fixture.verifier.externalShell()).thenReturn(producer);
        when(producer.begin(eq(fixture.lease), eq(fixture.binding), eq(fixture.executing), eq(grant)))
                .thenReturn(CompletableFuture.completedFuture("shell-channel"));
        // The executing record carries the Shell dispatch's own reference;
        // settle synchronously so the dispatch never reaches result polling.
        when(fixture.executing.getReference()).thenReturn(reference);
        Map<String, Object> settled = Map.of("state", "settled",
                "result", Map.of("executionStatus", "not_started"));
        when(fixture.transport.executeV3(eq(fixture.lease), eq(fixture.session), eq(reference),
                eq(payload), any())).thenReturn(CompletableFuture.completedFuture(settled));

        try {
            fixture.dispatcher.beginDispatch(fixture.context, fixture.prepared, payload, grant);
            // The dispatch reached the transport, not the files-gate refusal.
            verify(fixture.transport).executeV3(eq(fixture.lease), eq(fixture.session), eq(reference),
                    eq(payload), any());
            // The synchronous settle completes the dispatch before
            // beginDispatch returns, so the outcome — not the membership —
            // is the assertion.
            verify(fixture.state).settleExecution(fixture.executing,
                    Map.of("executionStatus", "not_started"));
        } catch (RuntimeException failure) {
            throw new AssertionError("The files gate refused the Shell dispatch: "
                    + failure.getMessage(), failure);
        }
    }
}
