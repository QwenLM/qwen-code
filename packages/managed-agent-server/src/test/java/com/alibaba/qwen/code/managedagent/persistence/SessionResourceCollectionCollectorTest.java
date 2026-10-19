package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class SessionResourceCollectionCollectorTest extends ToolPublicationRetentionStoreTest {
    private static final String CONTENT = "managed-tool-result-content";
    private static final String PAGE = "managed-tool-result-page";
    private static final String MANIFEST = "managed-tool-result-manifest";

    private String resScope;
    private String token;

    @Test
    void retirementInventoryCompletionIsAtomicWithVerifiedGcSettlement() {
        initSession();
        head(session);
        jdbc.update(
                "UPDATE ma_session_head SET journal_revision = 2, compacted_through_revision = 1"
                        + " WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        retire();
        var collector = collector(true, Duration.ZERO);
        assertThatThrownBy(collector::runOnce).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("journal collection is incomplete");
        assertThat(jdbc.queryForObject(
                                "SELECT resource_gc_completed FROM ma_session WHERE tenant_id = ?"
                                        + " AND session_id = ?",
                Boolean.class, tenant, session)).isFalse();
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                    + " 'SESSION_RESOURCE_GC' AND tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isNotEqualTo("SUCCEEDED");
        jdbc.update(
                "UPDATE ma_session_head SET compacted_through_revision = journal_revision WHERE"
                        + " tenant_id = ? AND session_id = ?",
                tenant, session);
        jdbc.update(
                "UPDATE ma_operation SET available_at = 0, claim_until = NULL WHERE operation_kind"
                        + " = 'SESSION_RESOURCE_GC' AND tenant_id = ? AND session_id = ?",
                tenant, session);
        assertThat(collector.runOnce()).isTrue();
        assertThat(jdbc.queryForObject(
                                "SELECT resource_gc_completed FROM ma_session WHERE tenant_id = ?"
                                        + " AND session_id = ?",
                Boolean.class, tenant, session)).isTrue();
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                    + " 'SESSION_RESOURCE_GC' AND tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject(
                                "SELECT journal_revision FROM ma_session_head WHERE tenant_id = ?"
                                        + " AND session_id = ?", Long.class, tenant, session))
                .isEqualTo(2);
    }

    private void initSession() {
        resScope = ManagedSessionStore.sessionScopeKey(tenant, session);
        token = "a".repeat(32);
    }

    private void head(String sessionId) {
        jdbc.update(
                "INSERT INTO ma_session_head (head_kind, tenant_key, harness_key, tenant_id, harness_session_id, workspace_id, session_id, storage_version, state, writer_generation, writer_id, writer_lease_until, lease_token_hash, journal_revision, committed_sequence, last_commit_digest, activation_epoch, compacted_through_revision, recovery_status, gmt_create, gmt_modified) VALUES ('MANAGED_SESSION', ?, ?, ?, ?, 'workspace-1', ?, 1, 'SEALED', 1, 'original', 946684800000, ?, 1, 1, ?, 1, 1, 'READY', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSchemaKeys.key(tenant), ManagedSchemaKeys.key(sessionId), tenant, sessionId, sessionId, "a".repeat(64), "b".repeat(64));
    }

    private void publish(String resourceId, String kind, byte[] bytes) {
        publish(resourceId, kind, bytes, "PUBLISHED", "MYSQL_INLINE");
    }

    private void publish(String resourceId, String kind, byte[] bytes, String state, String storage) {
        publish(resourceId, kind, bytes, state, storage, 1);
    }

    private void publish(String resourceId, String kind, byte[] bytes, String state, String storage,
            int schemaVersion) {
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, object_key, publish_command_id, state, gmt_create, last_verified_at) VALUES (?, ?, ?, 'workspace-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSchemaKeys.key(resScope, resourceId), resScope, tenant, session, resourceId, kind, schemaVersion, bytes.length,
                ToolPublicationContract.sha256(bytes), storage, bytes,
                "TOOL_PUBLICATION".equals(storage) ? "object-" + resourceId : null, resourceId, state);
    }

    private void reference(String resourceId) {
        jdbc.update(
                "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, workspace_id, session_id, journal_revision, resource_id, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, ?, 'workspace-1', ?, 1, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                resScope, ManagedSchemaKeys.key(resScope, "journal"), ManagedSchemaKeys.key(resScope, resourceId), tenant, session, resourceId);
    }

    private void seedLedger() {
        String id = "session-resources-" + resScope;
        long now = ToolPublicationRetentionStore.now(jdbc);
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id, operation_kind, tenant_id, session_id, target_kind, target_key, request_digest, request_json, phase, state, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'SESSION_RESOURCE_GC', ?, ?, 'SESSION', ?, ?, '{}', 'COLLECTING', 'PENDING', ?, ?)",
                ManagedSchemaKeys.operationKey(OperationKind.SESSION_RESOURCE_GC, resScope, resScope, id), resScope, resScope, id,
                tenant, session, resScope, ManagedSchemaKeys.key(id), now, now);
    }

    private void recovery(String id, String state) {
        recovery(jdbc, id, state);
    }

    private void recovery(JdbcTemplate target, String id, String state) {
        String op = addRecoveryOperation(target, id, state);
        target.update(
                "INSERT INTO ma_operation_work (operation_key, work_kind, target_key, target_id, tenant_id, session_id, state, payload_json, gmt_create, gmt_modified) VALUES (?, 'SESSION', ?, ?, ?, ?, 'PENDING', '{}', 0, 0)", op, ManagedSchemaKeys.key(session), session, tenant, session);
    }

    private String addRecoveryOperation(JdbcTemplate target, String id, String state) {
        String op = ManagedSchemaKeys.operationKey(OperationKind.WORKSPACE_RECOVERY, resScope, ManagedSchemaKeys.key("storage-1"), id);
        long now = ToolPublicationRetentionStore.now(target);
        target.update(
                "INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id, operation_kind, tenant_id, session_id, target_kind, target_key, request_digest, request_json, phase, state, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'WORKSPACE_RECOVERY', ?, ?, 'STORAGE', ?, ?, '{}', 'CAPTURE', ?, ?, ?)",
                op, resScope, resScope, id, tenant, session, ManagedSchemaKeys.key("storage-1"), "a".repeat(64), state, now, now);
        return op;
    }

    private void childRelayRow(String kind, String state) {
        long now = ToolPublicationRetentionStore.now(jdbc);
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_id, operation_kind, tenant_id, session_id, target_kind, target_key, request_digest, request_json, phase, state, gmt_create, gmt_modified) VALUES (?, ?, ?, 'run-1', ?, ?, ?, 'CHILD_RUN', ?, ?, '{}', 'STARTING', ?, ?, ?)",
                ManagedSchemaKeys.operationKey(OperationKind.valueOf(kind), resScope, ManagedSchemaKeys.key("run-1"), "run-1"),
                resScope, resScope, kind, tenant, session, ManagedSchemaKeys.key("run-1"), "a".repeat(64), state, now, now);
    }

    private void tombstone(String id, String operation, long time) {
        jdbc.update(
                "INSERT INTO ma_session (tenant_id, session_id, session_kind, tenant_key, session_key, session_scope_key, retirement_operation_id, retirement_generation, retired_at, gmt_create, gmt_modified) VALUES (?, ?, 'CONTROL', ?, ?, ?, ?, 1, ?, ?, ?)", tenant, id, ManagedSchemaKeys.key(tenant),
                ManagedSchemaKeys.key(id), ManagedSessionStore.sessionScopeKey(tenant, id), operation, time, time, time);
    }

    private SessionResourceCollectionCollector collector(boolean enabled, Duration grace) {
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(enabled);
        props.getToolPublication().setDeletionGrace(grace);
        return new SessionResourceCollectionCollector(jdbc, manager, props);
    }

    private Map<String, Object> ledger() {
        var row = jdbc.queryForMap(
                        "SELECT *, claim_until AS claim_until_epoch FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", resScope);
        var progress = row.get("result_json") == null ? new ObjectMapper().createObjectNode()
                : ManagedToolResultStore.parse((String) row.get("result_json"));
        row.put("collected_bytes", progress.path("collectedBytes").asLong());
        row.put("gc_cursor", progress.path("cursor").asText(""));
        row.put("collected_at", row.get("completed_at"));
        row.put("gc_owner", row.get("claim_owner"));
        row.put("gc_generation", row.get("claim_generation"));
        row.put("gc_blocker", row.get("failure_code"));
        row.put("gc_next_at", row.get("available_at"));
        return row;
    }

    private long countLedgers() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation"
                + " WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", Long.class, resScope);
    }

    private List<Map<String, Object>> rows() {
        return jdbc.queryForList("SELECT resource_id, state, inline_bytes FROM ma_resource"
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
        jdbc.update("UPDATE ma_session SET recovery_protected = TRUE"
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
        seedLedger();
        var collector = collector(true, Duration.ofHours(24));
        assertThat(collector.runOnce()).isFalse();
        var ledger = ledger();
        long retiredAt = jdbc.queryForObject("SELECT retired_at FROM ma_session"
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
        jdbc.update("UPDATE ma_session_head SET state = 'ACTIVE'"
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
        jdbc.update("UPDATE ma_operation SET available_at = 0"
                + " WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", resScope);
        assertThat(collector.runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        assertThat(ledger().get("gc_blocker")).isNull();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"CAPTURING", "VERIFYING"})
    void inFlightRecoveryHoldsCollectionUntilTheOperationTerminates(String state) {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        recovery("op-recovery", state);
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isFalse();
        var blocked = ledger();
        assertThat(blocked.get("gc_blocker")).isEqualTo("recovery_active");
        long nowMillis = System.currentTimeMillis();
        assertThat(((Number) blocked.get("gc_next_at")).longValue())
                .isBetween(nowMillis + 50_000, nowMillis + 70_000);
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
        jdbc.update(
                "UPDATE ma_operation SET state = ? WHERE operation_kind = 'WORKSPACE_RECOVERY' AND"
                        + " operation_id = X'6f702d7265636f76657279'",
                "CAPTURING".equals(state) ? "SEALED" : "VERIFIED");
        jdbc.update("UPDATE ma_operation SET available_at = 0"
                + " WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", resScope);
        assertThat(collector.runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        assertThat(ledger().get("gc_blocker")).isNull();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"done", "orphaned", "unknown"})
    void aChildStartHoldsCollectionOnlyUntilTheRelayClassifiesIt(String classification) {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        childRelayRow("CHILD_SESSION_START", "watching");
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isFalse();
        assertThat(ledger().get("gc_blocker")).isEqualTo("child_start_unresolved");
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
        // Every classification is terminal: an `unknown` walk (#14165 FG10d) is never rewritten,
        // so it releases the parent as `done` does, even beside a close a host without close
        // capability still owes on its own row.
        jdbc.update("UPDATE ma_operation SET state = ? WHERE operation_kind = 'CHILD_SESSION_START'"
                + " AND session_scope_key = ?", classification, resScope);
        if (!"orphaned".equals(classification)) {
            childRelayRow("CHILD_SESSION_CLOSE", "close_debt");
        }
        jdbc.update("UPDATE ma_operation SET available_at = 0"
                + " WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", resScope);
        assertThat(collector.runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        assertThat(ledger().get("gc_blocker")).isNull();
    }

    @Test
    void recoveryRegisteringInTheClaimPageGapDefersCollection() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        // The ledger directly, so the test drives the claim and the page as separate steps.
        seedLedger();
        var collector = collector(true, Duration.ZERO);
        var claim = collector.claim();
        assertThat(claim).isNotNull();
        // The registration commits after claim()'s transaction and before page().
        recovery("op-late", "CAPTURING");
        assertThat(collector.collect(claim)).isFalse();
        assertThat(rows().getFirst().get("state")).isEqualTo("PUBLISHED");
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
        var deferred = ledger();
        assertThat(deferred.get("collected_at")).isNull();
        assertThat(deferred.get("gc_blocker")).isEqualTo("collection_retry");
        jdbc.update(
                "UPDATE ma_operation SET state = 'SEALED' WHERE operation_kind ="
                        + " 'WORKSPACE_RECOVERY' AND operation_id = X'6f702d6c617465'");
        jdbc.update("UPDATE ma_operation SET available_at = 0"
                + " WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", resScope);
        assertThat(collector.runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
    }

    @Test
    void uncommittedRecoveryRegistrationHoldsThePageUntilItCommits() throws Exception {
        String product;
        try (var connection = jdbc.getDataSource().getConnection()) {
            product = connection.getMetaData().getDatabaseProductName();
        }
        // Only InnoDB has the next-key and record locks this pins; H2 neither blocks nor sees the
        // insert.
        org.junit.jupiter.api.Assumptions.assumeTrue(product.equals("MySQL") || product.equals("MariaDB"));
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        seedLedger();
        var collector = collector(true, Duration.ZERO);
        var claim = collector.claim();
        assertThat(claim).isNotNull();
        try (var registrar = jdbc.getDataSource().getConnection();
                var pages = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            // A registration in flight: its pin row is inserted but not committed when the page
            // runs.
            registrar.setAutoCommit(false);
            recovery(new ManagedSchemaJdbcTemplate(new org.springframework.jdbc.datasource.SingleConnectionDataSource(registrar, true)),
                    "op-inflight", "CAPTURING");
            var page = pages.submit(() -> collector.collect(claim));
            Thread.sleep(1000);
            // The locking re-check waits on the uncommitted pin; a plain read would not see it and
            // collect.
            assertThat(page.isDone()).isFalse();
            registrar.commit();
            assertThat(page.get(30, java.util.concurrent.TimeUnit.SECONDS)).isFalse();
        }
        assertThat(rows().getFirst().get("state")).isEqualTo("PUBLISHED");
        assertThat(rows().getFirst().get("inline_bytes")).isNotNull();
        assertThat(ledger().get("gc_blocker")).isEqualTo("collection_retry");
    }

    @Test
    void pageGapLockHoldsARegistrationEvenOnAReadCommittedPool() throws Exception {
        String product;
        try (var connection = jdbc.getDataSource().getConnection()) {
            product = connection.getMetaData().getDatabaseProductName();
        }
        // Gap locks exist only on InnoDB, and only under REPEATABLE READ.
        org.junit.jupiter.api.Assumptions.assumeTrue(product.equals("MySQL") || product.equals("MariaDB"));
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        seedLedger();
        // A pool whose connections default to READ COMMITTED, as many managed MySQL services ship.
        var readCommitted = new org.springframework.jdbc.datasource.DelegatingDataSource(jdbc.getDataSource()) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                var connection = super.getConnection();
                connection.setTransactionIsolation(java.sql.Connection.TRANSACTION_READ_COMMITTED);
                return connection;
            }
        };
        var dropReached = new java.util.concurrent.CountDownLatch(1);
        var paused = new ManagedSchemaJdbcTemplate(readCommitted) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("UPDATE ma_resource SET state = 'COLLECTED'")) {
                    dropReached.countDown();
                    try {
                        Thread.sleep(1500);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
                return super.update(sql, args);
            }
        };
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(true);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(paused,
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(readCommitted), props);
        var claim = collector.claim();
        assertThat(claim).isNotNull();
        try (var pages = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            // The page passes its re-check first and holds its transaction just before the byte
            // drop.
            var page = pages.submit(() -> collector.collect(claim));
            assertThat(dropReached.await(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            long started = System.nanoTime();
            recovery("op-after", "CAPTURING");
            long waitedMillis = (System.nanoTime() - started) / 1_000_000;
            // The pin could not be written until the page committed its byte drop: the page's gap
            // lock
            // serialized it, so no registration can pin bytes that are being dropped.
            assertThat(page.get(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(waitedMillis).isGreaterThanOrEqualTo(1000);
        }
    }

    @Test
    void collectorTransactionsPinRepeatableRead() {
        initSession();
        seedLedger();
        var isolations = new java.util.ArrayList<Integer>();
        var recording = new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()) {
            @Override protected void doBegin(Object transaction,
                    org.springframework.transaction.TransactionDefinition definition) {
                isolations.add(definition.getIsolationLevel());
                super.doBegin(transaction, definition);
            }
        };
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(true);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        new SessionResourceCollectionCollector(jdbc, recording, props).claim();
        // H2 cannot observe the gap locks this pin enables, so assert the requested isolation
        // directly; the InnoDB-observable half is the MySQL-only pair above.
        assertThat(isolations).isNotEmpty().allSatisfy(level -> assertThat(level)
                .isEqualTo(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ));
    }

    @Test
    void scheduledTickAbsorbsATransientFailureIntoAWarnAndTheRetryBlocker() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        var failing = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("UPDATE ma_resource SET state = 'COLLECTED'")) {
                    throw new org.springframework.dao.DataAccessResourceFailureException("injected page failure");
                }
                return super.update(sql, args);
            }
        };
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(true);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(failing, manager, props);
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                .getLogger(SessionResourceCollectionCollector.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        try {
            collector.tick();
            assertThat(appender.list).singleElement().satisfies(event -> {
                assertThat(event.getLevel()).isEqualTo(ch.qos.logback.classic.Level.WARN);
                assertThat(event.getThrowableProxy()).isNotNull();
            });
            var ledger = ledger();
            assertThat(ledger.get("gc_blocker")).isEqualTo("collection_retry");
            assertThat(rows().getFirst().get("state")).isEqualTo("PUBLISHED");
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void completionSweepsExpiredReadLeases() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        jdbc.update("INSERT INTO ma_read_lease (lease_id, tenant_key, session_key,"
                + " retirement_generation, expires_at) VALUES ('expired-1', ?, ?, 0, 1)",
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session));
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(ledger().get("collected_at")).isNotNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_read_lease"
                + " WHERE tenant_key = ? AND session_key = ?", Long.class,
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session))).isZero();
    }

    @Test
    void failedPageDefersWithCollectionRetryAndRethrows() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        var failing = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("UPDATE ma_resource SET state = 'COLLECTED'")) {
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
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create, last_verified_at) VALUES (?, ?, ?, 'workspace-1', ?, 'segment', ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'segment', 'PUBLISHED', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSchemaKeys.key(otherScope, "segment"), otherScope, tenant, other, CONTENT, 64, ToolPublicationContract.sha256(new byte[64]),
                new byte[64]);
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, other);
            ToolPublicationRetentionStore.retire(jdbc, tenant, other, "delete-2");
        });
        retire();
        var collector = collector(true, Duration.ZERO);
        assertThat(collector.runOnce()).isTrue();
        try (lease) {
            assertThat(jdbc.queryForList("SELECT state, inline_bytes FROM ma_resource"
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
            tombstone(retired, "purge-" + index, now - (34 - index) * 1000);
        }
        retire();
        collector(true, Duration.ZERO).runOnce();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation",
                Long.class)).isEqualTo(32);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation c JOIN ma_session r ON"
                                        + " r.session_scope_key = c.session_scope_key AND"
                                        + " r.session_scope_key = c.session_scope_key WHERE"
                                        + " r.session_id = X'7374616c652d3333'", Long.class)).isZero();
    }

    @Test
    void immutableSqlBodiesAreCollectedWhileReferencesAndExternalLayoutsRemainProtected() {
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
        jdbc.update(
                "UPDATE ma_resource SET object_key = 'injected' WHERE session_scope_key = ? AND"
                        + " resource_id = X'672d756e6b6e6f776e2d6c61796f7574'", resScope);
        publish("h-version-layout", CONTENT, new byte[7]);
        jdbc.update(
                "UPDATE ma_resource SET object_version_id = 'injected' WHERE session_scope_key = ?"
                        + " AND resource_id = X'682d76657273696f6e2d6c61796f7574'", resScope);
        publish("i-encryption-layout", CONTENT, new byte[8]);
        jdbc.update(
                "UPDATE ma_resource SET encryption_key_id = 'injected' WHERE session_scope_key = ?"
                        + " AND resource_id = X'692d656e6372797074696f6e2d6c61796f7574'", resScope);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        var collected = java.util.Set.of("a-referenced", "b-monitor", "e-overbound", "f-version");
        assertThat(rows()).allSatisfy(row -> {
            boolean expected = collected.contains(row.get("resource_id"));
            assertThat(row.get("state")).isEqualTo(expected ? "COLLECTED" : "PUBLISHED");
            assertThat(row.get("inline_bytes") == null).isEqualTo(expected);
        });
        assertThat(((Number) ledger().get("collected_bytes")).longValue()).isEqualTo(2L * 1024 * 1024 + 8);
        assertThat(ledger().get("collected_at")).isNotNull();
    }

    @Test
    void alreadyFreedRowsAreNotCountedAgain() {
        initSession();
        head(session);
        publish("eligible", CONTENT, new byte[500]);
        publish("freed", CONTENT, new byte[1000]);
        // The shape a byte-freeing writer leaves behind: bytes nulled, state and byte_length kept.
        jdbc.update("UPDATE ma_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = X'6672656564'", resScope);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        var ledger = ledger();
        assertThat(((Number) ledger.get("collected_bytes")).longValue()).isEqualTo(500);
        assertThat(ledger.get("collected_at")).isNotNull();
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_resource WHERE session_scope_key = ? AND"
                                        + " resource_id = X'656c696769626c65'", String.class, resScope))
                .isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_resource WHERE session_scope_key = ? AND"
                                        + " resource_id = X'6672656564'", String.class, resScope))
                .isEqualTo("PUBLISHED");
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
            assertThat(ledger.get("gc_cursor")).isEqualTo(rows().stream().map(row -> ManagedSchemaKeys.key(resScope, (String) row.get("resource_id"))).sorted().toList().get(99));
            assertThat(ledger.get("collected_at")).isNull();
            // A second instance cannot take over while the claim is alive.
            assertThat(collector(true, Duration.ZERO).runOnce()).isFalse();
            assertThat(((Number) ledger().get("collected_bytes")).longValue()).isEqualTo(1000);
            // An expired claim is handed off and finishes exactly once.
            jdbc.update(
                    "UPDATE ma_operation SET claim_until = 0 WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", resScope);
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
        assertThat(ledger().get("gc_cursor")).isEqualTo(rows().stream().map(row -> ManagedSchemaKeys.key(resScope, (String) row.get("resource_id"))).sorted().toList().get(31));
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
        jdbc.update(
                "UPDATE ma_session_head SET state = 'SEALED', writer_lease_until = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli(), tenant, session);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        assertThatThrownBy(() -> sessions.readResource(tenant, "workspace-1", session, "collected", token))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
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
        var intercepted = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
                if (sql.contains("ma_operation") && sql.contains("FOR UPDATE")
                        && reads.incrementAndGet() == 2) {
                    plain.update("UPDATE ma_operation SET claim_owner = 'b-owner', claim_generation = claim_generation + 1, claim_until = ? WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?",
                            System.currentTimeMillis() + 300_000, resScope);
                }
                return super.query(sql, mapper, args);
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
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create, last_verified_at) VALUES (?, ?, ?, 'workspace-1', ?, 'segment-000', ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'segment-000', 'PUBLISHED', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSchemaKeys.key(otherScope, "segment-000"), otherScope, tenant, other, CONTENT, 64, ToolPublicationContract.sha256(new byte[64]),
                new byte[64]);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(rows().getFirst().get("state")).isEqualTo("COLLECTED");
        var survivors = jdbc.queryForList("SELECT state, inline_bytes FROM ma_resource"
                + " WHERE session_scope_key = ?", otherScope);
        assertThat(survivors).singleElement().satisfies(row -> {
            assertThat(row.get("state")).isEqualTo("PUBLISHED");
            assertThat(row.get("inline_bytes")).isNotNull();
        });
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'SESSION_RESOURCE_GC' AND session_scope_key = ?", Long.class, otherScope)).isZero();
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
        tombstone(later, "purge-later", now - 1000);
        assertThat(collector.runOnce()).isFalse();
        String laterScope = ManagedSessionStore.sessionScopeKey(tenant, later);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'SESSION_RESOURCE_GC' AND session_scope_key = ?", Long.class, laterScope)).isZero();
    }

    @Test
    void inGraceTombstoneCreatesNoLedgerUntilDue() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        assertThat(collector(true, Duration.ofHours(24)).runOnce()).isFalse();
        assertThat(countLedgers()).isZero();
        jdbc.update("UPDATE ma_session SET retired_at = retired_at - ?"
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
        var completed = ledger();
        assertThat(((Number) completed.get("gc_next_at")).longValue()).isEqualTo(ManagedSchemaTime.NEVER_DUE_MILLIS);
        assertThat(completed.get("state")).isEqualTo("SUCCEEDED");
        assertThat(collector.runOnce()).isFalse();
        assertThat(ledger().get("gc_generation")).isEqualTo(completed.get("gc_generation"));
    }

    @Test
    void recoveryReaderAnswersResourceCollected() {
        initSession();
        publish("collected", CONTENT, new byte[64], "COLLECTED", "MYSQL_INLINE");
        jdbc.update("UPDATE ma_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = X'636f6c6c6563746564'", resScope);
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
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?"
                + " WHERE session_scope_key = ? AND resource_id = X'74616d7065726564'", new byte[63], resScope);
        assertThatThrownBy(() -> sessions.readResource(tenant, "workspace-1", session, "tampered", token))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
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
        var intercepted = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
                if (sql.startsWith("SELECT resource_key, byte_length,")) {
                    executions.incrementAndGet();
                }
                return super.query(sql, mapper, args);
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
    void pageQueryNeverMaterializesInlineBytesWhileTheByteDropPredicatesOnThem() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        var recording = new SqlRecordingDataSource(jdbc.getDataSource());
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(true);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(new ManagedSchemaJdbcTemplate(recording),
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(recording), props);
        assertThat(collector.runOnce()).isTrue();
        // Referencing the BLOB in the page SELECT makes InnoDB materialize up to PAGE_ROWS + 1
        // MEDIUMBLOBs per scan just to NULL-test them; the byte drop stays a primary-key lookup.
        assertThat(recording.statements)
                .filteredOn(sql -> sql.startsWith("SELECT resource_key, byte_length,"))
                .isNotEmpty()
                .allSatisfy(sql -> assertThat(sql).doesNotContain("inline_bytes"));
        assertThat(recording.statements)
                .filteredOn(sql -> sql.startsWith("UPDATE ma_resource SET state = 'COLLECTED'"))
                .isNotEmpty()
                .allSatisfy(sql -> assertThat(sql).contains("inline_bytes IS NOT NULL"));
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
            jdbc.update(
                    "UPDATE ma_operation SET available_at = 0 WHERE operation_kind ="
                            + " 'SESSION_RESOURCE_GC' AND session_scope_key = ?", resScope);
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
        jdbc.update(
                "UPDATE ma_session_head SET state = 'SEALED', writer_lease_until = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli(), tenant, session);
        retire();
        assertThat(collector(true, Duration.ZERO).runOnce()).isTrue();
        assertThat(((Number) ledger().get("collected_bytes")).longValue()).isEqualTo(1024 + 256 + 64);
        assertThat(rows()).allSatisfy(row -> {
            assertThat(row.get("state")).isEqualTo("COLLECTED");
            assertThat(row.get("inline_bytes")).isNull();
        });
    }

    /** Records the SQL of every prepared statement the code under it creates. */
    private static final class SqlRecordingDataSource
            extends org.springframework.jdbc.datasource.AbstractDataSource {
        private final javax.sql.DataSource delegate;
        final List<String> statements = new java.util.concurrent.CopyOnWriteArrayList<>();

        SqlRecordingDataSource(javax.sql.DataSource delegate) {
            this.delegate = delegate;
        }

        @Override
        public java.sql.Connection getConnection() throws java.sql.SQLException {
            var connection = delegate.getConnection();
            return (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(
                    SessionResourceCollectionCollectorTest.class.getClassLoader(),
                    new Class<?>[] {java.sql.Connection.class}, (proxy, method, args) -> {
                        if ("prepareStatement".equals(method.getName()) && args != null
                                && args.length > 0 && args[0] instanceof String sql) {
                            statements.add(sql);
                        }
                        try {
                            return method.invoke(connection, args);
                        } catch (java.lang.reflect.InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
        }

        @Override
        public java.sql.Connection getConnection(String username, String password) throws java.sql.SQLException {
            return getConnection();
        }
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
        // The shape ToolPublicationCollector.confirm() leaves: bytes nulled, state untouched,
        // and the cataloged publication object marked COLLECTED in the same transaction.
        jdbc.update("UPDATE ma_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = X'6672656564'", resScope);
        jdbc.update(
                "UPDATE ma_resource SET scope_key = ?, publication_id = ?, slot_key ="
                        + " 'segment:stdout:0', capture_state = ? WHERE session_scope_key = ? AND"
                        + " resource_id = ?", ToolPublicationDataStore.scope(tenant, "workspace-1", session),
                "pub-collected", "COLLECTED", resScope, "freed");
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

    @Test
    void recoveryReaderIgnoresCollectedMarkersOfOtherResourcesAndOtherSessions() {
        initSession();
        publish("lost", MANIFEST, new byte[64], "REFERENCED", "MYSQL_INLINE");
        reference("lost");
        jdbc.update("UPDATE ma_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = X'6c6f7374'", resScope);
        // Neither marker is evidence for this row: one names another resource of the same
        // Session, the other names this resource id under another Session's scope.
        addCaptureObject(ToolPublicationDataStore.scope(tenant, "workspace-1", session), "pub-sibling", session, "segment:stdout:0", "sibling", null, new byte[64], "COLLECTED");
        addCaptureObject(ToolPublicationDataStore.scope(tenant, "workspace-1", "another-session"), "pub-elsewhere", "another-session", "segment:stdout:0", "lost", null, new byte[64], "COLLECTED");
        var reader = new WorkspaceRecoveryReader(jdbc, null);
        var source = new ObjectMapper().createObjectNode();
        source.putObject("head").put("tenantId", tenant).put("workspaceId", "workspace-1")
                .put("sessionId", session).put("journalRevision", 10)
                .putNull("latest_checkpoint_resource_id");
        var ref = new ObjectMapper().createObjectNode().put("resourceId", "lost")
                .put("kind", MANIFEST).put("schemaVersion", 1).put("byteLength", 64)
                .put("digest", ToolPublicationContract.sha256(new byte[64]));
        assertThatThrownBy(() -> reader.resource(source, ref)).hasMessageContaining("resource_corrupt");
    }

    @Test
    void recoveryReaderAnswersResourceCorruptForAnUnexplainedByteLoss() {
        initSession();
        publish("lost", MANIFEST, new byte[64], "REFERENCED", "MYSQL_INLINE");
        reference("lost");
        // The same byteless shape with no collected publication cataloging the resource:
        // nothing proves collection, so the read stays on the fail-closed path.
        jdbc.update("UPDATE ma_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = X'6c6f7374'", resScope);
        var reader = new WorkspaceRecoveryReader(jdbc, null);
        var source = new ObjectMapper().createObjectNode();
        source.putObject("head").put("tenantId", tenant).put("workspaceId", "workspace-1")
                .put("sessionId", session).put("journalRevision", 10)
                .putNull("latest_checkpoint_resource_id");
        var ref = new ObjectMapper().createObjectNode().put("resourceId", "lost")
                .put("kind", MANIFEST).put("schemaVersion", 1).put("byteLength", 64)
                .put("digest", ToolPublicationContract.sha256(new byte[64]));
        assertThatThrownBy(() -> reader.resource(source, ref)).hasMessageContaining("resource_corrupt");
    }

    @Test
    void recoveryReaderAnswersResourceCorruptForANonCollectedCatalogEntry() {
        initSession();
        publish("inflight", MANIFEST, new byte[64], "REFERENCED", "MYSQL_INLINE");
        reference("inflight");
        // A cataloged publication object in a state the admission path actually leaves
        // behind (VERIFIED) is not evidence of collection: the byte loss stays fail-closed.
        jdbc.update("UPDATE ma_resource SET inline_bytes = NULL"
                + " WHERE session_scope_key = ? AND resource_id = X'696e666c69676874'", resScope);
        jdbc.update(
                "UPDATE ma_resource SET scope_key = ?, publication_id = ?, slot_key ="
                        + " 'segment:stdout:0', capture_state = ? WHERE session_scope_key = ? AND"
                        + " resource_id = ?", ToolPublicationDataStore.scope(tenant, "workspace-1", session),
                "pub-inflight", "VERIFIED", resScope, "inflight");
        var reader = new WorkspaceRecoveryReader(jdbc, null);
        var source = new ObjectMapper().createObjectNode();
        source.putObject("head").put("tenantId", tenant).put("workspaceId", "workspace-1")
                .put("sessionId", session).put("journalRevision", 10)
                .putNull("latest_checkpoint_resource_id");
        var ref = new ObjectMapper().createObjectNode().put("resourceId", "inflight")
                .put("kind", MANIFEST).put("schemaVersion", 1).put("byteLength", 64)
                .put("digest", ToolPublicationContract.sha256(new byte[64]));
        assertThatThrownBy(() -> reader.resource(source, ref)).hasMessageContaining("resource_corrupt");
    }

    @Test
    void ledgerScanRescansAtTheCadenceOnAMonotonicClock() {
        initSession();
        head(session);
        publish("segment", CONTENT, new byte[64]);
        retire();
        var nanos = new java.util.concurrent.atomic.AtomicLong(Duration.ofSeconds(100).toNanos());
        var collector = collector(true, Duration.ZERO, nanos::get);
        collector.runOnce();
        assertThat(countLedgers()).isEqualTo(1);

        String later = "session-later";
        String laterScope = ManagedSessionStore.sessionScopeKey(tenant, later);
        retireSession(later, "purge-later");
        // Inside the 60-second window the same instance does not re-scan.
        nanos.addAndGet(Duration.ofSeconds(30).toNanos());
        collector.runOnce();
        assertThat(ledgerCount(laterScope)).isZero();
        // Once the cadence elapses, the same instance re-scans and creates the ledger.
        nanos.addAndGet(Duration.ofSeconds(31).toNanos());
        collector.runOnce();
        assertThat(ledgerCount(laterScope)).isEqualTo(1);

        String third = "session-third";
        String thirdScope = ManagedSessionStore.sessionScopeKey(tenant, third);
        retireSession(third, "purge-third");
        // A backward host-clock step (NTP, VM resume) reads as "within the window", not as a
        // permanent stall: scanning resumes as soon as the monotonic clock catches up.
        nanos.addAndGet(-Duration.ofHours(6).toNanos());
        collector.runOnce();
        assertThat(ledgerCount(thirdScope)).isZero();
        nanos.addAndGet(Duration.ofHours(6).toNanos() + Duration.ofSeconds(61).toNanos());
        collector.runOnce();
        assertThat(ledgerCount(thirdScope)).isEqualTo(1);
    }

    private SessionResourceCollectionCollector collector(boolean enabled, Duration grace, LongSupplier clock) {
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(enabled);
        props.getToolPublication().setDeletionGrace(grace);
        return new SessionResourceCollectionCollector(jdbc, manager, props, clock);
    }

    private void retireSession(String sessionId, String operationId) {
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, sessionId);
            ToolPublicationRetentionStore.retire(jdbc, tenant, sessionId, operationId);
        });
    }

    private long ledgerCount(String sessionScope) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation"
                + " WHERE operation_kind = 'SESSION_RESOURCE_GC' AND session_scope_key = ?", Long.class, sessionScope);
    }

    @Test
    void retainedPrivatePinRefusesAStaleClaimAndPreservesInlineBytes() {
        initSession();
        head(session);
        publish("private-content", CONTENT, new byte[100]);
        retire();
        seedLedger();
        var collector = collector(true, Duration.ZERO);
        var claim = collector.claim();
        assertThat(claim).isNotNull();
        jdbc.update(
                "UPDATE ma_session SET runtime_request_key = ? WHERE tenant_id = ? AND session_id ="
                        + " ?",
                "a".repeat(64),
                tenant,
                session);
        var before = rows();
        var beforeLedger = ledger();
        assertThatThrownBy(() -> collector.collect(claim))
                .isInstanceOfSatisfying(
                        ManagedAgentException.class,
                        error ->
                                assertThat(error.getCode())
                                        .isEqualTo("csi_managed_mutation_unavailable"));
        assertThat(rows()).usingRecursiveComparison().isEqualTo(before);
        assertThat(ledger()).isEqualTo(beforeLedger);
        assertThat(collector.runOnce()).isFalse();
        assertThat(rows()).usingRecursiveComparison().isEqualTo(before);
    }
}
