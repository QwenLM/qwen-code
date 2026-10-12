package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceCsiReservationStoreTest {
    private DriverManagerDataSource source;
    private JdbcTemplate jdbc;
    private WorkspaceCsiReservationStore store;
    private JdbcRuntimeBindingRepository bindings;

    @BeforeEach
    void setUp() {
        source = new DriverManagerDataSource("jdbc:h2:mem:k2-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
        store = store(source);
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test-key", new byte[32]));
    }

    @Test
    void registrationIsImmutableAndAliasesShareThePhysicalOwnershipRow() {
        var first = registration("tenant", "storage", "backend", "opaque-handle", 1);
        var alias = registration("other-tenant", "other-storage", "backend", "opaque-handle", 7);
        store.register(first);
        Map<String, Object> original = jdbc.queryForMap("SELECT * FROM managed_workspace_csi_registration");
        store(source).register(first);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_csi_registration")).isEqualTo(original);
        assertUnavailable(() -> store.register(registration("tenant", "storage", "backend", "replacement", 1)));
        assertUnavailable(() -> store.register(registration("tenant", "storage", "backend", "opaque-handle", 2)));
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_csi_registration")).isEqualTo(original);
        store.register(alias);
        assertThat(alias.aliasKey()).isNotEqualTo(first.aliasKey());
        assertThat(alias.physicalKey()).isEqualTo(first.physicalKey());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease", Integer.class)).isEqualTo(1);
        assertThat(store(source).inspect(first).phase()).isEqualTo("RELEASED");
    }

    @Test
    void keysHaveLengthBoundariesAndDoNotNormalizeOpaqueIdentities() {
        var first = registration("tenant", "storage", "a", "bc", 1);
        assertThat(first.physicalKey()).isNotEqualTo(registration("tenant", "storage", "ab", "c", 1).physicalKey());
        assertThat(first.physicalKey()).isNotEqualTo(registration("tenant", "storage", "a", "BC", 1).physicalKey());
        assertThat(first.physicalKey()).isNotEqualTo(registration("tenant", "storage", "a", "bc ", 1).physicalKey());
        assertThat(registration("tenant", "storage", "backend", "卷😀", 1).physicalKey()).hasSize(64);
        assertThatThrownBy(() -> registration("tenant", "storage", "backend", "bad\ud800", 1))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("Invalid CSI workspace registration");
        assertThat(first.toString()).doesNotContain("bc", "backend");
    }

    @Test
    void corruptedRegistrationRefusesAdmissionWithoutMutatingOwnership() {
        var registration = registration("tenant", "storage", "backend", "sensitive-handle", 1);
        store.register(registration);
        Map<String, Object> original = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        for (String change : new String[] {"registration_revision = 2", "physical_key = 'wrong'",
                "tenant_id = 'wrong'", "registration_json = '{}'"}) {
            var row = jdbc.queryForMap("SELECT * FROM managed_workspace_csi_registration");
            jdbc.update("UPDATE managed_workspace_csi_registration SET " + change);
            assertUnavailable(() -> store.inspect(registration));
            assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(original);
            jdbc.update("DELETE FROM managed_workspace_csi_registration");
            jdbc.update("INSERT INTO managed_workspace_csi_registration"
                    + " (alias_key, tenant_id, storage_id, physical_key, registration_revision, registration_json)"
                    + " VALUES (?, ?, ?, ?, ?, ?)", row.get("alias_key"), row.get("tenant_id"), row.get("storage_id"),
                    row.get("physical_key"), row.get("registration_revision"), row.get("registration_json"));
        }
        String encoded = jdbc.queryForObject("SELECT registration_json FROM managed_workspace_csi_registration", String.class);
        for (String corrupt : new String[] {encoded + " {}", encoded.substring(0, encoded.length() - 1) + ",\"extra\":true}",
                "{\"tenantId\":\"wrong\"," + encoded.substring(1)}) {
            jdbc.update("UPDATE managed_workspace_csi_registration SET registration_json = ?", corrupt);
            assertUnavailable(() -> store.inspect(registration));
            assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(original);
        }
    }

    @Test
    void committedReservationSurvivesNewStoreAndRejectsAnotherAlias() {
        var first = registration("tenant", "storage", "backend", "handle", 1);
        var alias = registration("other", "alias", "backend", "handle", 1);
        store.register(first);
        store.register(alias);
        var binding = binding(first, "workspace", "session");
        String reservationId = UUID.randomUUID().toString();
        var reserved = store.reserve(first, bindings, binding, reservationId);
        assertThat(reserved.phase()).isEqualTo("RESERVED");
        assertThat(reserved.revision()).isEqualTo(1);
        assertThat(reserved.bindingId()).isEqualTo(binding.getBindingId());
        assertThat(reserved.provisionRequestId()).isEqualTo(binding.getProvisionSeed().getProvisionRequestId());
        assertThat(store(source).reserve(first, bindings, binding, reservationId)).isEqualTo(reserved);
        var competing = binding(alias, "different-workspace", "different-session");
        var rows = jdbc.queryForList("SELECT * FROM managed_workspace_execution_lease");
        assertThatThrownBy(() -> store.reserve(alias, bindings, competing, UUID.randomUUID().toString()))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_csi_busy");
                    assertThat(error.isRetryable()).isTrue();
                });
        assertThat(jdbc.queryForList("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(rows);
    }

    @Test
    void sameOperationRenewalAdmitsTheEarlierSnapshotWithoutChangingTheReservation() {
        var registration = registration("tenant", "storage", "backend", "handle", 1);
        store.register(registration);
        var original = binding(registration, "workspace", "session");
        var renewed = bindings.renewOperation(original.getBindingId(), original.getOperationOwner(),
                original.getOperationGeneration(), Duration.ofMinutes(10));
        assertThat(renewed).isNotNull();
        assertThat(renewed.getVersion()).isGreaterThan(original.getVersion());
        assertThat(renewed.getOperationLeaseUntil()).isAfter(original.getOperationLeaseUntil());
        String reservationId = UUID.randomUUID().toString();
        var reserved = store.reserve(registration, bindings, original, reservationId);
        var before = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        assertThat(store.reserve(registration, bindings, original, reservationId)).isEqualTo(reserved);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(before);
    }

    @Test
    void staleOperationAndDrainCannotModifyOrExpireThePhysicalReservation() {
        var registration = registration("tenant", "storage", "backend", "handle", 1);
        store.register(registration);
        var original = binding(registration, "workspace", "session");
        String reservationId = UUID.randomUUID().toString();
        var reserved = store.reserve(registration, bindings, original, reservationId);
        var before = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        for (String change : new String[] {"operation_owner = 'another'",
                "operation_generation = operation_generation + 1", "operation_lease_until = TIMESTAMP '2000-01-01 00:00:00'",
                "runtime_generation = runtime_generation + 1", "workspace_generation = '2'",
                "provision_request_id = 'changed'", "drain_requested = TRUE", "binding_state = 'READY'"}) {
            var snapshot = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding WHERE binding_id = ?", original.getBindingId());
            jdbc.update("UPDATE qwen_runtime_binding SET " + change + " WHERE binding_id = ?", original.getBindingId());
            assertUnavailable(() -> store.reserve(registration, bindings, original, reservationId));
            assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(before);
            for (String field : new String[] {"record_version", "operation_owner", "operation_generation",
                    "operation_lease_until", "runtime_generation", "workspace_generation", "provision_request_id",
                    "drain_requested", "binding_state"}) {
                jdbc.update("UPDATE qwen_runtime_binding SET " + field + " = ? WHERE binding_id = ?",
                        snapshot.get(field), original.getBindingId());
            }
        }
        assertThat(store.inspect(registration)).isEqualTo(reserved);
    }

    @Test
    void separateConnectionsSerializeAliasContenders() throws Exception {
        var first = registration("tenant", "storage", "backend", "handle", 1);
        var alias = registration("other", "alias", "backend", "handle", 1);
        store.register(first);
        store.register(alias);
        var firstBinding = binding(first, "workspace", "first-session");
        var secondBinding = binding(alias, "workspace", "second-session");
        var secondSource = new DriverManagerDataSource(source.getUrl(), "sa", "");
        var barrier = new CyclicBarrier(2);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var one = executor.submit(() -> contend(store, bindings, first, firstBinding, barrier));
            var two = executor.submit(() -> contend(store(secondSource), new JdbcRuntimeBindingRepository(secondSource,
                    new AesGcmSecretProtector("test-key", new byte[32])), alias, secondBinding, barrier));
            assertThat(one.get(10, TimeUnit.SECONDS) + two.get(10, TimeUnit.SECONDS)).isEqualTo(1);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease"
                + " WHERE csi_phase = 'RESERVED'", Integer.class)).isEqualTo(1);
    }

    @Test
    void lostLocalBindingWithoutAHolderCanRetireAfterItsAliasIsRegisteredAsCsi() {
        var registration = registration("tenant", "storage", "backend", "handle", 1);
        var context = new ContextBinding("tenant", "workspace", 1, "storage", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var local = new WorkspaceExecutionStore(jdbc, new DataSourceTransactionManager(source));
        var session = localSession(context);
        var original = bindings.findById(session.getBindingId());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease", Long.class)).isZero();
        store.register(registration);
        var other = registration("other", "other-storage", "backend", "handle", 1);
        store.register(other);
        var csiBinding = binding(other, "other-workspace", "other-session");
        store.reserve(other, bindings, csiBinding, UUID.randomUUID().toString());
        var registrationRows = jdbc.queryForList("SELECT * FROM managed_workspace_csi_registration ORDER BY alias_key");
        var csiOwner = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        assertThat(csiOwner.get("csi_phase")).isEqualTo("RESERVED");
        var seed = original.getProvisionSeed();
        var loss = new RuntimeRecoveryEvidence(UUID.randomUUID().toString(),
                RuntimeRecoveryEvidence.Fact.JOURNAL_LOST,
                "registered-process-exit", Instant.now(), "host", seed.getProvisionRequestId(),
                seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(), seed.getLeaseId(),
                seed.getEpoch(), original.getResourceHandle());
        var stop = new RuntimeRecoveryEvidence(UUID.randomUUID().toString(),
                RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED,
                "registered-process-exit", Instant.now(), "host", seed.getProvisionRequestId(),
                seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(), seed.getLeaseId(),
                seed.getEpoch(), original.getResourceHandle());
        var lost = bindings.compareAndSet(original, original.withRecoveryEvidence(loss, null, Instant.now()));
        assertThat(lost).isNotNull();
        assertThatThrownBy(() -> local.releaseLost(lost)).isInstanceOf(RuntimeBrokerException.class);
        var stopped = bindings.compareAndSet(lost, lost.withRecoveryEvidence(loss, stop, Instant.now()));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var drained = bindings.recoverLost(sessions, executions, stopped);
        assertThat(drained.getState()).isEqualTo(RuntimeBindingRecord.State.LOST);
        local.releaseLost(drained);
        var released = bindings.finishLostRecovery(sessions, executions, drained);
        assertThat(released.getState()).isEqualTo(RuntimeBindingRecord.State.RELEASED);
        assertThat(bindings.findById(original.getBindingId()).getState()).isEqualTo(RuntimeBindingRecord.State.RELEASED);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(csiOwner);
        assertThat(jdbc.queryForList("SELECT * FROM managed_workspace_csi_registration ORDER BY alias_key"))
                .isEqualTo(registrationRows);
        assertThatThrownBy(() -> local.claim(context, session)).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> local.isHeld(context, session)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(csiOwner);
    }

    @Test
    void localHolderAndCsiRegistrationExcludeEachOtherWithoutChangingEitherOwner() {
        var registration = registration("tenant", "storage", "backend", "handle", 1);
        var context = new ContextBinding("tenant", "workspace", 1, "storage", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var local = new WorkspaceExecutionStore(jdbc, new DataSourceTransactionManager(source));
        var session = localSession(context);
        local.claim(context, session);
        var original = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        assertUnavailable(() -> store.register(registration));
        local.assertHeld(context, session);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(original);
        local.release(context, session);
        assertUnavailable(() -> store.register(registration));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_registration", Integer.class)).isZero();

        var csi = registration("other", "alias", "backend", "handle", 1);
        store.register(csi);
        var otherContext = new ContextBinding("other", "workspace", 1, "alias", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var otherSession = localSession(otherContext);
        var before = jdbc.queryForList("SELECT * FROM managed_workspace_execution_lease");
        assertThatThrownBy(() -> local.claim(otherContext, otherSession))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> local.isHeld(otherContext, otherSession)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForList("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(before);
    }

    @Test
    void reservationRequiresTheCompleteAuthoritativeSeedAndCsiKind() {
        var registration = registration("tenant", "storage", "backend", "handle", 1);
        store.register(registration);
        var original = binding(registration, "workspace", "session");
        var before = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        var seed = original.getProvisionSeed();
        var forged = new RuntimeProvisionSeed(seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(),
                seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(), "different-token");
        var fake = new RuntimeBindingRecord(original.getBindingId(), original.getRequest(), forged,
                original.getGeneration(), original.getState(), null, false, original.getOperationOwner(),
                original.getOperationLeaseUntil(), original.getOperationGeneration(), original.getVersion(),
                null, original.getLastActiveAt());
        assertUnavailable(() -> store.reserve(registration, bindings, fake, UUID.randomUUID().toString()));
        var localRequest = new RuntimeProvisionRequest(original.getRequest().getScope(), "session",
                "local-process", registration.storageId());
        var wrongKind = new RuntimeBindingRecord(original.getBindingId(), localRequest, seed,
                original.getGeneration(), original.getState(), null, false, original.getOperationOwner(),
                original.getOperationLeaseUntil(), original.getOperationGeneration(), original.getVersion(),
                null, original.getLastActiveAt());
        assertUnavailable(() -> store.reserve(registration, bindings, wrongKind, UUID.randomUUID().toString()));
        var snapshot = jdbc.queryForMap("SELECT provision_seed_ciphertext, credential_key_id FROM qwen_runtime_binding");
        for (String change : new String[] {"provision_seed_ciphertext = NULL", "credential_key_id = NULL",
                "provision_seed_ciphertext = 'corrupt'", "credential_key_id = 'different'"}) {
            jdbc.update("UPDATE qwen_runtime_binding SET " + change);
            assertUnavailable(() -> store.reserve(registration, bindings, original, UUID.randomUUID().toString()));
            assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(before);
            jdbc.update("UPDATE qwen_runtime_binding SET provision_seed_ciphertext = ?, credential_key_id = ?",
                    snapshot.get("provision_seed_ciphertext"), snapshot.get("credential_key_id"));
        }
        assertThat(store.reserve(registration, bindings, original, UUID.randomUUID().toString()).phase()).isEqualTo("RESERVED");
    }

    @Test
    void aliasRegistrationAndLocalClaimRefuseAnExistingTransaction() {
        var registration = registration("tenant", "storage", "backend", "handle", 1);
        var context = new ContextBinding("tenant", "workspace", 1, "storage", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var session = localSession(context);
        var local = new WorkspaceExecutionStore(jdbc, new DataSourceTransactionManager(source));
        var outer = new TransactionTemplate(new DataSourceTransactionManager(source));
        outer.executeWithoutResult(status -> {
            assertUnavailable(() -> store.register(registration));
            assertThatThrownBy(() -> local.claim(context, session))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_registration", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease", Integer.class)).isZero();
        store.register(registration);
        assertThat(store.inspect(registration).phase()).isEqualTo("RELEASED");
    }

    private RuntimeSessionRecord localSession(ContextBinding context) {
        var scope = new RuntimeScope(context.getTenantId(), context.getWorkspaceId(), "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        String sessionId = UUID.randomUUID().toString();
        var request = new RuntimeProvisionRequest(scope, sessionId, "local-process", context.getStorageId());
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "test", Duration.ofMinutes(5));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var ready = bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                new RuntimeResourceHandle("local-process", 2, Map.of("provider", "local-process")), Instant.now(), Instant.now()));
        return bindings.admitSession(new JdbcRuntimeSessionRepository(source),
                new RuntimeSessionRecord(new RuntimeSession(sessionId, UUID.randomUUID().toString(), "bootstrap", scope),
                        ready.getBindingId(), ready.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
    }

    private static int contend(WorkspaceCsiReservationStore store, JdbcRuntimeBindingRepository bindings,
            WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, CyclicBarrier barrier) throws Exception {
        barrier.await(5, TimeUnit.SECONDS);
        try {
            store.reserve(registration, bindings, binding, UUID.randomUUID().toString());
            return 1;
        } catch (RuntimeBrokerException error) {
            assertThat(error.getCode()).isEqualTo("workspace_csi_busy");
            return 0;
        }
    }

    private RuntimeBindingRecord binding(WorkspaceCsiRegistration registration, String workspace, String session) {
        var request = new RuntimeProvisionRequest(new RuntimeScope(registration.tenantId(), workspace, "1",
                registration.mountRoot(), "sha256:" + "a".repeat(64), "session"), session,
                "kubernetes-workspace", registration.storageId());
        var created = bindings.findOrCreate(request);
        return bindings.claimOperation(created.getBindingId(), "coordinator", Duration.ofMinutes(5));
    }

    static WorkspaceCsiRegistration registration(String tenant, String storage, String backend, String handle, long revision) {
        return new WorkspaceCsiRegistration(tenant, storage, "cluster", "workspace-test", "claim", "pvc-uid",
                "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", handle, backend, "serial", "/workspace", revision);
    }

    private static WorkspaceCsiReservationStore store(DriverManagerDataSource source) {
        return new WorkspaceCsiReservationStore(new JdbcTemplate(source),
                new DataSourceTransactionManager(source), new ObjectMapper());
    }

    private static void assertUnavailable(Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
            assertThat(error.getCode()).isEqualTo("workspace_csi_unavailable");
            assertThat(error.getMessage()).doesNotContain("handle", "backend", "serial");
        });
    }
}
