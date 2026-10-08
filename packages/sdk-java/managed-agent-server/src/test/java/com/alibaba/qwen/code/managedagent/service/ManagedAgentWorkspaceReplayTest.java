package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.assertj.core.api.ThrowableAssert;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class ManagedAgentWorkspaceReplayTest {

    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private ManagedWorkspaceRegistry registry;
    private ManagedAgentStore store;
    private ManagedAgentProperties properties;
    private HarnessCoordinator coordinator;

    private ManagedAgentService service(AtomicBoolean files) {
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return files.get();
                    }

                    @Override
                    public Attachment createOrLoad(String tenantId,
                            String sessionId, boolean loadExisting) {
                        return new Attachment("boot");
                    }

                    @Override
                    public void rename(String tenantId, String sessionId,
                            String title) {
                    }
                };
        coordinator = mock(HarnessCoordinator.class);
        return new ManagedAgentService(store, new RequestDigests(),
                coordinator, harness, registry);
    }

    private String boundSession(String tenant) {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, "ws-a", "storage-a", "ws-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)",
                tenant, "ws-a",
                "actor-a".getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)",
                tenant, "ws-a",
                "actor-b".getBytes(StandardCharsets.UTF_8));
        return transaction.execute(status -> store
                .insertWorkspaceSessionCommand(tenant, "actor-a", "create",
                        "sha256:" + "a".repeat(64), "qwen-code", null, null,
                        List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId());
    }

    private void freshDatabase() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:workspace-replay-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"
                + ";LOCK_TIMEOUT=10000");
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
        transaction = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        registry = new ManagedWorkspaceRegistry(jdbc);
        properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), events -> { }, registry, properties);
    }

    // The recorded submit must answer through a Workspace-files outage, like
    // the recorded create does: the availability gate waits below the replay,
    // while the actor gate stays above it.
    @Test
    void aRecordedSubmitAnswersThroughAWorkspaceFilesOutage() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        AtomicBoolean files = new AtomicBoolean(true);
        ManagedAgentService service = service(files);
        List<InputBlock> input = List.of(new InputBlock("text", "go"));

        String turnId = transaction.execute(status -> {
            var admission = service.submitTurn(tenant, "actor-a", "submit",
                    sessionId, input);
            assertThat(admission.replayed()).isFalse();
            return admission.turnId();
        });

        files.set(false);
        clearInvocations(coordinator);
        transaction.executeWithoutResult(status -> {
            var replay = service.submitTurn(tenant, "actor-a", "submit",
                    sessionId, input);
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.turnId()).isEqualTo(turnId);
        });
        // The replay answers its recorded 202 but must not re-dispatch the
        // Turn: a client's own retries would otherwise spend the
        // pre-admission budget the files hold charges.
        verify(coordinator, never()).dispatch(tenant, sessionId, turnId);
        // The same budget claim in durable form: the Turn never deferred,
        // so it stays parked where the availability-gated sweep can
        // re-offer it once the files return.
        TurnRecord row = store.findTurn(tenant, sessionId, turnId)
                .orElseThrow();
        assertThat(row.status()).isEqualTo("ACCEPTED");
        assertThat(row.retryCount()).isZero();
        assertThat(store.findDispatchable(System.currentTimeMillis(), 10))
                .extracting(DispatchTarget::turnId)
                .contains(turnId);
        // The outage changes nothing about who the recorded outcome answers
        // to...
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-b",
                        "submit", sessionId, input))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
        // ...and a fresh key keeps the honest refusal.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-a",
                        "submit-fresh", sessionId, input))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
    }

    // A delete-tolerant rename replay shows the Session as last visible, but
    // the capabilities must describe the tombstone: every route they gate
    // reads through requireVisibleSession and answers 404 once deleted_at is
    // set, so a replayed body must not advertise them.
    @Test
    void aDeletedBoundSessionReplaysItsRenameWithoutAdvertisingArtifacts() {
        freshDatabase();
        properties.getArtifacts().setEnabled(true);
        // A non-yolo approval mode keeps the actions capability live before
        // the delete; the store snapshots it at construction.
        properties.getHarness().setApprovalMode("default");
        store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), events -> { }, registry, properties);
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService service = service(new AtomicBoolean(true));
        ManagedArtifactReader reader = mock(ManagedArtifactReader.class);
        when(reader.supported()).thenReturn(true);
        service.configureArtifacts(properties, reader);

        transaction.executeWithoutResult(status -> {
            var renamed = service.renameSession(tenant, "actor-a", "rename",
                    sessionId, "new title");
            assertThat(renamed.replayed()).isFalse();
            // The capabilities are live before the delete, so their absence
            // in the replay is measured rather than defaulted.
            assertThat(renamed.body().capabilities().artifacts()).isTrue();
            assertThat(renamed.body().capabilities().actions()).isTrue();
        });

        // The delete flow's durable footprint for a bound Session: the
        // operation row records the last-visible status — CLOSED or
        // ARCHIVED, the two pre-delete states a bound delete admits — and
        // the Session row becomes a tombstone. The command-row fallback can
        // never serve a bound delete: its only writer refused bound
        // Sessions since the binding existed.
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before, available_at, created_at,"
                        + " updated_at, completed_at) VALUES (?, ?, 'op-del',"
                        + " 'DELETE', '', 'delete', 'delete-digest',"
                        + " 'COMPLETED', 'JAVA_DURABLE', 'CONFIRMED',"
                        + " 'CLOSED', 0, 0, 0, 0)",
                tenant, sessionId);
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED',"
                        + " deleted_at = 1, updated_at = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, sessionId);

        transaction.executeWithoutResult(status -> {
            var replay = service.renameSession(tenant, "actor-a", "rename",
                    sessionId, "new title");
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.body().status()).isEqualTo("closed");
            assertThat(replay.body().capabilities().items()).isFalse();
            assertThat(replay.body().capabilities().snapshots()).isFalse();
            assertThat(replay.body().capabilities().artifacts()).isFalse();
            assertThat(replay.body().capabilities().resync()).isFalse();
            assertThat(replay.body().capabilities().tasks()).isFalse();
            assertThat(replay.body().capabilities().actions()).isFalse();
        });
    }

    // The pre-V17 footprint, on the only shape it can legitimately serve: an
    // unbound Session's delete wrote a DELETE_SESSION command row, and the
    // fallback query answers its last-visible status.
    @Test
    void aDeletedLegacySessionReplaysItsRenameFromTheCommandRowFallback() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        ManagedAgentService service = service(new AtomicBoolean(true));
        String sessionId = transaction.execute(status -> store
                .insertSessionCommand(tenant, "CREATE_SESSION", "create",
                        "create-digest", "qwen-code", null, null, List.of(),
                        null)
                .sessionId());

        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-a", "rename", sessionId,
                        "new title").replayed()).isFalse());

        jdbc.update("INSERT INTO managed_agent_command (tenant_id,"
                        + " operation, idempotency_key, request_digest,"
                        + " session_id, turn_id, command_status,"
                        + " session_status_before, created_at, updated_at)"
                        + " VALUES (?, 'DELETE_SESSION', 'delete',"
                        + " 'delete-digest', ?, NULL, 'COMPLETED', 'ACTIVE',"
                        + " 0, 0)",
                tenant, sessionId);
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED',"
                        + " deleted_at = 1, updated_at = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, sessionId);

        transaction.executeWithoutResult(status -> {
            var replay = service.renameSession(tenant, "actor-a", "rename",
                    sessionId, "new title");
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.body().status()).isEqualTo("active");
            // Every route the lifecycle flags gate answers 404 or 409 on
            // the tombstone, so the replayed body must not advertise them.
            assertThat(replay.body().capabilities().sessionLifecycle())
                    .isFalse();
            assertThat(replay.body().capabilities().sessionClose()).isFalse();
            assertThat(replay.body().capabilities().sessionArchive())
                    .isFalse();
            assertThat(replay.body().capabilities().sessionUnarchive())
                    .isFalse();
            assertThat(replay.body().capabilities().sessionDelete()).isFalse();
        });
    }

    // The fresh-key half of the split gate: only a recorded outcome
    // survives the delete. A fresh Idempotency-Key against a tombstone
    // answers 404 on both routes — as every other Session read does — for
    // the unbound and the bound-creator shapes; the 409s the state and
    // availability gates below would answer are reserved for live
    // Sessions.
    @Test
    void aFreshKeyAgainstADeletedSessionAnswers404() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        ManagedAgentService service = service(new AtomicBoolean(true));
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        String bound = boundSession(tenant);
        String legacy = transaction.execute(status -> store
                .insertSessionCommand(tenant, "CREATE_SESSION",
                        "create-legacy", "create-legacy-digest", "qwen-code",
                        null, null, List.of(), null)
                .sessionId());
        for (String sessionId : new String[] {bound, legacy}) {
            jdbc.update("UPDATE managed_agent_session SET status ="
                            + " 'DELETED', deleted_at = 1, updated_at = 1,"
                            + " version = version + 1 WHERE tenant_id = ?"
                            + " AND session_id = ?",
                    tenant, sessionId);
        }

        assertNotFound(() -> service.submitTurn(tenant, "actor-a",
                "fresh-submit-bound", bound, input));
        assertNotFound(() -> service.renameSession(tenant, "actor-a",
                "fresh-rename-bound", bound, "after delete"));
        assertNotFound(() -> service.submitTurn(tenant, "actor-a",
                "fresh-submit-legacy", legacy, input));
        assertNotFound(() -> service.renameSession(tenant, "actor-a",
                "fresh-rename-legacy", legacy, "after delete"));
    }

    private void assertNotFound(ThrowableAssert.ThrowingCallable call) {
        transaction.executeWithoutResult(status -> assertThatThrownBy(call)
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.NOT_FOUND);
                    assertThat(error.getCode()).isEqualTo("session_not_found");
                }));
    }

    // The other legal bound-delete footprint: an archived-then-deleted
    // bound Session records ARCHIVED as its last-visible status, and the
    // replay answers with it.
    @Test
    void aDeletedArchivedBoundSessionReplaysItsRenameAsArchived() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService service = service(new AtomicBoolean(true));

        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-a", "rename", sessionId,
                        "new title").replayed()).isFalse());

        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before, available_at, created_at,"
                        + " updated_at, completed_at) VALUES (?, ?, 'op-del',"
                        + " 'DELETE', '', 'delete', 'delete-digest',"
                        + " 'COMPLETED', 'JAVA_DURABLE', 'CONFIRMED',"
                        + " 'ARCHIVED', 0, 0, 0, 0)",
                tenant, sessionId);
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED',"
                        + " deleted_at = 1, updated_at = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, sessionId);

        transaction.executeWithoutResult(status -> {
            var replay = service.renameSession(tenant, "actor-a", "rename",
                    sessionId, "new title");
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.body().status()).isEqualTo("archived");
        });
    }

    // The cancel twin of the submit replay above: the recorded cancel must
    // also answer through a Workspace-files outage — cancelTurn runs the
    // same split gate, the actor check above the replay and the
    // availability refusal below it.
    @Test
    void aRecordedCancelAnswersThroughAWorkspaceFilesOutage() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        AtomicBoolean files = new AtomicBoolean(true);
        ManagedAgentService service = service(files);
        List<InputBlock> input = List.of(new InputBlock("text", "go"));

        String turnId = transaction.execute(status -> service.submitTurn(
                tenant, "actor-a", "submit", sessionId, input).turnId());
        transaction.executeWithoutResult(status -> assertThat(
                service.cancelTurn(tenant, "actor-a", "cancel", sessionId,
                        turnId).replayed()).isFalse());

        files.set(false);
        clearInvocations(coordinator);
        transaction.executeWithoutResult(status -> {
            var replay = service.cancelTurn(tenant, "actor-a", "cancel",
                    sessionId, turnId);
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.turnId()).isEqualTo(turnId);
        });
        // Same rule as the submit twin: the recorded cancel answers, the
        // Turn is not re-dispatched into the outage hold — and the durable
        // row proves the replay spent nothing: the first cancel's
        // CANCELLING stands, the budget is untouched, and the cancel
        // dispatch is still owed to the sweep.
        verify(coordinator, never()).dispatch(tenant, sessionId, turnId);
        TurnRecord row = store.findTurn(tenant, sessionId, turnId)
                .orElseThrow();
        assertThat(row.status()).isEqualTo("CANCELLING");
        assertThat(row.retryCount()).isZero();
        assertThat(store.findDispatchable(System.currentTimeMillis(), 10))
                .extracting(DispatchTarget::turnId)
                .contains(turnId);
        // The outage changes nothing about who the recorded outcome answers
        // to...
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.cancelTurn(tenant, "actor-b",
                        "cancel", sessionId, turnId))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
        // ...and a fresh key keeps the honest refusal.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.cancelTurn(tenant, "actor-a",
                        "cancel-fresh", sessionId, turnId))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
    }
}
