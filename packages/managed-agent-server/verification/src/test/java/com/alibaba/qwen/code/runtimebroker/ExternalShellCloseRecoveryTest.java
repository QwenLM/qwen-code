package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.external.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.service.BrokerServiceTestAccess;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import javax.sql.DataSource;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The external foreground-Shell lane's close and recovery over the real
 * repositories (#15512 slice C).
 *
 * <p>This placement retires only on the original worker's own drained stop: a
 * Shell still in flight, a LOST binding and a proven absence all fall short of
 * that proof, because none of them shows the captured bytes reached the control
 * plane. The close reads those three facts from SQL — an active execution row,
 * the binding's state, and the recovery evidence — so the fence is only proven
 * where those reads are the real ones.
 *
 * <p>{@link ExternalShellCloseRecoveryMySqlIT} runs these same cases on MySQL
 * 8.4; this class is the H2 leg.
 */
class ExternalShellCloseRecoveryTest {
    private Fixture fixture;

    /** The leg supplies its database; each test owns one and clears nothing else. */
    protected DataSource dataSource() {
        var source = new org.h2.jdbcx.JdbcDataSource();
        source.setURL("jdbc:h2:mem:external-shell-close-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        return source;
    }

    @AfterEach
    void releaseFixture() {
        if (fixture != null) {
            fixture.close();
            fixture = null;
        }
    }

    @Test
    @Timeout(60)
    void closeRefusesWhileAShellIsStillInFlightAndKeepsTheStorageHolder() {
        fixture = new Fixture(dataSource());
        var execution = fixture.executingShell();

        // No publication can be finished for an unsettled execution, so the
        // close cannot reach a stop the worker could prove. Releasing here
        // would hand the storage back with the capture still on the worker.
        var refused = assertThrows(CompletionException.class, fixture::drain);
        assertEquals("workspace_close_execution_unsettled", code(refused));
        assertNull(fixture.binding().getDrainReceipt());
        assertEquals(RuntimeBindingRecord.State.READY, fixture.binding().getState());
        assertTrue(fixture.executions.hasActiveByBinding(
                fixture.binding.getBindingId(), fixture.binding.getGeneration()));
        assertFalse(fixture.events.contains("stop"), "A refused close must not stop the worker");

        // The refusal releases its own operation claim, so the next attempt is
        // not wedged behind it.
        assertNull(fixture.binding().getOperationOwner());
        assertEquals(execution.getExecutionCallId(),
                fixture.executions.findByExecutionCallId(execution.getExecutionCallId())
                        .getExecutionCallId());
    }

    @Test
    @Timeout(60)
    void closeProceedsOnceTheShellSettledThroughItsFinishedPublication() {
        fixture = new Fixture(dataSource());
        var execution = fixture.executingShell();
        fixture.settle(execution);
        fixture.finished = true;

        fixture.drain();

        assertNotNull(fixture.binding().getDrainReceipt());
        assertEquals(RuntimeBindingRecord.State.RELEASED, fixture.binding().getState());
        assertTrue(fixture.events.contains("stop"));
        assertFalse(fixture.executions.hasActiveByBinding(
                fixture.binding.getBindingId(), fixture.binding.getGeneration()));
    }

    @Test
    @Timeout(60)
    void aLostWorkerIsNotItsOwnDrainProofAndTheCloseAsksForRecovery() {
        fixture = new Fixture(dataSource());
        var execution = fixture.executingShell();
        fixture.settle(execution);
        // The worker is gone. That proves the process ended, not that its
        // captured bytes arrived, so the storage holder must survive.
        fixture.lose();
        // The maintenance route that observed the loss hands the claim back;
        // the close then claims it and reads the same LOST row.
        fixture.releaseOperation();

        var refused = assertThrows(CompletionException.class, fixture::drain);
        assertEquals("workspace_close_identity_unverified", code(refused));
        assertEquals(RuntimeBindingRecord.State.LOST, fixture.binding().getState());
        assertNull(fixture.binding().getDrainReceipt());
        assertFalse(fixture.events.contains("stop"));
    }

    @Test
    @Timeout(60)
    void lostRecoveryAbandonsTheInFlightShellWithoutInventingItsResult() {
        fixture = new Fixture(dataSource());
        var execution = fixture.executingShell();
        var lost = fixture.lose();

        var pinned = fixture.bindings.recoverLost(fixture.sessions, fixture.executions, lost);

        // The journal is gone with the worker, so no result may be invented for
        // a call whose capture never arrived. Abandonment is the honest record,
        // and it still settles the row so a later generation can be admitted.
        assertEquals(RuntimeBindingRecord.State.LOST, pinned.getState());
        var abandoned = fixture.executions.findByExecutionCallId(execution.getExecutionCallId());
        assertEquals(ToolExecutionRecord.State.ABANDONED, abandoned.getState());
        assertTrue(abandoned.isTerminal());
        assertFalse(abandoned.isSettled());
        assertNull(abandoned.getResult());
        assertNull(abandoned.getExecutionStatus());
        assertNotNull(abandoned.getAbandonedAt());
        assertEquals(lost.getLossEvidence().evidenceId(), abandoned.getLossEvidenceId());
        assertFalse(fixture.executions.hasActiveByBinding(
                lost.getBindingId(), lost.getGeneration()));
    }

    @Test
    @Timeout(60)
    void aReplacedWorkerGenerationDoesNotInheritTheOldGenerationsCloseProof() {
        fixture = new Fixture(dataSource());
        var execution = fixture.executingShell();
        var lost = fixture.lose();
        var pinned = fixture.bindings.recoverLost(fixture.sessions, fixture.executions, lost);
        // The writers-stopped proof comes from the provisioner clearing the
        // physical holders; only then may recovery release the generation.
        var proved = fixture.bindings.compareAndSet(pinned, pinned.withRecoveryEvidence(
                RuntimeRecoveryContract.evidence(pinned, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                RuntimeRecoveryContract.evidence(pinned, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED),
                Instant.now()));
        assertNotNull(proved, "The writers-stopped proof must land on the pinned generation");
        // A managed placement's physical holders belong to the provider, so
        // only the explicit finish — the provisioner having cleared them —
        // retires the generation. Plain recovery keeps it LOST on purpose.
        assertEquals(RuntimeBindingRecord.State.LOST,
                fixture.bindings.recoverLost(fixture.sessions, fixture.executions, proved).getState());
        var released = fixture.bindings.finishLostRecovery(fixture.sessions, fixture.executions, proved);
        assertEquals(RuntimeBindingRecord.State.RELEASED, released.getState());

        // A new generation is a new worker with its own capture store. The
        // retired generation's rows must not answer for it, and the new one
        // starts with no drain receipt of its own.
        var next = fixture.bindings.findOrCreate(fixture.request());
        assertTrue(next.getGeneration() > released.getGeneration());
        assertNull(next.getDrainReceipt());
        assertFalse(fixture.executions.hasActiveByBinding(
                next.getBindingId(), next.getGeneration()));
        assertEquals(ToolExecutionRecord.State.ABANDONED,
                fixture.executions.findByExecutionCallId(execution.getExecutionCallId()).getState());
    }

    @Test
    @Timeout(60)
    void restartRecoveryKeepsTheCloseRefusingUntilTheRecoveredDispatchFinishesTheDrain() {
        fixture = new Fixture(dataSource());
        var execution = fixture.executingShell();

        // A replaced Broker process re-reads the same rows. Its own memory of
        // the dispatch is gone, but the Shell's row is still active, so the
        // close must refuse exactly as it did before the restart: a new process
        // proves nothing about bytes that never arrived.
        fixture.restart();
        var refused = assertThrows(CompletionException.class, fixture::drain);
        assertEquals("workspace_close_execution_unsettled", code(refused));
        assertNull(fixture.binding().getDrainReceipt());
        assertEquals(RuntimeBindingRecord.State.READY, fixture.binding().getState());
        assertFalse(fixture.events.contains("stop"));

        // The recovered dispatch re-ran the idempotent begin, moved the bytes
        // and settled the published envelope. Only now may the close retire.
        fixture.finished = true;
        fixture.settle(fixture.executions.findByExecutionCallId(execution.getExecutionCallId()));
        fixture.drain();
        assertNotNull(fixture.binding().getDrainReceipt());
        assertEquals(RuntimeBindingRecord.State.RELEASED, fixture.binding().getState());
    }

    private static String code(Throwable failure) {
        var cause = failure instanceof CompletionException wrapped && wrapped.getCause() != null
                ? wrapped.getCause() : failure;
        assertTrue(cause instanceof RuntimeBrokerException, "Unexpected failure: " + cause);
        return ((RuntimeBrokerException) cause).getCode();
    }

    /**
     * One admitted external Shell placement over the real JDBC repositories.
     * The provider is a stand-in that answers the drained stop with a receipt
     * for the exact binding it was handed; the publication verifier is the one
     * fact these cases vary, because it is what decides the close.
     */
    private static final class Fixture implements AutoCloseable {
        private static final Instant START = Instant.parse("2026-11-01T00:00:00Z");
        private static final Duration LEASE = Duration.ofMinutes(5);

        private final MutableClock clock = new MutableClock();
        private final DataSource source;
        private final JdbcRuntimeBindingRepository bindings;
        private final JdbcRuntimeSessionRepository sessions;
        private final JdbcToolExecutionRepository executions;
        private final RuntimeScope scope = new RuntimeScope("tenant", "storage", "1", "/workspace",
                WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST, "session");
        private final List<String> events = new ArrayList<>();
        private boolean finished;
        private RuntimeBindingRecord lost;
        private final RuntimeBindingRecord binding;
        private final RuntimeSessionRecord session;
        private RuntimeBrokerService service;

        private Fixture(DataSource source) {
            this.source = source;
            bindings = new JdbcRuntimeBindingRepository(source,
                    new AesGcmSecretProtector("test", new byte[32]));
            sessions = new JdbcRuntimeSessionRepository(source);
            executions = new JdbcToolExecutionRepository(source);
            var created = bindings.findOrCreate(request());
            var claimed = bindings.claimOperation(created.getBindingId(), "broker", LEASE);
            var seed = claimed.getProvisionSeed();
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:2345"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            var handle = new RuntimeResourceHandle(ExternalWorkspaceProvisioner.KIND,
                    WorkspaceExecutionProfile.EXTERNAL_SHELL_HANDLE_VERSION,
                    Map.of("provider", "provider", "physicalKey", "physical", "revision", 1));
            binding = bindings.compareAndSet(claimed,
                    claimed.withAttestation(lease, handle, clock.instant(), clock.instant()));
            // The close's own operation claim is released by the fixture's
            // setup so the drain under test has to claim it itself.
            bindings.releaseOperation(binding.getBindingId(), "broker", binding.getOperationGeneration());
            var acquiring = bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession("harness", "runtime", "bootstrap", scope),
                    binding.getBindingId(), binding.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, clock.instant()));
            session = sessions.compareAndSet(acquiring,
                    acquiring.withState(RuntimeSessionRecord.State.READY, clock.instant()));
            service = newService();
        }

        private RuntimeProvisionRequest request() {
            return new RuntimeProvisionRequest(scope, "harness",
                    ExternalWorkspaceProvisioner.KIND, "storage");
        }

        private RuntimeBrokerService newService() {
            return BrokerServiceTestAccess.create(
                    ignored -> CompletableFuture.completedFuture(scope),
                    provider(), transport(), bindings, sessions, executions, "broker",
                    LEASE, LEASE, clock, () -> UUID.randomUUID().toString(), verifier());
        }

        /** A replaced Broker process over the same durable rows. */
        private void restart() {
            service.close();
            service = newService();
        }

        private RuntimeBindingRecord binding() {
            return bindings.findById(binding.getBindingId());
        }

        /** One claimed, authorized Shell the worker has started but not settled. */
        private ToolExecutionRecord executingShell() {
            var reference = Map.<String, Object>of(
                    "sessionId", "runtime", "promptId", "turn", "callId", "call",
                    "argsDigest", "sha256:" + "a".repeat(64),
                    "dispatchMode", "deferred_v3", "publicationId", "publication",
                    "payloadDigest", "sha256:" + "b".repeat(64));
            var prepared = bindings.admitExecution(sessions, executions,
                    ToolExecutionRecord.prepared("execution", "key",
                            binding.getBindingId(), binding.getGeneration(),
                            "harness", "runtime", "turn", "call",
                            "sha256:" + "b".repeat(64), reference));
            var claimed = executions.claimDispatch(prepared.getExecutionCallId(), "broker", LEASE);
            return bindings.authorizeDispatch(sessions, executions, claimed, "broker",
                    claimed.getDispatchGeneration());
        }

        private void releaseOperation() {
            var current = binding();
            bindings.releaseOperation(current.getBindingId(), current.getOperationOwner(),
                    current.getOperationGeneration());
        }

        private void settle(ToolExecutionRecord execution) {
            var settled = executions.compareAndSet(execution, execution.withResult(
                    Map.of("executionStatus", "success", "responseParts", List.of(),
                            "capture", Map.of("captureStatus", "complete",
                                    "manifest", "control-plane-manifest")),
                    execution.getLastSequence(), clock.instant()),
                    "broker", execution.getDispatchGeneration());
            assertTrue(settled.isSettled());
        }

        /**
         * Marks the worker LOST under a live operation claim: recovery acts only
         * on a claim it can still prove, exactly as the maintenance route does.
         */
        private RuntimeBindingRecord lose() {
            var claimed = bindings.claimOperation(binding.getBindingId(), "recovery", LEASE);
            assertNotNull(claimed, "The fixture must hold the operation claim to lose the worker");
            lost = bindings.compareAndSet(claimed, claimed.withRecoveryEvidence(
                    RuntimeRecoveryContract.evidence(claimed, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    null, clock.instant()));
            return lost;
        }

        private void drain() {
            service.requestHarnessDrain("tenant", "harness");
            service.drainHarnessSession("tenant", "harness").toCompletableFuture().join();
        }

        private RuntimePublicationVerifier verifier() {
            return new RuntimePublicationVerifier() {
                public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                        String publicationId, String token) {
                    throw new AssertionError("The close arms verify no dispatch grant");
                }

                public Map<String, Object> finished(ToolExecutionRecord execution) {
                    return finished
                            ? Map.of("executionStatus", "success", "responseParts", List.of(),
                                    "capture", Map.of("captureStatus", "complete",
                                            "manifest", "control-plane-manifest"))
                            : null;
                }
            };
        }

        private RuntimeProvisioner provider() {
            return new RuntimeProvisioner() {
                public String kind() { return ExternalWorkspaceProvisioner.KIND; }
                public RuntimeProvisionRequest createRequest(RuntimeScope selected, String isolation) {
                    return request();
                }
                public boolean supportsDrainedStop() { return true; }
                public boolean supportsStartupRecovery(RuntimeResourceHandle handle) { return handle != null; }
                public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                    throw new AssertionError("The fixture attests its own lease");
                }
                public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request,
                        RuntimeProvisionSeed seed) {
                    throw new AssertionError("No allocation in the close fixture");
                }
                public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                        RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
                    return CompletableFuture.completedFuture(handle);
                }
                public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request,
                        RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease previous) {
                    events.add("reconcile");
                    // The close re-reads the original worker through its own
                    // lease before it may stop it; the same worker answers.
                    return CompletableFuture.completedFuture(RuntimeObservation.ready(handle,
                            previous.getEndpoint(), previous.getRuntimeInstanceId(),
                            previous.getLeaseId(), previous.getEpoch()));
                }
                public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord claimed) {
                    events.add("stop");
                    assertEquals(binding.getBindingId(), claimed.getBindingId());
                    return CompletableFuture.completedFuture(new RuntimeDrainReceipt(
                            claimed.getBindingId(), claimed.getGeneration(),
                            claimed.getProvisionSeed().getProvisionRequestId(),
                            claimed.getResourceHandle(), clock.instant()));
                }
            };
        }

        private RuntimeTransport transport() {
            return new RuntimeTransport() {
                public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease, RuntimeSession session) {
                    throw new AssertionError("The close arms attest through the provider");
                }
                public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
                    return CompletableFuture.completedFuture(null);
                }
                public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
                    events.add("release");
                    return CompletableFuture.completedFuture(true);
                }
                public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
                        Map<String, Object> operation) {
                    throw new AssertionError("No controls expected");
                }
                public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                        RuntimeSession session, Map<String, Object> reference) {
                    throw new AssertionError("The fixture claims its own Shell");
                }
                public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                        RuntimeSession session, Map<String, Object> reference) {
                    throw new AssertionError("No cancellation expected");
                }
            };
        }

        @Override
        public void close() {
            service.close();
        }
    }

    private static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-11-01T00:00:00Z");
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }
}
