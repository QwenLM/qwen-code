package com.alibaba.qwen.code.managedagent.persistence;

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
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceCsiRetirementStoreTest {
    private DriverManagerDataSource source;
    private JdbcTemplate jdbc;
    private JdbcRuntimeBindingRepository bindings;
    private WorkspaceCsiReservationStore store;
    private WorkspaceCsiRegistration registration;
    private RuntimeBindingRecord original;
    private WorkspaceCsiReservationStore.Reservation reservation;

    @BeforeEach
    void setUp() {
        source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        bindings = bindings(source);
        store = store(source);
        registration = WorkspaceCsiReservationStoreTest.registration("tenant", "storage", "backend", "handle", 1);
        store.register(registration);
        original = binding(registration);
        reservation = store.reserve(registration, bindings, original, UUID.randomUUID().toString());
    }

    @Test
    void publicationReadsOriginalReservedAndRetirementInTheCallerTransaction() {
        ready();
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        var ready = transaction.execute(status -> store.lockPublication(bindings, original));
        assertThat(ready.binding().getState()).isEqualTo(RuntimeBindingRecord.State.READY);
        assertThat(ready.retirement()).isNull();
        var intent = store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        var draining = transaction.execute(status -> store.lockPublication(bindings, original));
        assertThat(draining.retirement()).isEqualTo(intent);
        assertThat(draining.binding().getVersion()).isEqualTo(intent.sealedBindingVersion());
        assertThat(store.inspect(registration).phase()).isEqualTo("DRAINING");
        assertThat(jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class))
                .isEqualTo(original.getBindingId());
    }

    @Test
    void retainedIdentityAcceptsStrictlyEquivalentHandleRepresentationAcrossMappers() throws Exception {
        var value = new LinkedHashMap<String, Object>();
        value.put("zeta", 2);
        value.put("alpha", 1);
        var seed = original.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        original = bindings.compareAndSet(original, original.withAttestation(lease,
                new RuntimeResourceHandle("kubernetes-workspace", 3, value), Instant.now(), Instant.now()));
        var ordered = new WorkspaceCsiReservationStore(jdbc, new DataSourceTransactionManager(source),
                new ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS));
        var intent = ordered.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        var sealed = bindings.findById(original.getBindingId());
        assertThat(intent.resourceHandleJson()).isEqualTo("{\"alpha\":1,\"zeta\":2}");
        assertThat(new ObjectMapper().writeValueAsString(sealed.getResourceHandle().getValue()))
                .isEqualTo("{\"zeta\":2,\"alpha\":1}");
        WorkspaceCsiReservationStore.requireRetainedIdentity(new ObjectMapper(), intent, registration, sealed);
        var json = new ObjectMapper();
        var representation = json.valueToTree(intent);
        ((com.fasterxml.jackson.databind.node.ObjectNode) representation).put("resourceHandleJson", " { \"zeta\" : 2, \"alpha\" : 1 } ");
        WorkspaceCsiReservationStore.requireRetainedIdentity(json,
                json.treeToValue(representation, WorkspaceCsiReservationStore.Retirement.class), registration, sealed);
        for (String invalid : new String[] {"{\"alpha\":1,\"zeta\":3}", "{\"alpha\":1,\"alpha\":1,\"zeta\":2}",
                "{\"alpha\":1,\"zeta\":2}{}", "[]"}) {
            var changed = (com.fasterxml.jackson.databind.node.ObjectNode) json.valueToTree(intent);
            changed.put("resourceHandleJson", invalid);
            var refused = json.treeToValue(changed, WorkspaceCsiReservationStore.Retirement.class);
            assertUnavailable(() -> WorkspaceCsiReservationStore.requireRetainedIdentity(json, refused, registration, sealed));
        }
        for (String field : new String[] {"resourceHandleKind", "runtimeInstanceId", "leaseId", "leaseDigest"}) {
            var changed = (com.fasterxml.jackson.databind.node.ObjectNode) json.valueToTree(intent);
            changed.put(field, "foreign");
            var refused = json.treeToValue(changed, WorkspaceCsiReservationStore.Retirement.class);
            assertUnavailable(() -> WorkspaceCsiReservationStore.requireRetainedIdentity(json, refused, registration, sealed));
        }
    }

    @Test
    void publicationRefusesMissingIntentAndMalformedRegistrationWithoutMutation() {
        ready();
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        String encoded = jdbc.queryForObject("SELECT registration_json FROM ma_storage", String.class);
        jdbc.update("UPDATE ma_storage SET registration_json = '{}' ");
        assertUnavailable(() -> transaction.execute(status -> store.lockPublication(bindings, original)));
        jdbc.update("UPDATE ma_storage SET registration_json = ?", encoded);
        store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        jdbc.update("DELETE FROM ma_operation");
        var holder = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        var binding = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.RUNTIME_BINDING.columns() + " FROM ma_runtime_binding");
        assertUnavailable(() -> transaction.execute(status -> store.lockPublication(bindings, original)));
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(holder);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.RUNTIME_BINDING.columns() + " FROM ma_runtime_binding")).isEqualTo(binding);
    }

    @Test
    void publicationCannotUseUnboundOrDifferentDataSourceAuthority() {
        ready();
        assertUnavailable(() -> store.lockPublication(bindings, original));
        var other = dataSource();
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        assertUnavailable(() -> transaction.execute(status -> store.lockPublication(bindings(other), original)));
        assertThat(store.inspect(registration)).isEqualTo(reservation);
    }

    @Test
    void publicationRefusesAParentWhichHasNotBecomeReady() {
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        assertUnavailable(() -> transaction.execute(status -> store.lockPublication(bindings, original)));
        assertThat(store.inspect(registration)).isEqualTo(reservation);
    }

    @Test
    void executionReaderSeesCallerUncommittedStateAndRejectsAutoCommit() throws Exception {
        ready();
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var acquiring = bindings.admitSession(sessions, session("session"));
        sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        var execution = prepare(sessions, executions, "reader");
        assertThat(executions.usesDataSource(source)).isTrue();
        assertThat(executions.usesDataSource(dataSource())).isFalse();
        try (var connection = source.getConnection()) {
            assertThatThrownBy(() -> executions.findByExecutionCallIdForUpdate(connection, "reader"))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        transaction.executeWithoutResult(status -> {
            jdbc.update("UPDATE ma_tool_execution SET cancel_requested = TRUE WHERE execution_call_id = X'726561646572'");
            var locked = jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<ToolExecutionRecord>) connection ->
                    executions.findByExecutionCallIdForUpdate(connection, "reader"));
            assertThat(locked.getExecutionCallId()).isEqualTo(execution.getExecutionCallId());
            assertThat(locked.isCancelRequested()).isTrue();
            status.setRollbackOnly();
        });
        assertThat(executions.findByExecutionCallId("reader").isCancelRequested()).isFalse();
    }

    @Test
    void preCreateBlockedHolderCommitsIntentAndSealWithoutReleasingOwnership() {
        original = bindings.compareAndSet(original, original.withState(
                RuntimeBindingRecord.State.RECOVERY_BLOCKED, null, Instant.now()));
        String operation = UUID.randomUUID().toString();
        var intent = store.beginRetirement(registration, bindings, original, reservation, operation);
        var sealed = bindings.findById(original.getBindingId());
        assertThat(sealed.getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
        assertThat(sealed.isDrainRequested()).isTrue();
        assertThat(sealed.getOperationOwner()).isNull();
        assertThat(sealed.getOperationGeneration()).isEqualTo(original.getOperationGeneration() + 1);
        assertThat(sealed.getVersion()).isEqualTo(original.getVersion() + 1);
        assertThat(intent.resourceHandleJson()).isNull();
        assertThat(intent.leaseId()).isNull();
        assertThat(intent.reservation()).isEqualTo(reservation);
        assertThat(store.inspect(registration).phase()).isEqualTo("DRAINING");
        assertThat(store.inspect(registration).revision()).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class))
                .isEqualTo(original.getBindingId());
        assertThat(jdbc.queryForObject("SELECT binding_id FROM ma_storage_owner", String.class))
                .isEqualTo(original.getBindingId());
        var restored = store(source);
        assertThat(restored.beginRetirement(registration, bindings(source), original, reservation, operation)).isEqualTo(intent);
        assertThat(restored.inspectRetirement(registration, bindings(source), sealed)).isEqualTo(intent);
    }

    @Test
    void freshCoordinatorCannotReopenReleaseOrReplacePinnedResources() {
        ready();
        var intent = store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        var fresh = bindings.claimOperation(original.getBindingId(), "new-coordinator", Duration.ofMinutes(1));
        for (var state : new RuntimeBindingRecord.State[] {RuntimeBindingRecord.State.READY,
                RuntimeBindingRecord.State.PROVISIONING, RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                RuntimeBindingRecord.State.FAILED, RuntimeBindingRecord.State.RELEASED, RuntimeBindingRecord.State.LOST}) {
            assertThatThrownBy(() -> bindings.compareAndSet(fresh,
                    fresh.withState(state, fresh.getLease(), Instant.now()))).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> bindings.compareAndSet(fresh, fresh.withDrainRequested(false, Instant.now())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> bindings.compareAndSet(fresh, fresh.withResourceHandle(
                new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", "replacement")), Instant.now())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> bindings.compareAndSet(fresh, fresh.withState(RuntimeBindingRecord.State.DRAINING,
                new RuntimeLease("foreign", URI.create("http://127.0.0.1:9"), "foreign", "foreign", 1), Instant.now())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> bindings.compareAndSet(fresh, fresh.withAttestation(
                fresh.getLease(), fresh.getResourceHandle(), Instant.now(), Instant.now())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(store.inspectRetirement(registration, bindings, fresh)).isEqualTo(intent);
        assertThat(bindings.findById(original.getBindingId()).getVersion()).isEqualTo(fresh.getVersion());
    }

    @Test
    void sealedDispatchRefusesNewWorkAndPreservesOriginalResultAndSessionRelease() {
        ready();
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var acquiring = bindings.admitSession(sessions, session("session"));
        var session = sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        var early = prepare(sessions, executions, "early");
        var late = prepare(sessions, executions, "late");
        var earlyClaim = executions.claimDispatch(early.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
        var executing = bindings.authorizeDispatch(sessions, executions, earlyClaim, "dispatcher", earlyClaim.getDispatchGeneration());
        store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        var lateClaim = executions.claimDispatch(late.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
        assertClosed(() -> bindings.authorizeDispatch(sessions, executions, lateClaim, "dispatcher", lateClaim.getDispatchGeneration()));
        assertThat(executions.findByExecutionCallId(late.getExecutionCallId()).getState()).isEqualTo(ToolExecutionRecord.State.DISPATCHING);
        assertClosed(() -> bindings.admitSession(sessions, session("new")));
        assertClosed(() -> prepare(sessions, executions, "new"));
        assertThat(bindings.admitExecution(sessions, executions, early).getExecutionCallId()).isEqualTo(early.getExecutionCallId());
        var settled = executions.compareAndSet(executing, executing.withResult(Map.of("executionStatus", "success"), 1, Instant.now()),
                "dispatcher", executing.getDispatchGeneration());
        assertThat(settled.getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
        assertThat(executions.requestCancel(lateClaim.getExecutionCallId(), lateClaim.getVersion()).isCancelRequested()).isTrue();
        var releasing = sessions.compareAndSet(session, session.withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
        assertThat(bindings.completeSessionRelease(sessions, releasing).getState()).isEqualTo(RuntimeSessionRecord.State.RELEASED);
        assertThat(store.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @Test
    void changedLeaseEndpointCannotReuseTheOriginalRetirement() {
        ready();
        String operation = UUID.randomUUID().toString();
        var intent = store.beginRetirement(registration, bindings, original, reservation, operation);
        assertThat(intent.leaseDigest()).matches("[0-9a-f]{64}");
        assertThat(retirementIdentity())
                .doesNotContain(original.getLease().getToken());
        jdbc.update("UPDATE ma_runtime_binding SET runtime_endpoint = 'http://127.0.0.1:10'");
        assertUnavailable(() -> store.inspectRetirement(registration, bindings, original));
        assertUnavailable(() -> store.beginRetirement(registration, bindings, original, reservation, operation));
        jdbc.update("UPDATE ma_runtime_binding SET runtime_endpoint = ?", original.getLease().getEndpoint().toString());
        assertThat(store.inspectRetirement(registration, bindings, original)).isEqualTo(intent);
    }

    @Test
    void duplicateJournalKeyRollsBackBindingAndPhysicalChanges() {
        String operation = UUID.randomUUID().toString();
        new WorkspaceOperations(jdbc, "tenant").create(WorkspaceOperations.Kind.CSI_RETIREMENT, operation,
                WorkspaceOperations.values("binding_id", "foreign", "runtime_generation", 1L, "state", "DRAINING", "identity_json", "{}"));
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.RUNTIME_BINDING.columns() + " FROM ma_runtime_binding WHERE binding_id = ?", original.getBindingId());
        var physical = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        assertThatThrownBy(() -> store.beginRetirement(registration, bindings, original, reservation, operation))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.RUNTIME_BINDING.columns() + " FROM ma_runtime_binding WHERE binding_id = ?", original.getBindingId())).isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(physical);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isEqualTo(1);
    }

    @Test
    void conflictingOperationOrRevisionCannotChangeTheOriginalJournal() {
        String operation = UUID.randomUUID().toString();
        var intent = store.beginRetirement(registration, bindings, original, reservation, operation);
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation");
        assertUnavailable(() -> store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString()));
        var stale = new WorkspaceCsiReservationStore.Reservation("RESERVED", 1, UUID.randomUUID().toString(),
                reservation.registrationKey(), reservation.registrationRevision(), reservation.bindingId(),
                reservation.runtimeGeneration(), reservation.provisionRequestId());
        assertUnavailable(() -> store.beginRetirement(registration, bindings, original, stale, operation));
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation")).isEqualTo(before);
        assertThat(store.inspectRetirement(registration, bindings, original)).isEqualTo(intent);
    }

    @Test
    void sameVolumeAliasIsStillBusyWhileUnrelatedVolumeCanReserve() {
        store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        var alias = WorkspaceCsiReservationStoreTest.registration("other", "alias", "backend", "handle", 1);
        store.register(alias);
        var contender = binding(alias);
        assertThatThrownBy(() -> store.reserve(alias, bindings, contender, UUID.randomUUID().toString()))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_csi_busy");
                    assertThat(error.isRetryable()).isTrue();
                });
        var unrelated = WorkspaceCsiReservationStoreTest.registration("other", "another", "backend", "another-handle", 1);
        store.register(unrelated);
        assertThat(store.reserve(unrelated, bindings, binding(unrelated), UUID.randomUUID().toString()).phase()).isEqualTo("RESERVED");
        assertThat(store.inspect(registration).bindingId()).isEqualTo(original.getBindingId());
    }

    @Test
    void lapsedOriginalClaimCannotSealOrCreateAnIntent() {
        jdbc.update("UPDATE ma_runtime_binding SET operation_lease_until = 946684800000");
        var expired = bindings.findById(original.getBindingId());
        assertUnavailable(() -> store.beginRetirement(registration, bindings, expired, reservation, UUID.randomUUID().toString()));
        assertThat(bindings.findById(original.getBindingId()).isDrainRequested()).isFalse();
        assertThat(store.inspect(registration)).isEqualTo(reservation);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isZero();
    }

    @Test
    void staleOriginalAndAmbientTransactionsCannotLeavePartialIntents() {
        var renewed = bindings.renewOperation(original.getBindingId(), original.getOperationOwner(), original.getOperationGeneration(), Duration.ofMinutes(2));
        assertUnavailable(() -> store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString()));
        var outer = new TransactionTemplate(new DataSourceTransactionManager(source));
        outer.executeWithoutResult(status -> {
            assertUnavailable(() -> store.beginRetirement(registration, bindings, renewed, reservation, UUID.randomUUID().toString()));
            assertUnavailable(() -> store.inspectRetirement(registration, bindings, renewed));
        });
        var foreignSource = new DriverManagerDataSource(source.getUrl(), "sa", "");
        assertUnavailable(() -> store.beginRetirement(registration, bindings(foreignSource), renewed, reservation, UUID.randomUUID().toString()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isZero();
        assertThat(store.inspect(registration)).isEqualTo(reservation);
    }

    @Test
    void corruptJournalOrChangedPinsBlockInspectionAndRetry() {
        String operation = UUID.randomUUID().toString();
        store.beginRetirement(registration, bindings, original, reservation, operation);
        String encoded = retirementIdentity();
        for (String corrupt : new String[] {"{}", encoded + " {}", encoded.substring(0, encoded.length() - 1) + ",\"extra\":true}"}) {
            updateRetirementIdentity(corrupt);
            assertUnavailable(() -> store.inspectRetirement(registration, bindings, original));
            assertUnavailable(() -> store.beginRetirement(registration, bindings, original, reservation, operation));
        }
        updateRetirementIdentity(encoded);
        jdbc.update("UPDATE ma_runtime_binding SET drain_requested = FALSE");
        assertUnavailable(() -> store.inspectRetirement(registration, bindings, original));
        assertThat(store.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @Test
    void freshBaselineRefusesLegacyHoldersWithoutChangingTheirEvidence() {
        var legacy = dataSource();
        var db = new ManagedSchemaJdbcTemplate(legacy);
        db.execute("CREATE TABLE managed_workspace_execution_lease (storage_key CHAR(64) PRIMARY KEY,"
                + " holder_key CHAR(64), binding_id VARCHAR(64), runtime_generation BIGINT, runtime_session_id VARCHAR(64))");
        db.execute("CREATE TABLE qwen_managed_session_extension_record (record_id VARCHAR(64) PRIMARY KEY, first_sequence BIGINT)");
        db.update("INSERT INTO managed_workspace_execution_lease VALUES (?, ?, 'original-binding', 9, 'original-session')",
                "1".repeat(64), "2".repeat(64));
        db.update("INSERT INTO qwen_managed_session_extension_record VALUES ('hook-1', 83)");
        var holder = db.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        var hook = db.queryForMap("SELECT * FROM qwen_managed_session_extension_record");
        assertThatThrownBy(() -> ManagedSchema.initialize(legacy)).isInstanceOf(IllegalStateException.class);
        assertThat(db.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(holder);
        assertThat(db.queryForMap("SELECT * FROM qwen_managed_session_extension_record")).isEqualTo(hook);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'ma_runtime_slot'", Integer.class))
                .isZero();
    }

    private String retirementIdentity() {
        String id = jdbc.queryForObject("SELECT operation_id FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT'", String.class);
        return (String) new WorkspaceOperations(jdbc, "tenant").find(WorkspaceOperations.Kind.CSI_RETIREMENT, id, false).get("identity_json");
    }

    private void updateRetirementIdentity(String identity) {
        String id = jdbc.queryForObject("SELECT operation_id FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT'", String.class);
        new TransactionTemplate(new DataSourceTransactionManager(source)).executeWithoutResult(ignored ->
                new WorkspaceOperations(jdbc, "tenant").update(WorkspaceOperations.Kind.CSI_RETIREMENT, id,
                        WorkspaceOperations.values("identity_json", identity)));
    }

    private void ready() {
        var seed = original.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        original = bindings.compareAndSet(original, original.withAttestation(lease,
                new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", "fixture-original")), Instant.now(), Instant.now()));
    }

    private RuntimeSessionRecord session(String id) {
        return new RuntimeSessionRecord(new RuntimeSession("harness", id, "bootstrap", original.getRequest().getScope()),
                original.getBindingId(), original.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
    }

    private ToolExecutionRecord prepare(JdbcRuntimeSessionRepository sessions, JdbcToolExecutionRepository executions, String id) {
        return bindings.admitExecution(sessions, executions, ToolExecutionRecord.prepared(id, id + "-key",
                original.getBindingId(), original.getGeneration(), "harness", "session", "turn", id, "digest",
                Map.of("sessionId", "session", "promptId", "turn", "callId", id, "argsDigest", "digest")));
    }

    private RuntimeBindingRecord binding(WorkspaceCsiRegistration value) {
        var request = new RuntimeProvisionRequest(new RuntimeScope(value.tenantId(), UUID.randomUUID().toString(), "1",
                value.mountRoot(), "sha256:" + "a".repeat(64), "session"), UUID.randomUUID().toString(), "kubernetes-workspace", value.storageId());
        var created = bindings.findOrCreate(request);
        return bindings.claimOperation(created.getBindingId(), "coordinator", Duration.ofMinutes(5));
    }

    private static DriverManagerDataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:retire-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    private static JdbcRuntimeBindingRepository bindings(DriverManagerDataSource dataSource) {
        return new JdbcRuntimeBindingRepository(dataSource, new AesGcmSecretProtector("test-key", new byte[32]));
    }

    private static WorkspaceCsiReservationStore store(DriverManagerDataSource dataSource) {
        return new WorkspaceCsiReservationStore(new ManagedSchemaJdbcTemplate(dataSource), new DataSourceTransactionManager(dataSource), new ObjectMapper());
    }

    private static void assertUnavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_csi_unavailable"));
    }

    private static void assertClosed(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("runtime_admission_closed"));
    }
}
