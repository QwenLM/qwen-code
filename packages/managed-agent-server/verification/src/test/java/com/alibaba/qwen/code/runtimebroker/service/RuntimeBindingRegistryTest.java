package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.BindingContext;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class RuntimeBindingRegistryTest {
    private static final Instant NOW = Instant.parse("2026-10-31T00:00:00Z");
    private static final Duration LEASE_DURATION = Duration.ofSeconds(30);
    private static final RuntimeProvisionRequest REQUEST = new RuntimeProvisionRequest(
            new RuntimeScope("tenant", "workspace", "generation", "/cwd", "digest", "session"), "harness");
    private static final RuntimeLease LEASE = new RuntimeLease("runtime", URI.create("http://127.0.0.1:1"),
            "token", "lease", 1);

    private final RuntimeBindingRepository bindings = mock(RuntimeBindingRepository.class);
    private final RuntimeProvisioner provisioner = mock(RuntimeProvisioner.class);
    private final RuntimeBindingRegistry registry = new RuntimeBindingRegistry(bindings, provisioner,
            mock(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class),
            mock(com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver.class), "broker", LEASE_DURATION, Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    void routingRequiresTheExactLocallyAttestedGenerationAndLease() {
        RuntimeBindingRecord original = binding(7, RuntimeBindingRecord.State.READY, LEASE);
        assertNull(registry.matchingLiveBinding(original));
        registry.registerBinding(original, LEASE);
        assertSame(LEASE, registry.requireLiveBinding(original).lease());
        for (RuntimeLease changed : List.of(
                new RuntimeLease("other", LEASE.getEndpoint(), "token", "lease", 1),
                new RuntimeLease("runtime", URI.create("http://127.0.0.1:2"), "token", "lease", 1),
                new RuntimeLease("runtime", LEASE.getEndpoint(), "other", "lease", 1),
                new RuntimeLease("runtime", LEASE.getEndpoint(), "token", "other", 1),
                new RuntimeLease("runtime", LEASE.getEndpoint(), "token", "lease", 2))) {
            RuntimeBrokerException failure = assertThrows(RuntimeBrokerException.class,
                    () -> registry.requireLiveBinding(binding(7, RuntimeBindingRecord.State.READY, changed)));
            assertEquals("runtime_reconciliation_required", failure.getCode());
            assertTrue(failure.isRetryable());
        }
        assertFalse(registry.isLiveBinding(binding(8, RuntimeBindingRecord.State.READY, LEASE)));
        assertFalse(registry.isLiveBinding(binding(7, RuntimeBindingRecord.State.READY, null)));
        registry.registerBinding(binding(8, RuntimeBindingRecord.State.READY, LEASE), LEASE);
        assertFalse(registry.isLiveBinding(original));
        verifyNoInteractions(bindings, provisioner);
    }

    @Test
    void executionEligibilityUsesTheOriginalPersistedGeneration() {
        ToolExecutionRecord execution = mock(ToolExecutionRecord.class);
        when(execution.getBindingId()).thenReturn("binding");
        when(execution.getRuntimeGeneration()).thenReturn(7L);
        for (RuntimeBindingRecord.State state : RuntimeBindingRecord.State.values()) {
            when(bindings.findById("binding")).thenReturn(binding(7, state, LEASE));
            if (state == RuntimeBindingRecord.State.READY || state == RuntimeBindingRecord.State.DRAINING) {
                assertDoesNotThrow(() -> registry.requireAnswerableBinding(execution));
            } else {
                assertEvidenceUnavailable(execution);
            }
        }
        when(bindings.findById("binding")).thenReturn(binding(8, RuntimeBindingRecord.State.READY, LEASE));
        assertEvidenceUnavailable(execution);
        when(bindings.findById("binding")).thenReturn(null);
        assertEvidenceUnavailable(execution);
        verifyNoInteractions(provisioner);
    }

    @Test
    void invalidationRevokesTheRouteBeforeClaimingAndReleasesItsExactClaimAfterAWriteFailure() {
        RuntimeBindingRecord original = binding(7, RuntimeBindingRecord.State.READY, LEASE);
        registry.registerBinding(original, LEASE);
        when(bindings.claimOperation("binding", "broker", LEASE_DURATION)).thenAnswer(call -> {
            assertFalse(registry.hasBinding("binding"));
            return original;
        });
        IllegalStateException outage = new IllegalStateException("repository unavailable");
        when(bindings.compareAndSet(eq(original), any())).thenAnswer(call -> {
            RuntimeBindingRecord lost = call.getArgument(1);
            assertEquals(RuntimeBindingRecord.State.LOST, lost.getState());
            assertEquals(original.getGeneration(), lost.getGeneration());
            assertSame(LEASE, lost.getLease());
            throw outage;
        });
        assertSame(outage, assertThrows(IllegalStateException.class, () -> registry.invalidateBinding(original)));
        assertFalse(registry.hasBinding("binding"));
        var order = inOrder(bindings);
        order.verify(bindings).claimOperation("binding", "broker", LEASE_DURATION);
        order.verify(bindings).compareAndSet(eq(original), any());
        order.verify(bindings).releaseOperation("binding", "broker", original.getOperationGeneration());
        order.verifyNoMoreInteractions();
        verifyNoInteractions(provisioner);
    }

    @Test
    void aLostClaimStillRevokesTheLocalRouteWithoutReleasingOtherResources() {
        RuntimeBindingRecord original = binding(7, RuntimeBindingRecord.State.READY, LEASE);
        registry.registerBinding(original, LEASE);
        registry.invalidateBinding(original);
        assertFalse(registry.hasBinding("binding"));
        var order = inOrder(bindings);
        order.verify(bindings).claimOperation("binding", "broker", LEASE_DURATION);
        order.verifyNoMoreInteractions();
        verifyNoInteractions(provisioner);
    }

    @Test
    void lateOperationCleanupCannotRemoveReplacementReservations() {
        var firstBinding = new CompletableFuture<BindingContext>();
        var nextBinding = new CompletableFuture<BindingContext>();
        assertNull(registry.reserveBinding("binding", firstBinding));
        assertSame(firstBinding, registry.reserveBinding("binding", nextBinding));
        registry.finishBindingOperation("binding", firstBinding);
        assertNull(registry.reserveBinding("binding", nextBinding));
        registry.finishBindingOperation("binding", firstBinding);
        assertSame(nextBinding, registry.bindingOperation("binding"));

        var firstSession = new CompletableFuture<SessionContext>();
        var nextSession = new CompletableFuture<SessionContext>();
        assertNull(registry.registerSession("session", firstSession));
        assertSame(firstSession, registry.registerSession("session", nextSession));
        registry.removeSession("session", firstSession);
        assertNull(registry.registerSession("session", nextSession));
        registry.removeSession("session", firstSession);
        assertSame(nextSession, registry.session("session"));

        registry.cancelPendingOperations();
        assertTrue(nextBinding.isCancelled());
        assertTrue(nextSession.isCancelled());
        assertFalse(firstBinding.isCancelled());
        assertFalse(firstSession.isCancelled());
        verifyNoInteractions(bindings, provisioner);
    }

    private void assertEvidenceUnavailable(ToolExecutionRecord execution) {
        RuntimeBrokerException failure = assertThrows(RuntimeBrokerException.class,
                () -> registry.requireAnswerableBinding(execution));
        assertEquals("runtime_execution_evidence_unavailable", failure.getCode());
        assertEquals(409, failure.getStatusCode());
        assertFalse(failure.isRetryable());
    }

    private static RuntimeBindingRecord binding(long generation, RuntimeBindingRecord.State state, RuntimeLease lease) {
        return new RuntimeBindingRecord("binding", REQUEST, generation, state, lease,
                false, "broker", NOW.plus(LEASE_DURATION), 9, 1, NOW, NOW);
    }
}
