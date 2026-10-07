package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

public class SessionResourceCollectionCollectorTest extends ToolPublicationRetentionStoreTest {
    private static final String CONTENT = "managed-tool-result-content";
    private static final String PAGE = "managed-tool-result-page";
    private static final String MANIFEST = "managed-tool-result-manifest";

    private String resScope;
    private String token;

    private void initSession() {
        resScope = ManagedSessionStore.sessionScopeKey(tenant, session);
        token = "a".repeat(32);
    }

    private void head(String sessionId) {
        jdbc.update("INSERT INTO qwen_managed_session_journal_head (tenant_id, workspace_id, session_id,"
                + " storage_version, state, writer_generation, writer_id, writer_lease_until, lease_token_hash,"
                + " journal_revision, committed_sequence, last_commit_digest, activation_epoch,"
                + " compacted_through_revision, recovery_status, created_at, updated_at)"
                + " VALUES (?, 'workspace-1', ?, 1, 'SEALED', 1, 'original', '2000-01-01 00:00:00', ?, 1, 1, ?, 1,"
                + " 0, 'READY', CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))",
                tenant, sessionId, "a".repeat(64), "b".repeat(64));
    }

    private void publish(String resourceId, String kind, byte[] bytes) {
        publish(resourceId, kind, bytes, "PUBLISHED", "MYSQL_INLINE");
    }

    private void publish(String resourceId, String kind, byte[] bytes, String state, String storage) {
        publish(resourceId, kind, bytes, state, storage, 1);
    }

