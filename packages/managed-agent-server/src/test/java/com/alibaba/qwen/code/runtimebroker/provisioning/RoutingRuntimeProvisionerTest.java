package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RoutingRuntimeProvisionerTest {
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace/project",
            WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");

    @Test
    void selectsRealKindsAndNeverFallsBackWhenASelectorOrSavedKindIsUnknown() {
        var local = new Provider("local-process", false);
        var ssh = new Provider("ssh-process", true);
        try (var router = new RoutingRuntimeProvisioner(Map.of(local.kind(), local, ssh.kind(), ssh),
                scope -> scope.getWorkspaceId().equals("remote") ? ssh.kind() : local.kind())) {
            assertEquals(local.kind(), router.createRequest(SCOPE, "harness").getProvisionerKind());
            assertEquals(ssh.kind(), router.createRequest(new RuntimeScope("tenant", "remote", "1",
                    "/workspace/project", SCOPE.getCapabilityDigest(), "session"), "harness").getProvisionerKind());
            assertTrue(router.supportsKind(ssh.kind()));
            assertFalse(router.supportsKind("routing"));
            assertThrows(RuntimeBrokerException.class, () -> router.provision(
                    new RuntimeProvisionRequest(SCOPE, "harness", "unknown")));
            assertEquals(0, local.starts);
            assertEquals(0, ssh.starts);
        }
        try (var router = new RoutingRuntimeProvisioner(Map.of(local.kind(), local), scope -> "ssh-process")) {
            assertThrows(RuntimeBrokerException.class, () -> router.createRequest(SCOPE, "harness"));
        }
    }

    @Test
    void routesRecoveryAndDrainCapabilitiesForTheSavedProvider() throws Exception {
        var local = new Provider("local-process", false);
        var ssh = new Provider("ssh-process", true);
        try (var router = new RoutingRuntimeProvisioner(Map.of(local.kind(), local, ssh.kind(), ssh), scope -> ssh.kind())) {
            var request = router.createRequest(SCOPE, "harness");
            var binding = new InMemoryRuntimeBindingRepository().findOrCreate(request);
            assertFalse(router.supportsDrainedStop(), "one provider cannot enable another provider's global gate");
            assertTrue(router.supportsDrainedStop(binding));
            assertTrue(router.supportsStartupRecovery(new RuntimeResourceHandle(ssh.kind(), 1, Map.of())));
            assertFalse(router.supportsStartupRecovery(new RuntimeResourceHandle(local.kind(), 1, Map.of())));
            assertThrows(RuntimeBrokerException.class, () -> router.ensureResource(request,
                    RuntimeProvisionSeed.create("binding", 1), new RuntimeResourceHandle(local.kind(), 1, Map.of())));
            assertEquals(0, local.observations);
            var seed = RuntimeProvisionSeed.create("binding", 1);
            var lease = await(router.provision(request, seed));
            assertEquals(1, ssh.starts);
            assertTrue(router.isUsable(lease));
            await(router.release(request, lease));
            assertTrue(router.isUsable(lease), "a durable discard cannot invalidate a winning observer");
            await(router.reconcile(request, seed, new RuntimeResourceHandle(ssh.kind(), 1, Map.of()), lease));
            assertEquals(1, ssh.observations);
        }
    }

    @Test
    void releaseForgetsOnlyADelegateThatHasActuallyStopped() throws Exception {
        for (boolean durable : List.of(false, true)) {
            var provider = new Provider(durable ? "ssh-process" : "local-process", durable);
            var released = new ArrayList<RuntimeLease>();
            try (var router = new RoutingRuntimeProvisioner(Map.of(provider.kind(), provider), scope -> provider.kind(),
                    (kind, lease) -> {}, released::add)) {
                var request = router.createRequest(SCOPE, "harness");
                var lease = await(router.provision(request));
                await(router.release(request, lease));
                assertEquals(durable, router.isUsable(lease));
                assertEquals(durable ? List.of() : List.of(lease), released);
            }
        }
    }

    @Test
    void retirementForgetsRoutingOnlyAfterAMatchingStopReceipt() throws Exception {
        var provider = new Provider("local-process", true);
        var released = new ArrayList<RuntimeLease>();
        try (var router = new RoutingRuntimeProvisioner(Map.of(provider.kind(), provider), scope -> provider.kind(),
                (kind, lease) -> {}, released::add)) {
            var request = router.createRequest(SCOPE, "harness");
            var bindings = new InMemoryRuntimeBindingRepository();
            var binding = bindings.findOrCreate(request);
            var claim = bindings.claimOperation(binding.getBindingId(), "owner", Duration.ofMinutes(1));
            var lease = await(router.provision(request, claim.getProvisionSeed()));
            var ready = claim.withAttestation(lease, new RuntimeResourceHandle(provider.kind(), 1, Map.of()),
                    Instant.now(), Instant.now());
            var draining = ready.withDrainRequested(true, Instant.now())
                    .withState(RuntimeBindingRecord.State.DRAINING, lease, Instant.now());
            provider.badProof = true;
            assertFalse(await(router.stopDrained(draining)).matches(draining));
            assertTrue(router.isUsable(lease));
            assertTrue(released.isEmpty());
            provider.badProof = false;
            assertTrue(await(router.stopDrained(draining)).matches(draining));
            assertFalse(router.isUsable(lease));
            assertEquals(List.of(lease), released);
        }
    }

    @Test
    void brokerAdoptsThroughRouterUsingTheSavedKindInsteadOfTheRouterName() throws Exception {
        var provider = new Provider("ssh-process", true);
        var bindings = new InMemoryRuntimeBindingRepository();
        var request = provider.createRequest(SCOPE, "harness");
        var initial = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(initial.getBindingId(), "setup", Duration.ofSeconds(30));
        var seed = claimed.getProvisionSeed();
        var handle = new RuntimeResourceHandle(provider.kind(), 1, Map.of());
        var lease = await(provider.provision(request, seed));
        bindings.compareAndSet(claimed, claimed.withAttestation(lease, handle, Instant.now(), Instant.now()));
        bindings.releaseOperation(initial.getBindingId(), "setup", claimed.getOperationGeneration());
        RuntimeTransport transport = new RuntimeTransport() {
            @Override
            public CompletionStage<RuntimeAttestation> attest(RuntimeLease observed, RuntimeProvisionRequest saved,
                    RuntimeProvisionSeed savedSeed) {
                return CompletableFuture.completedFuture(new RuntimeAttestation(savedSeed.getProvisionalRuntimeId(),
                        savedSeed.getGatewayIncarnation(), savedSeed.getLeaseId(), savedSeed.getEpoch(), saved.getScope(),
                        savedSeed.getProvisionRequestId()));
            }

            @Override
            public CompletionStage<Void> acquire(RuntimeLease observed, RuntimeSession session) {
                throw new AssertionError("Recovery must not acquire a Session");
            }

            @Override
            public CompletionStage<Object> control(RuntimeLease observed, RuntimeSession session,
                    Map<String, Object> operation) {
                throw new AssertionError("Recovery must not send controls");
            }

            @Override
            public CompletionStage<Map<String, Object>> execute(RuntimeLease observed, RuntimeSession session,
                    Map<String, Object> reference) {
                throw new AssertionError("Recovery must not execute tools");
            }

            @Override
            public CompletionStage<Map<String, Object>> cancel(RuntimeLease observed, RuntimeSession session,
                    Map<String, Object> reference) {
                throw new AssertionError("Recovery must not cancel tools");
            }

            @Override
            public CompletionStage<Boolean> release(RuntimeLease observed, RuntimeSession session) {
                throw new AssertionError("Recovery must not release a Session");
            }
        };
        try (var router = new RoutingRuntimeProvisioner(Map.of(provider.kind(), provider), ignored -> provider.kind());
                var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(SCOPE), router, transport,
                        bindings, new InMemoryRuntimeSessionRepository(), new InMemoryToolExecutionRepository(),
                        "restored", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            var restored = await(service.recoverBinding(initial.getBindingId(), initial.getGeneration()));
            assertEquals(RuntimeBindingRecord.State.READY, restored.getState());
            assertEquals(1, provider.observations);
            assertEquals(1, provider.starts, "recovery observes the original resource instead of provisioning");
        }
    }

    private static <T> T await(CompletionStage<T> stage) throws Exception {
        return stage.toCompletableFuture().get(5, TimeUnit.SECONDS);
    }

    private static final class Provider implements RuntimeProvisioner {
        private final String kind;
        private final boolean durable;
        private int starts;
        private int observations;
        private boolean live = true;
        private boolean badProof;

        private Provider(String kind, boolean durable) {
            this.kind = kind;
            this.durable = durable;
        }

        @Override
        public String kind() {
            return kind;
        }

        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            return provision(request, RuntimeProvisionSeed.create("binding", 1));
        }

        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            starts++;
            return CompletableFuture.completedFuture(new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:40000"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()));
        }

        @Override
        public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle handle, RuntimeLease lease) {
            observations++;
            return CompletableFuture.completedFuture(RuntimeObservation.ready(handle, lease.getEndpoint(),
                    lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch()));
        }

        @Override
        public boolean supportsDrainedStop() {
            return durable;
        }

        @Override
        public boolean isUsable(RuntimeLease lease) {
            return live;
        }

        @Override
        public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
            if (!durable) live = false;
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
            if (!badProof) live = false;
            return CompletableFuture.completedFuture(new RuntimeDrainReceipt(
                    badProof ? "wrong-binding" : binding.getBindingId(), binding.getGeneration(),
                    binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now()));
        }

        @Override
        public boolean supportsStartupRecovery(RuntimeResourceHandle handle) {
            return durable && handle != null && kind.equals(handle.getKind());
        }
    }
}
