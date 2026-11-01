package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RuntimeBrokerStorageAdmissionTest {
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");

    @Test
    void preCreateBusyPreservesTheOriginalIdentityAcrossRetriesAndBrokerRestart() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var provisioner = new AdmissionProvisioner();
        provisioner.admit = binding -> {
            throw busy();
        };
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        for (int round = 0; round < 2; round++) {
            try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
                for (int retry = 0; retry < 2; retry++) {
                    assertEquals("workspace_csi_busy", failure(broker.warm("harness")).getCode());
                    var current = bindings.findById(original.getBindingId());
                    assertEquals(RuntimeBindingRecord.State.PROVISIONING, current.getState());
                    assertEquals(original.getGeneration(), current.getGeneration());
                    assertEquals(original.getProvisionSeed(), current.getProvisionSeed());
                    assertNull(current.getOperationOwner());
                    assertNull(current.getResourceHandle());
                }
            }
        }
        assertEquals(0, provisioner.ensureCalls);
        provisioner.admit = binding -> { };
        try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
            assertEquals("workspace_csi_provenance_unavailable", failure(broker.warm("harness")).getCode());
        }
        assertEquals(1, provisioner.ensureCalls);
        assertEquals(original.getProvisionSeed(), provisioner.createdWith);
    }

    @ParameterizedTest
    @CsvSource({
            "kubernetes-scratch, runtime_kubernetes_capacity",
            "external-scratch, runtime_external_capacity"
    })
    void scratchCapacityPreservesTheOriginalSeedAcrossPreCreateRetries(String kind, String code) {
        var bindings = new InMemoryRuntimeBindingRepository();
        var provisioner = new AdmissionProvisioner();
        provisioner.provisionerKind = kind;
        provisioner.admit = binding -> {
            throw new RuntimeBrokerException(503, code, "Capacity exhausted.", true);
        };
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        for (int round = 0; round < 2; round++) {
            try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
                assertEquals(code, failure(broker.warm("harness")).getCode());
                var current = bindings.findById(original.getBindingId());
                assertEquals(RuntimeBindingRecord.State.PROVISIONING, current.getState());
                assertEquals(original.getProvisionSeed(), current.getProvisionSeed());
                assertEquals(original.getGeneration(), current.getGeneration());
                assertNull(current.getResourceHandle());
                assertNull(current.getOperationOwner());
            }
        }
        assertEquals(0, provisioner.ensureCalls);
        provisioner.admit = binding -> { };
        try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
            assertEquals("workspace_csi_provenance_unavailable", failure(broker.warm("harness")).getCode());
        }
        assertEquals(1, provisioner.ensureCalls);
        assertEquals(original.getProvisionSeed(), provisioner.createdWith);
    }

    @Test
    void preCreateUnavailablePreservesTheOriginalSeedAcrossRetriesAndBrokerRestart() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var provisioner = new AdmissionProvisioner();
        provisioner.provisionerKind = "external-scratch";
        provisioner.admit = binding -> {
            throw new RuntimeBrokerException(503, "runtime_external_unavailable",
                    "External Runtime provider is unavailable.", true);
        };
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        for (int round = 0; round < 2; round++) {
            try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
                assertEquals("runtime_external_unavailable", failure(broker.warm("harness")).getCode());
                var current = bindings.findById(original.getBindingId());
                assertEquals(RuntimeBindingRecord.State.PROVISIONING, current.getState());
                assertEquals(original.getProvisionSeed(), current.getProvisionSeed());
                assertEquals(original.getGeneration(), current.getGeneration());
                assertNull(current.getResourceHandle());
                assertNull(current.getOperationOwner());
            }
        }
        assertEquals(0, provisioner.ensureCalls);
        provisioner.admit = binding -> { };
        try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
            assertEquals("workspace_csi_provenance_unavailable", failure(broker.warm("harness")).getCode());
        }
        assertEquals(1, provisioner.ensureCalls);
        assertEquals(original.getProvisionSeed(), provisioner.createdWith);
    }

    @Test
    void externalUnavailableAfterEnteringEnsurePreservesTheOriginalSeedAcrossBrokerRounds() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var provisioner = new AdmissionProvisioner();
        provisioner.provisionerKind = "external-scratch";
        provisioner.ensureFailure = new RuntimeBrokerException(503, "runtime_external_unavailable",
                "External Runtime provider is unavailable.", true);
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        for (int round = 0; round < 2; round++) {
            try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
                assertEquals("runtime_external_unavailable", failure(broker.warm("harness")).getCode());
                var current = bindings.findById(original.getBindingId());
                assertEquals(RuntimeBindingRecord.State.PROVISIONING, current.getState());
                assertEquals(original.getProvisionSeed(), current.getProvisionSeed());
                assertEquals(original.getGeneration(), current.getGeneration());
                assertNull(current.getResourceHandle());
                assertNull(current.getOperationOwner());
            }
        }
        assertEquals(2, provisioner.ensureCalls);
        provisioner.ensureFailure = new RuntimeBrokerException(409,
                "workspace_csi_provenance_unavailable", "Provenance unavailable.", false);
        try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
            assertEquals("workspace_csi_provenance_unavailable", failure(broker.warm("harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findById(original.getBindingId()).getState());
        }
        assertEquals(3, provisioner.ensureCalls);
        assertEquals(original.getProvisionSeed(), provisioner.createdWith);
    }

    @ParameterizedTest
    @CsvSource({
            "runtime_external_unavailable",
            "runtime_external_capacity"
    })
    void externalRetryableReserveWithPersistedHandleRemainsAdoptableAcrossBrokerRounds(String code) {
        var bindings = new InMemoryRuntimeBindingRepository();
        var provisioner = new AdmissionProvisioner();
        provisioner.provisionerKind = "external-scratch";
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        var handle = new RuntimeResourceHandle("external-scratch", 1, Map.of("providerId", "provider-a"));
        var claimed = bindings.claimOperation(original.getBindingId(), "broker", Duration.ofMinutes(1));
        var withHandle = bindings.compareAndSet(claimed, claimed.withResourceHandle(handle, Instant.now()));
        assertEquals(original.getProvisionSeed(), withHandle.getProvisionSeed());
        assertEquals(handle, bindings.releaseOperation(original.getBindingId(), "broker",
                withHandle.getOperationGeneration()).getResourceHandle());
        provisioner.admit = binding -> {
            throw new RuntimeBrokerException(503, code, "External Runtime provider is unavailable.", true);
        };
        for (int round = 0; round < 2; round++) {
            try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
                assertEquals(code, failure(broker.warm("harness")).getCode());
                var current = bindings.findById(original.getBindingId());
                assertEquals(RuntimeBindingRecord.State.PROVISIONING, current.getState());
                assertEquals(handle, current.getResourceHandle());
                assertEquals(original.getProvisionSeed(), current.getProvisionSeed());
                assertEquals(original.getGeneration(), current.getGeneration());
                assertNull(current.getOperationOwner());
            }
        }
        assertEquals(0, provisioner.ensureCalls);
        provisioner.admit = binding -> { };
        try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
            assertEquals("workspace_csi_provenance_unavailable", failure(broker.warm("harness")).getCode());
        }
        assertEquals(1, provisioner.ensureCalls);
        assertEquals(original.getProvisionSeed(), provisioner.createdWith);
    }

    // External-scratch has its own row above: a retryable ensure failure with
    // no persisted handle leaves that kind adoptable instead of blocked.
    @ParameterizedTest
    @CsvSource({
            "kubernetes-scratch, runtime_kubernetes_capacity"
    })
    void scratchCapacityAfterEnteringEnsureRemainsRecoveryBlocked(String kind, String code) {
        var bindings = new InMemoryRuntimeBindingRepository();
        var provisioner = new AdmissionProvisioner();
        provisioner.provisionerKind = kind;
        provisioner.ensureFailure = new RuntimeBrokerException(503, code, "Capacity exhausted.", true);
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
            assertEquals(code, failure(broker.warm("harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findById(original.getBindingId()).getState());
            assertEquals("runtime_broker_recovery_blocked", failure(broker.warm("harness")).getCode());
        }
        assertEquals(1, provisioner.ensureCalls);
    }

    @Test
    void busyAfterEnteringEnsureDoesNotReceiveThePreCreateRetryException() {
        var bindings = new InMemoryRuntimeBindingRepository();
        var provisioner = new AdmissionProvisioner();
        provisioner.ensureFailure = busy();
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        try (var broker = broker(provisioner, bindings, Clock.systemUTC(), Duration.ofSeconds(30))) {
            assertEquals("runtime_broker_recovery_blocked", failure(broker.warm("harness")).getCode());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findById(original.getBindingId()).getState());
            assertEquals("runtime_broker_recovery_blocked", failure(broker.warm("harness")).getCode());
        }
        assertEquals(1, provisioner.ensureCalls);
    }

    @Test
    void admissionDoesNotCompeteWithRenewalAndExpiredAdmissionCreatesNothing() {
        var clock = new TestClock();
        var bindings = new InMemoryRuntimeBindingRepository(clock, () -> "binding");
        var provisioner = new AdmissionProvisioner();
        provisioner.admit = claimed -> {
            try {
                Thread.sleep(200);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
            }
            assertEquals(claimed.getVersion(), bindings.findById(claimed.getBindingId()).getVersion());
            clock.now = clock.now.plusSeconds(1);
        };
        var original = bindings.findOrCreate(provisioner.createRequest(SCOPE, "harness"));
        try (var broker = broker(provisioner, bindings, clock, Duration.ofMillis(150))) {
            assertEquals("runtime_provision_fenced", failure(broker.warm("harness")).getCode());
        }
        assertEquals(0, provisioner.ensureCalls);
        assertEquals(original.getProvisionSeed(), bindings.findById(original.getBindingId()).getProvisionSeed());
        assertEquals(RuntimeBindingRecord.State.PROVISIONING, bindings.findById(original.getBindingId()).getState());
    }

    private static RuntimeBrokerService broker(RuntimeProvisioner provisioner,
            InMemoryRuntimeBindingRepository bindings, Clock clock, Duration duration) {
        return com.alibaba.qwen.code.runtimebroker.service.BrokerServiceTestAccess.create(ignored -> CompletableFuture.completedFuture(SCOPE), provisioner,
                new HttpRuntimeTransport(), bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "coordinator", duration, Duration.ofSeconds(30),
                clock, () -> "execution");
    }

    private static RuntimeBrokerException failure(CompletionStage<?> stage) {
        return (RuntimeBrokerException) assertThrows(CompletionException.class,
                () -> stage.toCompletableFuture().join()).getCause();
    }

    private static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_csi_busy", "Storage is reserved.", true);
    }

    private static final class AdmissionProvisioner implements RuntimeProvisioner {
        private String provisionerKind = "kubernetes-workspace";
        private Consumer<RuntimeBindingRecord> admit = binding -> { };
        private int ensureCalls;
        private RuntimeProvisionSeed createdWith;
        private RuntimeBrokerException ensureFailure = new RuntimeBrokerException(409,
                "workspace_csi_provenance_unavailable", "Provenance unavailable.", false);

        @Override
        public String kind() {
            return provisionerKind;
        }

        @Override
        public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
            return new RuntimeProvisionRequest(scope, isolationKey, kind(),
                    "kubernetes-workspace".equals(kind()) ? "storage" : null);
        }

        @Override
        public void reserveResource(RuntimeBindingRecord binding) {
            admit.accept(binding);
        }

        @Override
        public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
            ensureCalls++;
            createdWith = seed;
            return CompletableFuture.failedFuture(ensureFailure);
        }

        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            throw new AssertionError("Admission must not start a worker");
        }
    }

    private static final class TestClock extends Clock {
        private Instant now = Instant.parse("2026-10-01T00:00:00Z");

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
