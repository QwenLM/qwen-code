package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ParkedTurn;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WakeStamp;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The seal-time wake stamp (docs/design/2026-11-19-managed-control-plane-wake-seal-stamp.md §3.1). */
class WakeSealStampTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "a".repeat(32);
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private JdbcManagedSessionStore store;
    private String session;
    private long generation;

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:wake-seal-stamp-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setUp() throws Exception {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        store = VerificationFixtures.managedSessionStore(jdbc);
        session = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create,"
                + " gmt_modified) VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 1, 1)", session);
        acquire();
        String records = "{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n";
        String digest = DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8));
        var commit = JSON.createObjectNode().put("workspaceId", "workspace").put("writerId", "writer")
                .put("writerGeneration", generation).put("expectedJournalRevision", 0)
                .put("expectedCommittedSequence", 0).put("transactionId", "genesis")
                .put("operation", "session.create").put("commandId", "genesis").put("contentDigest", digest)
                .put("firstSequence", 0).put("lastSequence", 0).put("eventCount", 0).put("activationEpoch", 0)
                .put("recordCount", 2).put("recordDigest", digest)
                .put("recordBytesBase64", Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        var request = JSON.treeToValue(commit, CommitTransactionRequest.class);
        transaction.execute(status -> store.commit("tenant", session, TOKEN, request));
    }

    @Test
    void aSuspensionWithADeferredInputStampsItsRevisionAndDueTime() {
        long due = System.currentTimeMillis() + 3_600_000L;
        seal(new WakeStamp(1, true, due));
        var head = head();
        assertThat(head.get("state")).isEqualTo("SEALED");
        assertThat(head.get("wake_seal_revision")).isEqualTo(1L);
        assertThat(head.get("wake_head_revision")).isEqualTo(1L);
        assertThat(((Number) head.get("is_wake_pending")).intValue()).isEqualTo(1);
        assertThat(head.get("wake_retry_at")).isEqualTo(due);
        // Not yet due: the backstop neither selects nor claims it.
        assertThat(wakeStore().findPending("workspace", 8)).isEmpty();
    }

    @Test
    void aStampedHeadDueNowIsSelectedAsStamped() {
        seal(new WakeStamp(1, true, 0));
        var candidates = wakeStore().findPending("workspace", 8);
        assertThat(candidates).hasSize(1);
        assertThat(candidates.getFirst().stamped()).isTrue();
        assertThat(wakeStore().claim(candidates.getFirst())).isTrue();
    }

    @Test
    void theBackstopScanSelectsAStampedChildSession() {
        // A child Session is a PUBLIC Session with a parent run: the scan
        // covers it, and WakeRecovery checks the parent run before loading.
        jdbc.update("UPDATE ma_session SET parent_session_id = 'parent', root_session_id = 'parent',"
                + " parent_child_run_id = 'run' WHERE session_id = ?", session);
        seal(new WakeStamp(1, true, 0));
        var candidates = wakeStore().findPending("workspace", 8);
        assertThat(candidates).hasSize(1);
        assertThat(candidates.getFirst().stamped()).isTrue();
        assertThat(candidates.getFirst().parentSessionId()).isEqualTo("parent");
        assertThat(candidates.getFirst().parentChildRunId()).isEqualTo("run");
    }

    @Test
    void aSuspensionWithNothingPendingLeavesTheScanSet() {
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 7, is_wake_pending = 1");
        seal(new WakeStamp(1, false, 0));
        var head = head();
        assertThat(head.get("wake_seal_revision")).isEqualTo(1L);
        assertThat(((Number) head.get("is_wake_pending")).intValue()).isZero();
        assertThat(((Number) head.get("is_wake_scan_pending")).intValue()).isZero();
        assertThat(head.get("wake_retry_at")).isEqualTo(7L);
    }

    @Test
    void aSuspensionCanCertifyAnActionParkedTurn() {
        seal(new WakeStamp(1, false, 0, new ParkedTurn("prompt-1", 1234, 7L)));
        var head = head();
        assertThat(head.get("wake_seal_parked_prompt_id")).isEqualTo("prompt-1");
        assertThat(head.get("wake_seal_parked_until")).isEqualTo(1234L);
        assertThat(head.get("wake_seal_parked_approval_revision")).isEqualTo(7L);
        assertThat(head.get("is_wake_pending")).isEqualTo(0);
        assertThat(head.get("is_wake_scan_pending")).isEqualTo(0);

        acquire();
        head = head();
        assertThat(head.get("wake_seal_parked_prompt_id")).isNull();
        assertThat(head.get("wake_seal_parked_until")).isNull();
        assertThat(head.get("wake_seal_parked_approval_revision")).isNull();
    }

    @Test
    void aParkCertificateMayOmitItsApprovalRevision() {
        seal(new WakeStamp(1, false, 0, new ParkedTurn("prompt-1", 1234, null)));
        assertThat(head().get("wake_seal_parked_approval_revision")).isNull();
    }

    @Test
    void aParkCertificateCannotAlsoRequestAWake() {
        assertThatThrownBy(() -> seal(new WakeStamp(1, true, 1234,
                new ParkedTurn("prompt-1", 1234, 7L))))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        refused -> assertThat(refused.getCode()).isEqualTo("invalid_managed_session_store_request"));
        assertThat(head().get("state")).isEqualTo("ACTIVE");
        assertThat(head().get("wake_seal_parked_prompt_id")).isNull();
    }

    @Test
    void aParkCertificateCannotShareTheBackgroundCertificate() {
        assertThatThrownBy(() -> seal(new WakeStamp(1, false, 0, true,
                new ParkedTurn("prompt-1", 1234, 7L))))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        refused -> assertThat(refused.getCode()).isEqualTo("invalid_managed_session_store_request"));
        assertThat(head().get("state")).isEqualTo("ACTIVE");
        assertThat(head().get("wake_seal_background")).isEqualTo(0);
        assertThat(head().get("wake_seal_parked_prompt_id")).isNull();
    }

    @Test
    void aStampForAnotherRevisionRefusesTheSealUntilARecomputedRetry() {
        assertThatThrownBy(() -> seal(new WakeStamp(0, true, 0)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        refused -> assertThat(refused.getCode()).isEqualTo("managed_session_wake_stamp_stale"));
        assertThat(head().get("state")).isEqualTo("ACTIVE");
        assertThat(head().get("wake_seal_revision")).isNull();
        seal(new WakeStamp(1, true, 0));
        assertThat(head().get("wake_seal_revision")).isEqualTo(1L);
    }

    @Test
    void aBareSealLeavesNoStamp() {
        seal(null);
        assertThat(head().get("state")).isEqualTo("SEALED");
        assertThat(head().get("wake_seal_revision")).isNull();
    }

    @Test
    void anAcquisitionClearsTheStampAndCapsAFutureDueTime() {
        seal(new WakeStamp(1, true, System.currentTimeMillis() + 3_600_000L));
        long before = System.currentTimeMillis();
        acquire();
        var head = head();
        assertThat(head.get("wake_seal_revision")).isNull();
        assertThat((Long) head.get("wake_retry_at"))
                .isBetween(before, System.currentTimeMillis() + JdbcWakeRecoveryStore.RETRY_MS);
        // The seal of a load that refuses sends no stamp and inherits none.
        seal(null);
        assertThat(head().get("wake_seal_revision")).isNull();
    }

    @Test
    void anAcquisitionNeverLowersADelayAClaimSet() {
        seal(new WakeStamp(1, true, 0));
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = 5");
        acquire();
        assertThat(head().get("wake_retry_at")).isEqualTo(5L);
    }

    // Phase 3b §4.8: the background certificate rides the same stamp, under
    // the same writer fence and revision check, and any acquisition clears it.
    @Test
    void aBackgroundCertifiedSealRecordsTheCertificateAtItsRevision() {
        seal(new WakeStamp(1, false, 0, true));
        var head = head();
        assertThat(head.get("wake_seal_revision")).isEqualTo(1L);
        assertThat(head.get("wake_seal_background")).isEqualTo(1);
    }

    @Test
    void anOrdinarySealLeavesTheCertificateClear() {
        seal(new WakeStamp(1, false, 0));
        assertThat(head().get("wake_seal_background")).isEqualTo(0);
    }

    @Test
    void aBackgroundCertificateForAnotherRevisionRefusesTheSeal() {
        assertThatThrownBy(() -> seal(new WakeStamp(0, false, 0, true)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        refused -> assertThat(refused.getCode()).isEqualTo("managed_session_wake_stamp_stale"));
        assertThat(head().get("wake_seal_background")).isEqualTo(0);
    }

    @Test
    void anAcquisitionClearsTheBackgroundCertificate() {
        seal(new WakeStamp(1, false, 0, true));
        acquire();
        assertThat(head().get("wake_seal_background")).isEqualTo(0);
        // The seal of a load that refuses sends no stamp and inherits none.
        seal(null);
        assertThat(head().get("wake_seal_background")).isEqualTo(0);
    }

    private void acquire() {
        generation = transaction.execute(status -> store.acquireWriter("tenant", session, TOKEN,
                new AcquireWriterRequest("workspace", "writer", 60_000L))).writerGeneration();
    }

    private void seal(WakeStamp wake) {
        transaction.execute(status -> store.sealWriter("tenant", session, TOKEN,
                new SealWriterRequest("workspace", "writer", generation, wake)));
    }

    private Map<String, Object> head() {
        // Read each column at its Java type: an unsigned BIGINT need not come back as a Long.
        return jdbc.queryForObject("SELECT state, wake_seal_revision, wake_head_revision, is_wake_pending,"
                        + " is_wake_scan_pending, wake_retry_at, wake_seal_background,"
                        + " wake_seal_parked_prompt_id, wake_seal_parked_until, wake_seal_parked_approval_revision"
                        + " FROM ma_session_head WHERE session_id = ?",
                (row, index) -> {
                    var values = new java.util.HashMap<String, Object>();
                    values.put("state", row.getString("state"));
                    values.put("wake_seal_revision", row.getObject("wake_seal_revision", Long.class));
                    values.put("wake_head_revision", row.getObject("wake_head_revision", Long.class));
                    values.put("is_wake_pending", row.getInt("is_wake_pending"));
                    values.put("is_wake_scan_pending", row.getInt("is_wake_scan_pending"));
                    values.put("wake_retry_at", row.getLong("wake_retry_at"));
                    values.put("wake_seal_background", row.getInt("wake_seal_background"));
                    values.put("wake_seal_parked_prompt_id", row.getString("wake_seal_parked_prompt_id"));
                    values.put("wake_seal_parked_until", row.getObject("wake_seal_parked_until", Long.class));
                    values.put("wake_seal_parked_approval_revision",
                            row.getObject("wake_seal_parked_approval_revision", Long.class));
                    return values;
                }, session);
    }

    private JdbcWakeRecoveryStore wakeStore() {
        return new JdbcWakeRecoveryStore(jdbc);
    }
}
