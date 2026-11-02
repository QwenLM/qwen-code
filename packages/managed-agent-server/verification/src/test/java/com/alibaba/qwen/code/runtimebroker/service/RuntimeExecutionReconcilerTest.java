package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.ExecutionReconciliation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

class RuntimeExecutionReconcilerTest {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @Timeout(15)
    void anObserverDuringCooldownStampJoinsTheLookupInsteadOfCallingTheWorkerAgain(boolean failed) throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var closed = new AtomicBoolean();
        Clock clock = Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC);
        var cooldown = spy(new ExecutionObservationCooldown(clock, scheduler));
        doAnswer(call -> {
            entered.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS), "cooldown stamp was not released");
            return call.callRealMethod();
        }).when(cooldown).stamp(eq("execution"), any());

        var registry = mock(RuntimeBindingRegistry.class);
        var state = mock(RuntimeExecutionState.class);
        var executions = mock(ToolExecutionRepository.class);
        var provisioner = mock(RuntimeProvisioner.class);
        var transport = mock(RuntimeTransport.class);
        var unknown = mock(ToolExecutionRecord.class);
        var context = mock(SessionContext.class);
        var binding = mock(RuntimeBindingRecord.class);
        var session = mock(RuntimeSession.class);
        var lease = mock(RuntimeLease.class);
        when(unknown.getExecutionCallId()).thenReturn("execution");
        when(unknown.getState()).thenReturn(ToolExecutionRecord.State.UNKNOWN);
        when(unknown.getBindingId()).thenReturn("binding");
        when(unknown.getRuntimeGeneration()).thenReturn(7L);
        when(unknown.getReference()).thenReturn(Map.of("callId", "call"));
        when(state.requireOwnedExecution("harness", "runtime", "execution")).thenReturn(unknown);
        when(executions.findByExecutionCallId("execution")).thenReturn(unknown);
        when(registry.session("runtime")).thenReturn(CompletableFuture.completedFuture(context));
        when(registry.hasBinding("binding")).thenReturn(true);
        when(context.session()).thenReturn(session);
        when(context.binding()).thenReturn(binding);
        when(context.lease()).thenReturn(lease);
        when(session.getHarnessSessionId()).thenReturn("harness");
        when(binding.getBindingId()).thenReturn("binding");
        when(binding.getGeneration()).thenReturn(7L);
        when(provisioner.isUsable(lease)).thenReturn(true);
        var answer = new CompletableFuture<Map<String, Object>>();
        var lookups = new AtomicInteger();
        when(transport.status(eq(lease), eq(session), any(), eq(0L))).thenAnswer(call -> {
            lookups.incrementAndGet();
            return answer;
        });
        var reconciler = new RuntimeExecutionReconciler(registry, state, executions, provisioner, transport,
                null, Duration.ofSeconds(10), clock, closed, cooldown);
        Thread completer = null;
        try {
            var first = reconciler.observeExecution("harness", "runtime", "execution").toCompletableFuture();
            completer = Thread.ofPlatform().start(() -> {
                if (failed) {
                    answer.completeExceptionally(new IllegalStateException("worker unavailable"));
                } else {
                    answer.complete(Map.of("state", "executing"));
                }
            });
            assertTrue(entered.await(5, TimeUnit.SECONDS), "lookup never reached cooldown stamp");
            var submitted = CompletableFuture.supplyAsync(() -> reconciler.observeExecution(
                    "harness", "runtime", "execution").toCompletableFuture());
            var joined = submitted.get(1, TimeUnit.SECONDS);
            assertEquals(1, lookups.get(), "a caller escaped between reservation removal and cooldown stamp");
            assertFalse(joined.isDone());
            release.countDown();
            completer.join(2000);
            assertFalse(completer.isAlive());
            if (failed) {
                assertThrows(CompletionException.class, first::join);
                assertThrows(CompletionException.class, joined::join);
            } else {
                assertEquals("executing", first.get(2, TimeUnit.SECONDS).getRuntimeState());
                assertEquals("executing", joined.get(2, TimeUnit.SECONDS).getRuntimeState());
            }
            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    reconciler.observeExecution("harness", "runtime", "execution").toCompletableFuture()
                            .get(2, TimeUnit.SECONDS).getOutcome());
            assertEquals(1, lookups.get(), "a sequential observer missed the completed cooldown");
        } finally {
            release.countDown();
            closed.set(true);
            reconciler.cancelPendingOperations();
            scheduler.shutdownNow();
            if (completer != null) {
                completer.join(2000);
            }
        }
    }
}
