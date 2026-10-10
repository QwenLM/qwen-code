package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceCsiSessionGuardTest {
    private static final String TOKEN = "csi-original-writer-token-for-test";
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private WorkspaceCsiRegistration registration;
    private WorkspaceCsiReservationStore reservations;
    private WorkspaceCsiReservationStore.Reservation reservation;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcRuntimeSessionRepository sessions;
    private JdbcToolExecutionRepository executions;
    private ManagedSessionStore journal;
    private RuntimeProvisionRequest request;
    private String sessionId;
    private RuntimeBindingRecord binding;

    @BeforeEach
    void setUp() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:csi-guard-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        var json = new ObjectMapper();
        registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        reservations = new WorkspaceCsiReservationStore(jdbc, manager, json);
        reservations.register(registration);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("reviewed-agent/1");
        sessionId = WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null,
                        new WorkspaceSelection("workspace", "."))).sessionId();
        var managed = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        request = transaction.execute(status -> managed.requireCsiRequest(registration, sessionId));
        bindings = new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("test", new byte[32]));
        sessions = new JdbcRuntimeSessionRepository(source);
        executions = new JdbcToolExecutionRepository(source);
        journal = new ManagedSessionStore(jdbc);
    }

    @ParameterizedTest
    @EnumSource(value = StoreModels.OperationKind.class, names = {"CLOSE", "DELETE"})
    void publicLifecycleCannotFenceAnOriginalPrivateCsiSession(StoreModels.OperationKind kind) {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var managed = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        var before = jdbc.queryForMap("SELECT * FROM managed_agent_session WHERE session_id = ?", sessionId);
        var ownership = reservations.inspect(registration);
        assertApiCode(() -> transaction.execute(status -> managed.beginWorkspaceLifecycle("tenant", sessionId,
                kind, "actor", "actor-digest", "public-lifecycle", "request-digest", true, 1)),
                "csi_managed_mutation_unavailable");
        assertThat(jdbc.queryForMap("SELECT * FROM managed_agent_session WHERE session_id = ?", sessionId))
                .usingRecursiveComparison().isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_operation", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_harness_drain", Integer.class)).isZero();
        assertThat(reservations.inspect(registration)).isEqualTo(ownership);
    }

    @Test
    void missingOriginalBindingRefusesWriterWithoutCreatingAnyNativeAuthority() {
        assertBrokerCode(() -> transaction.execute(status -> acquire()), "csi_original_binding_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_binding", Integer.class)).isZero();
    }

    @Test
    void originalWriterCanReplayButNeverTakeOverAnExpiredOrSealedHead() {
        ready();
        var first = transaction.execute(status -> acquire());
        assertThat(first.writerGeneration()).isEqualTo(1);
        assertThat(transaction.execute(status -> acquire()).replayed()).isTrue();
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = '2000-01-01 00:00:00'");
        var before = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head");
        assertApiCode(() -> transaction.execute(status -> acquire()), "csi_original_writer_unavailable");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head")).isEqualTo(before);
        assertApiCode(() -> transaction.execute(status -> journal.sealWriter("tenant", sessionId, TOKEN,
                new ManagedSessionStoreModels.SealWriterRequest("workspace", "writer", 1))), "csi_finalize_required");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head")).isEqualTo(before);
    }

    @Test
    void drainRefusesAdmissionAndAcquireCompletionWhileOriginalWriterRenewalRemainsPossible() {
        ready();
        var runtime = bindings.admitSession(sessions, candidate(sessionId));
        transaction.execute(status -> acquire());
        retire();
        assertBrokerCode(() -> transaction.execute(status -> acquire()), "runtime_admission_closed");
        assertBrokerCode(() -> sessions.findOrCreate(candidate(sessionId)), "runtime_admission_closed");
        assertBrokerCode(() -> sessions.compareAndSet(runtime,
                runtime.withState(RuntimeSessionRecord.State.READY, Instant.now())), "runtime_admission_closed");
        assertThat(sessions.findById(request.getScope(), sessionId).getState())
                .isEqualTo(RuntimeSessionRecord.State.ACQUIRING);
        var renewed = transaction.execute(status -> journal.renewWriter("tenant", sessionId, TOKEN,
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "writer", 1, 60_000L)));
        assertThat(renewed.writerGeneration()).isEqualTo(1);
        assertThat(reservations.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @Test
    void onlyTheOriginalUuidSessionCanJoinAndOrdinaryReleaseCannotMutateIt() {
        ready();
        assertBrokerCode(() -> bindings.admitSession(sessions, candidate(UUID.randomUUID().toString())),
                "csi_original_binding_unavailable");
        assertBrokerCode(() -> sessions.findOrCreate(candidate(UUID.randomUUID().toString())),
                "csi_original_binding_unavailable");
        var runtime = bindings.admitSession(sessions, candidate(sessionId));
        var ready = sessions.compareAndSet(runtime, runtime.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        var before = jdbc.queryForMap("SELECT * FROM qwen_runtime_session");
        assertBrokerCode(() -> bindings.beginSessionRelease(sessions, executions, ready), "csi_finalize_required");
        assertBrokerCode(() -> bindings.completeSessionRelease(sessions, ready), "csi_finalize_required");
        assertBrokerCode(() -> sessions.compareAndSet(ready,
                ready.withState(RuntimeSessionRecord.State.RELEASED, Instant.now())), "csi_finalize_required");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_session")).isEqualTo(before);
        assertThat(reservations.inspect(registration)).isEqualTo(reservation);
    }

    @Test
    void currentPinSlotAndHistoryMustAgreeAndNoReplacementGenerationIsCreated() {
        ready();
        bindings.admitSession(sessions, candidate(sessionId));
        String pin = request.requestKey();
        jdbc.update("UPDATE managed_agent_session SET runtime_request_key = ?", "a".repeat(64));
        assertBrokerCode(() -> bindings.findOrCreate(request), "csi_original_binding_unavailable");
        assertBrokerCode(() -> transaction.execute(status -> acquire()), "csi_original_binding_unavailable");
        jdbc.update("UPDATE managed_agent_session SET runtime_request_key = ?", pin);
        jdbc.update("UPDATE qwen_runtime_binding_slot SET active_binding_id = NULL");
        assertBrokerCode(() -> bindings.findOrCreate(request), "csi_original_binding_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_binding", Integer.class)).isEqualTo(1);
        jdbc.update("UPDATE qwen_runtime_binding_slot SET active_binding_id = ?", binding.getBindingId());
        jdbc.update("UPDATE qwen_runtime_session SET session_state = 'RELEASED'");
        var original = transaction.execute(status -> jdbc.execute((ConnectionCallback<JdbcCsiFilesRetirementGuard.Original>)
                connection -> JdbcCsiFilesRetirementGuard.lockManagedSession(connection, "tenant", sessionId)));
        assertThat(original.bindingId()).isEqualTo(binding.getBindingId());
    }

    @Test
    void admissionRecheckReadsOnlyExistingReadySessionAndNeverRecreatesIt() {
        ready();
        var acquiring = bindings.admitSession(sessions, candidate(sessionId));
        var runtime = sessions.compareAndSet(acquiring,
                acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        var before = jdbc.queryForMap("SELECT * FROM qwen_runtime_session");
        var checked = bindings.requireSessionAdmission(sessions, runtime);
        assertThat(checked.getRuntimeSessionId()).isEqualTo(runtime.getRuntimeSessionId());
        assertThat(checked.getBindingId()).isEqualTo(runtime.getBindingId());
        assertThat(checked.getRuntimeGeneration()).isEqualTo(runtime.getRuntimeGeneration());
        assertThat(checked.getState()).isEqualTo(RuntimeSessionRecord.State.READY);
        assertThat(checked.getVersion()).isEqualTo(runtime.getVersion());
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_session")).isEqualTo(before);
        jdbc.update("UPDATE qwen_runtime_session SET session_state = 'RELEASED'");
        assertBrokerCode(() -> bindings.requireSessionAdmission(sessions, runtime), "runtime_session_not_ready");
        assertThat(jdbc.queryForObject("SELECT session_state FROM qwen_runtime_session", String.class)).isEqualTo("RELEASED");
        jdbc.update("DELETE FROM qwen_runtime_session");
        assertBrokerCode(() -> bindings.requireSessionAdmission(sessions, runtime), "runtime_session_not_ready");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_session", Integer.class)).isZero();
    }

    @Test
    void cachedAdmissionRecheckRefusesRetirementWithoutChangingSession() {
        ready();
        var acquiring = bindings.admitSession(sessions, candidate(sessionId));
        var runtime = sessions.compareAndSet(acquiring,
                acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        retire();
        var before = jdbc.queryForMap("SELECT * FROM qwen_runtime_session");
        assertBrokerCode(() -> bindings.requireSessionAdmission(sessions, runtime), "runtime_admission_closed");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_session")).isEqualTo(before);
    }

    @Test
    void releasedSecondSessionHistoryStillBlocksAdmission() {
        ready();
        bindings.admitSession(sessions, candidate(sessionId));
        jdbc.update("UPDATE qwen_runtime_session SET runtime_session_id = 'foreign-session', session_state = 'RELEASED'");
        var before = jdbc.queryForMap("SELECT * FROM qwen_runtime_session");
        assertBrokerCode(() -> bindings.admitSession(sessions, candidate(sessionId)), "csi_original_binding_unavailable");
        assertBrokerCode(() -> sessions.findOrCreate(candidate(sessionId)), "csi_original_binding_unavailable");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_session")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_session", Integer.class)).isEqualTo(1);
    }

    @Test
    void originalRequestHistoryCannotHideBehindAnotherIsolationKey() {
        ready();
        transaction.execute(status -> acquire());
        var second = new LinkedHashMap<>(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding"));
        second.put("binding_id", UUID.randomUUID().toString());
        second.put("runtime_generation", 2L);
        second.put("binding_state", "RELEASED");
        second.put("isolation_key", "foreign-owned-isolation-key");
        jdbc.update("INSERT INTO qwen_runtime_binding (" + String.join(",", second.keySet()) + ") VALUES ("
                + String.join(",", Collections.nCopies(second.size(), "?")) + ")", second.values().toArray());
        var before = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head");
        assertBrokerCode(() -> transaction.execute(status -> journal.renewWriter("tenant", sessionId, TOKEN,
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "writer", 1, 60_000L))),
                "csi_original_binding_unavailable");
        assertBrokerCode(() -> bindings.findOrCreate(request), "csi_original_binding_unavailable");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_binding", Integer.class)).isEqualTo(2);
        assertThat(reservations.inspect(registration)).isEqualTo(reservation);
    }

    @Test
    void legacyDiscriminatorCannotMissCsiAfterTheFirstTwoSortedCandidates() {
        ready();
        jdbc.update("UPDATE qwen_runtime_binding_slot SET request_key = ?", "f".repeat(64));
        jdbc.update("UPDATE managed_agent_session SET tool_profile = 'hosted-workspace-files/1', runtime_request_key = NULL");
        for (String key : new String[] {"0".repeat(64), "1".repeat(64), "2".repeat(64)}) {
            jdbc.update("INSERT INTO qwen_runtime_binding_slot (request_key, tenant_id, workspace_id, workspace_generation,"
                    + " canonical_cwd, capability_digest, isolation_class, isolation_key, provisioner_kind, storage_id,"
                    + " last_generation, active_binding_id) SELECT ?, tenant_id, workspace_id, workspace_generation,"
                    + " canonical_cwd, ?, isolation_class, isolation_key, provisioner_kind, storage_id,"
                    + " 0, NULL FROM qwen_runtime_binding_slot WHERE request_key = ?", key,
                    "sha256:" + "0".repeat(64), "f".repeat(64));
        }
        assertBrokerCode(() -> transaction.execute(status -> acquire()), "csi_original_binding_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head", Integer.class)).isZero();
        jdbc.update("DELETE FROM qwen_runtime_binding");
        jdbc.update("DELETE FROM qwen_runtime_binding_slot WHERE request_key = ?", "f".repeat(64));
        assertThat(transaction.execute(status -> acquire()).writerGeneration()).isEqualTo(1);
    }

    @Test
    void ordinarySlotReferencesCannotHideForeignCsiAfterTheFirstTwoCandidates() {
        ready();
        String legacyId = UUID.randomUUID().toString();
        for (int index = 0; index < 3; index++) {
            var scope = new RuntimeScope("tenant", "workspace", "3", "/workspace",
                    "sha256:" + Integer.toString(index).repeat(64), "session");
            bindings.findOrCreate(new RuntimeProvisionRequest(scope, legacyId));
        }
        var grant = transaction.execute(status -> journal.acquireWriter("tenant", legacyId, TOKEN,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "legacy-writer", 60_000L)));
        assertThat(grant.writerGeneration()).isEqualTo(1);
        var third = jdbc.queryForList("SELECT request_key, active_binding_id FROM qwen_runtime_binding_slot"
                + " WHERE tenant_id = 'tenant' AND isolation_key = ? ORDER BY request_key", legacyId).get(2);
        jdbc.update("UPDATE qwen_runtime_binding_slot SET active_binding_id = ? WHERE request_key = ?",
                binding.getBindingId(), third.get("request_key"));
        var before = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head");
        assertBrokerCode(() -> transaction.execute(status -> journal.renewWriter("tenant", legacyId, TOKEN,
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "legacy-writer", 1, 60_000L))),
                "csi_original_binding_unavailable");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head")).isEqualTo(before);
        jdbc.update("UPDATE qwen_runtime_binding_slot SET active_binding_id = ? WHERE request_key = ?",
                third.get("active_binding_id"), third.get("request_key"));
        assertThat(transaction.execute(status -> journal.renewWriter("tenant", legacyId, TOKEN,
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "legacy-writer", 1, 60_000L)))
                .writerGeneration()).isEqualTo(1);
    }

    @Test
    void privateWriterCannotBorrowAnUnboundConnection() {
        ready();
        assertThatThrownBy(this::acquire).isInstanceOf(IllegalStateException.class)
                .hasMessage("CSI mutation requires its original transaction connection");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head", Integer.class)).isZero();
    }

    @Test
    void newProfileCannotFallBackToLegacyAndLegacyCannotCarryItsPin() {
        ready();
        jdbc.update("UPDATE managed_agent_session SET tool_profile = 'hosted-workspace-files/1'");
        assertBrokerCode(() -> transaction.execute(status -> acquire()), "csi_original_binding_unavailable");
        jdbc.update("UPDATE managed_agent_session SET runtime_request_key = NULL");
        assertBrokerCode(() -> transaction.execute(status -> acquire()), "csi_original_binding_unavailable");
    }

    private ManagedSessionStoreModels.WriterGrant acquire() {
        return journal.acquireWriter("tenant", sessionId, TOKEN,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 60_000L));
    }

    private RuntimeSessionRecord candidate(String runtimeId) {
        return new RuntimeSessionRecord(new RuntimeSession(sessionId, runtimeId, "bootstrap", request.getScope()),
                binding.getBindingId(), binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
    }

    private void ready() {
        binding = bindings.findOrCreate(request);
        binding = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(120));
        reservation = reservations.reserve(registration, bindings, binding, UUID.randomUUID().toString());
        var handle = new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", "fixture-original"));
        var seed = binding.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("https://original.example.invalid"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        binding = bindings.compareAndSet(binding, binding.withAttestation(lease, handle, Instant.now(), Instant.now()));
    }

    private void retire() {
        reservations.beginRetirement(registration, bindings, binding, reservation, UUID.randomUUID().toString());
    }

    private static void assertBrokerCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }

    private static void assertApiCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
