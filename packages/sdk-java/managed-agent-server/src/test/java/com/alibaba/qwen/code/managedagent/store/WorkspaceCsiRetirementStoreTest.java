package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
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
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceCsiRetirementStoreTest {
    private DriverManagerDataSource source;
    private JdbcTemplate jdbc;
    private JdbcRuntimeBindingRepository bindings;
    private WorkspaceCsiReservationStore store;
    private WorkspaceCsiRegistration registration;
    private RuntimeBindingRecord original;
    private WorkspaceCsiReservationStore.Reservation reservation;

    private static final List<String> PROGRESS_COLUMNS = List.of("progress_format", "progress_version", "progress_stage",
            "settlement_deadline_ms", "frozen_request_bytes", "frozen_request_sha256", "cut_bytes", "cut_sha256",
            "finalize_receipt_bytes", "finalize_receipt_sha256");

    @BeforeEach
    void setUp() {
        source = dataSource();
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
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
        assertThat(jdbc.queryForObject("SELECT active_binding_id FROM qwen_runtime_binding_slot", String.class))
                .isEqualTo(original.getBindingId());
    }

    @Test
    void unprovenLaterReservationCannotSealOrBecomePublicationAuthority() {
        ready();
        var binding = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding");
        var slot = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding_slot");
        var rows = jdbc.queryForList("SELECT * FROM managed_workspace_csi_retirement");
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        for (long revision : new long[] {4, 7}) {
            jdbc.update("UPDATE managed_workspace_execution_lease SET csi_revision = ?", revision);
            var holder = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
            var later = new WorkspaceCsiReservationStore.Reservation("RESERVED", revision,
                    reservation.reservationId(), reservation.registrationKey(), reservation.registrationRevision(),
                    reservation.bindingId(), reservation.runtimeGeneration(), reservation.provisionRequestId());
            assertUnavailable(() -> store(source).beginRetirement(registration, bindings, original,
                    later, UUID.randomUUID().toString()));
            assertUnavailable(() -> store(source).inspectRetirement(registration, bindings, original));
            assertUnavailable(() -> transaction.execute(status -> store.lockPublication(bindings, original)));
            assertThat(jdbc.queryForList("SELECT * FROM managed_workspace_csi_retirement")).isEqualTo(rows);
            assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(holder);
            assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding")).isEqualTo(binding);
            assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding_slot")).isEqualTo(slot);
        }
    }

    @Test
    void newRetirementInitializesSettlementAtTheExactDatabaseStartWithoutChangingItsIdentity() throws Exception {
        ready();
        var slot = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding_slot");
        var registered = jdbc.queryForMap("SELECT * FROM managed_workspace_csi_registration");
        var before = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class).toInstant();
        var intent = store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        var after = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class).toInstant();
        var row = jdbc.queryForMap("SELECT * FROM managed_workspace_csi_retirement");
        var startedAt = Instant.parse(intent.startedAt());
        assertThat(startedAt).isBetween(before, after);
        assertThat(row.get("progress_format")).isEqualTo("qwen-csi-application-retirement/1");
        assertThat(row.get("progress_version")).isEqualTo(1L);
        assertThat(row.get("progress_stage")).isEqualTo("SETTLING");
        assertThat(row.get("settlement_deadline_ms")).isEqualTo(Math.addExact(startedAt.toEpochMilli(), 300_000L));
        assertThat(row.get("phase")).isEqualTo("DRAINING");
        assertThat(row.get("identity_json")).isEqualTo(new ObjectMapper().writeValueAsString(intent));
        for (String column : PROGRESS_COLUMNS.subList(4, PROGRESS_COLUMNS.size())) {
            assertThat(row.get(column)).as(column).isNull();
        }
        var sealed = bindings.findById(original.getBindingId());
        assertThat(sealed.getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
        assertThat(sealed.isDrainRequested()).isTrue();
        assertThat(sealed.getOperationOwner()).isNull();
        assertThat(sealed.getOperationLeaseUntil()).isNull();
        assertThat(sealed.getOperationGeneration()).isEqualTo(original.getOperationGeneration() + 1);
        assertThat(sealed.getResourceHandle()).isEqualTo(original.getResourceHandle());
        assertThat(sealed.hasSameLease(original.getLease())).isTrue();
        assertThat(store.inspect(registration)).isEqualTo(new WorkspaceCsiReservationStore.Reservation("DRAINING", 2,
                reservation.reservationId(), reservation.registrationKey(), reservation.registrationRevision(),
                reservation.bindingId(), reservation.runtimeGeneration(), reservation.provisionRequestId()));
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding_slot")).isEqualTo(slot);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_csi_registration")).isEqualTo(registered);
    }

    @Test
    void originalRetryPreservesTheFixedDeadlineAndExactFrozenProgress() {
        String operation = UUID.randomUUID().toString();
        var intent = store.beginRetirement(registration, bindings, original, reservation, operation);
        byte[] frozen = "{\"original\":\"frozen-request\"}".getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE managed_workspace_csi_retirement SET progress_version = 2, progress_stage = 'FROZEN',"
                        + " frozen_request_bytes = ?, frozen_request_sha256 = ?", frozen,
                com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.sha256(frozen));
        var before = jdbc.queryForMap("SELECT retirement_id, binding_id, runtime_generation, physical_key, phase,"
                + " identity_json, progress_format, progress_version, progress_stage, settlement_deadline_ms,"
                + " frozen_request_sha256, cut_bytes, cut_sha256, finalize_receipt_bytes, finalize_receipt_sha256"
                + " FROM managed_workspace_csi_retirement");
        var sealed = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding");
        var holder = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        var fresh = store(source);
        assertThat(fresh.beginRetirement(registration, bindings(source), original, reservation, operation)).isEqualTo(intent);
        assertThat(fresh.inspectRetirement(registration, bindings(source), original)).isEqualTo(intent);
        var after = jdbc.queryForMap("SELECT * FROM managed_workspace_csi_retirement");
        before.forEach((column, value) -> assertThat(after.get(column)).as(column).isEqualTo(value));
        assertThat(jdbc.queryForObject("SELECT frozen_request_bytes FROM managed_workspace_csi_retirement", byte[].class))
                .containsExactly(frozen);
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding")).isEqualTo(sealed);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(holder);
    }

    @Test
    void originalRetryDoesNotInitializeLegacyNullProgress() {
        String operation = UUID.randomUUID().toString();
        var intent = store.beginRetirement(registration, bindings, original, reservation, operation);
        for (String column : PROGRESS_COLUMNS) {
            jdbc.update("UPDATE managed_workspace_csi_retirement SET " + column + " = NULL");
        }
        var before = jdbc.queryForMap("SELECT * FROM managed_workspace_csi_retirement");
        var fresh = store(source);
        assertThat(fresh.beginRetirement(registration, bindings(source), original, reservation, operation)).isEqualTo(intent);
        assertThat(fresh.inspectRetirement(registration, bindings(source), original)).isEqualTo(intent);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_csi_retirement")).isEqualTo(before);
    }

    @Test
    void holderFailureRollsBackNewProgressTogetherWithTheOriginalBindingSeal() {
        var before = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding");
        var slot = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding_slot");
        var holder = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        jdbc.execute("ALTER TABLE managed_workspace_execution_lease ADD CONSTRAINT keep_reserved CHECK (csi_phase = 'RESERVED')");
        assertThatThrownBy(() -> store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString()))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_retirement", Integer.class)).isZero();
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding")).isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding_slot")).isEqualTo(slot);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(holder);
    }

    @Test
    void applicationMigrationKeepsLegacyRowsByteExactAndLeavesEveryProgressColumnNull() {
        var legacy = dataSource();
        Flyway.configure().dataSource(legacy).locations("classpath:db/migration").target("66").load().migrate();
        var db = new JdbcTemplate(legacy);
        String operation = UUID.randomUUID().toString();
        String identity = "{ \"phase\": \"DRAINING\", \"startedAt\": \"2026-10-01T12:34:56.123456Z\" }";
        db.update("INSERT INTO managed_workspace_csi_retirement"
                        + " (retirement_id, binding_id, runtime_generation, physical_key, phase, identity_json)"
                        + " VALUES (?, 'legacy-binding', 1, ?, 'DRAINING', ?)", operation, "f".repeat(64), identity);
        var before = db.queryForMap("SELECT * FROM managed_workspace_csi_retirement");
        Flyway.configure().dataSource(legacy).locations("classpath:db/migration").load().migrate();
        var after = db.queryForMap("SELECT * FROM managed_workspace_csi_retirement");
        before.forEach((column, value) -> assertThat(after.get(column)).as(column).isEqualTo(value));
        assertThat(after).hasSize(before.size() + PROGRESS_COLUMNS.size());
        for (String column : PROGRESS_COLUMNS) {
            assertThat(after).containsKey(column);
            assertThat(after.get(column)).as(column).isNull();
        }
    }

    @Test
    void publicationRefusesMissingIntentAndMalformedRegistrationWithoutMutation() {
        ready();
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        String encoded = jdbc.queryForObject("SELECT registration_json FROM managed_workspace_csi_registration", String.class);
        jdbc.update("UPDATE managed_workspace_csi_registration SET registration_json = '{}' ");
        assertUnavailable(() -> transaction.execute(status -> store.lockPublication(bindings, original)));
        jdbc.update("UPDATE managed_workspace_csi_registration SET registration_json = ?", encoded);
        store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        jdbc.update("DELETE FROM managed_workspace_csi_retirement");
        var holder = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        var binding = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding");
        assertUnavailable(() -> transaction.execute(status -> store.lockPublication(bindings, original)));
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(holder);
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding")).isEqualTo(binding);
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
            jdbc.update("UPDATE qwen_tool_execution SET cancel_requested = TRUE WHERE execution_call_id = 'reader'");
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
        assertThat(jdbc.queryForObject("SELECT active_binding_id FROM qwen_runtime_binding_slot", String.class))
                .isEqualTo(original.getBindingId());
        assertThat(jdbc.queryForObject("SELECT binding_id FROM managed_workspace_execution_lease", String.class))
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
        assertThat(jdbc.queryForObject("SELECT identity_json FROM managed_workspace_csi_retirement", String.class))
                .doesNotContain(original.getLease().getToken());
        jdbc.update("UPDATE qwen_runtime_binding SET runtime_endpoint = 'http://127.0.0.1:10'");
        assertUnavailable(() -> store.inspectRetirement(registration, bindings, original));
        assertUnavailable(() -> store.beginRetirement(registration, bindings, original, reservation, operation));
        jdbc.update("UPDATE qwen_runtime_binding SET runtime_endpoint = ?", original.getLease().getEndpoint().toString());
        assertThat(store.inspectRetirement(registration, bindings, original)).isEqualTo(intent);
    }

    @Test
    void retainedIdentityUsesTheOriginalFullLeaseSnapshotWithoutReadingTheCurrentHolder() throws Exception {
        ready();
        var intent = store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString());
        var sealed = bindings.findById(original.getBindingId());
        var before = jdbc.queryForList("SELECT * FROM managed_workspace_execution_lease");
        var json = new ObjectMapper();
        WorkspaceCsiReservationStore.requireRetainedIdentity(json, intent, registration, sealed);
        for (String digest : new String[]{"0".repeat(64), "1".repeat(64)}) {
            var bytes = (com.fasterxml.jackson.databind.node.ObjectNode) json.valueToTree(intent);
            bytes.put("leaseDigest", digest);
            var altered = json.treeToValue(bytes, WorkspaceCsiReservationStore.Retirement.class);
            assertUnavailable(() -> WorkspaceCsiReservationStore.requireRetainedIdentity(json, altered, registration, sealed));
        }
        var lease = sealed.getLease();
        var changed = new RuntimeLease(lease.getRuntimeInstanceId(), URI.create("http://127.0.0.1:10"), lease.getToken(),
                lease.getLeaseId(), lease.getEpoch());
        var copy = sealed.withState(RuntimeBindingRecord.State.DRAINING, changed, Instant.now());
        assertUnavailable(() -> WorkspaceCsiReservationStore.requireRetainedIdentity(json, intent, registration, copy));
        assertThat(jdbc.queryForList("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(before);
        assertThat(bindings.findById(original.getBindingId()).getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
    }

    @Test
    void duplicateJournalKeyRollsBackBindingAndPhysicalChanges() {
        String operation = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_workspace_csi_retirement"
                        + " (retirement_id, binding_id, runtime_generation, physical_key, phase, identity_json)"
                        + " VALUES (?, 'foreign', 1, ?, 'DRAINING', '{}')",
                operation, "f".repeat(64));
        var before = jdbc.queryForMap("SELECT * FROM qwen_runtime_binding WHERE binding_id = ?", original.getBindingId());
        var physical = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        assertThatThrownBy(() -> store.beginRetirement(registration, bindings, original, reservation, operation))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_runtime_binding WHERE binding_id = ?", original.getBindingId())).isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(physical);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_retirement", Integer.class)).isEqualTo(1);
    }

    @Test
    void conflictingOperationOrRevisionCannotChangeTheOriginalJournal() {
        String operation = UUID.randomUUID().toString();
        var intent = store.beginRetirement(registration, bindings, original, reservation, operation);
        var before = jdbc.queryForMap("SELECT * FROM managed_workspace_csi_retirement");
        assertUnavailable(() -> store.beginRetirement(registration, bindings, original, reservation, UUID.randomUUID().toString()));
        var stale = new WorkspaceCsiReservationStore.Reservation("RESERVED", 1, UUID.randomUUID().toString(),
                reservation.registrationKey(), reservation.registrationRevision(), reservation.bindingId(),
                reservation.runtimeGeneration(), reservation.provisionRequestId());
        assertUnavailable(() -> store.beginRetirement(registration, bindings, original, stale, operation));
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_csi_retirement")).isEqualTo(before);
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
        jdbc.update("UPDATE qwen_runtime_binding SET operation_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        var expired = bindings.findById(original.getBindingId());
        assertUnavailable(() -> store.beginRetirement(registration, bindings, expired, reservation, UUID.randomUUID().toString()));
        assertThat(bindings.findById(original.getBindingId()).isDrainRequested()).isFalse();
        assertThat(store.inspect(registration)).isEqualTo(reservation);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_retirement", Integer.class)).isZero();
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_retirement", Integer.class)).isZero();
        assertThat(store.inspect(registration)).isEqualTo(reservation);
    }

    @Test
    void corruptJournalOrChangedPinsBlockInspectionAndRetry() {
        String operation = UUID.randomUUID().toString();
        store.beginRetirement(registration, bindings, original, reservation, operation);
        String encoded = jdbc.queryForObject("SELECT identity_json FROM managed_workspace_csi_retirement", String.class);
        for (String corrupt : new String[] {"{}", encoded + " {}", encoded.substring(0, encoded.length() - 1) + ",\"extra\":true}"}) {
            jdbc.update("UPDATE managed_workspace_csi_retirement SET identity_json = ?", corrupt);
            assertUnavailable(() -> store.inspectRetirement(registration, bindings, original));
            assertUnavailable(() -> store.beginRetirement(registration, bindings, original, reservation, operation));
        }
        jdbc.update("UPDATE managed_workspace_csi_retirement SET identity_json = ?", encoded);
        jdbc.update("UPDATE qwen_runtime_binding SET drain_requested = FALSE");
        assertUnavailable(() -> store.inspectRetirement(registration, bindings, original));
        assertThat(store.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @Test
    void migrationPreservesOriginalLocalHolderAndHookSequence() {
        var legacy = dataSource();
        Flyway.configure().dataSource(legacy).locations("classpath:db/migration").target("34").load().migrate();
        var db = new JdbcTemplate(legacy);
        db.update("INSERT INTO managed_workspace_execution_lease (storage_key, holder_key, binding_id, runtime_generation, runtime_session_id) VALUES (?, ?, 'original-binding', 9, 'original-session')",
                "1".repeat(64), "2".repeat(64));
        db.update("INSERT INTO qwen_managed_session_extension_record (session_scope_key, record_key, tenant_id, workspace_id,"
                + " session_id, domain, record_id, operation_hash, revision, record_resource_id, task_kind, task_state, created_at, first_sequence)"
                + " VALUES (?, ?, 'tenant', 'workspace', 'session', 'hook', 'hook-1', ?, 3, 'resource', 'hook', 'running', 1, 83)",
                "3".repeat(64), "4".repeat(64), "5".repeat(64));
        var holder = db.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        var hook = db.queryForMap("SELECT * FROM qwen_managed_session_extension_record");
        Flyway.configure().dataSource(legacy).locations("classpath:db/migration").load().migrate();
        var after = db.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        holder.forEach((key, value) -> assertThat(after.get(key)).isEqualTo(value));
        assertThat(after.get("storage_kind")).isEqualTo("LOCAL");
        assertThat(db.queryForMap("SELECT * FROM qwen_managed_session_extension_record")).isEqualTo(hook);
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
        return new WorkspaceCsiReservationStore(new JdbcTemplate(dataSource), new DataSourceTransactionManager(dataSource), new ObjectMapper());
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
