package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        tx = new TransactionTemplate(manager);
        retention = new ToolPublicationRetentionStore(jdbc, manager);
        tenant = "retention-" + UUID.randomUUID();
        session = "session-1";
        scope = ToolPublicationRetentionStore.hash(tenant + session);
        key = new ObjectMapper().createObjectNode().put("tenantId", tenant)
                .put("workspaceId", "workspace-1").put("sessionId", session);
        jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
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
        try (var lease = retention.read(key)) {
            lease.check();
        }
        retire();
        long first = jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ? AND retired_at IS NOT NULL",
                Long.class, tenant);
        assertThat(retention.observe(Duration.ofHours(24))).filteredOn(candidate -> candidate.scope().equals(scope))
                .singleElement().extracting(ToolPublicationRetentionStore.Candidate::blocker).isEqualTo("grace_period");
        retire();
        assertThat(jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ? AND retired_at IS NOT NULL",
                Long.class, tenant)).isEqualTo(first);
        assertThatThrownBy(() -> retention.read(key)).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("tool_output_session_retired"));
        var sessions = new ManagedSessionStore(jdbc);
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session,
                "a".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L))))
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void expiredOrRetiredLeaseCannotBeRevivedByAnotherLease() {
        try (var old = retention.read(key)) {
            jdbc.update("UPDATE ma_read_lease SET expires_at = 0 WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.hash(tenant));
            try (var replacement = retention.read(key)) {
                replacement.check();
                assertThatThrownBy(old::check).isInstanceOf(ManagedAgentException.class);
                retire();
                assertThatThrownBy(replacement::check).isInstanceOf(ManagedAgentException.class);
                assertThat(blocker()).isEqualTo("reader_active");
            }
        }
        assertThat(blocker()).isNull();
    }

    @Test
    void readLeasePinsTheObservedRetirementGenerationAndRequiresItsRoot() {
        try (var first = retention.read(key)) {
            jdbc.update("UPDATE ma_session SET retirement_generation = 7 WHERE tenant_id = ? AND session_id = ?", tenant, session);
            assertThatThrownBy(first::check).isInstanceOf(ManagedAgentException.class);
        }
        try (var next = retention.read(key)) {
            next.check();
            assertThat(jdbc.queryForObject("SELECT retirement_generation FROM ma_read_lease WHERE tenant_key = ?",
                    Long.class, ToolPublicationRetentionStore.hash(tenant))).isEqualTo(7);
            jdbc.update("UPDATE ma_read_lease SET expires_at = ? WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.now(jdbc) + 60_000, ToolPublicationRetentionStore.hash(tenant));
            next.check();
            jdbc.update("DELETE FROM ma_session WHERE tenant_id = ? AND session_id = ?", tenant, session);
            assertThatThrownBy(next::check).isInstanceOf(ManagedAgentException.class);
        }
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
                        try {
                            assertThat(resume.await(10, TimeUnit.SECONDS)).isTrue();
                        } catch (InterruptedException error) {
                            throw new IllegalStateException(error);
                        }
                        return super.read(target, offset, length);
                    }
                };
            }
        };
        try (var input = retention.open(scope, "pub-1", "object", objects);
                var executor = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var result = executor.submit(() -> input.read(new byte[2]));
            assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
            jdbc.update("UPDATE ma_read_lease SET expires_at = 0 WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.hash(tenant));
            resume.countDown();
            assertThatThrownBy(() -> result.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(ManagedAgentException.class);
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
            jdbc.update("UPDATE ma_read_lease SET expires_at = 0 WHERE tenant_key = ?",
                    ToolPublicationRetentionStore.hash(tenant));
            assertThatThrownBy(() -> retention.open(scope, "pub-1", "object", objects, original::check))
                    .isInstanceOf(ManagedAgentException.class);
            assertThat(opens).hasValue(0);
        }
    }

    @Test
    void retryReconcilesTheOriginalPhysicalPutWithoutSendingAgain() {
        var puts = new java.util.concurrent.atomic.AtomicInteger();
        var objects = new MemoryObjects() {
            @Override public void putIfAbsent(String objectKey, byte[] bytes) {
                puts.incrementAndGet();
                super.putIfAbsent(objectKey, bytes);
                throw new IllegalStateException("response lost");
            }
        };
        assertThatThrownBy(() -> retention.put(key, scope, "pub-1", "exact-key", new byte[] {1}, objects))
                .isInstanceOf(IllegalStateException.class);
        retention.put(key, scope, "pub-1", "exact-key", new byte[] {1}, objects);
        assertThat(puts).hasValue(1);
        assertThat(jdbc.queryForList("SELECT state FROM ma_operation WHERE operation_kind = 'OBJECT_PUT' AND scope_key = ?",
                String.class, scope)).containsExactly("RETURNED");
        retire();
        assertThat(blocker()).isNull();
        assertThatThrownBy(() -> retention.put(key, scope, "pub-1", "exact-key", new byte[] {1}, objects))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(objects.bytes).containsKey("exact-key");
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM ma_output_capture WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(1000);
    }

    @Test
    void successfulPutWithLostSqlReceiptReconcilesWithoutAnotherPhysicalWrite() {
        var failed = new java.util.concurrent.atomic.AtomicBoolean();
        var puts = new java.util.concurrent.atomic.AtomicInteger();
        var opens = new java.util.concurrent.atomic.AtomicInteger();
        var faultJdbc = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... arguments) {
                if (sql.startsWith("UPDATE ma_operation SET ")
                        && sql.contains("state = 'RETURNED', completed_at")
                        && failed.compareAndSet(false, true)) {
                    throw new org.springframework.dao.DataAccessResourceFailureException("lost SQL receipt");
                }
                return super.update(sql, arguments);
            }
        };
        var faultRetention = new ToolPublicationRetentionStore(faultJdbc, manager);
        var objects = new MemoryObjects() {
            @Override public void putIfAbsent(String objectKey, byte[] bytes) {
                puts.incrementAndGet();
                super.putIfAbsent(objectKey, bytes);
            }
            @Override public InputStream open(String objectKey) {
                opens.incrementAndGet();
                return super.open(objectKey);
            }
        };
        assertThatThrownBy(() -> faultRetention.put(key, scope, "pub-1", "exact-key", new byte[] {1, 2}, objects))
                .isInstanceOf(org.springframework.dao.DataAccessResourceFailureException.class);
        var identity = jdbc.queryForMap("SELECT operation_id, claim_generation FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'", String.class))
                .isEqualTo("IN_FLIGHT");
        retention.put(key, scope, "pub-1", "exact-key", new byte[] {1, 2}, objects);
        retention.put(key, scope, "pub-1", "exact-key", new byte[] {1, 2}, objects);
        assertThat(puts).hasValue(1);
        assertThat(opens).hasValue(1);
        assertThat(jdbc.queryForMap("SELECT operation_id, claim_generation FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'"))
                .isEqualTo(identity);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'", String.class))
                .isEqualTo("RETURNED");
        retire();
        assertThat(blocker()).isNull();
    }

    @Test
    void inFlightWriteWithoutACompleteMatchingObjectRemainsProtected() throws Exception {
        var entered = new CountDownLatch(1);
        var resume = new CountDownLatch(1);
        var puts = new java.util.concurrent.atomic.AtomicInteger();
        var objects = new MemoryObjects() {
            @Override public void putIfAbsent(String objectKey, byte[] bytes) {
                puts.incrementAndGet();
                entered.countDown();
                try {
                    assertThat(resume.await(20, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    throw new IllegalStateException(error);
                }
                super.putIfAbsent(objectKey, bytes);
            }
        };
        try (var executor = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var original = executor.submit(() -> retention.put(key, scope, "pub-1", "exact-key", new byte[] {1, 2}, objects));
            try {
                assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
                for (byte[] invalid : new byte[][] {new byte[0], new byte[] {1}, new byte[] {1, 3}, new byte[] {1, 2, 3}}) {
                    if (invalid.length != 0) {
                        objects.bytes.put("exact-key", invalid);
                    }
                    assertThatThrownBy(() -> retention.put(key, scope, "pub-1", "exact-key", new byte[] {1, 2}, objects))
                            .isInstanceOfSatisfying(ManagedAgentException.class,
                                    error -> assertThat(error.getCode()).isEqualTo("tool_output_put_unresolved"));
                }
                objects.bytes.remove("exact-key");
                retire();
                assertThat(blocker()).isEqualTo("put_unresolved");
                assertThat(puts).hasValue(1);
            } finally {
                resume.countDown();
            }
            original.get(10, TimeUnit.SECONDS);
        }
        assertThat(blocker()).isNull();
        assertThat(objects.bytes.get("exact-key")).containsExactly(1, 2);
        assertThat(puts).hasValue(1);
    }

    @Test
    void incompleteQuarantinedAndLegacyEvidenceRemainProtected() {
        retire();
        assertThat(blocker()).isNull();
        jdbc.update("UPDATE ma_output_capture SET write_evidence = FALSE WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("legacy_write_evidence_missing");
        jdbc.update("UPDATE ma_output_capture SET write_evidence = TRUE, quarantined = TRUE WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("quarantined");
        jdbc.update("UPDATE ma_output_capture SET quarantined = FALSE, accepted_complete = FALSE WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("not_accepted_complete");
        jdbc.update("UPDATE ma_output_capture SET accepted_complete = TRUE, producer_phase = 'FINISHING' WHERE scope_key = ?", scope);
        assertThat(blocker()).isEqualTo("not_accepted_complete");
        jdbc.update("UPDATE ma_session SET recovery_protected = TRUE WHERE tenant_id = ?", tenant);
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
        jdbc.update("UPDATE ma_session_head SET recovery_status = ?"
                + " WHERE tenant_id = ? AND session_id = ?", recovery, tenant, session);
        retire();
        assertThat(blocker()).isEqualTo("READY".equals(recovery) ? null : "recovery_protected");
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session)).isFalse();
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM ma_output_capture WHERE scope_key = ?",
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
                try {
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    throw new IllegalStateException(error);
                }
                ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete-1");
            }));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();
            var acquisition = executor.submit(() -> tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session,
                    "a".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L))));
            release.countDown();
            deletion.get(10, TimeUnit.SECONDS);
            assertThatThrownBy(() -> acquisition.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(ManagedAgentException.class);
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
        jdbc.update("UPDATE ma_output_capture SET session_id = ? WHERE tenant_id = ? AND session_id = ?",
                session, tenant, original);
        var sessions = new ManagedSessionStore(jdbc);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        var operation = tx.execute(status -> publicStore.beginOperation(tenant, session, StoreModels.OperationKind.DELETE,
                "actor", "delete", "digest").operation());
        var claim = tx.execute(status -> publicStore.claimOperation(tenant, session, operation.operationId(),
                "worker", Duration.ofMinutes(1)).orElseThrow());
        assertThatThrownBy(() -> tx.execute(status -> publicStore.completeOperation(tenant, session, operation.operationId(),
                "worker", claim.claimGeneration(), false))).isInstanceOf(ManagedAgentException.class);
        assertThat(publicStore.requireSession(tenant, session).status()).isEqualTo("DELETING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL AND tenant_id = ?",
                Long.class, tenant)).isZero();
        tx.executeWithoutResult(status -> sessions.sealWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.SealWriterRequest("workspace-1", "writer", 1)));
        assertThat(tx.<Boolean>execute(status -> publicStore.completeOperation(tenant, session, operation.operationId(),
                "worker", claim.claimGeneration() - 1, false))).isFalse();
        assertThat(tx.<Boolean>execute(status -> publicStore.completeOperation(tenant, session, operation.operationId(),
                "worker", claim.claimGeneration(), false))).isTrue();
        assertThat(publicStore.requireSession(tenant, session).status()).isEqualTo("DELETED");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo("DELETED");
        assertThatThrownBy(() -> sessions.restore(tenant, "workspace-1", session, "a".repeat(32)))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(tx.<String>execute(status -> publicStore.beginOperation(tenant, session, StoreModels.OperationKind.DELETE,
                "actor", "delete", "digest").operation().operationId())).isEqualTo(operation.operationId());
    }

    @Test
    void liveWriterPreventsRetirementAndDefaultsDisablePhysicalDeletion() {
        var sessions = new ManagedSessionStore(jdbc);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        assertThatThrownBy(this::retire).isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL AND tenant_id = ?",
                Long.class, tenant)).isZero();
        assertThat(new ManagedAgentProperties().getToolPublication().isGcEnabled()).isFalse();
        assertThat(new ManagedAgentProperties().getToolPublication().getDeletionGrace()).isEqualTo(Duration.ofHours(24));
    }

    @Test
    void quarantineAfterRetirementKeepsKnownCorruptOutputHeld() {
        addCaptureObject(scope, "pub-1", session, "segment:stdout:0", "resource-1", "object-1", null, "VERIFIED");
        retire();
        retention.quarantineResource(scope, "resource-1", "object-1");
        assertThat(blocker()).isEqualTo("quarantined");
        assertThat(jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE scope_key = ?",
                String.class, scope)).isEqualTo("QUARANTINED");
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM ma_output_capture WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(1000);
    }

    @Test
    void candidateCountsAllUsedSlotsAndKeepsOperationAndObjectBlockers() {
        jdbc.update("UPDATE ma_output_capture SET producer_used_bytes = 456, admission_used_bytes = 789"
                + " WHERE scope_key = ?", scope);
        retire();
        assertThat(retention.observe(Duration.ZERO)).singleElement()
                .extracting(ToolPublicationRetentionStore.Candidate::bytes).isEqualTo(1368L);
        addOperation(OperationKind.OUTPUT_UPLOAD, scope, "pub-1", session, "op-1", "PENDING");
        assertThat(blocker()).isEqualTo("operation_unresolved");
        jdbc.update("UPDATE ma_operation SET state = 'SUCCEEDED' WHERE operation_kind = 'OUTPUT_UPLOAD' AND scope_key = ?", scope);
        addCaptureObject(scope, "pub-1", session, "segment:stdout:0", "candidate", null, new byte[] {1}, "CANDIDATE");
        assertThat(blocker()).isEqualTo("object_unverified");
        jdbc.update("UPDATE ma_resource SET capture_state = 'VERIFIED' WHERE scope_key = ?", scope);
        assertThat(blocker()).isNull();
    }

    @Test
    void retirementSuppressesOutstandingWorkOnlyInItsOwnResultScope() {
        for (String state : java.util.List.of("LEASED", "READY")) {
            addOperation(OperationKind.TOOL_RESULT_PROJECTION, ManagedToolResultStore.scope(tenant, session),
                    null, session, state, state);
        }
        addOperation(OperationKind.TOOL_RESULT_PROJECTION, ManagedToolResultStore.scope(tenant, "other"),
                null, "other", "other", "LEASED");
        retire();
        var leased = jdbc.queryForMap("SELECT state, claim_until, failure_code FROM ma_operation"
                + " WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ?", "LEASED");
        assertThat(leased.get("state")).isEqualTo("SUPPRESSED");
        assertThat(leased.get("claim_until")).isNull();
        assertThat(leased.get("failure_code")).isEqualTo("session_retired");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'"
                + " AND operation_id = ?", String.class, "READY")).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'"
                + " AND operation_id = ?", String.class, "other")).isEqualTo("LEASED");
    }

    @Test
    void unauthorizedPrivateResourceReadDoesNotAdmitALease() {
        var admissions = new java.util.concurrent.atomic.AtomicInteger();
        var observed = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... arguments) {
                if (sql.startsWith("INSERT INTO ma_read_lease")) {
                    admissions.incrementAndGet();
                }
                return super.update(sql, arguments);
            }
        };
        var sessions = new ManagedSessionStore(observed);
        tx.executeWithoutResult(status -> sessions.acquireWriter(tenant, session, "a".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer", 60000L)));
        assertThatThrownBy(() -> sessions.readResource(tenant, "workspace-1", session, "resource-1", "b".repeat(32)))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(admissions).hasValue(0);
    }

    @Test
    void failedLeaseCleanupPreservesGuardAndStreamCloseFailures() throws Exception {
        var failing = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... arguments) {
                if (sql.startsWith("DELETE FROM ma_read_lease")) {
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

    protected void addCaptureObject(String captureScope, String publication, String captureSession,
            String slot, String resourceId, String objectKey, byte[] inline, String captureState) {
        String resourceScope = ManagedSessionStore.sessionScopeKey(tenant, captureSession);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, state, scope_key, publication_id, slot_key, capture_state, capture_object_key, inline_bytes, operation_id, gmt_create) VALUES (?, ?, ?, 'workspace-1', ?, ?, 'managed-tool-result-content', 1, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, ?, ?, 'op', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSchemaKeys.key(resourceScope, resourceId), resourceScope, tenant, captureSession, resourceId,
                inline == null ? 1 : inline.length, ToolPublicationRetentionStore.hash(slot),
                inline == null ? "TOOL_PUBLICATION" : "MYSQL_INLINE", captureScope, publication, slot,
                captureState, objectKey, inline);
    }

    protected String addOperation(OperationKind kind, String opScope, String publication, String targetSession,
            String id, String state) {
        String target = publication == null ? ManagedSchemaKeys.key(id) : ManagedSchemaKeys.key(publication);
        String operationKey = ManagedSchemaKeys.operationKey(kind, opScope, target, id);
        long time = ToolPublicationRetentionStore.now(jdbc);
        jdbc.update("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id,"
                        + " tenant_id, workspace_id, session_id, publication_id, target_kind, target_key, request_digest,"
                        + " request_json, state, phase, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'workspace-1', ?, ?,"
                        + " 'OUTPUT_CAPTURE', ?, ?, '{}', ?, 'TEST', ?, ?)",
                operationKey, ManagedSessionStore.sessionScopeKey(tenant, targetSession), opScope, kind.name(), id,
                tenant, targetSession, publication, target, "b".repeat(64), state, time, time);
        return operationKey;
    }

    protected static class MemoryObjects implements ToolPublicationObjectStore {
        protected final Map<String, byte[]> bytes = new HashMap<>();
        @Override public void putIfAbsent(String key, byte[] value) { bytes.putIfAbsent(key, value.clone()); }
        @Override public InputStream open(String key) { return new ByteArrayInputStream(bytes.get(key)); }
        @Override public void validateConfiguration() {}
    }
}
