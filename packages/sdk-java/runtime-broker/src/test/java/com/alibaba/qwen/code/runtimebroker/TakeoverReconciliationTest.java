package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashSet;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class TakeoverReconciliationTest {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void adoptionSettlesEachDispatchedStateWithoutClaimingOrFencing(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        List<ToolExecutionRecord> originals = new ArrayList<>();
        for (var state : List.of(ToolExecutionRecord.State.EXECUTING,
                ToolExecutionRecord.State.CANCEL_REQUESTED, ToolExecutionRecord.State.UNKNOWN)) {
            originals.add(fixture.execution(state.name(), state));
        }
        try (RuntimeBrokerService broker = fixture.broker(reference -> settled())) {
            fixture.acquire(broker);
            assertEquals(3, fixture.lookups.size());
            for (ToolExecutionRecord original : originals) {
                ToolExecutionRecord result = fixture.executions.findByExecutionCallId(original.getExecutionCallId());
                assertEquals(ToolExecutionRecord.State.SETTLED, result.getState());
                assertEquals(Map.of("executionStatus", "success", "output", "original result"), result.getResult());
                assertEquals(original.getVersion() + 1, result.getVersion(), "settlement must be one direct write");
                assertEquals(original.getDispatchOwner(), result.getDispatchOwner());
                assertEquals(original.getDispatchGeneration(), result.getDispatchGeneration());
                assertEquals(original.getDispatchLeaseUntil(), result.getDispatchLeaseUntil());
                assertEquals(original.isCancelRequested(), result.isCancelRequested());
                assertEquals(original.getLastSequence(), result.getLastSequence());
            }
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void expiredDispatchesSettleDirectlyFromOriginalRuntimeEvidence(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        ToolExecutionRecord original = fixture.execution("expired", ToolExecutionRecord.State.EXECUTING,
                Duration.ofSeconds(1));
        awaitLeaseExpiry(List.of(original));
        try (RuntimeBrokerService broker = fixture.broker(reference -> settled())) {
            fixture.acquire(broker);
            ToolExecutionRecord result = fixture.executions.findByExecutionCallId(original.getExecutionCallId());
            assertEquals(ToolExecutionRecord.State.SETTLED, result.getState());
            assertEquals(original.getVersion() + 1, result.getVersion());
            assertEquals(original.getDispatchOwner(), result.getDispatchOwner());
            assertEquals(original.getDispatchLeaseUntil(), result.getDispatchLeaseUntil());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void unavailableAndInvalidEvidenceStaysBlockedWithoutReplay(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        List<ToolExecutionRecord> originals = new ArrayList<>();
        for (var state : List.of(ToolExecutionRecord.State.EXECUTING,
                ToolExecutionRecord.State.CANCEL_REQUESTED, ToolExecutionRecord.State.UNKNOWN)) {
            for (String response : List.of("failure", "malformed", "pending")) {
                originals.add(fixture.execution(response + "-" + state, state, Duration.ofSeconds(1)));
            }
        }
        awaitLeaseExpiry(originals);
        try (RuntimeBrokerService broker = fixture.broker(reference -> {
            String call = (String) reference.get("callId");
            if (call.startsWith("failure")) {
                return CompletableFuture.failedFuture(new IllegalStateException("Runtime unavailable"));
            }
            return CompletableFuture.completedFuture(call.startsWith("malformed")
                    ? Map.of("state", "settled", "result", Map.of("executionStatus", "invalid"))
                    : Map.of("state", "executing"));
        })) {
            fixture.acquire(broker);
            assertEquals(originals.size(), fixture.lookups.size());
            for (ToolExecutionRecord original : originals) {
                ToolExecutionRecord stored = fixture.executions.findByExecutionCallId(original.getExecutionCallId());
                assertEquals(original.getState(), stored.getState());
                assertEquals(original.getVersion(), stored.getVersion());
            }
        }
        fixture.takeoverOnly = false;
        try (RuntimeBrokerService broker = fixture.broker(reference ->
                CompletableFuture.completedFuture(Map.of("state", "unknown")))) {
            fixture.acquire(broker);
            for (ToolExecutionRecord original : originals) {
                assertEquals(original.getExecutionCallId(), broker.createExecution(original.getHarnessSessionId(),
                        original.getRuntimeSessionId(), original.getIdempotencyKey(), original.getReference())
                        .toCompletableFuture().get(10, TimeUnit.SECONDS).getExecutionCallId());
                assertEquals(ToolExecutionRecord.State.UNKNOWN,
                        fixture.executions.findByExecutionCallId(original.getExecutionCallId()).getState());
            }
            assertTrue(fixture.unexpectedTransportCalls.isEmpty(), fixture.unexpectedTransportCalls.toString());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void hungStatusTimesOutAndCannotSettleFromALateResponse(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        fixture.execution("hung-a", ToolExecutionRecord.State.UNKNOWN);
        fixture.execution("hung-b", ToolExecutionRecord.State.UNKNOWN);
        var pending = new CompletableFuture<Map<String, Object>>();
        try (RuntimeBrokerService broker = fixture.broker(reference -> fixture.lookups.size() == 1 ? pending : settled())) {
            fixture.acquire(broker);
            assertEquals(2, fixture.lookups.size());
            String pendingId = fixture.saved.id + fixture.lookups.getFirst();
            ToolExecutionRecord unresolved = fixture.executions.findByExecutionCallId(pendingId);
            assertEquals(ToolExecutionRecord.State.UNKNOWN, unresolved.getState());
            assertTrue(fixture.executions.findByExecutionCallId(fixture.saved.id + fixture.lookups.getLast()).isSettled());
            pending.complete(settled().toCompletableFuture().join());
            assertEquals(unresolved.getVersion(), fixture.executions.findByExecutionCallId(pendingId).getVersion());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void storageFailureAbortsAcquisitionAndRetrySkipsCommittedSettlements(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        List<ToolExecutionRecord> originals = new ArrayList<>();
        for (int index = 0; index < 3; index++) {
            originals.add(fixture.execution("storage-" + index, ToolExecutionRecord.State.UNKNOWN));
        }
        fixture.failSettlementNumber = 2;
        try (RuntimeBrokerService broker = fixture.broker(reference -> settled())) {
            assertThrows(java.util.concurrent.ExecutionException.class, () -> fixture.acquire(broker));
            assertEquals(2, fixture.lookups.size());
            assertEquals(1, originals.stream().map(record -> fixture.executions.findByExecutionCallId(
                    record.getExecutionCallId())).filter(ToolExecutionRecord::isSettled).count());
            String committed = fixture.lookups.getFirst();
            fixture.failSettlementNumber = 0;
            fixture.lookups.clear();
            fixture.acquire(broker);
            assertEquals(2, fixture.lookups.size());
            assertFalse(fixture.lookups.contains(committed));
            assertTrue(originals.stream().allMatch(record -> fixture.executions.findByExecutionCallId(
                    record.getExecutionCallId()).isSettled()));
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void unresolvedFirstPageDoesNotStarveLaterExecutionsOrScanOtherSessions(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        List<ToolExecutionRecord> originals = new ArrayList<>();
        for (int index = 0; index < 103; index++) {
            originals.add(fixture.execution("page-" + index, ToolExecutionRecord.State.UNKNOWN));
        }
        fixture.execution("prepared", ToolExecutionRecord.State.PREPARED);
        fixture.execution("dispatching", ToolExecutionRecord.State.DISPATCHING);
        var foreign = new RuntimeRecoveryContract.Fixture(fixture.bindings, fixture.sessions, fixture.executions,
                "other-session");
        ToolExecutionRecord foreignPrepared = foreign.prepare("untouched");
        ToolExecutionRecord foreignClaim = fixture.executions.claimDispatch(foreignPrepared.getExecutionCallId(),
                "other-broker", Duration.ofMinutes(5));
        ToolExecutionRecord foreignUnknown = fixture.executions.compareAndSet(foreignClaim,
                foreignClaim.withState(ToolExecutionRecord.State.UNKNOWN, false),
                foreignClaim.getDispatchOwner(), foreignClaim.getDispatchGeneration());
        try (RuntimeBrokerService broker = fixture.broker(reference -> fixture.lookups.size() <= 100
                ? CompletableFuture.completedFuture(Map.of("state", "unknown")) : settled())) {
            fixture.acquire(broker);
            assertEquals(103, fixture.lookups.size());
            assertEquals(103, new HashSet<>(fixture.lookups).size());
            assertEquals(3, originals.stream().map(record -> fixture.executions.findByExecutionCallId(
                    record.getExecutionCallId())).filter(ToolExecutionRecord::isSettled).count());
            assertEquals(foreignUnknown.getVersion(), fixture.executions.findByExecutionCallId(
                    foreignUnknown.getExecutionCallId()).getVersion());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void closingMidScanPreventsLateWritesAndReplacementSkipsSettledRows(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        List<ToolExecutionRecord> originals = new ArrayList<>();
        for (int index = 0; index < 4; index++) {
            originals.add(fixture.execution("interrupted-" + index, ToolExecutionRecord.State.UNKNOWN));
        }
        var pending = new CompletableFuture<Map<String, Object>>();
        var secondLookup = new CompletableFuture<Void>();
        try (RuntimeBrokerService broker = fixture.broker(reference -> {
            if (fixture.lookups.size() == 1) {
                return settled();
            }
            secondLookup.complete(null);
            return pending;
        })) {
            var acquisition = broker.acquire(fixture.saved.session.getSession().getHarnessSessionId(),
                    fixture.saved.session.getRuntimeSessionId(), "bootstrap").toCompletableFuture();
            secondLookup.get(5, TimeUnit.SECONDS);
            assertEquals(2, fixture.lookups.size());
            assertFalse(acquisition.isDone());
            broker.close();
            pending.complete(settled().toCompletableFuture().join());
            assertThrows(java.util.concurrent.ExecutionException.class, () -> acquisition.get(5, TimeUnit.SECONDS));
            assertEquals(2, fixture.lookups.size());
            assertEquals(1, originals.stream().map(record -> fixture.executions.findByExecutionCallId(
                    record.getExecutionCallId())).filter(ToolExecutionRecord::isSettled).count());
        }
        String alreadySettled = fixture.lookups.getFirst();
        fixture.lookups.clear();
        try (RuntimeBrokerService replacement = fixture.broker(reference -> settled())) {
            fixture.acquire(replacement);
            assertEquals(3, fixture.lookups.size());
            assertFalse(fixture.lookups.contains(alreadySettled));
            assertTrue(originals.stream().allMatch(record -> fixture.executions.findByExecutionCallId(
                    record.getExecutionCallId()).isSettled()));
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void concurrentTerminalWriteWinsOverStatusEvidence(boolean jdbc) throws Exception {
        Fixture fixture = new Fixture(jdbc);
        ToolExecutionRecord original = fixture.execution("race", ToolExecutionRecord.State.EXECUTING);
        try (RuntimeBrokerService broker = fixture.broker(reference -> {
            assertNotNull(fixture.executions.compareAndSet(original, original.withResult(
                    Map.of("executionStatus", "error", "output", "concurrent result"), 7, java.time.Instant.now()),
                    original.getDispatchOwner(), original.getDispatchGeneration()));
            return settled();
        })) {
            fixture.acquire(broker);
            ToolExecutionRecord stored = fixture.executions.findByExecutionCallId(original.getExecutionCallId());
            assertEquals(Map.of("executionStatus", "error", "output", "concurrent result"), stored.getResult());
            assertEquals(7, stored.getLastSequence());
            assertEquals(original.getVersion() + 1, stored.getVersion());
        }
    }

    private static CompletionStage<Map<String, Object>> settled() {
        return CompletableFuture.completedFuture(Map.of("state", "settled", "result",
                Map.of("executionStatus", "success", "output", "original result")));
    }

    private static void awaitLeaseExpiry(List<ToolExecutionRecord> records) throws InterruptedException {
        Instant latest = records.stream().map(ToolExecutionRecord::getDispatchLeaseUntil)
                .max(Instant::compareTo).orElseThrow();
        Thread.sleep(Math.max(0, Duration.between(Instant.now(), latest.plusMillis(20)).toMillis()));
        assertTrue(records.stream().noneMatch(record -> record.hasLiveDispatchAt(Instant.now())));
    }

    private static final class Fixture {
        final RuntimeBindingRepository bindings;
        final RuntimeSessionRepository sessions;
        final ToolExecutionRepository executions;
        final RuntimeRecoveryContract.Fixture saved;
        final List<String> lookups = new CopyOnWriteArrayList<>();
        final List<String> unexpectedTransportCalls = new CopyOnWriteArrayList<>();
        final List<String> unexpectedRepositoryCalls = new CopyOnWriteArrayList<>();
        boolean takeoverOnly = true;
        int settlements;
        int failSettlementNumber;

        Fixture(boolean jdbc) {
            if (jdbc) {
                var source = new JdbcDataSource();
                source.setURL("jdbc:h2:mem:takeover-" + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
                JdbcRuntimeBrokerSchema.initialize(source);
                bindings = new JdbcRuntimeBindingRepository(source,
                        new AesGcmSecretProtector("test-key", new byte[32]));
                sessions = new JdbcRuntimeSessionRepository(source);
                executions = new JdbcToolExecutionRepository(source);
            } else {
                bindings = new InMemoryRuntimeBindingRepository();
                sessions = new InMemoryRuntimeSessionRepository();
                executions = new InMemoryToolExecutionRepository();
            }
            saved = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, "takeover");
            bindings.releaseOperation(saved.binding.getBindingId(), "recovery", saved.binding.getOperationGeneration());
        }

        ToolExecutionRecord execution(String id, ToolExecutionRecord.State state) {
            return execution(id, state, Duration.ofMinutes(5));
        }

        ToolExecutionRecord execution(String id, ToolExecutionRecord.State state, Duration duration) {
            ToolExecutionRecord prepared = saved.prepare(id);
            if (state == ToolExecutionRecord.State.PREPARED) {
                return prepared;
            }
            ToolExecutionRecord claimed = executions.claimDispatch(prepared.getExecutionCallId(), "dead-broker",
                    duration);
            if (state == ToolExecutionRecord.State.DISPATCHING) {
                return claimed;
            }
            return executions.compareAndSet(claimed, claimed.withState(state,
                    state == ToolExecutionRecord.State.CANCEL_REQUESTED),
                    claimed.getDispatchOwner(), claimed.getDispatchGeneration());
        }

        void acquire(RuntimeBrokerService broker) throws Exception {
            broker.acquire(saved.session.getSession().getHarnessSessionId(), saved.session.getRuntimeSessionId(),
                    "bootstrap").toCompletableFuture().get(10, TimeUnit.SECONDS);
            assertTrue(unexpectedTransportCalls.isEmpty(), unexpectedTransportCalls.toString());
            assertTrue(unexpectedRepositoryCalls.isEmpty(), unexpectedRepositoryCalls.toString());
        }

        RuntimeBrokerService broker(Function<Map<String, Object>, CompletionStage<Map<String, Object>>> status) {
            RuntimeProvisioner provisioner = new RuntimeProvisioner() {
                @Override
                public String kind() { return "test-supervisor"; }

                @Override
                public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                    throw new AssertionError("Takeover must adopt the original Runtime");
                }

                @Override
                public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
                        RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lease) {
                    assertEquals(saved.binding.getGeneration(), lease.getEpoch());
                    return CompletableFuture.completedFuture(RuntimeObservation.ready(handle, lease.getEndpoint(),
                            lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch()));
                }
            };
            RuntimeTransport transport = (RuntimeTransport) Proxy.newProxyInstance(
                    RuntimeTransport.class.getClassLoader(), new Class<?>[] {RuntimeTransport.class},
                    (proxy, method, args) -> {
                        if (method.getName().equals("attest")) {
                            RuntimeLease lease = (RuntimeLease) args[0];
                            RuntimeProvisionRequest request = (RuntimeProvisionRequest) args[1];
                            RuntimeProvisionSeed seed = (RuntimeProvisionSeed) args[2];
                            return CompletableFuture.completedFuture(new RuntimeAttestation(
                                    lease.getRuntimeInstanceId(), seed.getGatewayIncarnation(), lease.getLeaseId(),
                                    lease.getEpoch(), request.getScope(), seed.getProvisionRequestId()));
                        }
                        if (method.getName().equals("status")) {
                            RuntimeLease lease = (RuntimeLease) args[0];
                            RuntimeSession session = (RuntimeSession) args[1];
                            assertEquals(saved.binding.getLease().getLeaseId(), lease.getLeaseId());
                            assertEquals(saved.binding.getLease().getEpoch(), lease.getEpoch());
                            assertEquals(saved.session.getRuntimeSessionId(), session.getRuntimeSessionId());
                            @SuppressWarnings("unchecked")
                            Map<String, Object> reference = (Map<String, Object>) args[2];
                            lookups.add((String) reference.get("callId"));
                            return status.apply(reference);
                        }
                        unexpectedTransportCalls.add(method.getName());
                        throw new AssertionError("Takeover must not invoke transport " + method.getName());
                    });
            ToolExecutionRepository observed = (ToolExecutionRepository) Proxy.newProxyInstance(
                    ToolExecutionRepository.class.getClassLoader(), new Class<?>[] {ToolExecutionRepository.class},
                    (proxy, method, args) -> {
                        if (method.getName().equals("resolveUnsettled") && ++settlements == failSettlementNumber) {
                            throw new IllegalStateException("Ledger write unavailable");
                        }
                        if (takeoverOnly) {
                            if (List.of("claimDispatch", "renewDispatch", "requestCancel", "compareAndSet")
                                    .contains(method.getName())) {
                                unexpectedRepositoryCalls.add(method.getName());
                                throw new AssertionError("Takeover must not claim or fence dispatch: " + method.getName());
                            }
                        }
                        try {
                            return method.invoke(executions, args);
                        } catch (InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
            return new RuntimeBrokerService(id -> CompletableFuture.completedFuture(saved.session.getSession().getScope()),
                    provisioner, transport, bindings, sessions, takeoverOnly ? observed : executions,
                    "replacement-" + UUID.randomUUID(),
                    Duration.ofSeconds(1), Duration.ofSeconds(1));
        }
    }
}
