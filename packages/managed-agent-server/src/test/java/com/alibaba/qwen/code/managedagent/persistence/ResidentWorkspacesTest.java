package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.managedagent.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiResourceGuard.ProtectionIdentity;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class ResidentWorkspacesTest {
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private ManagedAgentStore store;
    private ResidentWorkspaces residents;
    private WorkspaceCsiReservationStore storage;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcRuntimeSessionRepository runtimeSessions;
    private JdbcToolExecutionRepository executions;
    private WorkspaceExecutionStore authority;
    private final ResidentWorkspace mapping = mapping("workspace", "storage");
    private final ContextBinding context = new ContextBinding("tenant", "workspace", 1, "storage", ".",
            WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);

    @BeforeEach
    void setUp() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:resident-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        transaction = new TransactionTemplate(manager);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setResidentWorkspaces(List.of(mapping));
        authority = new WorkspaceExecutionStore(jdbc, manager, null, properties);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), mock(CommittedEventPublisher.class),
                new ManagedWorkspaceRegistry(jdbc), properties);
        residents = new ResidentWorkspaces(List.of(mapping));
        storage = new WorkspaceCsiReservationStore(jdbc, manager, new ObjectMapper());
        storage.register(mapping.registration());
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test-key", new byte[32]));
        runtimeSessions = new JdbcRuntimeSessionRepository(source);
        executions = new JdbcToolExecutionRepository(source, bindings);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'resident', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OWNER')", ManagedWorkspaceRegistry.actorKey("tenant", "owner"));
    }

    @Test
    void publicCreationReplaysOneAdmissionAndRejectsAnotherUnfinishedSession() {
        var first = create("first");
        assertThat(create("first").sessionId()).isEqualTo(first.sessionId());
        assertThatThrownBy(() -> create("second")).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT runtime_request_key FROM ma_session WHERE session_id = ?",
                String.class, first.sessionId())).isNull();
        for (String state : List.of("CLOSING", "DELETING")) {
            jdbc.update("UPDATE ma_session SET status = ? WHERE session_id = ?", state, first.sessionId());
            assertThatThrownBy(() -> create("second")).isInstanceOf(RuntimeBrokerException.class);
        }
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id = ?", first.sessionId());
        assertThat(create("second").sessionId()).isNotEqualTo(first.sessionId());
    }

    @Test
    void fixedPhysicalVolumeCannotBeAssignedToAnotherWorkspace() {
        assertThatThrownBy(() -> new ResidentWorkspaces(List.of(mapping, mapping("other", "alias"))))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(residents.request(context).getIsolationKey()).isNull();
        assertThat(residents.find(new ContextBinding("foreign", "workspace", 1, "storage", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1))).isNull();
    }

    @Test
    void concurrentPublicCreationHasOneWinnerUnderTheWorkspaceLock() throws Exception {
        var start = new java.util.concurrent.CyclicBarrier(2);
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> concurrentCreate(start, "race-first"));
            var second = pool.submit(() -> concurrentCreate(start, "race-second"));
            assertThat(List.of(first.get(10, java.util.concurrent.TimeUnit.SECONDS),
                    second.get(10, java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(true, false);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?"
                + " AND session_kind = 'PUBLIC'", Long.class, "tenant")).isEqualTo(1);
    }

    private boolean concurrentCreate(java.util.concurrent.CyclicBarrier start, String key) throws Exception {
        try {
            independentCreate(start, key);
            return true;
        }
        catch (RuntimeBrokerException refusal) {
            assertThat(refusal.getStatusCode()).isEqualTo(409);
            assertThat(refusal.getCode()).isEqualTo("workspace_busy");
            return false;
        }
    }

    @Test
    void independentStoresReplayTheSameConcurrentAdmission() throws Exception {
        var start = new java.util.concurrent.CyclicBarrier(2);
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> independentCreate(start, "same-key").sessionId());
            var second = pool.submit(() -> independentCreate(start, "same-key").sessionId());
            assertThat(first.get(10, java.util.concurrent.TimeUnit.SECONDS))
                    .isEqualTo(second.get(10, java.util.concurrent.TimeUnit.SECONDS));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?"
                + " AND session_kind = 'PUBLIC'", Long.class, "tenant")).isEqualTo(1);
    }

    private StoreModels.Admission independentCreate(java.util.concurrent.CyclicBarrier start, String key)
            throws Exception {
        var source = new DriverManagerDataSource(
                ((DriverManagerDataSource) jdbc.getDataSource()).getUrl(), "sa", "");
        var peerJdbc = new ManagedSchemaJdbcTemplate(source);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setResidentWorkspaces(List.of(mapping));
        var peer = new ManagedAgentStore(peerJdbc, new ObjectMapper(), Clock.systemUTC(),
                mock(CommittedEventPublisher.class), new ManagedWorkspaceRegistry(peerJdbc), properties);
        var peerTransaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        start.await(10, java.util.concurrent.TimeUnit.SECONDS);
        return peerTransaction.execute(status -> peer.insertWorkspaceSessionCommand("tenant", "owner", key,
                "digest-" + key, "qwen-code", null, "Session", List.of(), null,
                new WorkspaceSelection("workspace", ".")));
    }

    @Test
    void ownershipEvidenceUsesTheOriginalSourceAndDoesNotChangeTheReservation() {
        var session = create("snapshot").sessionId();
        var original = ready(residents.request(context));
        active(original, session);
        var before = storage.inspect(mapping.registration());
        var source = jdbc.getDataSource();
        var reader = new com.alibaba.qwen.code.managedagent.session.ResidentAcceptanceSnapshot(jdbc,
                new DataSourceTransactionManager(source), mapping, new ObjectMapper());
        var snapshot = reader.capture();
        assertThat(snapshot.path("tables").path("ma_session")).hasSize(1);
        assertThat(snapshot.path("tables").path("ma_runtime_binding")).hasSize(1);
        assertThat(snapshot.path("tables").path("ma_runtime_session")).hasSize(1);
        assertThat(snapshot.path("tables").path("ma_storage_owner")).hasSize(1);
        assertThat(snapshot.path("tables").path("ma_runtime_binding").get(0)
                .path("provision_seed_ciphertext").path("type").asText()).isEqualTo("sha256");
        assertThat(snapshot.toString()).doesNotContain(original.getProvisionSeed().getToken());
        assertThat(reader.capture()).isEqualTo(snapshot);
        assertThat(storage.inspect(mapping.registration())).isEqualTo(before);
        assertThatThrownBy(() -> transaction.execute(status -> reader.capture()))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.session.ResidentAcceptanceSnapshot(jdbc,
                new DataSourceTransactionManager(new DriverManagerDataSource("jdbc:h2:mem:foreign", "sa", "")), mapping, new ObjectMapper()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void unfinishedRuntimeSessionBlocksCreationEvenIfThePublicSessionWasClosedIncorrectly() {
        var session = create("original").sessionId();
        var original = ready(residents.request(context));
        active(original, session);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id = ?", session);
        assertThatThrownBy(() -> create("next")).isInstanceOf(RuntimeBrokerException.class);
    }

    @Test
    void runtimeSessionClaimIsExclusiveAndNeverWritesThePhysicalOwner() {
        var session = create("original").sessionId();
        var request = residents.request(context);
        var original = ready(request);
        var record = active(original, session);
        var before = storage.inspect(mapping.registration());
        authority.authorize(store.requireSession("tenant", session));
        authority.claim(context, record);
        authority.assertHeld(context, record);
        var second = active(original, session);
        assertThatThrownBy(() -> authority.claim(context, second)).isInstanceOf(RuntimeBrokerException.class);
        runtimeSessions.compareAndSet(second, second.withState(RuntimeSessionRecord.State.RELEASED, Instant.now()));
        var releasing = bindings.beginSessionRelease(runtimeSessions, executions, record);
        authority.release(context, releasing);
        bindings.completeSessionRelease(runtimeSessions, releasing);
        assertThatThrownBy(() -> authority.assertHeld(context, record)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(storage.inspect(mapping.registration())).isEqualTo(before);
    }

    @Test
    void aClearedOriginalSlotNeverCreatesAReplacementGeneration() {
        var request = residents.request(context);
        ready(request);
        // Owned fault injection models a cleared slot after the original generation existed.
        jdbc.update("UPDATE ma_runtime_slot SET active_binding_id = NULL WHERE request_key = ?", request.requestKey());
        assertThatThrownBy(() -> bindings.findOrCreate(request)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding WHERE request_key = ?", Long.class,
                request.requestKey())).isEqualTo(1);
        assertThat(storage.inspect(mapping.registration()).phase()).isEqualTo("RESERVED");
    }

    @Test
    void aPreparedDispatchCannotCrossTheDurableSessionCloseFence() {
        var session = create("original").sessionId();
        var original = ready(residents.request(context));
        var runtime = active(original, session);
        var prepared = com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord.prepared("execution", "idempotency",
                original.getBindingId(), original.getGeneration(), session, runtime.getRuntimeSessionId(), "prompt", "call",
                "sha256:" + "a".repeat(64), Map.of("sessionId", runtime.getRuntimeSessionId(), "promptId", "prompt", "callId", "call",
                        "argsDigest", "sha256:" + "a".repeat(64)));
        executions.findOrCreate(prepared);
        var dispatching = executions.claimDispatch("execution", "dispatcher", Duration.ofMinutes(1));
        jdbc.update("UPDATE ma_session SET status = 'CLOSING' WHERE session_id = ?", session);
        bindings.requestHarnessDrain("tenant", session);
        assertThatThrownBy(() -> bindings.authorizeDispatch(runtimeSessions, executions, dispatching,
                "dispatcher", dispatching.getDispatchGeneration())).isInstanceOf(RuntimeBrokerException.class);
        assertThat(executions.findByExecutionCallId("execution").getAuthorizedDispatchGeneration()).isNull();
        assertThat(bindings.findActive(residents.request(context)).getState()).isEqualTo(RuntimeBindingRecord.State.READY);
    }

    @Test
    void secondRuntimeContextIsRefusedBeforeCreatingAnUnsettledRow() {
        var session = create("original").sessionId();
        var request = residents.request(context);
        var original = ready(request);
        var first = new RuntimeSessionRecord(new RuntimeSession(session, UUID.randomUUID().toString(), "bootstrap",
                request.getScope()), original.getBindingId(), original.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
        bindings.admitSession(runtimeSessions, first);
        assertThat(bindings.admitSession(runtimeSessions, first).getRuntimeSessionId()).isEqualTo(first.getRuntimeSessionId());
        var second = new RuntimeSessionRecord(new RuntimeSession(session, UUID.randomUUID().toString(), "bootstrap",
                request.getScope()), original.getBindingId(), original.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
        assertThatThrownBy(() -> bindings.admitSession(runtimeSessions, second)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(runtimeSessions.findById(request.getScope(), second.getRuntimeSessionId())).isNull();
        assertThat(runtimeSessions.countActiveByBinding(original.getBindingId(), original.getGeneration())).isEqualTo(1);
    }

    @Test
    void logicalCloseReleasesTheOriginalRuntimeSessionAndKeepsTheCsiReservation() {
        var session = create("original").sessionId();
        var request = residents.request(context);
        var original = ready(request);
        var record = active(original, session);
        var before = storage.inspect(mapping.registration());
        jdbc.update("UPDATE ma_session SET status = 'CLOSING' WHERE session_id = ?", session);
        bindings.requestHarnessDrain("tenant", session);
        var releases = new AtomicInteger();
        try (var broker = broker(original, releases, true)) {
            broker.closeResidentHarnessSession(request, session).toCompletableFuture().join();
            broker.closeResidentHarnessSession(request, session).toCompletableFuture().join();
        }
        assertThat(releases).hasValue(1);
        assertThat(runtimeSessions.findById(request.getScope(), record.getRuntimeSessionId()).getState())
                .isEqualTo(RuntimeSessionRecord.State.RELEASED);
        assertThat(bindings.findActive(request).getState()).isEqualTo(RuntimeBindingRecord.State.READY);
        assertThat(bindings.findActive(request).isDrainRequested()).isFalse();
        assertThat(storage.inspect(mapping.registration())).isEqualTo(before);
        Boolean closed = transaction.execute(status -> residents.verifyClosed(jdbc, "tenant", session));
        assertThat(closed).isTrue();
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id = ?", session);
        assertThat(create("next").sessionId()).isNotEqualTo(session);
        assertThat(bindings.findActive(request).getBindingId()).isEqualTo(original.getBindingId());
    }

    @Test
    void originalCleanupReleasesOnlyTheSavedResidentSessionAndReplaysWithoutAnotherRelease() {
        var session = create("original").sessionId();
        var request = residents.request(context);
        var original = ready(request);
        var record = active(original, session);
        var before = storage.inspect(mapping.registration());
        jdbc.update("UPDATE ma_session SET status = 'CLOSING' WHERE session_id = ?", session);
        bindings.requestHarnessDrain("tenant", session);
        var releases = new AtomicInteger();
        try (var broker = broker(original, releases, true)) {
            assertThat(broker.releaseOriginal(session, record.getRuntimeSessionId(), original.getBindingId(),
                    original.getGeneration()).toCompletableFuture().join()).isTrue();
            var released = runtimeSessions.findById(request.getScope(), record.getRuntimeSessionId());
            assertThat(released.getState()).isEqualTo(RuntimeSessionRecord.State.RELEASED);
            assertThat(broker.releaseOriginal(session, record.getRuntimeSessionId(), original.getBindingId(),
                    original.getGeneration()).toCompletableFuture().join()).isTrue();
            assertThat(runtimeSessions.findById(request.getScope(), record.getRuntimeSessionId()).getVersion())
                    .isEqualTo(released.getVersion());
        }
        assertThat(releases).hasValue(1);
        assertThat(bindings.findActive(request).getState()).isEqualTo(RuntimeBindingRecord.State.READY);
        assertThat(bindings.findActive(request).getVersion()).isEqualTo(original.getVersion());
        assertThat(bindings.findActive(request).isDrainRequested()).isFalse();
        assertThat(storage.inspect(mapping.registration())).isEqualTo(before);
    }

    @Test
    void originalResidentCleanupRejectsUnknownAndMismatchedOwnersWithoutCreatingATombstone() {
        var session = create("original").sessionId();
        var original = ready(residents.request(context));
        var record = active(original, session);
        var before = storage.inspect(mapping.registration());
        var releases = new AtomicInteger();
        String missing = UUID.randomUUID().toString();
        try (var broker = broker(original, releases, true)) {
            for (var call : List.<Runnable>of(
                    () -> broker.releaseOriginal(session, missing, original.getBindingId(), original.getGeneration()).toCompletableFuture().join(),
                    () -> broker.releaseOriginal("foreign", record.getRuntimeSessionId(), original.getBindingId(), original.getGeneration()).toCompletableFuture().join(),
                    () -> broker.releaseOriginal(session, record.getRuntimeSessionId(), "foreign", original.getGeneration()).toCompletableFuture().join(),
                    () -> broker.releaseOriginal(session, record.getRuntimeSessionId(), original.getBindingId(), original.getGeneration() + 1).toCompletableFuture().join())) {
                assertThatThrownBy(call::run).hasCauseInstanceOf(RuntimeBrokerException.class);
            }
        }
        assertThat(releases).hasValue(0);
        assertThat(runtimeSessions.findById(original.getRequest().getScope(), missing)).isNull();
        assertThat(runtimeSessions.findById(original.getRequest().getScope(), record.getRuntimeSessionId()).getVersion())
                .isEqualTo(record.getVersion());
        assertThat(bindings.findActive(original.getRequest()).getVersion()).isEqualTo(original.getVersion());
        assertThat(storage.inspect(mapping.registration())).isEqualTo(before);
    }

    @Test
    void unconfirmedOriginalCleanupKeepsTheResidentSessionAndReservationHolding() {
        var session = create("original").sessionId();
        var original = ready(residents.request(context));
        var record = active(original, session);
        var before = storage.inspect(mapping.registration());
        jdbc.update("UPDATE ma_session SET status = 'CLOSING' WHERE session_id = ?", session);
        bindings.requestHarnessDrain("tenant", session);
        var releases = new AtomicInteger();
        try (var broker = broker(original, releases, false)) {
            assertThatThrownBy(() -> broker.releaseOriginal(session, record.getRuntimeSessionId(), original.getBindingId(),
                    original.getGeneration()).toCompletableFuture().join()).hasCauseInstanceOf(RuntimeBrokerException.class);
        }
        assertThat(releases).hasValue(1);
        assertThat(runtimeSessions.findById(original.getRequest().getScope(), record.getRuntimeSessionId()).getState())
                .isEqualTo(RuntimeSessionRecord.State.RELEASING);
        assertThatThrownBy(() -> create("next")).isInstanceOf(RuntimeBrokerException.class);
        assertThat(storage.inspect(mapping.registration())).isEqualTo(before);
        assertThat(bindings.findActive(original.getRequest()).getVersion()).isEqualTo(original.getVersion());
    }

    @Test
    void uncertainReleaseKeepsBothHandoffAndCompletionClosed() {
        var session = create("original").sessionId();
        var request = residents.request(context);
        var original = ready(request);
        active(original, session);
        var before = storage.inspect(mapping.registration());
        jdbc.update("UPDATE ma_session SET status = 'CLOSING' WHERE session_id = ?", session);
        bindings.requestHarnessDrain("tenant", session);
        try (var broker = broker(original, new AtomicInteger(), false)) {
            assertThatThrownBy(() -> broker.closeResidentHarnessSession(request, session).toCompletableFuture().join())
                    .hasCauseInstanceOf(RuntimeBrokerException.class);
        }
        assertThatThrownBy(() -> transaction.execute(status -> residents.verifyClosed(jdbc, "tenant", session)))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> create("next")).isInstanceOf(RuntimeBrokerException.class);
        assertThat(storage.inspect(mapping.registration())).isEqualTo(before);
        assertThat(bindings.findActive(request).getState()).isEqualTo(RuntimeBindingRecord.State.READY);
    }

    private StoreModels.Admission create(String key) {
        return transaction.execute(status -> store.insertWorkspaceSessionCommand("tenant", "owner", key,
                "digest-" + key, "qwen-code", null, "Session", List.of(), null, new WorkspaceSelection("workspace", ".")));
    }

    private RuntimeBindingRecord ready(RuntimeProvisionRequest request) {
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "owner", Duration.ofMinutes(5));
        storage.reserve(mapping.registration(), bindings, claimed, UUID.randomUUID().toString());
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var ready = bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                new RuntimeResourceHandle("kubernetes-workspace", 1, Map.of("dataFixture", true)), Instant.now(), Instant.now()));
        bindings.releaseOperation(ready.getBindingId(), "owner", ready.getOperationGeneration());
        return bindings.findById(ready.getBindingId());
    }

    private RuntimeSessionRecord active(RuntimeBindingRecord original, String session) {
        var record = runtimeSessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession(session,
                UUID.randomUUID().toString(), "bootstrap", original.getRequest().getScope()), original.getBindingId(),
                original.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        return runtimeSessions.compareAndSet(record, record.withState(RuntimeSessionRecord.State.READY, Instant.now()));
    }

    private RuntimeBrokerService broker(RuntimeBindingRecord original, AtomicInteger releases, boolean confirmed) {
        var provider = new RuntimeProvisioner() {
            @Override public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) { throw new AssertionError("No replacement"); }
            @Override public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                    RuntimeResourceHandle handle, RuntimeLease lease) { return CompletableFuture.completedFuture(RuntimeObservation.ready(
                            handle, lease.getEndpoint(), lease.getRuntimeInstanceId(), lease.getLeaseId(), lease.getEpoch())); }
            @Override public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) { throw new AssertionError("No physical release"); }
        };
        var transport = new RuntimeTransport() {
            @Override public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease, RuntimeProvisionRequest request,
                    RuntimeProvisionSeed seed) { throw new AssertionError("No new acquisition"); }
            @Override public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) { throw new AssertionError("No acquisition"); }
            @Override public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) { throw new AssertionError("No new control"); }
            @Override public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) { throw new AssertionError("No new execution"); }
            @Override public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) { throw new AssertionError("No cancellation"); }
            @Override public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
                releases.incrementAndGet();
                return CompletableFuture.completedFuture(confirmed);
            }
        };
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(original.getRequest().getScope()), provider,
                transport, bindings, runtimeSessions, executions, "closing", Duration.ofSeconds(30), Duration.ofSeconds(30));
    }

    private static ResidentWorkspace mapping(String workspace, String storage) {
        return new ResidentWorkspace(workspace, 1, new WorkspaceCsiRegistration("tenant", storage, "cluster", "resident",
                "claim", "pvc-uid", "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "handle", "backend",
                "serial", "/workspace", 1), new ProtectionIdentity("namespace", "policy", "policy-uid", 1, "binding", "binding-uid", 1),
                "worker@sha256:" + "a".repeat(64), List.of("node", "/worker/cli.js"), List.of());
    }
}
