package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.assertj.core.api.ThrowableAssert;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedAgentWorkspaceReplayTest {
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private ManagedWorkspaceRegistry registry;
    private ManagedAgentStore store;
    private ManagedAgentProperties properties;
    private HarnessCoordinator coordinator;

    private ManagedAgentService service(AtomicBoolean files) {
        return service(files, null);
    }

    // A one-shot gate on the Workspace-files probe both Turn routes run
    // after the replay pre-read: while armed, the first caller to reach it
    // parks until the test lets it through, so a race's pre-read provably
    // precedes the recorder's commit.
    private static final class RaceGate {
        private final CountDownLatch parked = new CountDownLatch(1);
        private final CountDownLatch through = new CountDownLatch(1);
        private final AtomicBoolean armed = new AtomicBoolean(false);
    }

    // Parks the first caller to reach a gated probe after the gate is
    // armed, so a race's pre-read provably precedes the recorder's commit.
    private static void park(RaceGate gate) {
        if (gate != null && gate.armed.compareAndSet(true, false)) {
            gate.parked.countDown();
            try {
                if (!gate.through.await(30, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("race release timed out");
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
            }
        }
    }

    private ManagedAgentService service(AtomicBoolean files, RaceGate gate) {
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        park(gate);
                        return files.get();
                    }

                    // The rename race parks here: the racer's replay
                    // pre-read is already done and beginSessionRename has
                    // not yet run.
                    @Override
                    public boolean supportsFencedTitles() {
                        park(gate);
                        return true;
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
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, "ws-a", "storage-a", "ws-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')",
                tenant, "ws-a",
                "actor-a".getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')",
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
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        registry = new ManagedWorkspaceRegistry(jdbc);
        properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), events -> {}, registry, properties);
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
                Clock.systemUTC(), events -> {}, registry, properties);
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
        // the Session row becomes a tombstone.
        recordDelete(tenant, sessionId, "CLOSED");

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

    // The unbound shape: a legacy Session's delete admits from ACTIVE, its
    // operation row records that status, and the replay answers with it.
    @Test
    void aDeletedLegacySessionReplaysItsRenameAsLastVisible() {
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

        recordDelete(tenant, sessionId, "ACTIVE");

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
    // the unbound, the bound-creator and the bound readable-non-creator
    // shapes; the 409s the state and availability gates below would answer
    // are reserved for live Sessions.
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
            jdbc.update("UPDATE ma_session SET status ="
                            + " 'DELETED', deleted_at = 1, gmt_modified = 1,"
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
        // actor-b can read the Workspace but did not create the Session:
        // the tombstone fence must still beat the non-creator 409.
        assertNotFound(() -> service.submitTurn(tenant, "actor-b",
                "fresh-submit-bound-noncreator", bound, input));
    }

    // A caller with no Workspace grant must not learn whether a key is
    // live: against a tombstoned bound Session, an Idempotency-Key already
    // recorded under a different SUBMIT_TURN digest answers the same 404 as
    // a fresh key — the read grant runs above the replay, so the digest
    // mismatch never reaches the 409 the replay branch would answer.
    @Test
    void aReusedKeyAgainstADeletedSessionAnswers404ToAGrantlessActor() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        ManagedAgentService service = service(new AtomicBoolean(true));
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        String bound = boundSession(tenant);

        transaction.executeWithoutResult(status -> assertThat(
                service.submitTurn(tenant, "actor-a", "submit", bound, input)
                        .replayed()).isFalse());
        jdbc.update("UPDATE ma_session SET status = 'DELETED',"
                        + " deleted_at = 1, gmt_modified = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, bound);

        // actor-z holds no grant row at all.
        assertNotFound(() -> service.submitTurn(tenant, "actor-z", "submit",
                bound, List.of(new InputBlock("text", "other"))));
        assertNotFound(() -> service.submitTurn(tenant, "actor-z",
                "fresh-submit", bound, input));
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

        recordDelete(tenant, sessionId, "ARCHIVED");

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

    // The recorder admission: a non-creator OPERATOR's retry of his
    // own recorded key replays the recorded outcome — the retry an
    // idempotency key exists for — while another OPERATOR who never
    // recorded the key keeps the refusal.
    @Test
    void aNonCreatorOperatorReplaysHisOwnRecordedCommands() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        // A third actor holding OPERATOR who never records a key.
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role) VALUES (?, 'ws-a',"
                        + " ?, 'OPERATOR')",
                tenant, "actor-c".getBytes(StandardCharsets.UTF_8));
        ManagedAgentService service = service(new AtomicBoolean(true));
        List<InputBlock> input = List.of(new InputBlock("text", "go"));

        String turnId = transaction.execute(status -> {
            var admission = service.submitTurn(tenant, "actor-b", "submit-b",
                    sessionId, input);
            assertThat(admission.replayed()).isFalse();
            return admission.turnId();
        });
        transaction.executeWithoutResult(status -> {
            var replay = service.submitTurn(tenant, "actor-b", "submit-b",
                    sessionId, input);
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.turnId()).isEqualTo(turnId);
        });
        transaction.executeWithoutResult(status -> assertThat(
                service.cancelTurn(tenant, "actor-b", "cancel-b", sessionId,
                        turnId).replayed()).isFalse());
        transaction.executeWithoutResult(status -> {
            var replay = service.cancelTurn(tenant, "actor-b", "cancel-b",
                    sessionId, turnId);
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.turnId()).isEqualTo(turnId);
        });
        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-b", "rename-b",
                        sessionId, "his title").replayed()).isFalse());
        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-b", "rename-b",
                        sessionId, "his title").replayed()).isTrue());
        // Another OPERATOR who never recorded the keys keeps the refusal.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-c",
                        "submit-b", sessionId, input))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-c", "rename-b", sessionId, "his title"))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
    }

    // A receipt recorded before the recorder stamp existed reads back a
    // NULL actor. Its recorder was never stored, so it keeps the role-gated
    // replay it was recorded under: the non-creator recorder's retry across
    // the rollout answers the recorded outcome instead of the creator
    // gate's 409, as does any OPERATOR's, while the role gate above the
    // replay still refuses a reader.
    @Test
    void aReceiptRecordedBeforeTheRecorderStampKeepsItsRoleGatedReplay() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role) VALUES (?, 'ws-a',"
                        + " ?, 'OPERATOR')",
                tenant, "actor-c".getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role) VALUES (?, 'ws-a',"
                        + " ?, 'READER')",
                tenant, "actor-r".getBytes(StandardCharsets.UTF_8));
        ManagedAgentService service = service(new AtomicBoolean(true));
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        String turnId = transaction.execute(status -> service.submitTurn(
                tenant, "actor-b", "submit-b", sessionId, input).turnId());
        transaction.executeWithoutResult(status -> service.cancelTurn(tenant,
                "actor-b", "cancel-b", sessionId, turnId));
        transaction.executeWithoutResult(status -> service.renameSession(
                tenant, "actor-b", "rename-b", sessionId, "his title"));
        assertThat(jdbc.update("UPDATE ma_request_receipt SET actor_id = NULL"
                        + " WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ?"
                        + " AND operation IN ('SUBMIT_TURN', 'CANCEL_TURN',"
                        + " 'RENAME_SESSION')",
                tenant)).isEqualTo(3);

        for (String actor : List.of("actor-b", "actor-c")) {
            transaction.executeWithoutResult(status -> {
                var replay = service.submitTurn(tenant, actor, "submit-b",
                        sessionId, input);
                assertThat(replay.replayed()).isTrue();
                assertThat(replay.turnId()).isEqualTo(turnId);
            });
            transaction.executeWithoutResult(status -> {
                var replay = service.cancelTurn(tenant, actor, "cancel-b",
                        sessionId, turnId);
                assertThat(replay.replayed()).isTrue();
                assertThat(replay.turnId()).isEqualTo(turnId);
            });
            transaction.executeWithoutResult(status -> assertThat(
                    service.renameSession(tenant, actor, "rename-b",
                            sessionId, "his title").replayed()).isTrue());
        }
        // A different title falls through to beginSessionRename, whose
        // discovery gate admits the same legacy receipt: the digest
        // comparison answers, exactly as before the stamp.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-c", "rename-b", sessionId, "other title"))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("idempotency_conflict")));
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-r", "rename-b", sessionId, "his title"))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("session_operation_forbidden")));
    }

    // The tombstone fence stands above the role and replay gates: a
    // deleted bound Session answers the reads' 404 — never the
    // live-Session 403 or 409 — to a reader with a fresh key and to a
    // non-recorder OPERATOR reusing a recorded key, while the recorder's
    // own retry still answers the recorded outcome.
    @Test
    void aDeletedBoundSessionAnswers404AboveTheRoleAndReplayGates() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        // actor-r can read the Workspace but is below OPERATOR; actor-c
        // holds OPERATOR but never records a key.
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role) VALUES (?, 'ws-a',"
                        + " ?, 'READER')",
                tenant, "actor-r".getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role) VALUES (?, 'ws-a',"
                        + " ?, 'OPERATOR')",
                tenant, "actor-c".getBytes(StandardCharsets.UTF_8));
        ManagedAgentService service = service(new AtomicBoolean(true));
        List<InputBlock> input = List.of(new InputBlock("text", "go"));

        String turnId = transaction.execute(status -> service.submitTurn(
                tenant, "actor-a", "submit", sessionId, input).turnId());
        transaction.executeWithoutResult(status -> service.cancelTurn(tenant,
                "actor-a", "cancel", sessionId, turnId));
        // The live-Session refusals, pinned so the tombstone codes below
        // are measured against them.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-r",
                        "reader-live", sessionId, input))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode()).isEqualTo(
                                        "session_operation_forbidden")));
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-c",
                        "submit", sessionId, input))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
        jdbc.update("UPDATE ma_session SET status = 'DELETED',"
                        + " deleted_at = 1, gmt_modified = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, sessionId);

        // A fresh key from the reader meets 404, not the role gate's 403.
        assertNotFound(() -> service.submitTurn(tenant, "actor-r",
                "reader-submit", sessionId, input));
        assertNotFound(() -> service.cancelTurn(tenant, "actor-r",
                "reader-cancel", sessionId, turnId));
        // A recorded key answers the non-recorder OPERATOR 404, not the
        // creator gate's 409.
        assertNotFound(() -> service.submitTurn(tenant, "actor-c", "submit",
                sessionId, input));
        assertNotFound(() -> service.cancelTurn(tenant, "actor-c", "cancel",
                sessionId, turnId));
        // The recorder's own retries still answer the recorded outcome.
        transaction.executeWithoutResult(status -> assertThat(
                service.submitTurn(tenant, "actor-a", "submit", sessionId,
                        input).replayed()).isTrue());
        transaction.executeWithoutResult(status -> assertThat(
                service.cancelTurn(tenant, "actor-a", "cancel", sessionId,
                        turnId).replayed()).isTrue());
    }

    // The answer side of the recorder/creator gate: the pre-read can miss
    // a key the recorder holds in a still-open transaction, and the
    // in-store probe or the duplicate-key arm then answers the recorded
    // admission ungated. A non-creator OPERATOR losing that race must be
    // refused — the recorded outcome answers only to the actor who
    // recorded it and to the Session's creator.
    @Test
    void aRecordedAdmissionRacedByANonCreatorOperatorIsRefused()
            throws Exception {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role) VALUES (?, 'ws-a',"
                        + " ?, 'OPERATOR')",
                tenant, "actor-c".getBytes(StandardCharsets.UTF_8));
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        ExecutorService threads = Executors.newFixedThreadPool(2);
        RaceGate submitGate = new RaceGate();
        RaceGate cancelGate = new RaceGate();
        RaceGate renameGate = new RaceGate();
        // One gate per race: each race's service parks its racer on the
        // gate that race arms.
        ManagedAgentService submitService = service(
                new AtomicBoolean(true), submitGate);
        ManagedAgentService cancelService = service(
                new AtomicBoolean(true), cancelGate);
        ManagedAgentService renameService = service(
                new AtomicBoolean(true), renameGate);
        // The submit race's recorded Turn is the cancel race's target.
        AtomicReference<String> racedTurn = new AtomicReference<>();
        try {
            Object submitAnswer = raceSecondCaller(threads, submitGate,
                    () -> {
                        var admission = submitService.submitTurn(tenant,
                                "actor-a", "submit-race", sessionId, input);
                        assertThat(admission.replayed()).isFalse();
                        racedTurn.set(admission.turnId());
                        return admission;
                    },
                    () -> submitService.submitTurn(tenant, "actor-c",
                            "submit-race", sessionId, input));
            assertThat(submitAnswer).isInstanceOfSatisfying(
                    ApiException.class, error -> assertThat(error.getCode())
                            .isEqualTo("workspace_unavailable"));

            Object cancelAnswer = raceSecondCaller(threads, cancelGate,
                    () -> {
                        var admission = cancelService.cancelTurn(tenant,
                                "actor-a", "cancel-race", sessionId,
                                racedTurn.get());
                        assertThat(admission.replayed()).isFalse();
                        return admission;
                    },
                    () -> cancelService.cancelTurn(tenant, "actor-c",
                            "cancel-race", sessionId, racedTurn.get()));
            assertThat(cancelAnswer).isInstanceOfSatisfying(
                    ApiException.class, error -> assertThat(error.getCode())
                            .isEqualTo("workspace_unavailable"));

            // The rename twin: the in-store COMPLETED read-back arm must
            // re-run the recorder/creator gate on the command row, or the
            // racer is served the recorded rename body with replayed=true.
            Object renameAnswer = raceSecondCaller(threads, renameGate,
                    () -> {
                        var result = renameService.renameSession(tenant,
                                "actor-a", "rename-race", sessionId,
                                "raced title");
                        assertThat(result.replayed()).isFalse();
                        return result;
                    },
                    () -> renameService.renameSession(tenant, "actor-c",
                            "rename-race", sessionId, "raced title"));
            assertThat(renameAnswer).isInstanceOfSatisfying(
                    ApiException.class, error -> assertThat(error.getCode())
                            .isEqualTo("workspace_unavailable"));
        } finally {
            submitGate.through.countDown();
            cancelGate.through.countDown();
            renameGate.through.countDown();
            threads.shutdownNow();
        }
    }

    // The PENDING half of the rename race: the recorder's command row is
    // committed — still claimable — after the racer's replay pre-read ran
    // empty. The discovery branch in beginSessionRename must re-run the
    // recorder/creator rule there, not afterwards: claiming that delivery
    // would flip the recorder's command to COMPLETED under the racer's
    // name, and failing the digest comparison first would name the live
    // key the uniform refusal keeps hidden.
    @Test
    void aPendingRenameRacedByANonCreatorOperatorIsRefused()
            throws Exception {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role) VALUES (?, 'ws-a',"
                        + " ?, 'OPERATOR')",
                tenant, "actor-c".getBytes(StandardCharsets.UTF_8));
        ExecutorService threads = Executors.newFixedThreadPool(2);
        RaceGate renameGate = new RaceGate();
        ManagedAgentService renameService = service(
                new AtomicBoolean(true), renameGate);
        try {
            Object answer = raceSecondCaller(threads, renameGate,
                    () -> {
                        store.beginSessionRename(tenant, "rename-race",
                                new RequestDigests().digest(Map.of("sessionId",
                                        sessionId, "title", "raced title")),
                                sessionId, "raced title", "actor-a");
                        return null;
                    },
                    () -> renameService.renameSession(tenant, "actor-c",
                            "rename-race", sessionId, "raced title"));
            assertThat(answer).isInstanceOfSatisfying(
                    ApiException.class, error -> assertThat(error.getCode())
                            .isEqualTo("workspace_unavailable"));
            // The leaked claim never happened: the recorder's command is
            // still PENDING and its delivery never handed out an attempt.
            assertThat(jdbc.queryForObject("SELECT state FROM"
                            + " ma_request_receipt WHERE namespace ="
                            + " 'SESSION_COMMAND' AND tenant_id = ?"
                            + " AND operation = 'RENAME_SESSION'"
                            + " AND idempotency_key = ?",
                    String.class, tenant, "rename-race")).isEqualTo("PENDING");
            assertThat(jdbc.queryForObject("SELECT attempt_count FROM"
                            + " ma_operation WHERE operation_kind = 'RENAME'"
                            + " AND tenant_id = ? AND session_id = ?",
                    Integer.class, tenant, sessionId)).isZero();
            // The recorder's own retry passes the same discovery gate, not
            // only refuses other actors: it resumes the delivery to
            // completion.
            transaction.executeWithoutResult(status -> assertThat(
                    renameService.renameSession(tenant, "actor-a",
                            "rename-race", sessionId, "raced title")
                            .replayed()).isTrue());
        } finally {
            renameGate.through.countDown();
            threads.shutdownNow();
        }
    }

    // Runs the recorder inside a transaction it holds open after the write,
    // then lets the racer — parked on the files probe, its replay pre-read
    // already done — through only once the recorder has committed. The
    // racer's insert therefore meets the committed key with no chance for
    // the pre-read gate to have seen it.
    private Object raceSecondCaller(ExecutorService threads, RaceGate gate,
            Supplier<Object> recorder, Supplier<Object> racer)
            throws Exception {
        CountDownLatch recorded = new CountDownLatch(1);
        CountDownLatch commit = new CountDownLatch(1);
        Future<?> recorderDone = threads.submit(() -> {
            transaction.executeWithoutResult(status -> {
                recorder.get();
                recorded.countDown();
                try {
                    if (!commit.await(30, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("commit timed out");
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            });
        });
        try {
            assertThat(recorded.await(30, TimeUnit.SECONDS)).isTrue();
            gate.armed.set(true);
            Future<Object> racerDone = threads.submit(() -> {
                try {
                    return transaction.execute(status -> racer.get());
                } catch (ApiException error) {
                    return error;
                }
            });
            assertThat(gate.parked.await(30, TimeUnit.SECONDS)).isTrue();
            commit.countDown();
            recorderDone.get(30, TimeUnit.SECONDS);
            gate.through.countDown();
            return racerDone.get(30, TimeUnit.SECONDS);
        } finally {
            commit.countDown();
            gate.through.countDown();
        }
    }

    // The delete flow's durable footprint, as the lifecycle admission
    // writes it: a DELETE operation row naming the last-visible status,
    // then the Session row as a tombstone.
    private void recordDelete(String tenant, String sessionId,
            String statusBefore) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, sessionId);
        String target = ManagedSchemaKeys.key(sessionId);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key,"
                        + " session_scope_key, operation_id, operation_kind,"
                        + " tenant_id, session_id, target_kind, target_key,"
                        + " target_id, actor_digest, idempotency_key,"
                        + " idempotency_digest, request_digest, request_json,"
                        + " state, phase, admission_stage, delivery_state,"
                        + " session_status_before, available_at, gmt_create,"
                        + " gmt_modified, completed_at) VALUES (?, ?, ?,"
                        + " 'op-del', 'DELETE', ?, ?, 'SESSION', ?, ?, '',"
                        + " 'delete', ?, 'delete-digest', '{}', 'COMPLETED',"
                        + " 'COMPLETED', 'JAVA_DURABLE', 'CONFIRMED', ?, 0, 0,"
                        + " 0, 0)",
                ManagedSchemaKeys.operationKey(
                        ManagedSchemaContract.OperationKind.DELETE, scope,
                        target, "op-del"),
                scope, scope, tenant, sessionId, target, sessionId,
                ManagedSchemaKeys.key("delete"), statusBefore);
        jdbc.update("UPDATE ma_session SET status = 'DELETED',"
                        + " deleted_at = 1, gmt_modified = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, sessionId);
    }
}