    private void publish(String resourceId, String kind, byte[] bytes, String state, String storage,
            int schemaVersion) {
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id,"
                + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes,"
                + " object_key, publish_command_id, state, created_at, last_verified_at)"
                + " VALUES (?, ?, 'workspace-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                + " CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))",
                resScope, tenant, session, resourceId, kind, schemaVersion, bytes.length,
                ToolPublicationContract.sha256(bytes), storage, bytes,
                "TOOL_PUBLICATION".equals(storage) ? "object-" + resourceId : null, resourceId, state);
    }

    private void reference(String resourceId) {
        jdbc.update("INSERT INTO qwen_managed_session_resource_ref (session_scope_key, tenant_id, workspace_id,"
                + " session_id, journal_revision, resource_id, created_at)"
                + " VALUES (?, ?, 'workspace-1', ?, 1, ?, CURRENT_TIMESTAMP(6))", resScope, tenant, session, resourceId);
    }

    private SessionResourceCollectionCollector collector(boolean enabled, Duration grace) {
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(enabled);
        props.getToolPublication().setDeletionGrace(grace);
        return new SessionResourceCollectionCollector(jdbc, manager, props);
    }

    private Map<String, Object> ledger() {
        return jdbc.queryForMap("SELECT * FROM qwen_managed_session_resource_collection"
                + " WHERE session_scope_key = ?", resScope);
    }

    private long countLedgers() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_collection"
                + " WHERE session_scope_key = ?", Long.class, resScope);
    }

    private List<Map<String, Object>> rows() {
        return jdbc.queryForList("SELECT resource_id, state, inline_bytes FROM qwen_managed_session_resource"
                + " WHERE session_scope_key = ? ORDER BY resource_id", resScope);
    }

    @Test
    void collectsRetiredStreamCaptureByteExact() {
        initSession();
        head(session);
        publish("b-manifest", MANIFEST, new byte[100]);
        publish("a-segment-1", CONTENT, new byte[1024]);
        publish("c-page", PAGE, new byte[256]);
        retire();
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isTrue();
        assertThat(rows()).allSatisfy(row -> {
            assertThat(row.get("state")).isEqualTo("COLLECTED");
            assertThat(row.get("inline_bytes")).isNull();
        });
        var ledger = ledger();
        assertThat(((Number) ledger.get("collected_bytes")).longValue()).isEqualTo(1024 + 100 + 256);
        assertThat(ledger.get("collected_at")).isNotNull();
        assertThat(ledger.get("gc_owner")).isNull();
        assertThat(ledger.get("gc_blocker")).isNull();
        assertThat(collector.runOnce()).isFalse();
    }

    @Test
    void gcDisabledKeepsBytesAndLedger() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        assertThat(collector(false, Duration.ZERO).runOnce()).isFalse();
        assertThat(countLedgers()).isZero();
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
    }

    @Test
    void untombstonedSessionNeverStartsCollection() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        assertThat(collector(true, Duration.ZERO).runOnce()).isFalse();
        assertThat(countLedgers()).isZero();
        assertThat(rows().getFirst().get("state")).isEqualTo("PUBLISHED");
    }

    @Test
    void recoveryProtectedBlockerRechecksAfterADay() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        jdbc.update("UPDATE qwen_output_session_retirement SET recovery_protected = TRUE"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isFalse();
        var ledger = ledger();
        assertThat(ledger.get("gc_blocker")).isEqualTo("recovery_protected");
        long now = System.currentTimeMillis();
        assertThat(((Number) ledger.get("gc_next_at")).longValue())
                .isBetween(now + Duration.ofHours(24).toMillis() - 10_000, now + Duration.ofHours(24).toMillis() + 60_000);
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
    }

    @Test
    void gracePeriodBlockerDefersToRetiredAtPlusGrace() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        jdbc.update("INSERT INTO qwen_managed_session_resource_collection (session_scope_key, tenant_key,"
                + " session_key, tenant_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))",
                resScope, ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session),
                tenant, session);
        var collector = collector(true, Duration.ofHours(24));
        assertThat(collector.runOnce()).isFalse();
        var ledger = ledger();
        long retiredAt = jdbc.queryForObject("SELECT retired_at FROM qwen_output_session_retirement"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session);
        assertThat(ledger.get("gc_blocker")).isEqualTo("grace_period");
        assertThat(((Number) ledger.get("gc_next_at")).longValue())
                .isEqualTo(retiredAt + Duration.ofHours(24).toMillis());
        assertThat(rows().getFirst().get("state")).isEqualTo("PUBLISHED");
    }

    @Test
    void liveHeadBlocksCollection() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'SEALED'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        assertThat(collector(true, Duration.ZERO).runOnce()).isFalse();
        var ledger = ledger();
        assertThat(ledger.get("gc_blocker")).isEqualTo("session_head_live");
        long nowMillis = System.currentTimeMillis();
        assertThat(((Number) ledger.get("gc_next_at")).longValue())
                .isBetween(nowMillis + 50_000, nowMillis + 70_000);
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
    }

    @Test
    void activeReaderLeaseHoldsThenCollects() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        var lease = retention.read(key);
        retire();
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isFalse();
        var blocked = ledger();
        assertThat(blocked.get("gc_blocker")).isEqualTo("reader_active");
        long nowMillis = System.currentTimeMillis();
        assertThat(((Number) blocked.get("gc_next_at")).longValue())
                .isBetween(nowMillis + 50_000, nowMillis + 70_000);
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
        lease.close();
        jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_next_at = 0"
                + " WHERE session_scope_key = ?", resScope);
        assertThat(collector.runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        assertThat(ledger().get("gc_blocker")).isNull();
    }

    @Test
    void completionSweepsExpiredReadLeases() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        jdbc.update("INSERT INTO qwen_output_read_lease (lease_id, tenant_key, session_key,"
                + " retirement_generation, expires_at) VALUES ('expired-1', ?, ?, 0, 1)",
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session));
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(ledger().get("collected_at")).isNotNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_read_lease"
                + " WHERE tenant_key = ? AND session_key = ?", Long.class,
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session))).isZero();
    }

    @Test
    void failedPageDefersWithCollectionRetryAndRethrows() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        var failing = new JdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("UPDATE qwen_managed_session_resource SET state = 'COLLECTED'")) {
                    throw new org.springframework.dao.DataAccessResourceFailureException("injected page failure");
                }
                return super.update(sql, args);
            }
        };
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(true);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(failing, manager, props);
        assertThatThrownBy(collector::runOnce)
                .isInstanceOf(org.springframework.dao.DataAccessResourceFailureException.class);
        var ledger = ledger();
        assertThat(ledger.get("gc_owner")).isNull();
        assertThat(ledger.get("gc_blocker")).isEqualTo("collection_retry");
        long nowMillis = System.currentTimeMillis();
        assertThat(((Number) ledger.get("gc_next_at")).longValue())
                .isBetween(nowMillis + 50_000, nowMillis + 70_000);
        assertThat(rows().getFirst().get("state")).isEqualTo("PUBLISHED");
    }

    @Test
    void blockedFirstCandidateDoesNotStarveTheNext() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        var lease = retention.read(key);
        String other = "session-b";
        String otherScope = ManagedSessionStore.sessionScopeKey(tenant, other);
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id,"
                + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes,"
                + " publish_command_id, state, created_at, last_verified_at)"
                + " VALUES (?, ?, 'workspace-1', ?, 'segment', ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'segment',"
                + " 'PUBLISHED', CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))",
                otherScope, tenant, other, CONTENT, 64, ToolPublicationContract.sha256(new byte[64]),
                new byte[64]);
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, other);
            ToolPublicationRetentionStore.retire(jdbc, tenant, other, "delete-2");
        });
        retire();
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isTrue();
        try (lease) {
            assertThat(jdbc.queryForList("SELECT state, inline_bytes FROM qwen_managed_session_resource"
                    + " WHERE session_scope_key = ?", otherScope)).singleElement()
                    .satisfies(row -> assertThat(row.get("state")).isEqualTo("COLLECTED"));
            assertThat(collector.runOnce()).isFalse();
            assertThat(ledger().get("gc_blocker")).isEqualTo("reader_active");
        }
    }

    @Test
    void ledgerCreationCapsAtThirtyTwoOldestTombstonesPerScan() {
        initSession();
        head(session);
        long now = ToolPublicationRetentionStore.now(jdbc);
        for (int index = 1; index <= 33; index++) {
            String retired = String.format("stale-%02d", index);
            jdbc.update("INSERT INTO qwen_output_session_retirement (tenant_key, session_key, tenant_id,"
                    + " session_id, operation_id, generation, retired_at, recovery_protected)"
                    + " VALUES (?, ?, ?, ?, ?, 1, ?, FALSE)",
                    ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(retired),
                    tenant, retired, "purge-" + index, now - (34 - index) * 1000);
        }
        retire();
        collector(true, Duration.ZERO).runOnce();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_collection",
                Long.class)).isEqualTo(32);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_collection c"
                + " JOIN qwen_output_session_retirement r ON r.tenant_key = c.tenant_key"
                + " AND r.session_key = c.session_key WHERE r.session_id = 'stale-33'", Long.class)).isZero();
    }

    @Test
    void perRowExclusionsAreNeverCollected() {
        initSession();
        head(session);
        publish("a-referenced", CONTENT, new byte[1], "REFERENCED", "MYSQL_INLINE");
        publish("b-monitor", "managed-monitor-observation", new byte[2]);
        publish("c-external", CONTENT, new byte[3], "PUBLISHED", "TOOL_PUBLICATION");
        publish("d-referenced-journal", CONTENT, new byte[4]);
        reference("d-referenced-journal");
        publish("e-overbound", CONTENT, new byte[2 * 1024 * 1024], "PUBLISHED", "MYSQL_INLINE");
        publish("f-version", PAGE, new byte[5], "PUBLISHED", "MYSQL_INLINE", 2);
        publish("g-unknown-layout", CONTENT, new byte[6]);
        jdbc.update("UPDATE qwen_managed_session_resource SET object_key = 'injected'"
                + " WHERE session_scope_key = ? AND resource_id = 'g-unknown-layout'", resScope);
        publish("h-version-layout", CONTENT, new byte[7]);
        jdbc.update("UPDATE qwen_managed_session_resource SET object_version_id = 'injected'"
                + " WHERE session_scope_key = ? AND resource_id = 'h-version-layout'", resScope);
        publish("i-encryption-layout", CONTENT, new byte[8]);
        jdbc.update("UPDATE qwen_managed_session_resource SET encryption_key_id = 'injected'"
                + " WHERE session_scope_key = ? AND resource_id = 'i-encryption-layout'", resScope);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(rows()).allSatisfy(row -> assertThat(row.get("inline_bytes")).isNotNull());
        assertThat(((Number) ledger().get("collected_bytes")).longValue()).isZero();
        assertThat(ledger().get("collected_at")).isNotNull();
    }

    @Test
    void rowCountPageBoundariesAndResumeAcrossOwners() {
        initSession();
        head(session);
        for (int index = 0; index < 105; index++) {
            publish(String.format("segment-%03d", index), CONTENT, new byte[10]);
        }
        retire();
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                .getLogger(SessionResourceCollectionCollector.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        try {
            var first = collector(true, Duration.ZERO);
            assertThat(first.runOnce()).isTrue();
            var ledger = ledger();
            assertThat(((Number) ledger.get("collected_bytes")).longValue()).isEqualTo(1000);
            assertThat(ledger.get("gc_cursor")).isEqualTo("segment-099");
            assertThat(ledger.get("collected_at")).isNull();
            // A second instance cannot take over while the claim is alive.
            assertThat(collector(true, Duration.ZERO).runOnce()).isFalse();
            assertThat(((Number) ledger().get("collected_bytes")).longValue()).isEqualTo(1000);
            // An expired claim is handed off and finishes exactly once.
            jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_claim_until = 0"
                    + " WHERE session_scope_key = ?", resScope);
            assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
            var finished = ledger();
            assertThat(((Number) finished.get("collected_bytes")).longValue()).isEqualTo(1050);
            assertThat(finished.get("collected_at")).isNotNull();
            assertThat(((Number) finished.get("gc_generation")).longValue()).isEqualTo(2);
            assertThat(rows()).allSatisfy(row -> assertThat(row.get("inline_bytes")).isNull());
            // Only the completing page logs, and it logs the Session total, not its own bytes.
            assertThat(appender.list).singleElement().satisfies(event -> assertThat(
                    event.getFormattedMessage()).endsWith("bytes=1050"));
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void byteBudgetCapsPagesBelowRowLimit() {
        initSession();
        head(session);
        for (int index = 0; index < 68; index++) {
            publish(String.format("segment-%02d", index), CONTENT, new byte[1024 * 1024]);
        }
        retire();
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isTrue();
        assertThat(((Number) ledger().get("collected_bytes")).longValue()).isEqualTo(32L * 1024 * 1024);
        assertThat(ledger().get("gc_cursor")).isEqualTo("segment-31");
        assertThat(ledger().get("collected_at")).isNull();
        assertThat(collector.runOnce()).isTrue();
        assertThat(collector.runOnce()).isTrue();
        var finished = ledger();
        assertThat(((Number) finished.get("collected_bytes")).longValue()).isEqualTo(68L * 1024 * 1024);
        assertThat(finished.get("collected_at")).isNotNull();
    }

    @Test
    void liveClaimHeldByAnotherOwnerIsNotStolen() {
        initSession();
        head(session);
        for (int index = 0; index < 105; index++) {
            publish(String.format("segment-%03d", index), CONTENT, new byte[10]);
        }
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        // Hold the claim alive while a competing instance retries; nothing may move.
        assertThat(collector(true, Duration.ZERO).runOnce()).isFalse();
        var ledger = ledger();
        assertThat(((Number) ledger.get("collected_bytes")).longValue()).isEqualTo(1000);
        assertThat(((Number) ledger.get("gc_generation")).longValue()).isEqualTo(1);
        assertThat(ledger.get("gc_blocker")).isNull();
    }

    @Test
    void readAfterCollectionAnswersTheSessionRetiredOutcome() {
        initSession();
        head(session);
        var sessions = new ManagedSessionStore(jdbc);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        publish("collected", CONTENT, new byte[64]);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'SEALED',"
                + " writer_lease_until = '2000-01-01 00:00:00' WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        assertThatThrownBy(() -> sessions.readResource(tenant, "workspace-1", session, "collected", token))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("tool_output_session_retired");
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                });
    }

    @Test
    void staleDeferCannotClobberAnActiveTakeover() {
        initSession();
        head(session);
        for (int index = 0; index < 105; index++) {
            publish(String.format("segment-%03d", index), CONTENT, new byte[10]);
        }
        retire();
        var plain = jdbc;
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        var intercepted = new JdbcTemplate(jdbc.getDataSource()) {
            @Override public Map<String, Object> queryForMap(String sql, Object... args) {
                if (sql.contains("qwen_managed_session_resource_collection") && sql.contains("FOR UPDATE")
                        && reads.incrementAndGet() == 2) {
                    plain.update("UPDATE qwen_managed_session_resource_collection SET gc_owner = 'b-owner',"
                            + " gc_generation = gc_generation + 1, gc_claim_until = ?"
                            + " WHERE session_scope_key = ?",
                            System.currentTimeMillis() + 300_000, resScope);
                }
                return super.queryForMap(sql, args);
            }
        };
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(true);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        var first = new SessionResourceCollectionCollector(intercepted, manager, props);
        assertThat(first.runOnce()).isFalse();
        var ledger = ledger();
        assertThat(ledger.get("gc_owner")).isEqualTo("b-owner");
        assertThat(((Number) ledger.get("gc_generation")).longValue()).isEqualTo(2);
        assertThat(ledger.get("gc_blocker")).isNull();
    }

    @Test
    void headlessRetiredSessionCompletesWithZeroBytes() {
        initSession();
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        var ledger = ledger();
        assertThat(ledger.get("collected_at")).isNotNull();
        assertThat(((Number) ledger.get("collected_bytes")).longValue()).isZero();
        assertThat(ledger.get("gc_blocker")).isNull();
    }

    @Test
    void collectionNeverTouchesAnotherSessionsRows() {
        initSession();
        head(session);
        publish("segment-000", CONTENT, new byte[64]);
        String other = "session-2";
        String otherScope = ManagedSessionStore.sessionScopeKey(tenant, other);
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id,"
                + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes,"
                + " publish_command_id, state, created_at, last_verified_at)"
                + " VALUES (?, ?, 'workspace-1', ?, 'segment-000', ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'segment-000',"
                + " 'PUBLISHED', CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))",
                otherScope, tenant, other, CONTENT, 64, ToolPublicationContract.sha256(new byte[64]),
                new byte[64]);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        var survivors = jdbc.queryForList("SELECT state, inline_bytes FROM qwen_managed_session_resource"
                + " WHERE session_scope_key = ?", otherScope);
        assertThat(survivors).singleElement().satisfies(row -> {
            assertThat(row.get("state")).isEqualTo("PUBLISHED");
            assertThat(row.get("inline_bytes")).isNotNull();
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_collection"
                + " WHERE session_scope_key = ?", Long.class, otherScope)).isZero();
    }

    @Test
    void collectsRowsAtTheirExactKindBounds() {
        initSession();
        head(session);
        publish("a-segment", CONTENT, new byte[1024 * 1024]);
        publish("b-page", PAGE, new byte[256 * 1024]);
        publish("c-manifest", MANIFEST, new byte[64 * 1024]);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(((Number) ledger().get("collected_bytes")).longValue())
                .isEqualTo(1024 * 1024 + 256 * 1024 + 64 * 1024);
        assertThat(rows()).allSatisfy(row -> assertThat(row.get("state")).isEqualTo("COLLECTED"));
    }

    @Test
    void negativeDeletionGraceIsRejected() {
        initSession();
        assertThatThrownBy(() -> collector(true, Duration.ofHours(-1)))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> collector(true, null))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void secondDueTombstoneInsideTheScanWindowWaitsForTheNextCadence() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        var collector = collector(true, Duration.ZERO);
        collector.runOnce();
        String later = "session-later";
        long now = ToolPublicationRetentionStore.now(jdbc);
        jdbc.update("INSERT INTO qwen_output_session_retirement (tenant_key, session_key, tenant_id,"
                + " session_id, operation_id, generation, retired_at, recovery_protected)"
                + " VALUES (?, ?, ?, ?, 'purge-later', 1, ?, FALSE)",
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(later),
                tenant, later, now - 1000);
        assertThat(collector.runOnce()).isFalse();
        String laterScope = ManagedSessionStore.sessionScopeKey(tenant, later);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_collection"
                + " WHERE session_scope_key = ?", Long.class, laterScope)).isZero();
    }

    @Test
    void inGraceTombstoneCreatesNoLedgerUntilDue() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        assertThat(collector(true, Duration.ofHours(24)).runOnce()).isFalse();
        assertThat(countLedgers()).isZero();
        jdbc.update("UPDATE qwen_output_session_retirement SET retired_at = retired_at - ?"
                + " WHERE tenant_id = ? AND session_id = ?",
                Duration.ofHours(25).toMillis(), tenant, session);
        assertThat(collector(true, Duration.ofHours(24)).runOnce()).isTrue();
        assertThat(countLedgers()).isEqualTo(1);
    }

    @Test
    void completedLedgerIsExcludedFromClaimScans() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isTrue();
        assertThat(((Number) ledger().get("gc_next_at")).longValue()).isNegative();
        assertThat(collector.runOnce()).isFalse();
    }

    @Test
    void recoveryReaderAnswersResourceCollected() {
        initSession();
        publish("collected", CONTENT, new byte[64], "COLLECTED", "MYSQL_INLINE");
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = 'collected'", resScope);
        var reader = new WorkspaceRecoveryReader(jdbc, null);
        var source = new ObjectMapper().createObjectNode();
        source.putObject("head").put("tenantId", tenant).put("workspaceId", "workspace-1")
                .put("sessionId", session).put("journalRevision", 10)
                .putNull("latest_checkpoint_resource_id");
        byte[] bytes = new byte[64];
        var ref = new ObjectMapper().createObjectNode().put("resourceId", "collected")
                .put("kind", CONTENT).put("schemaVersion", 1).put("byteLength", bytes.length)
                .put("digest", ToolPublicationContract.sha256(bytes));
        assertThatThrownBy(() -> reader.resource(source, ref)).hasMessageContaining("resource_collected");
    }

    @Test
    void tamperedLiveRowStillFailsClosed() {
        initSession();
        var sessions = new ManagedSessionStore(jdbc);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        publish("tampered", CONTENT, new byte[64]);
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ?"
                + " WHERE session_scope_key = ? AND resource_id = 'tampered'", new byte[63], resScope);
        assertThatThrownBy(() -> sessions.readResource(tenant, "workspace-1", session, "tampered", token))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("managed_session_resource_corrupt");
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
                });
    }

    @Test
    void pagesFetchEligibilityOnceWithoutAnExhaustionProbe() {
        initSession();
        head(session);
        for (int index = 0; index < 250; index++) {
            publish(String.format("segment-%03d", index), CONTENT, new byte[10]);
        }
        retire();
        var executions = new java.util.concurrent.atomic.AtomicInteger();
        var intercepted = new JdbcTemplate(jdbc.getDataSource()) {
            @Override public List<Map<String, Object>> queryForList(String sql, Object... args) {
                if (sql.startsWith("SELECT resource_id, byte_length FROM qwen_managed_session_resource")) {
                    executions.incrementAndGet();
                }
                return super.queryForList(sql, args);
            }
        };
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(true);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(intercepted, manager, props);
        assertThat(collector.runOnce()).isTrue();
        assertThat(collector.runOnce()).isTrue();
        assertThat(collector.runOnce()).isTrue();
        var ledger = ledger();
        assertThat(((Number) ledger.get("collected_bytes")).longValue()).isEqualTo(2500);
        assertThat(ledger.get("collected_at")).isNotNull();
        assertThat(executions).hasValue(3);
    }

    @Test
    void blockerTransitionLogsOncePerChange() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        var lease = retention.read(key);
        retire();
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                .getLogger(SessionResourceCollectionCollector.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        try {
            var collector = collector(true, Duration.ZERO);
            assertThat(collector.runOnce()).isFalse();
            assertThat(ledger().get("gc_blocker")).isEqualTo("reader_active");
            assertThat(appender.list).singleElement().satisfies(event -> assertThat(
                    event.getFormattedMessage()).contains("blocker=reader_active"));
            jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_next_at = 0"
                    + " WHERE session_scope_key = ?", resScope);
            assertThat(collector.runOnce()).isFalse();
            assertThat(ledger().get("gc_blocker")).isEqualTo("reader_active");
            assertThat(appender.list).hasSize(1);
        } finally {
            logger.detachAppender(appender);
            appender.stop();
            lease.close();
        }
    }

    @Test
    void collectsRowsPublishedThroughTheRealProducerByteExact() {
        initSession();
        head(session);
        var sessions = new ManagedSessionStore(jdbc);
        var grant = tx.execute(status -> sessions.acquireWriter(tenant, session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        publishThroughStore(sessions, grant.writerGeneration(), "produced-content", CONTENT, new byte[1024]);
        publishThroughStore(sessions, grant.writerGeneration(), "produced-page", PAGE, new byte[256]);
        publishThroughStore(sessions, grant.writerGeneration(), "produced-manifest", MANIFEST, new byte[64]);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'SEALED',"
                + " writer_lease_until = '2000-01-01 00:00:00' WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(((Number) ledger().get("collected_bytes")).longValue()).isEqualTo(1024 + 256 + 64);
        assertThat(rows()).allSatisfy(row -> {
            assertThat(row.get("state")).isEqualTo("COLLECTED");
            assertThat(row.get("inline_bytes")).isNull();
        });
    }

    private void publishThroughStore(ManagedSessionStore sessions, long generation, String resourceId,
            String kind, byte[] bytes) {
        sessions.publishToolResult(tenant, session, token,
                new ManagedSessionStoreModels.PublishToolResultRequest("workspace-1", "writer", generation,
                        resourceId, kind, 1, bytes.length, ToolPublicationContract.sha256(bytes),
                        Base64.getEncoder().encodeToString(bytes)));
    }

    @Test
    void recoveryReaderAnswersResourceCollectedForPublicationNulledInlineCopy() {
        initSession();
        publish("freed", MANIFEST, new byte[64], "REFERENCED", "MYSQL_INLINE");
        reference("freed");
        // The shape ToolPublicationCollector.confirm() leaves: bytes nulled, state untouched.
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = 'freed'", resScope);
        var reader = new WorkspaceRecoveryReader(jdbc, null);
        var source = new ObjectMapper().createObjectNode();
        source.putObject("head").put("tenantId", tenant).put("workspaceId", "workspace-1")
                .put("sessionId", session).put("journalRevision", 10)
                .putNull("latest_checkpoint_resource_id");
        var ref = new ObjectMapper().createObjectNode().put("resourceId", "freed")
                .put("kind", MANIFEST).put("schemaVersion", 1).put("byteLength", 64)
                .put("digest", ToolPublicationContract.sha256(new byte[64]));
        assertThatThrownBy(() -> reader.resource(source, ref)).hasMessageContaining("resource_collected");
    }
}
