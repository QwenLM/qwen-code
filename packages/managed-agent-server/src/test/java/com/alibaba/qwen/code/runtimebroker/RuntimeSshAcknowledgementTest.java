package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.provisioning.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RuntimeSshAcknowledgementTest {
    @Test
    void acknowledgesTheNoStartOnlyAfterTheDispatchResultHasCommitted() {
        try (var fixture = new Fixture(SshRuntimeProvisioner.KIND)) {
            Map<String, Object> result = new LinkedHashMap<>(Map.of("executionStatus", "not_started"));
            result.put("capture", null);
            fixture.transport.dispatchResult = result;
            String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\"}}";
            var execution = fixture.service.prepareExecution("harness", "runtime", "dispatch-key",
                    Map.of("sessionId", "runtime", "promptId", "prompt", "callId", "call",
                            "argsDigest", "sha256:" + CsiNativeActivationProof.sha256(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                            "runtimeProtocol", 3, "inputDigest", CsiNativeActivationProof.sha256(JsonCodec.encode(Map.of("command", "pwd")))),
                    null).toCompletableFuture().join();
            fixture.service.startExecution("harness", "runtime", execution.getExecutionCallId(), payload).toCompletableFuture().join();
            assertTrue(fixture.executions.findByExecutionCallId(execution.getExecutionCallId()).isSettled());
            assertEquals(1, fixture.transport.acknowledgements.get());
            assertEquals(receipt(execution), fixture.transport.receipt);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void drainNeverUsesStopAsAFallbackForAnIdentityConflict(boolean responseConflict) {
        try (var fixture = new Fixture(SshRuntimeProvisioner.KIND)) {
            fixture.persist(true, "not_started", true, false);
            if (responseConflict) {
                var session = fixture.sessions.findById(fixture.scope, "runtime");
                var binding = fixture.bindings.findById(session.getBindingId());
                var lease = binding.getLease();
                fixture.observation = RuntimeObservation.ready(binding.getResourceHandle(), URI.create("http://127.0.0.1:9998"),
                        lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch());
            } else {
                fixture.observationFailure = new RuntimeBrokerException(409, "ssh_runtime_identity_conflict", "Changed original identity", false);
            }
            fixture.service.requestHarnessDrain("tenant", "harness");
            assertThrows(CompletionException.class,
                    () -> fixture.service.drainHarnessSession("tenant", "harness").toCompletableFuture().join());
            assertEquals(0, fixture.transport.acknowledgements.get());
            assertEquals(0, fixture.stops.get());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void drainRetriesOnlyTheOriginalDurableNoStartAcknowledgement(boolean deferred) {
        try (var fixture = new Fixture(SshRuntimeProvisioner.KIND)) {
            ToolExecutionRecord execution = fixture.persist(deferred, "not_started", true, false);
            fixture.transport.failNext = true;
            fixture.service.release("harness", "runtime").toCompletableFuture().join();
            fixture.service.requestHarnessDrain("tenant", "harness");
            assertThrows(CompletionException.class,
                    () -> fixture.service.drainHarnessSession("tenant", "harness").toCompletableFuture().join());
            assertEquals(0, fixture.stops.get(), "Lost ACK cannot reach worker retirement");
            fixture.service.drainHarnessSession("tenant", "harness").toCompletableFuture().join();
            assertEquals(2, fixture.transport.acknowledgements.get());
            assertEquals(deferred ? 2 : 0, fixture.transport.deferredAcknowledgements.get());
            assertEquals(execution.getReference(), fixture.transport.reference);
            assertEquals(receipt(execution), fixture.transport.receipt);
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    fixture.sessions.findById(fixture.scope, "runtime").getState());
            assertNotNull(fixture.bindings.findById(execution.getBindingId()).getDrainReceipt());
            assertEquals(1, fixture.stops.get());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void explicitSshNoStartAcknowledgementRequiresTheExactDurableReceipt(boolean deferred) {
        try (var fixture = new Fixture(SshRuntimeProvisioner.KIND)) {
            ToolExecutionRecord execution = fixture.persist(deferred, "not_started", true, false);
            Map<String, Object> wrong = new LinkedHashMap<>(receipt(execution));
            wrong.put("deliveryStatus", "blocked");
            assertThrows(CompletionException.class, () -> fixture.service.acknowledgeExecution(
                    "harness", "runtime", execution.getExecutionCallId(), wrong).toCompletableFuture().join());
            assertEquals(0, fixture.transport.acknowledgements.get());
            assertEquals("settled", fixture.service.acknowledgeExecution("harness", "runtime",
                    execution.getExecutionCallId(), receipt(execution)).toCompletableFuture().join().get("state"));
            assertEquals(receipt(execution), fixture.transport.receipt);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"local", "unknown", "running", "capture", "missing_capture", "success"})
    void doesNotAcknowledgeUnsupportedOrUnsettledResults(String scenario) {
        try (var fixture = new Fixture("local".equals(scenario) ? LocalProcessRuntimeProvisioner.KIND : SshRuntimeProvisioner.KIND)) {
            fixture.requireAcknowledgement = false;
            ToolExecutionRecord execution = fixture.persist(true, "success".equals(scenario) ? "success" : "not_started",
                    !"missing_capture".equals(scenario), "capture".equals(scenario));
            if ("unknown".equals(scenario) || "running".equals(scenario)) {
                var unsettled = fixture.executions.findOrCreate(ToolExecutionRecord.prepared("unsettled", "unsettled-key",
                        execution.getBindingId(), execution.getRuntimeGeneration(), "harness", "runtime",
                        "prompt", "unsettled", "digest", Map.of("sessionId", "runtime", "promptId", "prompt",
                                "callId", "unsettled", "argsDigest", "digest", "payloadDigest", "digest", "dispatchMode", "deferred_v3")));
                var claim = fixture.executions.claimDispatch(unsettled.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
                fixture.executions.compareAndSet(claim, "unknown".equals(scenario) ? claim.withUnknown()
                                : claim.withState(ToolExecutionRecord.State.EXECUTING, false),
                        "dispatcher", claim.getDispatchGeneration());
            }
            fixture.service.requestHarnessDrain("tenant", "harness");
            if ("unknown".equals(scenario) || "running".equals(scenario)) {
                assertThrows(CompletionException.class,
                        () -> fixture.service.drainHarnessSession("tenant", "harness").toCompletableFuture().join());
            } else {
                fixture.service.drainHarnessSession("tenant", "harness").toCompletableFuture().join();
            }
            assertEquals(0, fixture.transport.acknowledgements.get());
        }
    }

    private static Map<String, Object> receipt(ToolExecutionRecord execution) {
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("executionCallId", execution.getExecutionCallId());
        receipt.put("manifest", null);
        receipt.put("deliveryStatus", "committed");
        receipt.put("historyRevision", null);
        return receipt;
    }

    private static final class Fixture implements AutoCloseable {
        private final RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        private final JdbcRuntimeBindingRepository bindings;
        private final JdbcRuntimeSessionRepository sessions;
        private final JdbcToolExecutionRepository executions;
        private final Transport transport = new Transport();
        private final AtomicInteger stops = new AtomicInteger();
        private final RuntimeBrokerService service;
        private boolean requireAcknowledgement = true;
        private RuntimeObservation observation;
        private RuntimeBrokerException observationFailure;

        Fixture(String kind) {
            var source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:ssh-ack-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            ManagedSchema.initialize(source);
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
            sessions = new JdbcRuntimeSessionRepository(source);
            executions = new JdbcToolExecutionRepository(source);
            var provider = new RuntimeProvisioner() {
                public String kind() { return kind; }
                public boolean supportsDrainedStop() { return true; }
                public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
                    return new RuntimeProvisionRequest(scope, isolationKey, kind, "storage");
                }
                public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                    throw new AssertionError("A durable seed is required");
                }
                public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                        RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
                    return CompletableFuture.completedFuture(new RuntimeResourceHandle(kind, 1, Map.of("resource", "original")));
                }
                public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
                    return CompletableFuture.completedFuture(new RuntimeLease(seed.getProvisionalRuntimeId(),
                            URI.create("http://127.0.0.1:9999"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()));
                }
                public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                        RuntimeResourceHandle handle, RuntimeLease lease) {
                    if (observationFailure != null) {
                        return CompletableFuture.failedFuture(observationFailure);
                    }
                    if (observation != null) {
                        return CompletableFuture.completedFuture(observation);
                    }
                    return CompletableFuture.completedFuture(RuntimeObservation.ready(handle, lease.getEndpoint(),
                            lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch()));
                }
                public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
                    stops.incrementAndGet();
                    if (requireAcknowledgement && transport.acknowledgements.get() == 0) {
                        return CompletableFuture.failedFuture(new RuntimeBrokerException(409,
                                "ssh_runtime_unsettled", "Original worker still requires ACK", false));
                    }
                    return CompletableFuture.completedFuture(new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                            binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now()));
                }
            };
            service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provider, transport,
                    bindings, sessions, executions, "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
        }

        ToolExecutionRecord persist(boolean deferred, String status, boolean captureField, boolean captured) {
            var session = sessions.findById(scope, "runtime");
            Map<String, Object> reference = new LinkedHashMap<>(Map.of("sessionId", "runtime", "promptId", "prompt",
                    "callId", "call", "argsDigest", "digest"));
            if (deferred) {
                reference.put("dispatchMode", "deferred_v3");
                reference.put("publicationId", "pub");
                reference.put("payloadDigest", "digest");
            } else {
                reference.put("runtimeProtocol", 3);
                reference.put("inputDigest", "input-digest");
                reference.put("toolName", "run_shell_command");
            }
            var prepared = executions.findOrCreate(ToolExecutionRecord.prepared("execution", "key", session.getBindingId(),
                    session.getRuntimeGeneration(), "harness", "runtime", "prompt", "call", "digest", reference));
            var claim = executions.claimDispatch(prepared.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
            Map<String, Object> result = new LinkedHashMap<>(Map.of("executionStatus", status));
            if (captureField) {
                result.put("capture", captured ? Map.of("manifest", Map.of("resourceId", "manifest")) : null);
            }
            return executions.compareAndSet(claim, claim.withResult(result, 1, Instant.now()), "dispatcher", claim.getDispatchGeneration());
        }

        public void close() { service.close(); }

        private final class Transport implements RuntimeTransport {
            private final AtomicInteger acknowledgements = new AtomicInteger();
            private final AtomicInteger deferredAcknowledgements = new AtomicInteger();
            private Map<String, Object> reference;
            private Map<String, Object> receipt;
            private boolean failNext;
            private Map<String, Object> dispatchResult;

            public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease, RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
                return CompletableFuture.completedFuture(new RuntimeAttestation(lease.getRuntimeInstanceId(), seed.getGatewayIncarnation(),
                        lease.getLeaseId(), lease.getEpoch(), request.getScope(), seed.getProvisionRequestId(), request.getStorageId()));
            }
            public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) { return CompletableFuture.completedFuture(null); }
            public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) { return CompletableFuture.completedFuture(true); }
            public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) {
                throw new AssertionError("No provider controls expected");
            }
            public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session, Map<String, Object> ref) {
                if (dispatchResult != null) {
                    return CompletableFuture.completedFuture(dispatchResult);
                }
                throw new AssertionError("Durable ACK retries must never execute again");
            }
            public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session, Map<String, Object> ref) {
                return CompletableFuture.completedFuture(Map.of("state", "unknown"));
            }
            public CompletionStage<Map<String, Object>> acknowledge(RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> ref, Map<String, Object> savedReceipt) {
                var persisted = executions.findByExecutionCallId((String) savedReceipt.get("executionCallId"));
                assertNotNull(persisted);
                assertTrue(persisted.isSettled(), "ACK must follow durable SQL settlement");
                assertEquals(persisted.getReference(), ref);
                RuntimeLease original = bindings.findById(persisted.getBindingId()).getLease();
                assertEquals(original.getRuntimeInstanceId(), lease.getRuntimeInstanceId());
                assertEquals(original.getEndpoint(), lease.getEndpoint());
                assertEquals(original.getToken(), lease.getToken());
                assertEquals(original.getLeaseId(), lease.getLeaseId());
                assertEquals(original.getEpoch(), lease.getEpoch());
                reference = ref;
                receipt = savedReceipt;
                acknowledgements.incrementAndGet();
                if (failNext) {
                    failNext = false;
                    return CompletableFuture.failedFuture(new IllegalStateException("Lost original ACK"));
                }
                return CompletableFuture.completedFuture(Map.of("state", "settled"));
            }
            public CompletionStage<Map<String, Object>> acknowledgeV3(RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> ref, Map<String, Object> savedReceipt) {
                deferredAcknowledgements.incrementAndGet();
                return acknowledge(lease, session, ref, savedReceipt);
            }
        }
    }
}
