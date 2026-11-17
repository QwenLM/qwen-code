package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RuntimeExtensionMetadataControlTest {
    private static final Instant NOW = Instant.parse("2026-10-24T00:00:00Z");
    private static final String OPERATION = "550e8400-e29b-41d4-a716-446655440000";
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST, "session");
    private static final RuntimeScope SHARED_SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST, "workspace");
    private static final RuntimeScope FOREIGN_SCOPE = new RuntimeScope("tenant", "other-workspace", "1", "/workspace",
            ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST, "workspace");

    @Test
    void aStatusProbeDoesNotCreateAPlacementOrToolSession() {
        try (var fixture = new Fixture(false)) {
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("harness", null, null, status())).getCode());
            assertTrue(fixture.bindings.findByHarnessSession("tenant", "harness", null, 100).isEmpty());
            assertEquals(0, fixture.observations.get());
            assertEquals(0, fixture.controls.get());
        }
    }

    @Test
    void restoredStatusObservesOnlyTheOriginalLeaseWithoutAcquiringItsMount() {
        try (var fixture = new Fixture(true)) {
            var before = fixture.original;
            var result = fixture.broker.extensionControl("harness", null, null, status()).toCompletableFuture().join();
            assertEquals(Map.of("bindingId", before.getBindingId(), "generation", Long.toString(before.getGeneration())), result.get("runtime"));
            assertEquals(1, fixture.observations.get());
            assertEquals(1, fixture.attestations.get());
            assertEquals(1, fixture.controls.get());
            assertUnchanged(before, fixture.bindings.findById(before.getBindingId()));
            assertEquals(0, fixture.sessions.countActiveByBinding(before.getBindingId(), before.getGeneration()));
            fixture.observable = false;
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("harness",
                    before.getBindingId(), before.getGeneration(), status())).getCode());
            assertEquals(1, fixture.controls.get());
        }
    }

    @Test
    void originalIdentityAndRecoveryAdmissionCannotFallBackToAnotherOwner() {
        try (var fixture = new Fixture(true)) {
            var binding = fixture.original;
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("harness",
                    binding.getBindingId(), binding.getGeneration() + 1, status())).getCode());
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("another-harness",
                    binding.getBindingId(), binding.getGeneration(), status())).getCode());
            var reconcile = Map.<String, Object>of("kind", "extension-reconcile", "operationId", OPERATION, "expectedRevision", 0, "revision", 1);
            assertThrows(RuntimeBrokerException.class, () -> fixture.broker.extensionControl("harness", null, null, reconcile));
            var draining = fixture.bindings.compareAndSet(binding,
                    binding.withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), NOW).withDrainRequested(true, NOW));
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("harness",
                    binding.getBindingId(), binding.getGeneration(), Map.of("kind", "extension-activate", "operationId", OPERATION,
                            "expectedRevision", 0, "revision", 1))).getCode());
            fixture.broker.extensionControl("harness", binding.getBindingId(), binding.getGeneration(), reconcile).toCompletableFuture().join();
            assertUnchanged(draining, fixture.bindings.findById(binding.getBindingId()));
            assertEquals(1, fixture.controls.get());
        }
    }

    @Test
    void sharedWorkspaceStatusProbeResolvesTheReadyBinding() {
        try (var fixture = new Fixture(true, SHARED_SCOPE, sharedRequest())) {
            var before = fixture.original;
            var result = fixture.broker.extensionControl("harness", null, null, status()).toCompletableFuture().join();
            assertEquals(Map.of("bindingId", before.getBindingId(), "generation", Long.toString(before.getGeneration())), result.get("runtime"));
            assertEquals(1, fixture.controls.get());
            assertEquals(0, fixture.sessions.countActiveByBinding(before.getBindingId(), before.getGeneration()));
            assertUnchanged(before, fixture.bindings.findById(before.getBindingId()));
        }
    }

    @Test
    void sharedWorkspaceIdentityCarryingProbeKeepsTheOriginalOwner() {
        try (var fixture = new Fixture(true, SHARED_SCOPE, sharedRequest())) {
            var before = fixture.original;
            var result = fixture.broker.extensionControl("harness", before.getBindingId(), before.getGeneration(), status())
                    .toCompletableFuture().join();
            assertEquals(Map.of("bindingId", before.getBindingId(), "generation", Long.toString(before.getGeneration())), result.get("runtime"));
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("harness",
                    before.getBindingId(), before.getGeneration() + 1, status())).getCode());
        }
    }

    @Test
    void sharedWorkspaceProbeRefusesAForeignScope() {
        try (var fixture = new Fixture(true, SHARED_SCOPE, sharedRequest())) {
            fixture.scopeResolver = id -> "another-harness".equals(id) ? FOREIGN_SCOPE : SHARED_SCOPE;
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("another-harness",
                    null, null, status())).getCode());
            assertEquals(0, fixture.controls.get());
        }
    }

    @Test
    void sharedWorkspaceProbeRefusesADrainingBinding() {
        try (var fixture = new Fixture(true, SHARED_SCOPE, sharedRequest())) {
            var binding = fixture.original;
            fixture.bindings.compareAndSet(binding,
                    binding.withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), NOW).withDrainRequested(true, NOW));
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("harness",
                    null, null, status())).getCode());
            assertEquals(0, fixture.controls.get());
        }
    }

    @Test
    void sharedWorkspaceRecoveryReadObservesADrainingOriginal() {
        try (var fixture = new Fixture(true, SHARED_SCOPE, sharedRequest())) {
            var binding = fixture.original;
            fixture.bindings.compareAndSet(binding,
                    binding.withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), NOW).withDrainRequested(true, NOW));
            var result = fixture.broker.extensionControl("harness", binding.getBindingId(), binding.getGeneration(), status())
                    .toCompletableFuture().join();
            assertEquals(Map.of("bindingId", binding.getBindingId(), "generation", Long.toString(binding.getGeneration())), result.get("runtime"));
            assertEquals(1, fixture.controls.get());
        }
    }

    @Test
    void sharedWorkspaceMutationRefusesADrainingHarness() {
        try (var fixture = new Fixture(true, SHARED_SCOPE, sharedRequest())) {
            var binding = fixture.original;
            fixture.bindings.requestHarnessDrain("tenant", "harness");
            var refused = failure(fixture.broker.extensionControl("harness", binding.getBindingId(), binding.getGeneration(),
                    Map.of("kind", "extension-activate", "operationId", OPERATION, "expectedRevision", 0, "revision", 1)));
            assertEquals("runtime_admission_closed", refused.getCode(), refused.getMessage());
            assertEquals(0, fixture.controls.get());
        }
    }

    @Test
    void sharedWorkspaceStatusProbeWithoutABindingCreatesNothing() {
        try (var fixture = new Fixture(false, SHARED_SCOPE, sharedRequest())) {
            assertEquals("managed_extension_owner_unavailable", failure(fixture.broker.extensionControl("harness",
                    null, null, status())).getCode());
            assertNull(fixture.bindings.findActive(sharedRequest()));
            assertEquals(0, fixture.observations.get());
            assertEquals(0, fixture.controls.get());
        }
    }

    private static RuntimeProvisionRequest sharedRequest() {
        return new RuntimeProvisionRequest(SHARED_SCOPE, null, RuntimeProviderKinds.LOCAL_PROCESS, "storage-fixture");
    }

    private static Map<String, Object> status() {
        return Map.of("kind", "extension-status", "operationId", OPERATION);
    }

    private static RuntimeBrokerException failure(CompletionStage<?> result) {
        return (RuntimeBrokerException) assertThrows(CompletionException.class,
                () -> result.toCompletableFuture().join()).getCause();
    }

    /** A JDBC read deserializes a fresh record, so "unchanged" is value equality. */
    private static void assertUnchanged(RuntimeBindingRecord expected, RuntimeBindingRecord actual) {
        assertTrue(actual.sameIdentity(expected));
        assertEquals(expected.getVersion(), actual.getVersion());
        assertEquals(expected.getState(), actual.getState());
        assertEquals(expected.getAttestationGeneration(), actual.getAttestationGeneration());
        assertEquals(expected.isDrainRequested(), actual.isDrainRequested());
        assertEquals(expected.getResourceHandle(), actual.getResourceHandle());
        assertTrue(expected.hasSameLease(actual.getLease()));
        assertEquals(expected.getOperationOwner(), actual.getOperationOwner());
        assertEquals(expected.getOperationGeneration(), actual.getOperationGeneration());
    }

    private static final class Fixture implements AutoCloseable {
        private final JdbcRuntimeBindingRepository bindings;
        private final JdbcRuntimeSessionRepository sessions;
        private final AtomicInteger observations = new AtomicInteger();
        private final AtomicInteger attestations = new AtomicInteger();
        private final AtomicInteger controls = new AtomicInteger();
        private final RuntimeScope scope;
        private final RuntimeProvisionRequest placement;
        private final RuntimeBindingRecord original;
        private final RuntimeBrokerService broker;
        private Function<String, RuntimeScope> scopeResolver;
        private boolean observable = true;

        Fixture(boolean installed) {
            this(installed, SCOPE, new RuntimeProvisionRequest(SCOPE, "harness", "fixture"));
        }

        Fixture(boolean installed, RuntimeScope scope, RuntimeProvisionRequest placement) {
            this.scope = scope;
            this.placement = placement;
            this.scopeResolver = id -> scope;
            var source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:extension-metadata-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
            bindings = new JdbcRuntimeBindingRepository(source,
                    new AesGcmSecretProtector("test", new byte[32]), () -> "binding");
            sessions = new JdbcRuntimeSessionRepository(source);
            if (installed) {
                var candidate = bindings.findOrCreate(placement);
                candidate = bindings.claimOperation(candidate.getBindingId(), "original-broker", Duration.ofMinutes(1));
                var seed = candidate.getProvisionSeed();
                var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                        seed.getToken(), seed.getLeaseId(), seed.getEpoch());
                original = bindings.compareAndSet(candidate, candidate.withAttestation(lease,
                        new RuntimeResourceHandle(placement.getProvisionerKind(), 1, Map.of("worker", "original")), NOW, NOW));
            } else {
                original = null;
            }
            RuntimeProvisioner provisioner = new RuntimeProvisioner() {
                @Override
                public String kind() {
                    return placement.getProvisionerKind();
                }

                @Override
                public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey, String harnessSessionId) {
                    return new RuntimeProvisionRequest(scope, isolationKey, placement.getProvisionerKind(), placement.getStorageId());
                }

                @Override
                public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                    throw new AssertionError("Extension metadata must never provision a Runtime");
                }

                @Override
                public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                        RuntimeResourceHandle handle, RuntimeLease lease) {
                    observations.incrementAndGet();
                    assertEquals(original.getRequest(), request);
                    assertEquals(original.getResourceHandle(), handle);
                    assertTrue(original.hasSameLease(lease));
                    return CompletableFuture.completedFuture(observable ? RuntimeObservation.ready(handle, lease.getEndpoint(),
                            lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch()) : RuntimeObservation.unknown(handle));
                }
            };
            var transport = (RuntimeTransport) Proxy.newProxyInstance(RuntimeTransport.class.getClassLoader(), new Class<?>[] {RuntimeTransport.class},
                    (proxy, method, args) -> {
                        if ("attest".equals(method.getName())) {
                            attestations.incrementAndGet();
                            var lease = original.getLease();
                            var seed = original.getProvisionSeed();
                            return CompletableFuture.completedFuture(new RuntimeAttestation(lease.getRuntimeInstanceId(), seed.getGatewayIncarnation(),
                                    lease.getLeaseId(), lease.getEpoch(), scope, seed.getProvisionRequestId(), placement.getStorageId()));
                        }
                        if ("extensionControl".equals(method.getName())) {
                            controls.incrementAndGet();
                            assertEquals(original.getBindingId(), ((RuntimeBindingRecord) args[0]).getBindingId());
                            assertEquals("harness", args[1]);
                            return CompletableFuture.completedFuture(Map.of("state", "outcome_unknown"));
                        }
                        throw new AssertionError("Extension metadata must not acquire or execute a tool: " + method.getName());
                    });
            broker = new RuntimeBrokerService(id -> CompletableFuture.completedFuture(scopeResolver.apply(id)), provisioner, transport,
                    bindings, sessions, new JdbcToolExecutionRepository(source), "new-broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
        }

        @Override
        public void close() { broker.close(); }
    }
}
