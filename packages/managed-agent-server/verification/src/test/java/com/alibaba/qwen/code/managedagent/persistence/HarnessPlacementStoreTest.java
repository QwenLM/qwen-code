package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ParkedTurn;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WakeStamp;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class HarnessPlacementStoreTest {
    protected JdbcTemplate jdbc;
    protected TransactionTemplate tx;
    protected JdbcHarnessPlacementStore placements;
    protected JdbcManagedSessionStore store;
    protected WriterCredentialPolicy credentials;
    private static final String TENANT = "tenant";
    private static final String SESSION = "session";
    private static final String WORKSPACE = "workspace";

    protected DataSource source() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:placement-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        var source = source();
        ManagedSchema.initialize(source);
        jdbc = new ReleaseFaultJdbc(source);
        tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        placements = new JdbcHarnessPlacementStore(jdbc);
        var properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey("0123456789abcdef0123456789abcdef");
        credentials = new WriterCredentialPolicy(properties);
        store = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc, credentials);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'qwen-code', 1, 1)", TENANT, SESSION);
    }

    @Test
    void freshBaselineRefusesAnAssignedPlacementWithoutItsOwner() {
        assertThat(jdbc.queryForMap("SELECT harness_instance_id, harness_owner_boot_id,"
                + " harness_placement_epoch, harness_placement_state FROM ma_session"))
                .containsEntry("harness_instance_id", null)
                .containsEntry("harness_owner_boot_id", null)
                .containsEntry("harness_placement_epoch", 0L)
                .containsEntry("harness_placement_state", "UNASSIGNED");
        assertThatThrownBy(() -> jdbc.update("UPDATE ma_session SET harness_instance_id = 'pod-a',"
                + " harness_placement_epoch = 1, harness_placement_state = 'ACTIVE'"))
                .isInstanceOfSatisfying(DataAccessException.class, error ->
                        assertThat(error.getMostSpecificCause().getMessage())
                                .containsIgnoringCase("ck_ma_harness_placement"));
        assertThat(placements.get(TENANT, SESSION)).isNull();
    }

    @ParameterizedTest
    @CsvSource({"CLOSE,CLOSING", "ARCHIVE,ARCHIVING", "DELETE,DELETING"})
    void pendingLifecycleCanMoveOnlyUnderItsCurrentClaimAndWriterFence(OperationKind kind, String pendingStatus) {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        jdbc.update("UPDATE ma_session SET status = ? WHERE tenant_id = ? AND session_id = ?", pendingStatus, TENANT, SESSION);
        jdbc.update("UPDATE ma_session_head SET phase = 'LIFECYCLE_ONLY', operation_id = 'close'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        jdbc.update("INSERT INTO ma_operation (operation_ref, scope_kind, scope_id, operation_id, operation_kind, tenant_id, session_id,"
                + " target_kind, target_id, request_digest, request_json, state, phase, delivery_state, claim_owner,"
                + " claim_generation, claim_until, lifecycle_protocol_version, gmt_create, gmt_modified)"
                + " VALUES (?, 'SESSION', ?, 'close', ?, ?, ?, 'SESSION', ?, ?, '{}', 'PENDING', 'LIFECYCLE_ONLY',"
                + " 'LEASED', 'worker', 7, ?, 1, 1, 1)",
                ManagedIdentityRefs.operationRef(kind.name(), TENANT, "SESSION", SESSION, SESSION, "close"),
                SESSION, kind.name(), TENANT, SESSION, SESSION,
                "f".repeat(64), JdbcHarnessPlacementStore.now(jdbc) + 60_000);
        var operation = new OperationRecord(TENANT, SESSION, "close", kind, "request", "PENDING",
                "ADMITTED", "LEASED", "ACTIVE", null, "worker", 7, 0, null, 1);
        assertThatThrownBy(() -> tx.execute(status -> placements.takeover(TENANT, SESSION, owner, "pod-b", "boot-b")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_placement_not_admitted");
        assertThatThrownBy(() -> tx.execute(status -> placements.takeoverForLifecycle(operation, owner, "pod-b", "boot-b")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_owner_still_live");
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 1 WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        var successor = tx.execute(status -> placements.takeoverForLifecycle(operation, owner, "pod-b", "boot-b"));
        assertThat(successor.epoch()).isEqualTo(2);
        jdbc.update("UPDATE ma_operation SET claim_generation = 8 WHERE operation_id = ?", "close");
        assertThatThrownBy(() -> tx.execute(status -> placements.assignForLifecycle(operation, "pod-c", "boot-c")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("workspace_lifecycle_claim_fenced");
    }

    @Test
    void terminalSessionsDoNotRetainAnOldClientAfterTheirWriterStops() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        assertThat(placements.hasUnreleasedOwnership("pod-a", "boot-a")).isTrue();
        jdbc.update("UPDATE ma_session_head SET state = 'SEALED' WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        assertThat(placements.hasUnreleasedOwnership("pod-a", "boot-a")).isFalse();
        jdbc.update("UPDATE ma_session SET status = 'ARCHIVED' WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        assertThat(placements.hasUnreleasedOwnership("pod-a", "boot-a")).isFalse();
        jdbc.update("UPDATE ma_session SET status = 'CLOSING' WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        assertThat(placements.hasUnreleasedOwnership("pod-a", "boot-a")).isTrue();
    }

    @Test
    void neverAcquiredPlacementCanMoveAndRejectsTheOriginalGrant() {
        var first = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        String originalToken = token(first);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head WHERE tenant_id = ? AND session_id = ?",
                Integer.class, TENANT, SESSION)).isZero();
        var successor = tx.execute(status -> placements.takeover(TENANT, SESSION, first, "pod-b", "boot-b"));
        assertThat(successor.epoch()).isEqualTo(2);
        assertThat(placements.get(TENANT, SESSION)).isEqualTo(successor);
        assertThatThrownBy(() -> tx.execute(status -> store.acquireWriter(TENANT, SESSION, originalToken,
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L))))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("writer_credential_invalid");
        var acquired = tx.execute(status -> store.acquireWriter(TENANT, SESSION, token(successor),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-b", 60_000L)));
        assertThat(acquired.writerGeneration()).isPositive();
    }

    @Test
    void placementIsStickyAndAFormerOwnerCannotReacquireAfterExpiry() {
        var first = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        var repeated = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-b", "boot-b"));
        assertThat(repeated).isEqualTo(first);
        String token = token(first);
        var grant = tx.execute(status -> store.acquireWriter(TENANT, SESSION, token,
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        assertThatThrownBy(() -> tx.execute(status -> placements.takeover(TENANT, SESSION, first, "pod-b", "boot-b")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_owner_still_live");
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 1 WHERE tenant_id = ? AND session_id = ?"
                + " AND head_kind = 'MANAGED_SESSION'", TENANT, SESSION);
        var next = tx.execute(status -> placements.takeover(TENANT, SESSION, first, "pod-b", "boot-b"));
        assertThat(next.epoch()).isEqualTo(2);
        assertThatThrownBy(() -> tx.execute(status -> store.acquireWriter(TENANT, SESSION, token,
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L))))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("writer_credential_invalid");
        var successor = tx.execute(status -> store.acquireWriter(TENANT, SESSION, token(next),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-b", 60_000L)));
        assertThat(successor.writerGeneration()).isGreaterThan(grant.writerGeneration());
        assertThatThrownBy(() -> tx.execute(status -> store.sealWriter(TENANT, SESSION, token,
                new ManagedSessionStoreModels.SealWriterRequest(WORKSPACE, "boot-a", grant.writerGeneration()))))
                .isInstanceOf(ManagedAgentException.class);
        var renewed = tx.execute(status -> store.renewWriter(TENANT, SESSION, token(next),
                new ManagedSessionStoreModels.RenewWriterRequest(WORKSPACE, "boot-b", successor.writerGeneration(), 60_000L)));
        assertThat(renewed)
                .extracting(ManagedSessionStoreModels.WriterGrant::writerGeneration).isEqualTo(successor.writerGeneration());
    }

    @ParameterizedTest
    @ValueSource(strings = {"ACTIVE", "QUIESCING"})
    void expiredCleanSuspensionIsFoundOnlyForADepartedOwner(String state) {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        if ("QUIESCING".equals(state)) {
            tx.executeWithoutResult(status -> store.quiesceOwnership(TENANT, SESSION, token(owner),
                    new ManagedSessionStoreModels.QuiesceOwnershipRequest(
                            WORKSPACE, "boot-a", 1, 1, "pod-a", "boot-a")));
        }
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3,"
                + " last_commit_digest = ?, activation_phase = 'released', activation_head_revision = 1,"
                + " writer_lease_until = 0 WHERE tenant_id = ? AND session_id = ?",
                "a".repeat(64), TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1, new WakeStamp(1, false, 0))));

        var candidates = placements.findExpiredSuspensions(Set.of("pod-b"), 10);
        assertThat(candidates).hasSize(1);
        assertThat(candidates.getFirst().state()).isEqualTo(state);
        assertThat(placements.findExpiredSuspensions(Set.of("pod-a", "pod-b"), 10)).isEmpty();

        var successor = tx.execute(status -> placements.takeover(TENANT, SESSION,
                candidates.getFirst(), "pod-b", "boot-b"));
        assertThat(successor.epoch()).isEqualTo(owner.epoch() + 1);
        assertThat(placements.hasUnreleasedOwnership("pod-a", "boot-a")).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record"
                + " WHERE domain = 'hosted_harness_release'", Integer.class)).isZero();
    }

    @Test
    void liveLeaseIsNotAReaperCandidate() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, activation_phase = 'released',"
                + " activation_head_revision = 1 WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1, new WakeStamp(1, false, 0))));

        assertThat(placements.findExpiredSuspensions(Set.of("pod-b"), 10)).isEmpty();
    }

    @Test
    void bareSealIsNotAReaperCandidate() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, activation_phase = 'released',"
                + " activation_head_revision = 1, writer_lease_until = 0"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1)));

        assertThat(placements.findExpiredSuspensions(Set.of("pod-b"), 10)).isEmpty();
    }

    @Test
    void releaseRevokesTheEpochBeforeSuccessorCasAndReplaysOnlyTheExactReceipt() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        String token = token(owner);
        var grant = tx.execute(status -> store.acquireWriter(TENANT, SESSION, token,
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.executeWithoutResult(status -> placements.quiesce(TENANT, SESSION, owner));
        assertThatThrownBy(() -> tx.execute(status -> store.acquireWriter(TENANT, SESSION, token,
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L))))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_placement_quiescing");
        tx.executeWithoutResult(status -> store.renewWriter(TENANT, SESSION, token,
                new ManagedSessionStoreModels.RenewWriterRequest(WORKSPACE, "boot-a", grant.writerGeneration(), 60_000L)));
        var release = new ManagedSessionStoreModels.ReleaseOwnershipRequest(WORKSPACE, "boot-a", grant.writerGeneration(),
                1, 1, "pod-a", "boot-a", "release-one", new ManagedSessionStoreModels.OwnershipCommitProof(3, "a".repeat(64)));
        assertThatThrownBy(() -> tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token, release)))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_release_proof_conflict");
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3, last_commit_digest = ?,"
                + " activation_epoch = 1, activation_phase = 'released', activation_head_revision = 1"
                + " WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'", "a".repeat(64), TENANT, SESSION);
        var receipt = tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token, release));
        assertThat(receipt.path("state").asText()).isEqualTo("RELEASED");
        assertThat(placements.get(TENANT, SESSION).state()).isEqualTo("RELEASED");
        assertThat(tx.<Boolean>execute(status -> placements.quiesce(TENANT, SESSION, owner))).isFalse();
        assertThat(placements.hasUnreleasedOwnership("pod-a", "boot-a")).isFalse();
        assertThat(placements.releaseReceipt(TENANT, SESSION, 1, "release-one")).containsEntry("state", "RELEASED");
        var repeated = tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token, release));
        assertThat(repeated).isEqualTo(receipt);
        for (Runnable stale : List.<Runnable>of(
                () -> store.acquireWriter(TENANT, SESSION, token, new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)),
                () -> store.renewWriter(TENANT, SESSION, token, new ManagedSessionStoreModels.RenewWriterRequest(WORKSPACE, "boot-a", grant.writerGeneration(), 60_000L)),
                () -> store.sealWriter(TENANT, SESSION, token, new ManagedSessionStoreModels.SealWriterRequest(WORKSPACE, "boot-a", grant.writerGeneration())),
                () -> store.authorizeOrdinary(TENANT, SESSION, token, new ManagedSessionStoreModels.AuthorizeLifecycleRequest(WORKSPACE, "boot-a", grant.writerGeneration())),
                () -> store.commit(TENANT, SESSION, token, emptyCommit(grant.writerGeneration())))) {
            assertThatThrownBy(() -> tx.executeWithoutResult(status -> stale.run())).isInstanceOf(ManagedAgentException.class)
                    .extracting("code").isEqualTo("harness_placement_released");
        }
        var next = tx.execute(status -> placements.takeover(TENANT, SESSION, placements.get(TENANT, SESSION), "pod-b", "boot-b"));
        assertThat(next.epoch()).isEqualTo(2);
        var afterTakeover = tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token, release));
        assertThat(afterTakeover).isEqualTo(receipt);
        assertThat(placements.hasUnreleasedOwnership("pod-b", "boot-b")).isTrue();
        assertThatThrownBy(() -> tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token,
                new ManagedSessionStoreModels.ReleaseOwnershipRequest(WORKSPACE, "boot-a", grant.writerGeneration(), 1, 1,
                        "pod-a", "boot-a", "different-operation", release.commitProof()))))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_release_operation_conflict");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE task_kind IS NOT NULL", Integer.class)).isZero();
        assertThatThrownBy(() -> store.restore(TENANT, WORKSPACE, SESSION, token)).isInstanceOf(ManagedAgentException.class);
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(next),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-b", 60_000L)));
        assertThat(store.restore(TENANT, WORKSPACE, SESSION, token(next)).journalRevision()).isEqualTo(1);
    }

    @Test
    void cleanSealedSuspensionCanReplaceAnAssignmentThatNeverAcquiredAWriter() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.executeWithoutResult(status -> store.quiesceOwnership(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.QuiesceOwnershipRequest(
                        WORKSPACE, "boot-a", 1, 1, "pod-a", "boot-a")));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3,"
                + " last_commit_digest = ?, activation_phase = 'released', activation_head_revision = 1"
                + " WHERE tenant_id = ? AND session_id = ?", "a".repeat(64), TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1,
                        new WakeStamp(1, false, 0, new ParkedTurn("prompt-1", 2_345, 7L)))));
        Long sealedModified = jdbc.queryForObject("SELECT gmt_modified FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, TENANT, SESSION);

        var request = new ManagedSessionStoreModels.ReleaseOwnershipRequest(
                WORKSPACE, "boot-a", 1, 1, 1, "pod-a", "boot-a", "release-clean-seal",
                new ManagedSessionStoreModels.OwnershipCommitProof(3, "a".repeat(64)));
        var release = tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token(owner), request));

        assertThat(release.path("state").asText()).isEqualTo("RELEASED");
        assertThat(jdbc.queryForObject("SELECT writer_lease_until FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, TENANT, SESSION))
                .isGreaterThan(System.currentTimeMillis());
        assertThat(placements.get(TENANT, SESSION).state()).isEqualTo("RELEASED");
        assertThat(jdbc.queryForMap("SELECT state, wake_seal_revision, wake_seal_parked_prompt_id,"
                + " wake_seal_parked_approval_revision, gmt_modified FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION))
                .containsEntry("state", "SEALED")
                .containsEntry("wake_seal_revision", 1L)
                .containsEntry("wake_seal_parked_prompt_id", "prompt-1")
                .containsEntry("wake_seal_parked_approval_revision", 7L)
                .containsEntry("gmt_modified", sealedModified);
        var missed = tx.execute(status -> placements.takeover(TENANT, SESSION, owner, "pod-a", "boot-a"));
        assertThat(missed.epoch()).isEqualTo(owner.epoch() + 1);
        var successor = tx.execute(status -> placements.takeover(TENANT, SESSION, missed, "pod-b", "boot-b"));
        assertThat(successor.epoch()).isEqualTo(missed.epoch() + 1);
        assertThat(successor.instanceId()).isEqualTo("pod-b");
        assertThat(jdbc.queryForMap("SELECT writer_generation, wake_seal_revision, gmt_modified FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION))
                .containsEntry("writer_generation", 1L)
                .containsEntry("wake_seal_revision", 1L)
                .containsEntry("gmt_modified", sealedModified);
        var grant = tx.execute(status -> store.acquireWriter(TENANT, SESSION, token(successor),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-b", 60_000L)));
        assertThat(grant.writerGeneration()).isEqualTo(2);
        assertThat(tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token(owner), request))
                .equals(release)).isTrue();
        assertThatThrownBy(() -> tx.execute(status -> placements.takeover(TENANT, SESSION, successor, "pod-c", "boot-c")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_owner_still_live");
        assertThat(placements.get(TENANT, SESSION)).isEqualTo(successor);
    }

    @Test
    void bareSealedWriterCannotReleaseItsPlacement() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.executeWithoutResult(status -> store.quiesceOwnership(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.QuiesceOwnershipRequest(
                        WORKSPACE, "boot-a", 1, 1, "pod-a", "boot-a")));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3,"
                + " last_commit_digest = ?, activation_phase = 'released', activation_head_revision = 1"
                + " WHERE tenant_id = ? AND session_id = ?", "a".repeat(64), TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1)));
        var release = new ManagedSessionStoreModels.ReleaseOwnershipRequest(
                WORKSPACE, "boot-a", 1, 1, 1, "pod-a", "boot-a", "release-bare-seal",
                new ManagedSessionStoreModels.OwnershipCommitProof(3, "a".repeat(64)));

        assertThatThrownBy(() -> tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token(owner), release)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("managed_session_writer_conflict"));
        assertThat(placements.get(TENANT, SESSION).state()).isEqualTo("QUIESCING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record"
                + " WHERE domain = 'hosted_harness_release'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", String.class, TENANT, SESSION))
                .isEqualTo("SEALED");
    }

    @Test
    void staleWakeSealCannotReleaseItsPlacement() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.executeWithoutResult(status -> store.quiesceOwnership(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.QuiesceOwnershipRequest(
                        WORKSPACE, "boot-a", 1, 1, "pod-a", "boot-a")));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3,"
                + " last_commit_digest = ?, activation_phase = 'released', activation_head_revision = 1"
                + " WHERE tenant_id = ? AND session_id = ?", "a".repeat(64), TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1, new WakeStamp(1, false, 0))));
        jdbc.update("UPDATE ma_session_head SET wake_seal_revision = 0"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        var release = new ManagedSessionStoreModels.ReleaseOwnershipRequest(
                WORKSPACE, "boot-a", 1, 1, 1, "pod-a", "boot-a", "release-stale-wake",
                new ManagedSessionStoreModels.OwnershipCommitProof(3, "a".repeat(64)));

        assertThatThrownBy(() -> tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token(owner), release)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("managed_session_writer_conflict"));
        assertThat(placements.get(TENANT, SESSION).state()).isEqualTo("QUIESCING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record"
                + " WHERE domain = 'hosted_harness_release'", Integer.class)).isZero();
    }

    @Test
    void cleanSealedReleaseRollsBackItsReceiptWithoutRewritingTheSeal() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.executeWithoutResult(status -> store.quiesceOwnership(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.QuiesceOwnershipRequest(
                        WORKSPACE, "boot-a", 1, 1, "pod-a", "boot-a")));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3,"
                + " last_commit_digest = ?, activation_phase = 'released', activation_head_revision = 1"
                + " WHERE tenant_id = ? AND session_id = ?", "a".repeat(64), TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1, new WakeStamp(1, false, 0))));
        var release = new ManagedSessionStoreModels.ReleaseOwnershipRequest(
                WORKSPACE, "boot-a", 1, 1, 1, "pod-a", "boot-a", "release-clean-seal-rollback",
                new ManagedSessionStoreModels.OwnershipCommitProof(3, "a".repeat(64)));
        ((ReleaseFaultJdbc) jdbc).failPlacement = true;

        assertThatThrownBy(() -> tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token(owner), release)))
                .isInstanceOf(IllegalStateException.class).hasMessage("injected placement release failure");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE domain = 'hosted_harness_release'",
                Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE kind = ?",
                Integer.class, "managed-hosted_harness_release")).isZero();
        assertThat(placements.get(TENANT, SESSION).state()).isEqualTo("QUIESCING");
        assertThat(jdbc.queryForMap("SELECT state, wake_seal_revision FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION))
                .containsEntry("state", "SEALED")
                .containsEntry("wake_seal_revision", 1L);
    }

    @Test
    void releaseReceiptAndSealRollBackTogetherAndFenceAWaitingRenewal() throws Exception {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        String token = token(owner);
        var grant = tx.execute(status -> store.acquireWriter(TENANT, SESSION, token,
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.executeWithoutResult(status -> store.quiesceOwnership(TENANT, SESSION, token,
                new ManagedSessionStoreModels.QuiesceOwnershipRequest(WORKSPACE, "boot-a", grant.writerGeneration(), 1, "pod-a", "boot-a")));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3, last_commit_digest = ?,"
                + " activation_epoch = 1, activation_phase = 'released', activation_head_revision = 1"
                + " WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'", "a".repeat(64), TENANT, SESSION);
        var release = new ManagedSessionStoreModels.ReleaseOwnershipRequest(WORKSPACE, "boot-a", grant.writerGeneration(), 1, 1,
                "pod-a", "boot-a", "release-atomic", new ManagedSessionStoreModels.OwnershipCommitProof(3, "a".repeat(64)));
        ((ReleaseFaultJdbc) jdbc).failSeal = true;
        assertThatThrownBy(() -> tx.execute(status -> store.releaseOwnership(TENANT, SESSION, token, release)))
                .isInstanceOf(IllegalStateException.class).hasMessage("injected release seal failure");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE domain = 'hosted_harness_release'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE kind = ?", Integer.class,
                "managed-hosted_harness_release")).isZero();
        ((ReleaseFaultJdbc) jdbc).failSeal = false;
        var started = new CountDownLatch(1);
        var pending = new AtomicReference<Future<String>>();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            tx.executeWithoutResult(status -> {
                jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE", TENANT, SESSION);
                pending.set(executor.submit(() -> {
                    started.countDown();
                    try {
                        tx.executeWithoutResult(inner -> store.renewWriter(TENANT, SESSION, token,
                                new ManagedSessionStoreModels.RenewWriterRequest(WORKSPACE, "boot-a", grant.writerGeneration(), 60_000L)));
                        return "renewed";
                    } catch (ManagedAgentException refused) {
                        return refused.getCode();
                    }
                }));
                try {
                    assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
                store.releaseOwnership(TENANT, SESSION, token, release);
            });
            assertThat(pending.get().get(10, TimeUnit.SECONDS)).isEqualTo("harness_placement_released");
        }
        assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION' AND tenant_id = ? AND session_id = ?",
                String.class, TENANT, SESSION)).isEqualTo("SEALED");
    }

    @Test
    void scopeCredentialsAndAmbiguousControlIdsNeverEnterThePool() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        assertThatThrownBy(() -> tx.execute(status -> store.acquireWriter(TENANT, SESSION,
                credentials.issue(TENANT, WORKSPACE, SESSION),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L))))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("writer_credential_invalid");
        assertThatThrownBy(() -> tx.execute(status -> store.acquireWriter("other", SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L))))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("writer_credential_invalid");
        for (String tenant : List.of("one", "two")) {
            jdbc.update("INSERT INTO ma_session (tenant_id, session_id, session_kind, workspace_id, gmt_create, gmt_modified)"
                    + " VALUES (?, 'control', 'CONTROL', 'workspace', 1, 1)", tenant);
        }
        assertThatThrownBy(() -> tx.execute(status -> placements.assign("one", "control", "pod-a", "boot-a")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_session_scope_ambiguous");
    }

    @Test
    void claimIsReservedForItsPollerUntilItsWriterAcquires() {
        var released = released();
        assertThat(placements.findClaimCandidates(10)).isEmpty();
        assertThat(tx.<Long>execute(status -> placements.recordDemand(TENANT, SESSION))).isNotNegative();
        Long requestedAt = jdbc.queryForObject("SELECT harness_claim_requested_at FROM ma_session", Long.class);
        tx.execute(status -> placements.recordDemand(TENANT, SESSION));
        assertThat(jdbc.queryForObject("SELECT harness_claim_requested_at FROM ma_session", Long.class))
                .isEqualTo(requestedAt);
        assertThat(placements.findClaimCandidates(10)).containsExactly(released);

        var claim = tx.execute(status -> placements.claim(TENANT, SESSION, released, "pod-b", "boot-b"));
        assertThat(claim.placement().epoch()).isEqualTo(released.epoch() + 1);
        assertThat(claim.reservedUntil()).isGreaterThan(JdbcHarnessPlacementStore.now(jdbc));
        assertThat(placements.findClaimCandidates(10)).isEmpty();
        assertThat(placements.findReservedClaims("pod-b", "boot-b", 10)).containsExactly(claim);
        assertThat(placements.findReservedClaims("pod-c", "boot-c", 10)).isEmpty();
        for (Runnable other : List.<Runnable>of(
                () -> placements.claim(TENANT, SESSION, claim.placement(), "pod-c", "boot-c"),
                () -> placements.takeover(TENANT, SESSION, claim.placement(), "pod-c", "boot-c"))) {
            assertThatThrownBy(() -> tx.executeWithoutResult(status -> other.run()))
                    .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_owner_still_live");
        }

        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(claim.placement()),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-b", 60_000L)));
        assertThat(jdbc.queryForMap("SELECT harness_claim_requested_at, harness_claim_reserved_until FROM ma_session"))
                .containsEntry("harness_claim_requested_at", null)
                .containsEntry("harness_claim_reserved_until", null);
        assertThat(placements.findReservedClaims("pod-b", "boot-b", 10)).isEmpty();
        assertThatThrownBy(() -> tx.execute(status -> placements.takeover(TENANT, SESSION, claim.placement(), "pod-c", "boot-c")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("harness_owner_still_live");
    }

    @Test
    void lapsedReservationReopensTheSessionAndFencesTheFirstClaimersGrant() {
        var released = released();
        tx.execute(status -> placements.recordDemand(TENANT, SESSION));
        var first = tx.execute(status -> placements.claim(TENANT, SESSION, released, "pod-b", "boot-b"));
        jdbc.update("UPDATE ma_session SET harness_claim_reserved_until = 1 WHERE tenant_id = ? AND session_id = ?",
                TENANT, SESSION);
        assertThat(placements.findReservedClaims("pod-b", "boot-b", 10)).isEmpty();
        assertThat(placements.findClaimCandidates(10)).containsExactly(first.placement());

        var second = tx.execute(status -> placements.claim(TENANT, SESSION, first.placement(), "pod-c", "boot-c"));
        assertThat(second.placement().epoch()).isEqualTo(first.placement().epoch() + 1);
        assertThat(placements.findReservedClaims("pod-c", "boot-c", 10)).containsExactly(second);
        assertThatThrownBy(() -> tx.execute(status -> store.acquireWriter(TENANT, SESSION, token(first.placement()),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-b", 60_000L))))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("writer_credential_invalid");
    }

    @Test
    void pushTakeoverAnswersTheDemandWithoutAReservation() {
        var released = released();
        tx.execute(status -> placements.recordDemand(TENANT, SESSION));
        var pushed = tx.execute(status -> placements.takeover(TENANT, SESSION, released, "pod-b", "boot-b"));
        assertThat(pushed.epoch()).isEqualTo(released.epoch() + 1);
        assertThat(jdbc.queryForMap("SELECT harness_claim_requested_at, harness_claim_reserved_until FROM ma_session"))
                .containsEntry("harness_claim_requested_at", null)
                .containsEntry("harness_claim_reserved_until", null);
        assertThat(placements.findClaimCandidates(10)).isEmpty();
        assertThat(placements.findReservedClaims("pod-b", "boot-b", 10)).isEmpty();
    }

    @Test
    void claimCandidatesAreOpenSessionsOldestDemandFirst() {
        var released = released();
        tx.execute(status -> placements.recordDemand(TENANT, SESSION));
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, harness_instance_id, harness_owner_boot_id,"
                + " harness_placement_epoch, harness_placement_state, harness_claim_requested_at, gmt_create, gmt_modified)"
                + " VALUES (?, 'older', 'qwen-code', 'pod-a', 'boot-a', 1, 'RELEASED', 1, 1, 1)", TENANT);
        assertThat(placements.findClaimCandidates(10)).extracting(JdbcHarnessPlacementStore.Placement::sessionId)
                .containsExactly("older", SESSION);
        assertThat(placements.findClaimCandidates(1)).extracting(JdbcHarnessPlacementStore.Placement::sessionId)
                .containsExactly("older");
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = 'older'", TENANT);
        assertThat(placements.findClaimCandidates(10)).containsExactly(released);
    }

    @Test
    void demandIsNotACandidateWithoutAPlacementOrUnderALiveWriter() {
        tx.execute(status -> placements.recordDemand(TENANT, SESSION));
        assertThat(placements.findClaimCandidates(10)).isEmpty();
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.execute(status -> placements.recordDemand(TENANT, SESSION));
        assertThat(placements.findClaimCandidates(10)).isEmpty();
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 1 WHERE tenant_id = ? AND session_id = ?",
                TENANT, SESSION);
        assertThat(placements.findClaimCandidates(10)).containsExactly(owner);
        assertThatThrownBy(() -> tx.execute(status -> placements.recordDemand(TENANT, "missing")))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("session_not_found");
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void racingClaimsAndPushTakeoversAdmitOnePlacement(boolean pushRaces) throws Exception {
        var released = released();
        tx.execute(status -> placements.recordDemand(TENANT, SESSION));
        var start = new CountDownLatch(1);
        var pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<?>> attempts = List.of(
                    pool.submit(() -> {
                        start.await();
                        return tx.execute(status -> placements.claim(TENANT, SESSION, released, "pod-b", "boot-b"));
                    }),
                    pool.submit(() -> {
                        start.await();
                        return pushRaces
                                ? tx.execute(status -> placements.takeover(TENANT, SESSION, released, "pod-c", "boot-c"))
                                : tx.execute(status -> placements.claim(TENANT, SESSION, released, "pod-c", "boot-c"));
                    }));
            start.countDown();
            int admitted = 0;
            for (var attempt : attempts) {
                try {
                    attempt.get(30, TimeUnit.SECONDS);
                    admitted++;
                } catch (ExecutionException refused) {
                    assertThat(refused.getCause()).isInstanceOf(ManagedAgentException.class)
                            .extracting("code").isEqualTo("harness_placement_changed");
                }
            }
            assertThat(admitted).isEqualTo(1);
            assertThat(placements.get(TENANT, SESSION).epoch()).isEqualTo(released.epoch() + 1);
        } finally {
            pool.shutdownNow();
        }
    }

    private JdbcHarnessPlacementStore.Placement released() {
        var owner = tx.execute(status -> placements.assign(TENANT, SESSION, "pod-a", "boot-a"));
        tx.executeWithoutResult(status -> store.acquireWriter(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "boot-a", 60_000L)));
        tx.executeWithoutResult(status -> store.quiesceOwnership(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.QuiesceOwnershipRequest(WORKSPACE, "boot-a", 1, 1, "pod-a", "boot-a")));
        jdbc.update("UPDATE ma_session_head SET journal_revision = 1, committed_sequence = 3,"
                + " last_commit_digest = ?, activation_phase = 'released', activation_head_revision = 1"
                + " WHERE tenant_id = ? AND session_id = ?", "a".repeat(64), TENANT, SESSION);
        tx.executeWithoutResult(status -> store.sealWriter(TENANT, SESSION, token(owner),
                new SealWriterRequest(WORKSPACE, "boot-a", 1, new WakeStamp(1, false, 0))));
        tx.executeWithoutResult(status -> store.releaseOwnership(TENANT, SESSION, token(owner),
                new ManagedSessionStoreModels.ReleaseOwnershipRequest(WORKSPACE, "boot-a", 1, 1, 1, "pod-a", "boot-a",
                        "release-claim", new ManagedSessionStoreModels.OwnershipCommitProof(3, "a".repeat(64)))));
        var released = placements.get(TENANT, SESSION);
        assertThat(released.state()).isEqualTo("RELEASED");
        return released;
    }

    private String token(JdbcHarnessPlacementStore.Placement placement) {
        return credentials.issue(TENANT, WORKSPACE, SESSION, placement.instanceId(), placement.bootId(), placement.epoch());
    }

    private ManagedSessionStoreModels.CommitTransactionRequest emptyCommit(long generation) {
        String records = "{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n";
        return new ManagedSessionStoreModels.CommitTransactionRequest(WORKSPACE, "boot-a", generation, 1, 3,
                "transaction", "session.create", "stale-command", "0".repeat(64), 0, 0, 0, null, null, null, 0, null,
                2, Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)), DigestUtils.sha256Hex(records), List.of());
    }

    private static final class ReleaseFaultJdbc extends ManagedSchemaJdbcTemplate {
        private boolean failSeal;
        private boolean failPlacement;

        private ReleaseFaultJdbc(DataSource source) {
            super(source);
        }

        @Override
        public int update(String sql, Object... args) {
            if (failSeal && sql.startsWith("UPDATE ma_session_head SET state = 'SEALED'")) {
                throw new IllegalStateException("injected release seal failure");
            }
            if (failPlacement && sql.startsWith("UPDATE ma_session SET harness_placement_state = 'RELEASED'")) {
                throw new IllegalStateException("injected placement release failure");
            }
            return super.update(sql, args);
        }
    }
}
