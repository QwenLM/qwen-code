package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

public class ToolPublicationRetentionStoreTest {
    protected JdbcTemplate jdbc;
    protected DataSourceTransactionManager manager;
    protected TransactionTemplate tx;
    protected ToolPublicationRetentionStore retention;
    protected ObjectNode key;
    protected String tenant;
    protected String session;
    protected String scope;

    protected javax.sql.DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:retention-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        return source;
    }

    @BeforeEach
    void setup() {
        var source = dataSource();
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        tx = new TransactionTemplate(manager);
        retention = new ToolPublicationRetentionStore(jdbc, manager);
        tenant = "retention-" + UUID.randomUUID();
        session = "session-1";
        scope = ToolPublicationRetentionStore.hash(tenant + session);
        key = new ObjectMapper().createObjectNode().put("tenantId", tenant)
                .put("workspaceId", "workspace-1").put("sessionId", session);
        jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                + " capture_bytes, producer_bytes, admission_bytes, producer_phase, write_evidence, accepted_complete,"
                + " capture_held_bytes, producer_held_bytes, admission_held_bytes, capture_used_bytes)"
                + " VALUES (?, ?, ?, 'workspace-1', ?, 'pub-1', ?, 'capture-1', '{}', ?, ?, 'FENCED',"
                + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE, 1000, 1000, 1000, 123)",
                scope, ToolPublicationRetentionStore.hash(tenant), tenant, session, scope, scope, scope);
    }

    protected void retire() {
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
            ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete-1");
        });
    }

    protected String blocker() {
        return retention.observe(Duration.ZERO).stream().filter(candidate -> candidate.scope().equals(scope))
                .findFirst().orElseThrow().blocker();
    }

    @Test
    void retainsActiveOutputAndStartsGraceOnlyAtPermanentRetirement() {
        assertThat(retention.observe(Duration.ZERO)).noneMatch(candidate -> scope.equals(candidate.scope()));
        try (var lease = retention.read(key)) { lease.check(); }
        retire();
        long first = jdbc.queryForObject("SELECT retired_at FROM qwen_output_session_retirement WHERE tenant_id = ?",
                Long.class, tenant);
        assertThat(retention.observe(Duration.ofHours(24))).filteredOn(candidate -> candidate.scope().equals(scope))
                .singleElement().extracting(ToolPublicationRetentionStore.Candidate::blocker).isEqualTo("grace_period");
        retire();
        assertThat(jdbc.queryForObject("SELECT retired_at FROM qwen_output_session_retirement WHERE tenant_id = ?",
                Long.class, tenant)).isEqualTo(first);
        assertThatThrownBy(() -> retention.read(key)).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.getCode()).isEqualTo("tool_output_session_retired"));
        var sessions = new ManagedSessionStore(jdbc);
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session,
                "a".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L))))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void expiredOrRetiredLeaseCannotBeRevivedByAnotherLease() {
        try (var old = retention.read(key)) {
            jdbc.update("UPDATE qwen_output_read_lease SET expires_at = 0 WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.hash(tenant));
            try (var replacement = retention.read(key)) {
                replacement.check();
                assertThatThrownBy(old::check).isInstanceOf(ApiException.class);
                retire();
                assertThatThrownBy(replacement::check).isInstanceOf(ApiException.class);
                assertThat(blocker()).isEqualTo("reader_active");
            }
        }
        assertThat(blocker()).isNull();
    }

    @Test
    void pausedPhysicalReadStopsBeforeReturningBytesAfterLeaseExpiry() throws Exception {
        var entered = new CountDownLatch(1);
        var resume = new CountDownLatch(1);
        var objects = new MemoryObjects() {
            @Override public InputStream open(String objectKey) {
                return new ByteArrayInputStream(new byte[] {1, 2}) {
                    @Override public synchronized int read(byte[] target, int offset, int length) {
                        entered.countDown();
                        try { assertThat(resume.await(10, TimeUnit.SECONDS)).isTrue(); }
                        catch (InterruptedException error) { throw new IllegalStateException(error); }
                        return super.read(target, offset, length);
                    }
                };
            }
        };
        try (var input = retention.open(scope, "pub-1", "object", objects);
                var executor = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var result = executor.submit(() -> input.read(new byte[2]));
            assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
            jdbc.update("UPDATE qwen_output_read_lease SET expires_at = 0 WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.hash(tenant));
            resume.countDown();
            assertThatThrownBy(() -> result.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(ApiException.class);
        }
    }

    @Test
    void aFreshMetadataLeaseCannotReviveTheOriginalRequest() {
        var opens = new java.util.concurrent.atomic.AtomicInteger();
        var objects = new MemoryObjects() {
            @Override public InputStream open(String objectKey) {
                opens.incrementAndGet();
                return new ByteArrayInputStream(new byte[] {1});
            }
        };
        try (var original = retention.read(key)) {
            jdbc.update("UPDATE qwen_output_read_lease SET expires_at = 0 WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.hash(tenant));
            assertThatThrownBy(() -> retention.open(scope, "pub-1", "object", objects, original::check))
                    .isInstanceOf(ApiException.class);
            assertThat(opens).hasValue(0);
        }
    }

    @Test
    void successfulRetryNeverClosesAnUnknownPhysicalPut() {
        var objects = new MemoryObjects() {
            private boolean loseResponse = true;
            @Override public void putIfAbsent(String objectKey, byte[] bytes) {
                super.putIfAbsent(objectKey, bytes);
                if (loseResponse) { loseResponse = false; throw new IllegalStateException("response lost"); }
            }
        };
        assertThatThrownBy(() -> retention.put(key, scope, "pub-1", "exact-key", new byte[] {1}, objects))
                .isInstanceOf(IllegalStateException.class);
        retention.put(key, scope, "pub-1", "exact-key", new byte[] {1}, objects);
        assertThat(jdbc.queryForList("SELECT state FROM qwen_output_put_attempt WHERE scope_key = ?", String.class, scope))
                .containsExactlyInAnyOrder("UNKNOWN", "RETURNED");
        retire();
        assertThat(blocker()).isEqualTo("put_unresolved");
        assertThatThrownBy(() -> retention.put(key, scope, "pub-1", "exact-key", new byte[] {1}, objects))
                .isInstanceOf(ApiException.class);
        assertThat(objects.bytes).containsKey("exact-key");
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM qwen_tool_publication WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(1000);
    }

    @Test
    void incompleteQuarantinedAndLegacyEvidenceRemainProtected() {
        retire();
        assertThat(blocker()).isNull();
        jdbc.update("UPDATE qwen_tool_publication SET write_evidence = FALSE WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("legacy_write_evidence_missing");
        jdbc.update("UPDATE qwen_tool_publication SET write_evidence = TRUE, quarantined = TRUE WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("quarantined");
        jdbc.update("UPDATE qwen_tool_publication SET quarantined = FALSE, accepted_complete = FALSE WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("not_accepted_complete");
        jdbc.update("UPDATE qwen_tool_publication SET accepted_complete = TRUE, producer_phase = 'FINISHING' WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("not_accepted_complete");
        jdbc.update("UPDATE qwen_output_session_retirement SET recovery_protected = TRUE WHERE tenant_id = ?", tenant);
        assertThat(blocker()).isEqualTo("recovery_protected");
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {
        "READY", "BLOCKED_RESOURCE", "BLOCKED_WORKSPACE", "BLOCKED_EXECUTION"
    })
    void retirementDerivesRecoveryProtectionFromThePrivateHead(String recovery) {
        var sessions = new ManagedSessionStore(jdbc);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        tx.executeWithoutResult(status -> sessions.sealWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.SealWriterRequest("workspace-1", "writer", 1)));
        jdbc.update("UPDATE qwen_managed_session_journal_head SET recovery_status = ?"
                + " WHERE tenant_id = ? AND session_id = ?", recovery, tenant, session);
        retire();
        assertThat(blocker()).isEqualTo("READY".equals(recovery) ? null : "recovery_protected");
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session)).isFalse();
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM qwen_tool_publication WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(1000);
    }

    @Test
    void writerAcquisitionAndRetirementSerializeEvenWithoutAnExistingHead() throws Exception {
        var sessions = new ManagedSessionStore(jdbc);
        var locked = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var deletion = executor.submit(() -> tx.executeWithoutResult(status -> {
                ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
                locked.countDown();
                try { assertThat(release.await(10, TimeUnit.SECONDS)).isTrue(); }
                catch (InterruptedException error) { throw new IllegalStateException(error); }
                ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete-1");
            }));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();
            var acquisition = executor.submit(() -> tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session,
                    "a".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L))));
            release.countDown();
            deletion.get(10, TimeUnit.SECONDS);
            assertThatThrownBy(() -> acquisition.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(ApiException.class);
        }
    }

    @Test
    void publicDeleteAndPrivateRetirementCommitAtomicallyAfterWriterStops() {
        var props = new ManagedAgentProperties();
        var publicStore = new ManagedAgentStore(jdbc, new ObjectMapper(), java.time.Clock.systemUTC(), events -> {},
                org.mockito.Mockito.mock(ManagedWorkspaceRegistry.class), props);
        String original = session;
        session = tx.execute(status -> publicStore.insertSessionCommand(tenant, "CREATE_SESSION", "create", "digest",
                "qwen-code", null, null, java.util.List.of(), null).sessionId());
        key.put("sessionId", session);
        jdbc.update("UPDATE qwen_tool_publication SET session_id = ? WHERE tenant_id = ? AND session_id = ?",
                session, tenant, original);
        var sessions = new ManagedSessionStore(jdbc);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        var operation = tx.execute(status -> publicStore.beginOperation(tenant, session, StoreModels.OperationKind.DELETE,
                "actor", "delete", "digest").operation());
        var claim = tx.execute(status -> publicStore.claimOperation(tenant, session, operation.operationId(),
                "worker", Duration.ofMinutes(1)).orElseThrow());
        assertThatThrownBy(() -> tx.execute(status -> publicStore.completeOperation(tenant, session, operation.operationId(),
                "worker", claim.claimGeneration(), false))).isInstanceOf(ApiException.class);
        assertThat(publicStore.requireSession(tenant, session).status()).isEqualTo("DELETING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement WHERE tenant_id = ?",
                Long.class, tenant)).isZero();
        tx.executeWithoutResult(status -> sessions.sealWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.SealWriterRequest("workspace-1", "writer", 1)));
        assertThat(tx.<Boolean>execute(status -> publicStore.completeOperation(tenant, session, operation.operationId(),
                "worker", claim.claimGeneration() - 1, false))).isFalse();
        assertThat(tx.<Boolean>execute(status -> publicStore.completeOperation(tenant, session, operation.operationId(),
                "worker", claim.claimGeneration(), false))).isTrue();
        assertThat(publicStore.requireSession(tenant, session).status()).isEqualTo("DELETED");
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_managed_session_journal_head WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo("DELETED");
        assertThatThrownBy(() -> sessions.restore(tenant, "workspace-1", session, "a".repeat(32)))
                .isInstanceOf(ApiException.class);
        assertThat(tx.<String>execute(status -> publicStore.beginOperation(tenant, session, StoreModels.OperationKind.DELETE,
                "actor", "delete", "digest").operation().operationId())).isEqualTo(operation.operationId());
    }

    @Test
    void liveWriterPreventsRetirementAndDefaultsDisablePhysicalDeletion() {
        var sessions = new ManagedSessionStore(jdbc);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        assertThatThrownBy(this::retire).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement WHERE tenant_id = ?",
                Long.class, tenant)).isZero();
        assertThat(new ManagedAgentProperties().getToolPublication().isGcEnabled()).isFalse();
        assertThat(new ManagedAgentProperties().getToolPublication().getDeletionGrace()).isEqualTo(Duration.ofHours(24));
    }

    @Test
    void quarantineAfterRetirementKeepsKnownCorruptOutputHeld() {
        jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key, resource_id,"
                + " byte_length, sha256, object_key, state, operation_id, created_at)"
                + " VALUES (?, 'pub-1', 'segment:stdout:0', 'resource-1', 1, ?, 'object-1',"
                + " 'VERIFIED', 'operation-1', CURRENT_TIMESTAMP(6))", scope, "a".repeat(64));
        retire();
        retention.quarantineResource(scope, "resource-1", "object-1");
        assertThat(blocker()).isEqualTo("quarantined");
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object WHERE scope_key = ?",
                String.class, scope)).isEqualTo("QUARANTINED");
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM qwen_tool_publication WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(1000);
    }

    @Test
    void candidateCountsAllUsedSlotsAndKeepsOperationAndObjectBlockers() {
        jdbc.update("UPDATE qwen_tool_publication SET producer_used_bytes = 456, admission_used_bytes = 789"
                + " WHERE scope_key = ?", scope);
        retire();
        assertThat(retention.observe(Duration.ZERO)).singleElement()
                .extracting(ToolPublicationRetentionStore.Candidate::bytes).isEqualTo(1368L);
        jdbc.update("INSERT INTO qwen_tool_publication_operation (scope_key, publication_id, operation_id,"
                + " request_digest, state, claim_epoch, deadline, created_at) VALUES (?, 'pub-1', 'op-1', ?,"
                + " 'PENDING', 1, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))", scope, "b".repeat(64));
        assertThat(blocker()).isEqualTo("operation_unresolved");
        jdbc.update("UPDATE qwen_tool_publication_operation SET state = 'SUCCEEDED' WHERE scope_key = ?", scope);
        jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key,"
                + " byte_length, sha256, state, operation_id, created_at) VALUES (?, 'pub-1', 'segment:stdout:0',"
                + " 1, ?, 'CANDIDATE', 'op-1', CURRENT_TIMESTAMP(6))", scope, "c".repeat(64));
        assertThat(blocker()).isEqualTo("object_unverified");
        jdbc.update("UPDATE qwen_tool_publication_object SET state = 'VERIFIED' WHERE scope_key = ?", scope);
        assertThat(blocker()).isNull();
    }

    @Test
    void retirementSuppressesOutstandingWorkOnlyInItsOwnResultScope() {
        for (String state : java.util.List.of("LEASED", "READY")) {
            jdbc.update("INSERT INTO managed_agent_tool_result (result_id, scope_key, execution_key, tenant_id,"
                    + " workspace_id, session_id, source_json, source_digest, work_state, claim_until)"
                    + " VALUES (?, ?, ?, ?, 'workspace-1', ?, '{}', ?, ?, 9999999999999)",
                    state, ManagedToolResultStore.scope(tenant, session), ToolPublicationRetentionStore.hash(state),
                    tenant, session, "d".repeat(64), state);
        }
        jdbc.update("INSERT INTO managed_agent_tool_result (result_id, scope_key, execution_key, tenant_id,"
                + " workspace_id, session_id, source_json, source_digest, work_state, claim_until)"
                + " VALUES ('other', ?, ?, ?, 'workspace-1', 'other', '{}', ?, 'LEASED', 9999999999999)",
                ManagedToolResultStore.scope(tenant, "other"), "e".repeat(64), tenant, "f".repeat(64));
        retire();
        var leased = jdbc.queryForMap("SELECT work_state, claim_until, failure_code FROM managed_agent_tool_result"
                + " WHERE result_id = 'LEASED'");
        assertThat(leased.get("work_state")).isEqualTo("SUPPRESSED");
        assertThat(leased.get("claim_until")).isNull();
        assertThat(leased.get("failure_code")).isEqualTo("session_retired");
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result WHERE result_id = 'READY'",
                String.class)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result WHERE result_id = 'other'",
                String.class)).isEqualTo("LEASED");
    }

    @Test
    void unauthorizedPrivateResourceReadDoesNotAdmitALease() {
        var admissions = new java.util.concurrent.atomic.AtomicInteger();
        var observed = new JdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... arguments) {
                if (sql.startsWith("INSERT INTO qwen_output_read_lease")) { admissions.incrementAndGet(); }
                return super.update(sql, arguments);
            }
        };
        var sessions = new ManagedSessionStore(observed);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        assertThatThrownBy(() -> sessions.readResource(tenant, "workspace-1", session, "resource-1", "b".repeat(32)))
                .isInstanceOf(ApiException.class);
        assertThat(admissions).hasValue(0);
    }

    @Test
    void failedLeaseCleanupPreservesGuardAndStreamCloseFailures() throws Exception {
        var failing = new JdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... arguments) {
                if (sql.startsWith("DELETE FROM qwen_output_read_lease")) {
                    throw new org.springframework.dao.DataAccessResourceFailureException("cleanup failed");
                }
                return super.update(sql, arguments);
            }
        };
        var store = new ToolPublicationRetentionStore(failing, manager);
        var original = new IllegalArgumentException("original guard");
        assertThatThrownBy(() -> store.open(scope, "pub-1", "object", new MemoryObjects(), () -> { throw original; }))
                .isSameAs(original);
        assertThat(original.getSuppressed()).singleElement().extracting(Throwable::getMessage).isEqualTo("cleanup failed");
        var objects = new MemoryObjects() {
            @Override public InputStream open(String objectKey) {
                return new ByteArrayInputStream(new byte[] {1}) {
                    @Override public void close() throws java.io.IOException { throw new java.io.IOException("original close"); }
                };
            }
        };
        var input = store.open(scope, "pub-1", "object", objects);
        assertThatThrownBy(input::close).isInstanceOf(java.io.IOException.class).hasMessage("original close")
                .satisfies(error -> assertThat(error.getSuppressed()).singleElement().extracting(Throwable::getMessage).isEqualTo("cleanup failed"));
    }

    protected static class MemoryObjects implements ToolPublicationObjectStore {
        protected final Map<String, byte[]> bytes = new HashMap<>();
        @Override public void putIfAbsent(String key, byte[] value) { bytes.putIfAbsent(key, value.clone()); }
        @Override public InputStream open(String key) { return new ByteArrayInputStream(bytes.get(key)); }
        @Override public void requireUnversioned() {}
    }
}
