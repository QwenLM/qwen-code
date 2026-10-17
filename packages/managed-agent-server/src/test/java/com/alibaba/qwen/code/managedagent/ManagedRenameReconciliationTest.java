package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.store.StoreModels.RenameDelivery;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import javax.sql.DataSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * D7-2, RENAME phase: a Session title whose submitted delivery got no answer
 * parks recovery_blocked, is never sent again, holds neither later titles nor
 * the lifecycle, and settles only from the Session journal's commit of its
 * revision, or from its own claim's late reply.
 */
class ManagedRenameReconciliationTest {
    static final String TENANT = "rename-tenant";
    static final String OWNER = "title-worker";
    static final String TITLE = "Renamed";
    private final AtomicLong now = new AtomicLong(1_000_000);
    // A statement containing this text fails, as a dropped connection would.
    private final AtomicReference<String> failOn = new AtomicReference<>();
    ManagedAgentStore store;
    // The same store behind its @Transactional boundaries, as Spring wires
    // it: each call commits or rolls back as one transaction.
    AgentStateStore transactional;
    JdbcTemplate jdbc;
    String sessionId;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:rename-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return source;
    }

    @BeforeEach
    void setUp() {
        DataSource dataSource = dataSource();
        ManagedSchema.initialize(dataSource);
        jdbc = new ManagedSchemaJdbcTemplate(dataSource) {
            @Override
            public int update(String sql, Object... args) {
                String marker = failOn.get();
                if (marker != null && sql.contains(marker)) {
                    throw new IllegalStateException("injected fault");
                }
                return super.update(sql, args);
            }
        };
        Clock clock = new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return Instant.ofEpochMilli(now.get());
            }
        };
        store = new ManagedAgentStore(jdbc, new ObjectMapper(), clock,
                ignored -> {}, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        ProxyFactory proxy = new ProxyFactory(store);
        proxy.setInterfaces(AgentStateStore.class);
        proxy.addAdvice(new TransactionInterceptor(
                new DataSourceTransactionManager(dataSource),
                new AnnotationTransactionAttributeSource()));
        transactional = (AgentStateStore) proxy.getProxy();
        sessionId = store.insertSessionCommand(TENANT, "CREATE_SESSION",
                "create", "digest", "qwen-code", null, null, List.of(), null)
                .sessionId();
    }

    @Test
    void anUnansweredTitleParksForTheReconcilerAndIsNeverSentAgain() {
        RenameDelivery delivery = submitted("title-1", TITLE);
        store.abandonSessionRename(TENANT, "title-1", sessionId,
                delivery.revision(), OWNER);
        store.retryRename(delivery, OWNER, 0);
        Map<String, Object> parked = row(delivery.revision());
        assertThat(parked).containsEntry("state", "RECOVERY_BLOCKED")
                .containsEntry("phase", "RECOVERY_BLOCKED")
                .containsEntry("admission_stage", "JAVA_DURABLE")
                .containsEntry("delivery_state", "BLOCKED")
                .containsEntry("failure_code", "session_title_unconfirmed")
                // The claim stays, so its own late reply still settles it.
                .containsEntry("claim_owner", OWNER);
        assertThat(receipt("title-1")).isEqualTo("FAILED");
        assertThat(store.findParkedOperations(50))
                .containsExactly(parkedOperation(delivery));
        assertThat(store.deliverableRenames(Long.MAX_VALUE)).isEmpty();
        assertThat(store.claimRename(delivery, "other", Duration.ofMinutes(1)))
                .isEmpty();
        refused(() -> store.beginSessionRename(TENANT, "title-1", "digest-title-1",
                sessionId, TITLE), "operation_outcome_unknown");
        // It holds no lifecycle hostage.
        assertThat(store.beginOperation(TENANT, sessionId, OperationKind.CLOSE,
                "actor", "close-1", "close-digest").operation().state())
                .isEqualTo("PENDING");
    }

    // Before D7-2 a delivery whose claim expired after its submission parked
    // UNKNOWN with its receipt still PENDING, and that receipt refused every
    // later title and lifecycle change for good. The sweep now parks it and
    // retires the receipt.
    @Test
    void aCrashParkedTitleNoLongerWedgesLaterTitles() {
        RenameDelivery delivery = submitted("title-1", TITLE);
        expireClaims();
        refused(() -> store.beginSessionRename(TENANT, "title-2", "digest-title-2",
                sessionId, "Later"), "session_operation_active");
        assertThat(store.deliverableRenames(Long.MAX_VALUE)).isEmpty();
        assertThat(row(delivery.revision()))
                .containsEntry("state", "RECOVERY_BLOCKED")
                .containsEntry("failure_code", "session_title_unconfirmed")
                .containsEntry("claim_owner", OWNER);
        assertThat(receipt("title-1")).isEqualTo("FAILED");
        SessionMutationCommand later = store.beginSessionRename(TENANT, "title-2",
                "digest-title-2", sessionId, "Later");
        assertThat(later.renameRevision()).isGreaterThan(delivery.revision());
        // The later title wins whatever became of the parked one.
        assertThat(row(delivery.revision())).containsEntry("state", "SUPERSEDED");
        assertThat(store.findParkedOperations(50)).isEmpty();
        refused(() -> store.beginSessionRename(TENANT, "title-1", "digest-title-1",
                sessionId, TITLE), "session_mutation_superseded");
    }

    // A deployment upgraded with legacy UNKNOWN rows converts them on the
    // first sweep: no schema version can carry a data-only change.
    @Test
    void theSweepConvertsALegacyUnknownTitle() {
        RenameDelivery delivery = submitted("title-1", TITLE);
        jdbc.update("UPDATE ma_operation SET state = 'UNKNOWN', delivery_state = 'BLOCKED'"
                + " WHERE operation_kind = 'RENAME'");
        assertThat(store.findParkedOperations(50)).isEmpty();
        assertThat(store.deliverableRenames(Long.MAX_VALUE)).isEmpty();
        assertThat(row(delivery.revision()))
                .containsEntry("state", "RECOVERY_BLOCKED")
                .containsEntry("phase", "RECOVERY_BLOCKED")
                .containsEntry("admission_stage", "JAVA_DURABLE")
                .containsEntry("claim_owner", OWNER);
        assertThat(receipt("title-1")).isEqualTo("FAILED");
        assertThat(store.findParkedOperations(50))
                .containsExactly(parkedOperation(delivery));
    }

    @Test
    void aTitleTheJournalHoldsCompletesAndShowsTheTitle() {
        RenameDelivery delivery = parked("title-1", TITLE);
        ParkedOperation due = parkedOperation(delivery);
        // No managed journal, then a live one without the commit: a writer
        // may still commit the title, so nothing is proven.
        assertThat(store.renameAcceptance(due)).contains(AcceptanceVerdict.unknown());
        managedHead("ACTIVE", 0);
        assertThat(store.renameAcceptance(due)).contains(AcceptanceVerdict.unknown());
        // A commit of the revision with another title proves nothing.
        journalTitle(delivery.revision(), "Other");
        assertThat(store.renameAcceptance(due)).contains(AcceptanceVerdict.unknown());
        jdbc.update("DELETE FROM ma_session_journal_tx");
        journalTitle(delivery.revision(), TITLE);
        assertThat(store.renameAcceptance(due)).contains(AcceptanceVerdict.committed());
        assertThat(store.settleParkedRename(due, AcceptanceVerdict.committed(), 0))
                .isTrue();
        assertThat(store.requireSession(TENANT, sessionId).title()).isEqualTo(TITLE);
        assertThat(receipt("title-1")).isEqualTo("COMPLETED");
        assertThat(row(delivery.revision()))
                .containsEntry("state", "COMPLETED")
                .containsEntry("admission_stage", "HARNESS_CONFIRMED")
                .containsEntry("delivery_state", "COMPLETED")
                .containsEntry("failure_code", null)
                .containsEntry("claim_owner", null);
        assertThat(titleEvents()).containsExactly(TITLE);
        assertThat(store.findParkedOperations(50)).isEmpty();
        // A settled outcome is never rewritten, and the key replays it.
        assertThat(store.renameAcceptance(due)).isEmpty();
        assertThat(store.settleParkedRename(due,
                AcceptanceVerdict.notCommitted("session_title_undelivered"), 0)).isFalse();
        SessionMutationCommand replay = store.beginSessionRename(TENANT, "title-1",
                "digest-title-1", sessionId, TITLE);
        assertThat(replay.status()).isEqualTo("COMPLETED");
        assertThat(replay.replayed()).isTrue();
    }

    // A lifecycle no longer waits for a parked title, so its commit may be
    // decided after the Session closed: the Harness holds the title, so the
    // Session shows it; once deleting, there is nothing left to show it on.
    @ParameterizedTest
    @ValueSource(strings = {"CLOSED", "DELETING"})
    void aCommittedTitleSettlesInAnyLaterSessionStatus(String status) {
        RenameDelivery delivery = parked("title-1", TITLE);
        jdbc.update("UPDATE ma_session SET status = ? WHERE session_id = ?", status, sessionId);
        managedHead("ACTIVE", 0);
        journalTitle(delivery.revision(), TITLE);
        ParkedOperation due = parkedOperation(delivery);
        assertThat(store.settleParkedRename(due, store.renameAcceptance(due).orElseThrow(), 0))
                .isTrue();
        assertThat(row(delivery.revision())).containsEntry("state", "COMPLETED");
        assertThat(receipt("title-1")).isEqualTo("COMPLETED");
        boolean shown = "CLOSED".equals(status);
        assertThat(store.requireSession(TENANT, sessionId).title())
                .isEqualTo(shown ? TITLE : null);
        assertThat(titleEvents()).isEqualTo(shown ? List.of(TITLE) : List.of());
    }

    // A journal that no writer can extend any more, and that compaction has
    // not touched, is complete: its missing commit proves the title never
    // landed.
    @Test
    void aTitleFailsOnceItsCompleteJournalLacksIt() {
        RenameDelivery delivery = parked("title-1", TITLE);
        ParkedOperation due = parkedOperation(delivery);
        managedHead("DELETING", 0);
        // Another revision's commit is not this title's.
        journalTitle(delivery.revision() + 1, TITLE);
        assertThat(store.renameAcceptance(due)).contains(
                AcceptanceVerdict.notCommitted("session_title_undelivered"));
        // Once compaction starts the journal may have lost the commit.
        jdbc.update("UPDATE ma_session_head SET state = 'DELETED',"
                + " compacted_through_revision = 1");
        assertThat(store.renameAcceptance(due)).contains(AcceptanceVerdict.unknown());
        jdbc.update("UPDATE ma_session_head SET compacted_through_revision = 0");
        assertThat(store.settleParkedRename(due, store.renameAcceptance(due).orElseThrow(),
                0)).isTrue();
        Map<String, Object> failed = row(delivery.revision());
        assertThat(failed).containsEntry("state", "FAILED")
                .containsEntry("admission_stage", "JAVA_DURABLE")
                .containsEntry("delivery_state", "BLOCKED")
                .containsEntry("failure_code", "session_title_undelivered")
                .containsEntry("claim_owner", null);
        assertThat(((Number) failed.get("available_at")).longValue()).isEqualTo(Long.MAX_VALUE);
        assertThat(receipt("title-1")).isEqualTo("FAILED");
        assertThat(store.requireSession(TENANT, sessionId).title()).isNull();
        assertThat(store.findParkedOperations(50)).isEmpty();
        // The key may try again, under a new revision; the proven failure
        // keeps its outcome rather than reading as superseded.
        SessionMutationCommand retry = store.beginSessionRename(TENANT, "title-1",
                "digest-title-1", sessionId, TITLE);
        assertThat(retry.status()).isEqualTo("PENDING");
        assertThat(retry.renameRevision()).isGreaterThan(delivery.revision());
        assertThat(row(delivery.revision())).containsEntry("state", "FAILED");
        assertThat(row(retry.renameRevision())).containsEntry("state", "PENDING");
    }

    @Test
    void anUnknownVerdictParksTheTitleUntilTheRecheck() {
        RenameDelivery delivery = parked("title-1", TITLE);
        ParkedOperation due = parkedOperation(delivery);
        long before = ((Number) row(delivery.revision()).get("attempt_count")).longValue();
        assertThat(store.settleParkedRename(due, AcceptanceVerdict.unknown(),
                now.get() + Duration.ofMinutes(5).toMillis())).isTrue();
        Map<String, Object> waiting = row(delivery.revision());
        assertThat(waiting).containsEntry("state", "RECOVERY_BLOCKED")
                .containsEntry("claim_owner", OWNER);
        assertThat(((Number) waiting.get("attempt_count")).longValue()).isEqualTo(before + 1);
        assertThat(store.findParkedOperations(50)).isEmpty();
        assertThat(receipt("title-1")).isEqualTo("FAILED");
    }

    @Test
    void theClaimsOwnLateReplyStillCompletesAParkedTitle() {
        RenameDelivery delivery = submitted("title-1", TITLE);
        expireClaims();
        store.deliverableRenames(Long.MAX_VALUE);
        assertThat(row(delivery.revision())).containsEntry("state", "RECOVERY_BLOCKED");
        store.completeSessionRename(delivery, OWNER, "boot");
        assertThat(store.requireSession(TENANT, sessionId).title()).isEqualTo(TITLE);
        assertThat(receipt("title-1")).isEqualTo("COMPLETED");
        assertThat(row(delivery.revision()))
                .containsEntry("state", "COMPLETED")
                .containsEntry("admission_stage", "HARNESS_CONFIRMED")
                .containsEntry("failure_code", null);
        assertThat(store.settleParkedRename(parkedOperation(delivery),
                AcceptanceVerdict.committed(), 0)).isFalse();
        assertThat(titleEvents()).containsExactly(TITLE);
    }

    // Review of #14475: a fault between parking a row and retiring its
    // receipt leaves neither, so a parked row never keeps the wedge.
    @Test
    void parkingAndRetiringTheReceiptCommitTogether() {
        RenameDelivery delivery = submitted("title-1", TITLE);
        expireClaims();
        failOn.set("UPDATE ma_request_receipt SET state = 'FAILED'");
        assertThatThrownBy(() -> transactional.deliverableRenames(Long.MAX_VALUE))
                .hasMessageContaining("injected fault");
        failOn.set(null);
        assertThat(row(delivery.revision())).containsEntry("state", "RUNNING")
                .containsEntry("phase", "SUBMITTED");
        assertThat(receipt("title-1")).isEqualTo("PENDING");
        assertThat(transactional.deliverableRenames(Long.MAX_VALUE)).isEmpty();
        assertThat(row(delivery.revision())).containsEntry("state", "RECOVERY_BLOCKED");
        assertThat(receipt("title-1")).isEqualTo("FAILED");
    }

    // Review of #14475: the title, its event, the receipt and the row
    // settle as one; a fault before the row completes shows nothing.
    @Test
    void aCommittedTitleIsShownOnlyWithItsSettledOutcome() {
        RenameDelivery delivery = parked("title-1", TITLE);
        managedHead("ACTIVE", 0);
        journalTitle(delivery.revision(), TITLE);
        ParkedOperation due = parkedOperation(delivery);
        failOn.set("admission_stage = 'HARNESS_CONFIRMED', delivery_state = 'COMPLETED'");
        assertThatThrownBy(() -> transactional.settleParkedRename(due,
                AcceptanceVerdict.committed(), 0)).hasMessageContaining("injected fault");
        failOn.set(null);
        assertThat(store.requireSession(TENANT, sessionId).title()).isNull();
        assertThat(titleEvents()).isEmpty();
        assertThat(receipt("title-1")).isEqualTo("FAILED");
        assertThat(row(delivery.revision())).containsEntry("state", "RECOVERY_BLOCKED");
        assertThat(transactional.settleParkedRename(due, AcceptanceVerdict.committed(), 0))
                .isTrue();
        assertThat(store.requireSession(TENANT, sessionId).title()).isEqualTo(TITLE);
        assertThat(titleEvents()).containsExactly(TITLE);
        assertThat(receipt("title-1")).isEqualTo("COMPLETED");
    }

    // Review of #14475: a row whose request lost its title is never read as
    // committed, yet a complete journal without the commit still fails it.
    @Test
    void aTitleRowWithoutItsTitleIsNeverCommittedButCanFail() {
        RenameDelivery delivery = parked("title-1", TITLE);
        jdbc.update("UPDATE ma_operation SET request_json = '{}' WHERE operation_kind = 'RENAME'");
        ParkedOperation due = parkedOperation(delivery);
        managedHead("ACTIVE", 0);
        journalTitle(delivery.revision(), TITLE);
        assertThat(store.renameAcceptance(due)).contains(AcceptanceVerdict.unknown());
        jdbc.update("DELETE FROM ma_session_journal_tx");
        jdbc.update("UPDATE ma_session_head SET state = 'DELETING'");
        assertThat(store.renameAcceptance(due)).contains(
                AcceptanceVerdict.notCommitted("session_title_undelivered"));
    }

    // A delivery that failed before it was submitted is known not to have
    // landed: it retries as before and still holds the lifecycle meanwhile.
    @Test
    void anUnsubmittedFailureRetriesAndKeepsTheBarrier() {
        RenameDelivery delivery = claimed("title-1", TITLE);
        store.abandonSessionRename(TENANT, "title-1", sessionId,
                delivery.revision(), OWNER);
        store.retryRename(delivery, OWNER, 0);
        assertThat(row(delivery.revision())).containsEntry("state", "PENDING")
                .containsEntry("failure_code", null);
        assertThat(store.findParkedOperations(50)).isEmpty();
        assertThat(store.deliverableRenames(Long.MAX_VALUE)).hasSize(1);
        refused(() -> store.beginOperation(TENANT, sessionId, OperationKind.CLOSE,
                "actor", "close-1", "close-digest"), "session_operation_active");
    }

    RenameDelivery claimed(String key, String title) {
        SessionMutationCommand command = store.beginSessionRename(TENANT, key,
                "digest-" + key, sessionId, title);
        RenameDelivery candidate = store.deliverableRenames(Long.MAX_VALUE).stream()
                .filter(delivery -> delivery.revision() == command.renameRevision())
                .findFirst().orElseThrow();
        return store.claimRename(candidate, OWNER, Duration.ofMinutes(1)).orElseThrow();
    }

    RenameDelivery submitted(String key, String title) {
        RenameDelivery delivery = claimed(key, title);
        store.markRenameSubmitted(delivery, OWNER);
        return delivery;
    }

    // Parked the way the coordinator parks a submission that threw.
    RenameDelivery parked(String key, String title) {
        RenameDelivery delivery = submitted(key, title);
        store.abandonSessionRename(TENANT, key, sessionId, delivery.revision(), OWNER);
        store.retryRename(delivery, OWNER, 0);
        return delivery;
    }

    void expireClaims() {
        jdbc.update("UPDATE ma_operation SET claim_until = 0 WHERE operation_kind = 'RENAME'");
    }

    ParkedOperation parkedOperation(RenameDelivery delivery) {
        return new ParkedOperation(TENANT, sessionId, "rename:" + delivery.revision(), "RENAME");
    }

    Map<String, Object> row(long revision) {
        return jdbc.queryForMap("SELECT state, phase, admission_stage, delivery_state,"
                + " failure_code, claim_owner, available_at, attempt_count FROM ma_operation"
                + " WHERE operation_kind = 'RENAME' AND operation_id = ?", "rename:" + revision);
    }

    String receipt(String key) {
        return jdbc.queryForObject("SELECT state FROM ma_request_receipt WHERE"
                + " namespace = 'SESSION_COMMAND' AND operation = 'RENAME_SESSION'"
                + " AND idempotency_key = ?", String.class, key);
    }

    List<String> titleEvents() {
        ObjectMapper json = new ObjectMapper();
        return jdbc.queryForList("SELECT data_json FROM ma_public_event WHERE tenant_id = ?"
                        + " AND session_id = ? AND event_type = 'session.updated' ORDER BY sequence_id",
                String.class, TENANT, sessionId).stream()
                .map(data -> {
                    try {
                        return json.readTree(data).path("metadata").path("title").asText();
                    } catch (java.io.IOException error) {
                        throw new IllegalStateException(error);
                    }
                })
                .toList();
    }

    void managedHead(String state, long compactedThrough) {
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key,"
                        + " tenant_id, session_id, harness_session_id, head_kind,"
                        + " state, storage_version, writer_generation,"
                        + " journal_revision, committed_sequence, activation_epoch,"
                        + " compacted_through_revision, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, ?, 'MANAGED_SESSION', ?, 1, 1, 1, 1, 0,"
                        + " ?, 0, 0)",
                JdbcRuntimeBindingRepository.harnessDrainKey(TENANT),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), TENANT,
                sessionId, sessionId, state, compactedThrough);
    }

    // The row the Hosted Harness's fenced title commit leaves: keyed by
    // renameSession and hosted-title:<revision>, with the title's digest.
    void journalTitle(long revision, String title) {
        String commandId = "hosted-title:" + revision;
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id,"
                        + " session_id, journal_revision, command_key_hash,"
                        + " transaction_id, operation, command_id, content_digest,"
                        + " first_sequence, last_sequence, event_count,"
                        + " writer_generation, writer_id, writer_token_hash,"
                        + " activation_epoch, record_encoding, record_bytes,"
                        + " byte_length, record_digest, gmt_create) VALUES (?, 'ws',"
                        + " ?, ?, ?, ?, 'renameSession', ?, ?, 1, 1, 1, 1, 'writer',"
                        + " ?, 0, 'identity', ?, 0, ?, 0)",
                TENANT, sessionId, revision,
                DigestUtils.sha256Hex("renameSession\u0000" + commandId),
                "tx-" + revision, commandId, DigestUtils.sha256Hex(title),
                "0".repeat(64), new byte[0], "0".repeat(64));
    }

    private static void refused(Runnable call, String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(
                ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode()).isEqualTo(code);
                });
    }
}
