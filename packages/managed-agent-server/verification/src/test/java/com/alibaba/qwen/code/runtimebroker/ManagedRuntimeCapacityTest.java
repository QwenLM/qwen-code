package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocol;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocolTest;
import com.alibaba.qwen.code.runtimebroker.provisioning.local.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedRuntimeCapacityTest {
    private static final RuntimeProvisionRequest REQUEST = ManagedContextProtocolTest.request();

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void capacityRefusalRetriesTheSameBindingAndSeed(int handleVersion) throws Exception {
        RuntimeResourceHandle handle = localResourceHandle(handleVersion);
        AtomicReference<RuntimeProvisionSeed> attestedSeed = new AtomicReference<>();
        List<RuntimeProvisionSeed> attemptedSeeds = new ArrayList<>();
        List<RuntimeResourceHandle> knownHandles = new ArrayList<>();
        HttpServer worker = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        worker.createContext(ManagedContextProtocol.ATTEST_PATH, exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] proof = JsonCodec.encode(ManagedContextProtocol.attestationResponse(
                    ManagedContextProtocol.boot(REQUEST, attestedSeed.get())));
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, proof.length);
            exchange.getResponseBody().write(proof);
            exchange.close();
        });
        worker.start();
        RuntimeProvisioner provisioner = new RuntimeProvisioner() {
            @Override
            public String kind() {
                return "routing";
            }

            @Override
            public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
                return REQUEST;
            }

            @Override
            public boolean supportsStartupRecovery(RuntimeResourceHandle saved) {
                return saved != null && saved.getVersion() == 2;
            }

            @Override
            public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
                knownHandles.add(knownHandle);
                return CompletableFuture.completedFuture(handle);
            }

            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                throw new AssertionError("durable provisioning must carry the original seed");
            }

            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
                attemptedSeeds.add(seed);
                if (attemptedSeeds.size() == 1) {
                    return CompletableFuture.failedFuture(new RuntimeBrokerException(
                            503, "runtime_local_capacity", "startup capacity exhausted", true,
                            new RejectedExecutionException()));
                }
                attestedSeed.set(seed);
                return CompletableFuture.completedFuture(new RuntimeLease(seed.getProvisionalRuntimeId(),
                        URI.create("http://127.0.0.1:" + worker.getAddress().getPort()), seed.getToken(),
                        seed.getLeaseId(), seed.getEpoch()));
            }
        };
        var bindings = new InMemoryRuntimeBindingRepository();
        try (var service = service(bindings, provisioner)) {
            RuntimeBrokerException refusal = failure(service.warm("harness"));
            assertEquals("runtime_local_capacity", refusal.getCode());
            assertEquals(503, refusal.getStatusCode());
            assertTrue(refusal.isRetryable());
            RuntimeBindingRecord waiting = bindings.findActive(REQUEST);
            assertEquals(RuntimeBindingRecord.State.PROVISIONING, waiting.getState());
            assertNull(waiting.getOperationOwner());
            assertEquals(handleVersion == 1 ? null : handle, waiting.getResourceHandle());

            RuntimeBindingRecord ready = service.warm("harness").toCompletableFuture().get(5, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY, ready.getState());
            assertEquals(waiting.getBindingId(), ready.getBindingId());
            assertEquals(waiting.getProvisionSeed(), ready.getProvisionSeed());
            assertEquals(handle, ready.getResourceHandle());
            assertEquals(List.of(waiting.getProvisionSeed(), waiting.getProvisionSeed()), attemptedSeeds);
            assertNull(knownHandles.getFirst());
            assertEquals(handleVersion == 1 ? null : handle, knownHandles.get(1));
        } finally {
            worker.stop(0);
        }
    }

    @ParameterizedTest
    @CsvSource({
            "local-process,503,runtime_provision_failed,true,true",
            "local-process,409,runtime_local_capacity,true,true",
            "local-process,503,runtime_local_capacity,false,true",
            "custom,503,runtime_local_capacity,true,true",
            "local-process,503,runtime_local_capacity,true,false"
    })
    void otherStartupFailuresStillBlockRecovery(String kind, int status, String code,
            boolean retryable, boolean rejected) {
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(REQUEST.getScope(), REQUEST.getIsolationKey(),
                kind, REQUEST.getStorageId());
        RuntimeProvisioner provisioner = new RuntimeProvisioner() {
            @Override
            public String kind() {
                return kind;
            }

            @Override
            public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
                return request;
            }

            @Override
            public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest requested,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
                return CompletableFuture.completedFuture(new RuntimeResourceHandle(kind, 1, Map.of("provider", kind)));
            }

            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest requested) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(status, code, "startup failed", retryable,
                        rejected ? new RejectedExecutionException() : null));
            }
        };
        var bindings = new InMemoryRuntimeBindingRepository();
        try (var service = service(bindings, provisioner)) {
            failure(service.warm("harness"));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED, bindings.findActive(request).getState());
            assertEquals("runtime_broker_recovery_blocked", failure(service.warm("harness")).getCode());
        }
    }

    @Test
    void capacityCleanupCannotClearTheReplacementOwnersHandleOrClaim() {
        var delegate = new InMemoryRuntimeBindingRepository();
        var nextHandle = new RuntimeResourceHandle("local-process", 2, Map.of("provider", "replacement"));
        var replacementClaim = new AtomicReference<RuntimeBindingRecord>();
        RuntimeBindingRepository bindings = new DelegatingBindingRepository(delegate) {
            @Override
            public RuntimeBindingRecord compareAndSet(RuntimeBindingRecord expected, RuntimeBindingRecord replacement) {
                if (expected.getResourceHandle() != null && replacement.getResourceHandle() == null) {
                    delegate.releaseOperation(expected.getBindingId(), expected.getOperationOwner(),
                            expected.getOperationGeneration());
                    RuntimeBindingRecord next = delegate.claimOperation(expected.getBindingId(),
                            "replacement-owner", Duration.ofMinutes(1));
                    replacementClaim.set(delegate.compareAndSet(next, next.withResourceHandle(nextHandle, Instant.now())));
                }
                return delegate.compareAndSet(expected, replacement);
            }
        };
        RuntimeProvisioner provisioner = new RuntimeProvisioner() {
            @Override
            public String kind() {
                return "local-process";
            }

            @Override
            public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
                return REQUEST;
            }

            @Override
            public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
                return CompletableFuture.completedFuture(
                        new RuntimeResourceHandle("local-process", 1, Map.of("provider", "local-process")));
            }

            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(
                        503, "runtime_local_capacity", "startup capacity exhausted", true,
                        new RejectedExecutionException()));
            }
        };
        try (var service = service(bindings, provisioner)) {
            failure(service.warm("harness"));
            assertNotNull(replacementClaim.get(), "the test must reach admission cleanup before stealing the claim");
            RuntimeBindingRecord retained = delegate.findActive(REQUEST);
            assertEquals("replacement-owner", retained.getOperationOwner());
            assertEquals(replacementClaim.get().getOperationGeneration(), retained.getOperationGeneration());
            assertEquals(nextHandle, retained.getResourceHandle());
            assertEquals(RuntimeBindingRecord.State.PROVISIONING, retained.getState());
        }
    }

    @Test
    void capacityErrorDuringAttestationStillBlocksAnAlreadyStartedRuntime() {
        var handle = new RuntimeResourceHandle("local-process", 1, Map.of("provider", "local-process"));
        var launches = new AtomicInteger();
        RuntimeProvisioner provisioner = new RuntimeProvisioner() {
            @Override
            public String kind() {
                return "local-process";
            }

            @Override
            public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
                return REQUEST;
            }

            @Override
            public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
                return CompletableFuture.completedFuture(handle);
            }

            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                throw new AssertionError("durable provisioning must carry the original seed");
            }

            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
                launches.incrementAndGet();
                return CompletableFuture.completedFuture(new RuntimeLease(seed.getProvisionalRuntimeId(),
                        URI.create("http://127.0.0.1:12345"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()));
            }
        };
        RuntimeTransport transport = mock(RuntimeTransport.class);
        when(transport.attest(any(), any(), any())).thenReturn(CompletableFuture.failedFuture(
                new RuntimeBrokerException(503, "runtime_local_capacity", "attestation unavailable", true,
                        new RejectedExecutionException())));
        var bindings = new InMemoryRuntimeBindingRepository();
        try (var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(REQUEST.getScope()),
                provisioner, transport, bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), UUID.randomUUID().toString(),
                Duration.ofSeconds(5), Duration.ofSeconds(5))) {
            assertEquals("runtime_broker_recovery_blocked", failure(service.warm("harness")).getCode());
            RuntimeBindingRecord blocked = bindings.findActive(REQUEST);
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED, blocked.getState());
            assertEquals(handle, blocked.getResourceHandle(), "post-start errors must retain the resource identity");
            assertNull(blocked.getOperationOwner());
            assertEquals("runtime_broker_recovery_blocked", failure(service.warm("harness")).getCode());
            assertEquals(1, launches.get(), "attestation failure must not permit another launch");
        }
    }

    private static RuntimeResourceHandle localResourceHandle(int version) {
        if (version == 2) {
            return new RuntimeResourceHandle("local-process", version, Map.of("provider", "local-process"));
        }
        // Use the real producer so a changed placeholder cannot silently disable retries.
        try (var local = new LocalProcessRuntimeProvisioner(List.of("unused-worker"),
                Path.of("."), new HttpRuntimeTransport())) {
            return local.ensureResource(REQUEST, ManagedContextProtocolTest.seed(), null).toCompletableFuture().join();
        }
    }

    private static RuntimeBrokerService service(RuntimeBindingRepository bindings, RuntimeProvisioner provisioner) {
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(REQUEST.getScope()),
                provisioner, new HttpRuntimeTransport(), bindings, new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), UUID.randomUUID().toString(),
                Duration.ofSeconds(5), Duration.ofSeconds(5));
    }

    private static RuntimeBrokerException failure(CompletionStage<?> stage) {
        ExecutionException failure = assertThrows(ExecutionException.class,
                () -> stage.toCompletableFuture().get(5, TimeUnit.SECONDS));
        return assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
    }
}
