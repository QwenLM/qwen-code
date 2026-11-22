package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class ToolPublicationCollectorTest extends ToolPublicationRetentionStoreTest {
    protected static class DeletingObjects extends MemoryObjects {
        protected final List<String> deleted = new ArrayList<>();
        @Override public void deleteIfPresent(String key) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            bytes.remove(key);
            deleted.add(key);
        }
    }

    protected ToolPublicationCollector collector(ToolPublicationObjectStore objects) {
        return collector(jdbc, objects, true);
    }

    private ToolPublicationCollector collector(org.springframework.jdbc.core.JdbcTemplate template,
            ToolPublicationObjectStore objects, boolean enabled) {
        var props = new ManagedAgentProperties();
        props.getToolPublication().setGcEnabled(enabled);
        props.getToolPublication().setDeletionGrace(Duration.ZERO);
        return new ToolPublicationCollector(template, manager, retention, objects, props);
    }

    protected void addObject(String slot, String objectKey, byte[] inline) {
        addCaptureObject(scope, "pub-1", session, slot, slot, objectKey, inline, "VERIFIED");
    }

    protected String cursor() {
        return JdbcManagedToolResultStore.parse(jdbc.queryForObject("SELECT COALESCE(result_json, '{}') FROM ma_operation"
                + " WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", String.class, scope)).path("cursor").asText("");
    }

    protected String state() {
        return jdbc.queryForObject("SELECT retention_state FROM ma_output_capture WHERE scope_ref = ?", String.class, scope);
    }

    protected long held() {
        return jdbc.queryForObject("SELECT capture_held_bytes + producer_held_bytes + admission_held_bytes FROM"
                + " ma_output_capture WHERE scope_ref = ?", Long.class, scope);
    }

    protected void retryNow() {
        jdbc.update("UPDATE ma_operation SET available_at = 0, claim_until = 0 WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", scope);
    }

    private String addPublication(String publication, String sessionId) {
        String publicationScope = com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs.publicationScopeRef(tenant, "workspace-1", sessionId);
        jdbc.update("INSERT INTO ma_output_capture (scope_ref, tenant_id, workspace_id, session_id,"
                        + " publication_id, execution_call_id, capture_id, binding_json, binding_digest, token_hash, state,"
                        + " capture_bytes, producer_bytes, admission_bytes, producer_phase, is_write_evidence, is_accepted_complete,"
                        + " capture_held_bytes, producer_held_bytes, admission_held_bytes, capture_used_bytes)"
                        + " SELECT ?, tenant_id, workspace_id, ?, ?, 'execution-' || ?, ?, binding_json, binding_digest,"
                        + " token_hash, state, capture_bytes, producer_bytes, admission_bytes, producer_phase,"
                        + " is_write_evidence, is_accepted_complete, capture_held_bytes, producer_held_bytes, admission_held_bytes,"
                        + " capture_used_bytes FROM ma_output_capture WHERE scope_ref = ? AND publication_id = 'pub-1'",
                publicationScope, sessionId, publication, publication,
                "capture-" + publication, scope);
        return publicationScope;
    }

    @Test
    void retirementEnqueuesAllCapturesInBoundedBatchesAndRollsBackEveryIntentOnFailure() {
        for (int index = 2; index <= 65; index++) {
            addPublication("pub-" + index, session);
        }
        tx.executeWithoutResult(status -> ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session));
        var batchSizes = new ArrayList<Integer>();
        var fail = new AtomicBoolean(true);
        var recording = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("INSERT IGNORE INTO ma_operation") && sql.contains("'CAPTURE_GC'")) {
                    assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
                    batchSizes.add(args.length / 12);
                    if (batchSizes.size() == 2 && fail.getAndSet(false)) {
                        throw new org.springframework.dao.DataAccessResourceFailureException("second enqueue batch");
                    }
                }
                return super.update(sql, args);
            }
        };
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(recording, tenant, session);
            ToolPublicationRetentionStore.retire(recording, tenant, session, "delete-1");
        })).hasMessageContaining("second enqueue batch");
        assertThat(batchSizes).containsExactly(32, 32);
        assertThat(jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session)).isNull();
        assertThat(jdbc.queryForObject("SELECT retirement_generation FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session)).isZero();
        assertThat(jdbc.queryForList("SELECT retention_state FROM ma_output_capture", String.class))
                .hasSize(65).containsOnly("PINNED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Long.class)).isZero();
        batchSizes.clear();
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(recording, tenant, session);
            ToolPublicationRetentionStore.retire(recording, tenant, session, "delete-1");
        });
        assertThat(batchSizes).containsExactly(32, 32, 1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'",
                Long.class)).isEqualTo(65);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC'",
                Long.class)).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"LEASED", "SUCCEEDED"})
    void retirementReplayRepairsMissingIntentsWithoutResettingProgress(String state) {
        addPublication("pub-2", session);
        addPublication("pub-3", session);
        String otherScope = addPublication("pub-1", "other-session");
        String workspaceScope = com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs.publicationScopeRef(tenant, "workspace-2", session);
        jdbc.update("UPDATE ma_output_capture SET scope_ref = ?, workspace_id = 'workspace-2'"
                + " WHERE scope_ref = ? AND publication_id = ?", workspaceScope, scope, "pub-2");
        retire();
        assertThat(jdbc.queryForMap("SELECT scope_id, workspace_id FROM ma_operation"
                + " WHERE operation_kind = 'CAPTURE_GC' AND publication_id = ? AND tenant_id = ? AND session_id = ?",
                "pub-2", tenant, session))
                .containsEntry("scope_id", workspaceScope)
                .containsEntry("workspace_id", "workspace-2");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, otherScope)).isZero();
        jdbc.update("UPDATE ma_operation SET state = ?, phase = 'DELETING', claim_owner = 'collector',"
                + " claim_generation = 7, claim_until = ?, available_at = ?, completed_at = 1234,"
                + " result_json = '{\"version\":1,\"cursor\":\"kept\",\"collectedBytes\":123}'"
                + " WHERE operation_kind = 'SESSION_RESOURCE_GC' OR publication_id = ?",
                state, ToolPublicationRetentionStore.now(jdbc) + 60000, ManagedSchemaTime.NEVER_DUE_MILLIS, "pub-1");
        var progress = jdbc.queryForList("SELECT * FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC'"
                + " OR publication_id = ? ORDER BY operation_ref", "pub-1");
        var root = jdbc.queryForMap("SELECT retired_at, retirement_generation, retirement_operation_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        jdbc.update("DELETE FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND publication_id = ?", "pub-2");
        retire();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'"
                + " AND scope_kind = 'PUBLICATION' AND scope_id = ? AND publication_id = ?", String.class, workspaceScope, "pub-2")).isEqualTo("PENDING");
        assertThat(jdbc.queryForList("SELECT * FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC'"
                + " OR publication_id = ? ORDER BY operation_ref", "pub-1")).usingRecursiveComparison().isEqualTo(progress);
        jdbc.update("DELETE FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC' OR publication_id = ?", "pub-3");
        retire();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Long.class)).isEqualTo(4);
        assertThat(jdbc.queryForList("SELECT * FROM ma_operation WHERE publication_id = ?", "pub-1"))
                .usingRecursiveComparison().isEqualTo(progress.stream().filter(row -> "pub-1".equals(row.get("publication_id"))).toList());
        assertThat(jdbc.queryForMap("SELECT retired_at, retirement_generation, retirement_operation_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session)).isEqualTo(root);
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
            ToolPublicationRetentionStore.retire(jdbc, tenant, session, "another-delete");
        })).hasMessageContaining("another operation");
    }

    @ParameterizedTest
    @ValueSource(strings = {"full", "short", "deleted-tail", "rollback"})
    void operationRepairFreezesRoundAndRevisitsSkippedOrRolledBackRows(String mode) {
        int captures = "short".equals(mode) ? 65 : 64;
        boolean rollback = "rollback".equals(mode);
        boolean deletedTail = "deleted-tail".equals(mode);
        for (int index = 2; index <= captures; index++) {
            addPublication("pub-" + index, session);
        }
        retire();
        jdbc.update("UPDATE ma_session SET is_recovery_protected = TRUE WHERE tenant_id = ?", tenant);
        jdbc.update("UPDATE ma_operation SET state = 'SUCCEEDED', available_at = ? WHERE operation_kind = 'CAPTURE_GC'",
                ManagedSchemaTime.NEVER_DUE_MILLIS);
        jdbc.update("DELETE FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND publication_id IN (?, ?)",
                "pub-1", "pub-" + captures);
        if (!rollback) {
            jdbc.update("UPDATE ma_output_capture SET retention_state = 'PINNED' WHERE publication_id = ?", "pub-1");
        }
        var ids = jdbc.queryForList("SELECT id FROM ma_output_capture ORDER BY id", Long.class);
        assertThat(ids).hasSize(captures);
        var pages = new ArrayList<List<Long>>();
        var bounds = new ArrayList<List<Object>>();
        var maxima = new ArrayList<Long>();
        var recording = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public <T> T queryForObject(String sql, Class<T> type) {
                T value = super.queryForObject(sql, type);
                if (sql.equals("SELECT MAX(id) FROM ma_output_capture")) {
                    maxima.add(((Number) value).longValue());
                }
                return value;
            }
            @Override public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
                var rows = super.query(sql, mapper, args);
                if (sql.contains("AS needs_operation")) {
                    assertThat(sql).contains("WHERE id > ? AND id <= ? ORDER BY id LIMIT 32) c ORDER BY c.id");
                    bounds.add(List.of(args));
                    pages.add(rows.stream().map(row -> ((Number) ((java.util.Map<?, ?>) row).get("id")).longValue()).toList());
                }
                return rows;
            }
        };
        var objects = new DeletingObjects();
        var gc = collector(recording, objects, true);
        tx.executeWithoutResult(status -> {
            assertThat(gc.runOnce()).isFalse();
            if (rollback) {
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'"
                        + " AND publication_id = ?", Long.class, "pub-1")).isEqualTo(1);
                status.setRollbackOnly();
            }
        });
        assertThat(pages).containsExactly(ids.subList(0, 32));
        assertThat(bounds).containsExactly(List.of(0L, ids.getLast()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'",
                Long.class)).isEqualTo(captures - 2);
        jdbc.update("UPDATE ma_output_capture SET retention_state = 'RETIRING' WHERE publication_id = ?", "pub-1");
        if (deletedTail) {
            jdbc.update("DELETE FROM ma_output_capture WHERE id > ?", ids.get(31));
        }
        int roundPages = (captures + 31) / 32;
        for (int scan = 1; scan <= roundPages; scan++) {
            for (int index = 0; index < 32; index++) {
                addPublication("new-" + scan + "-" + index, session);
            }
            assertThat(maxima).containsExactly(ids.getLast());
            assertThat(gc.runOnce()).isFalse();
            if (scan < roundPages) {
                assertThat(maxima).containsExactly(ids.getLast());
                assertThat(bounds.getLast()).containsExactly(ids.get(scan * 32 - 1), ids.getLast());
                assertThat(pages.getLast()).isEqualTo(deletedTail ? List.of()
                        : ids.subList(scan * 32, Math.min((scan + 1) * 32, captures)));
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'"
                        + " AND publication_id = ?", Long.class, "pub-1")).isZero();
            }
        }
        long latest = jdbc.queryForObject("SELECT MAX(id) FROM ma_output_capture", Long.class);
        assertThat(maxima).containsExactly(ids.getLast(), latest);
        assertThat(bounds.getLast()).containsExactly(0L, latest);
        assertThat(pages).hasSize(roundPages + 1);
        assertThat(pages.getLast()).isEqualTo(ids.subList(0, 32));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'",
                Long.class)).isEqualTo(captures - (deletedTail ? 1 : 0));
        assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'"
                + " AND publication_id = ?", String.class, "pub-1")).isEqualTo("recovery_protected");
        if (!deletedTail) {
            assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE operation_kind = 'CAPTURE_GC'"
                    + " AND publication_id = ?", String.class, "pub-" + captures)).isEqualTo("recovery_protected");
        }
        assertThat(objects.deleted).isEmpty();
        assertThat(jdbc.queryForList("SELECT retention_state FROM ma_output_capture WHERE id <= ?",
                String.class, ids.getLast())).containsOnly("RETIRING");
    }

    @Test
    void protectedBacklogWaitsForDailyRecheckAndYieldsAfterItsFirstSweep() {
        var blockers = List.of("legacy_write_evidence_missing", "quarantined",
                "not_accepted_complete", "recovery_protected");
        int publicationsPerBlocker = 40;
        int protectedCount = blockers.size() * publicationsPerBlocker;
        for (String blocker : blockers) {
            String heldSession = "held-" + blocker;
            for (int index = 0; index < publicationsPerBlocker; index++) {
                String publication = blocker + "-" + index;
                String heldScope = addPublication(publication, heldSession);
                addCaptureObject(heldScope, publication, heldSession, "inline", publication, null, new byte[] {4}, "VERIFIED");
            }
            tx.executeWithoutResult(status -> {
                ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, heldSession);
                ToolPublicationRetentionStore.retire(jdbc, tenant, heldSession, "delete-" + blocker);
            });
            switch (blocker) {
                case "legacy_write_evidence_missing" -> jdbc.update("UPDATE ma_output_capture"
                        + " SET is_write_evidence = FALSE WHERE session_id = ?", heldSession);
                case "quarantined" -> jdbc.update("UPDATE ma_output_capture"
                        + " SET is_quarantined = TRUE WHERE session_id = ?", heldSession);
                case "not_accepted_complete" -> jdbc.update("UPDATE ma_output_capture"
                        + " SET is_accepted_complete = FALSE WHERE session_id = ?", heldSession);
                case "recovery_protected" -> jdbc.update("UPDATE ma_session"
                        + " SET is_recovery_protected = TRUE WHERE session_id = ?", heldSession);
                default -> throw new AssertionError(blocker);
            }
        }
        addObject("healthy", "healthy/exact-key", null);
        retire();
        jdbc.update("UPDATE ma_operation SET available_at = 1 WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", scope);
        var evaluations = new java.util.concurrent.atomic.AtomicInteger();
        var template = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
                var rows = super.query(sql, mapper, args);
                if (sql.contains(" FROM ma_output_capture WHERE scope_ref = ?")
                        && !rows.isEmpty() && rows.getFirst() instanceof java.util.Map<?, ?> row && "RETIRING".equals(row.get("retention_state"))) {
                    evaluations.incrementAndGet();
                }
                return rows;
            }
        };
        var objects = new DeletingObjects();
        var gc = collector(template, objects, true);
        long before = ToolPublicationRetentionStore.now(jdbc);
        int firstSweepTicks = (protectedCount + 1 + 31) / 32;
        for (int tick = 0; tick < firstSweepTicks && !"COLLECTED".equals(state()); tick++) {
            gc.runOnce();
        }
        long after = ToolPublicationRetentionStore.now(jdbc);
        assertThat(state()).as("healthy publication collects within the first sweep at 32 due candidates per tick")
                .isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(objects.deleted).containsExactly("healthy/exact-key");
        assertThat(evaluations.get()).isEqualTo(protectedCount + 1);
        for (String blocker : blockers) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture c JOIN ma_operation o ON o.scope_id = c.scope_ref"
                            + " AND o.scope_kind = 'PUBLICATION' AND o.publication_id = c.publication_id AND o.operation_kind = 'CAPTURE_GC' WHERE c.session_id = ?"
                            + " AND retention_state = 'RETIRING' AND o.failure_code = ? AND o.available_at BETWEEN ? AND ?"
                            + " AND capture_held_bytes + producer_held_bytes + admission_held_bytes = 3000"
                            + " AND capture_used_bytes = 123", Long.class, "held-" + blocker, blocker,
                    before + Duration.ofHours(24).toMillis(), after + Duration.ofHours(24).toMillis()))
                    .isEqualTo(publicationsPerBlocker);
        }
        jdbc.update("UPDATE ma_operation SET available_at = available_at - 120000 WHERE operation_kind = 'CAPTURE_GC' AND state <> 'SUCCEEDED'");
        assertThat(gc.runOnce()).isFalse();
        assertThat(evaluations.get()).isEqualTo(protectedCount + 1);
        jdbc.update("UPDATE ma_operation SET available_at = 0 WHERE operation_kind = 'CAPTURE_GC' AND publication_id = 'quarantined-0'");
        assertThat(gc.runOnce()).isFalse();
        assertThat(evaluations.get()).isEqualTo(protectedCount + 2);
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation"
                + " WHERE operation_kind = 'CAPTURE_GC' AND publication_id = 'quarantined-0'", Long.class))
                .isGreaterThanOrEqualTo(after + Duration.ofHours(24).toMillis());
        assertThat(jdbc.queryForList("SELECT inline_bytes FROM ma_resource"
                + " WHERE publication_id <> 'pub-1'", byte[].class)).hasSize(protectedCount)
                .allSatisfy(bytes -> assertThat(bytes).containsExactly((byte) 4));
        assertThat(objects.deleted).containsExactly("healthy/exact-key");
    }

    @ParameterizedTest
    @ValueSource(strings = {"put_unresolved", "operation_unresolved", "object_unverified", "session_not_retired"})
    void otherBlockersKeepMinuteRetryWithoutReleasingBytesOrQuota(String expectedBlocker) {
        addObject("one", "blocked/exact-key", null);
        var objects = new DeletingObjects() {
            @Override public void putIfAbsent(String objectKey, byte[] bytes) {
                super.putIfAbsent(objectKey, bytes);
                throw new IllegalStateException("response lost");
            }
        };
        objects.bytes.put("blocked/exact-key", new byte[] {7});
        switch (expectedBlocker) {
            case "put_unresolved" -> assertThatThrownBy(() -> retention.put(key, scope, "pub-1",
                    "blocked/exact-key", new byte[] {7}, objects)).isInstanceOf(IllegalStateException.class);
            case "operation_unresolved" -> addOperation(OperationKind.OUTPUT_UPLOAD, scope, "pub-1", session, "pending", "PENDING");
            case "object_unverified" -> jdbc.update("UPDATE ma_resource SET capture_state = 'CANDIDATE'"
                    + " WHERE scope_ref = ?", scope);
            case "session_not_retired" -> jdbc.update("UPDATE ma_output_capture SET retention_state = 'RETIRING'"
                    + " WHERE scope_ref = ?", scope);
            default -> throw new AssertionError(expectedBlocker);
        }
        if (!"session_not_retired".equals(expectedBlocker)) {
            retire();
        }
        long before = ToolPublicationRetentionStore.now(jdbc);
        assertThat(collector(objects).runOnce()).isFalse();
        long after = ToolPublicationRetentionStore.now(jdbc);
        assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                String.class, scope)).isEqualTo(expectedBlocker);
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, scope)).isBetween(before + 60000, after + 60000);
        assertThat(state()).isEqualTo("RETIRING");
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes FROM ma_output_capture WHERE scope_ref = ?",
                Long.class, scope)).isEqualTo(123);
        assertThat(objects.bytes.get("blocked/exact-key")).containsExactly((byte) 7);
        assertThat(objects.deleted).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"VERIFIED", "CANDIDATE", "QUARANTINED"})
    void failedPrefixAllowsCollectionOnlyWithVerifiedObjects(String objectState) {
        String failed = addOperation(OperationKind.OUTPUT_VERIFY, scope, "pub-1", session, "failed-prefix", "FAILED");
        jdbc.update("UPDATE ma_operation SET slot_key = 'prefix:stdout', is_verification_ready = TRUE,"
                + " failure_status = 403, failure_code = 'managed_tool_publication_storage_denied' WHERE operation_ref = ?", failed);
        addObject("one", "failed-prefix/exact-key", null);
        addObject("inline", null, new byte[] {8});
        jdbc.update("UPDATE ma_resource SET capture_state = ? WHERE scope_ref = ? AND slot_key = 'one'",
                objectState, scope);
        var objects = new DeletingObjects();
        objects.bytes.put("failed-prefix/exact-key", new byte[] {7});
        retire();
        if (!"VERIFIED".equals(objectState)) {
            assertThat(blocker()).isEqualTo("object_unverified");
            assertThat(collector(objects).runOnce()).isFalse();
            assertThat(held()).isEqualTo(3000);
            assertThat(objects.deleted).isEmpty();
            assertThat(objects.bytes.get("failed-prefix/exact-key")).containsExactly((byte) 7);
            assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource"
                    + " WHERE scope_ref = ? AND slot_key = 'inline'", byte[].class, scope)).containsExactly((byte) 8);
            return;
        }
        assertThat(blocker()).isNull();
        assertThat(collector(objects).runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes + producer_used_bytes + admission_used_bytes"
                + " FROM ma_output_capture WHERE scope_ref = ?", Long.class, scope)).isZero();
        assertThat(objects.deleted).containsExactly("failed-prefix/exact-key");
        assertThat(objects.bytes).isEmpty();
        assertThat(jdbc.queryForList("SELECT inline_bytes FROM ma_resource WHERE scope_ref = ?",
                byte[].class, scope)).containsOnly((byte[]) null);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'OUTPUT_VERIFY' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                String.class, scope)).isEqualTo("FAILED");
    }

    @Test
    void dueProtectedPublicationRechecksEvidenceInsteadOfTrustingItsStoredBlocker() {
        addObject("one", "protected/exact-key", null);
        var objects = new DeletingObjects();
        objects.bytes.put("protected/exact-key", new byte[] {7});
        retire();
        jdbc.update("UPDATE ma_output_capture SET is_quarantined = TRUE WHERE scope_ref = ?", scope);
        var gc = collector(objects);
        assertThat(gc.runOnce()).isFalse();
        assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                String.class, scope)).isEqualTo("quarantined");
        assertThat(held()).isEqualTo(3000);
        assertThat(objects.deleted).isEmpty();
        // Test-only evidence change; production has no supported post-retirement repair path.
        jdbc.update("UPDATE ma_output_capture SET is_quarantined = FALSE WHERE scope_ref = ?", scope);
        retryNow();
        assertThat(gc.runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes FROM ma_output_capture WHERE scope_ref = ?",
                Long.class, scope)).isZero();
        assertThat(objects.deleted).containsExactly("protected/exact-key");
        assertThat(objects.bytes).doesNotContainKey("protected/exact-key");
        assertThat(gc.runOnce()).isFalse();
        assertThat(objects.deleted).containsExactly("protected/exact-key");
        assertThat(jdbc.queryForObject("SELECT collected_bytes FROM ma_output_capture WHERE scope_ref = ?",
                Long.class, scope)).isEqualTo(123);
    }

    @Test
    void dueGraceCandidateUsesCurrentGraceAndShorteningDoesNotRescheduleItsDeadline() {
        addObject("one", "grace/exact-key", null);
        var objects = new DeletingObjects();
        objects.bytes.put("grace/exact-key", new byte[] {7});
        retire();
        long retiredAt = ToolPublicationRetentionStore.now(jdbc) - Duration.ofHours(2).toMillis();
        jdbc.update("UPDATE ma_session SET retired_at = ? WHERE tenant_id = ?", retiredAt, tenant);
        jdbc.update("UPDATE ma_operation SET failure_code = 'grace_period', available_at = ? WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                retiredAt + Duration.ofHours(1).toMillis(), scope);
        var properties = new ManagedAgentProperties();
        properties.getToolPublication().setGcEnabled(true);
        properties.getToolPublication().setDeletionGrace(Duration.ofHours(24));
        var gc = new ToolPublicationCollector(jdbc, manager, retention, objects, properties);
        assertThat(gc.runOnce()).isFalse();
        assertThat(state()).isEqualTo("RETIRING");
        assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                String.class, scope)).isEqualTo("grace_period");
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, scope)).isEqualTo(retiredAt + Duration.ofHours(24).toMillis());
        assertThat(jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ?",
                Long.class, tenant)).isEqualTo(retiredAt);
        assertThat(held()).isEqualTo(3000);
        assertThat(objects.bytes.get("grace/exact-key")).containsExactly((byte) 7);
        assertThat(objects.deleted).isEmpty();
        properties.getToolPublication().setDeletionGrace(Duration.ZERO);
        assertThat(gc.runOnce()).isFalse();
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, scope)).isEqualTo(retiredAt + Duration.ofHours(24).toMillis());
        assertThat(held()).isEqualTo(3000);
        assertThat(objects.deleted).isEmpty();
        retryNow();
        assertThat(gc.runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(objects.deleted).containsExactly("grace/exact-key");
    }

    @Test
    void activeReaderRetryIsCappedAtTheClaimInterval() {
        addObject("one", "reader/exact-key", null);
        var objects = new DeletingObjects();
        var gc = collector(objects);
        try (var lease = retention.read(key)) {
            lease.check();
            retire();
            long before = ToolPublicationRetentionStore.now(jdbc);
            assertThat(gc.runOnce()).isFalse();
            long after = ToolPublicationRetentionStore.now(jdbc);
            assertThat(blocker()).isEqualTo("reader_active");
            assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                    Long.class, scope)).isBetween(before + 59_000, after + 61_000);
            assertThat(held()).isEqualTo(3000);
            assertThat(objects.deleted).isEmpty();
        }
        retryNow();
        assertThat(gc.runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(objects.deleted).containsExactly("reader/exact-key");
    }

    @Test
    void soonExpiringReadLeaseSchedulesItsOwnInstant() {
        addObject("one", "reader/near-key", null);
        var gc = collector(new DeletingObjects());
        try (var lease = retention.read(key)) {
            long near = ToolPublicationRetentionStore.now(jdbc) + 20_000;
            jdbc.update("UPDATE ma_read_lease SET expires_at = ? WHERE tenant_id = ?", near,
                    tenant);
            retire();
            assertThat(gc.runOnce()).isFalse();
            assertThat(blocker()).isEqualTo("reader_active");
            assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                    Long.class, scope)).isEqualTo(near);
        }
    }

    @Test
    void resourceHandoffRetriesWithinSecondsUntilTheSessionLedgerSettles() {
        addObject("one", "handoff/exact-key", null);
        jdbc.update("INSERT INTO ma_resource_ref (owner_kind, owner_ref,"
                + " owner_revision, tenant_id, workspace_id, session_id, resource_id,"
                + " journal_revision, gmt_create) VALUES ('JOURNAL', ?, 1, ?, 'workspace-1', ?,"
                + " 'one', 1, " + ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs.ref(
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs.OWNER_REF_BYTES, tenant, session), tenant,
                session);
        retire();
        jdbc.update("UPDATE ma_operation SET available_at = 1 WHERE operation_kind ="
                + " 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", scope);
        var gc = collector(new DeletingObjects());
        long before = ToolPublicationRetentionStore.now(jdbc);
        assertThat(gc.runOnce()).isFalse();
        long after = ToolPublicationRetentionStore.now(jdbc);
        assertThat(blocker()).isEqualTo("resource_referenced");
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, scope)).isBetween(before, after + 5_000);
        jdbc.update("UPDATE ma_session SET is_resource_gc_completed = TRUE WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        retryNow();
        assertThat(gc.runOnce()).isFalse();
        assertThat(blocker()).isEqualTo("resource_referenced");
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, scope)).isBetween(after + 59_000, after + 61_000);
    }

    @Test
    void blockerTransitionLogsOncePerChange() {
        addObject("one", "reader/exact-key", null);
        var gc = collector(new DeletingObjects());
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                .getLogger(ToolPublicationCollector.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        try (var lease = retention.read(key)) {
            retire();
            assertThat(gc.runOnce()).isFalse();
            assertThat(blocker()).isEqualTo("reader_active");
            assertThat(appender.list).singleElement().satisfies(event -> assertThat(
                    event.getFormattedMessage()).contains("blocker=reader_active"));
            retryNow();
            assertThat(gc.runOnce()).isFalse();
            assertThat(blocker()).isEqualTo("reader_active");
            assertThat(appender.list).hasSize(1);
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void graceCandidatesYieldToAnEligiblePublicationAndWaitUntilTheirDeadline() {
        String heldSession = "held-session";
        for (int index = 0; index < 150; index++) {
            addPublication("held-" + index, heldSession);
        }
        addObject("one", "eligible/one", null);
        retire();
        Duration grace = Duration.ofHours(24);
        jdbc.update("UPDATE ma_session SET retired_at = ? WHERE tenant_id = ? AND session_id = ?",
                ToolPublicationRetentionStore.now(jdbc) - grace.toMillis() - 1000, tenant, session);
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, heldSession);
            ToolPublicationRetentionStore.retire(jdbc, tenant, heldSession, "delete-held");
        });
        long deadline = jdbc.queryForObject("SELECT retired_at FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, heldSession) + grace.toMillis();
        jdbc.update("UPDATE ma_operation SET available_at = 1 WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", scope);
        var properties = new ManagedAgentProperties();
        properties.getToolPublication().setGcEnabled(true);
        properties.getToolPublication().setDeletionGrace(grace);
        var objects = new DeletingObjects();
        var gc = new ToolPublicationCollector(jdbc, manager, retention, objects, properties);
        gc.runOnce();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND session_id = ?"
                + " AND failure_code IS NOT NULL", Long.class, heldSession)).isBetween(2L, 32L);
        for (int tick = 1; tick < 5 && !"COLLECTED".equals(state()); tick++) {
            gc.runOnce();
        }
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(objects.deleted).containsExactly("eligible/one");
        assertThat(held()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture c JOIN ma_operation o ON o.scope_id = c.scope_ref"
                        + " AND o.scope_kind = 'PUBLICATION' AND o.publication_id = c.publication_id AND o.operation_kind = 'CAPTURE_GC' WHERE c.session_id = ?"
                        + " AND retention_state = 'RETIRING' AND o.failure_code = 'grace_period' AND o.available_at = ?"
                        + " AND capture_held_bytes + producer_held_bytes + admission_held_bytes = 3000",
                Long.class, heldSession, deadline)).isEqualTo(150);
    }

    @Test
    void aPublicationCommandCannotReserveTheIndependentCollectorIdentity() {
        String gcId = "capture-gc-" + ManagedSchemaKeys.key(scope, "pub-1");
        addOperation(OperationKind.OUTPUT_UPLOAD, scope, "pub-1", session, gcId, "SUCCEEDED");
        addObject("inline", null, new byte[] {4});
        retire();
        assertThat(collector(new DeletingObjects()).runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForList("SELECT state FROM ma_operation WHERE scope_kind = 'PUBLICATION' AND scope_id = ? AND operation_id = ?"
                        + " ORDER BY operation_kind", String.class, scope, gcId)).containsExactly("SUCCEEDED", "SUCCEEDED");
        assertThat(held()).isZero();
    }

    @Test
    void inlinePublicationReleasesQuotaWhenTheObjectStoreIsUnavailable() {
        addObject("inline", null, new byte[] {4});
        retire();
        var objects = new DeletingObjects() {
            @Override public void validateConfiguration() {
                throw new IllegalStateException("OSS versioning unavailable");
            }
        };
        assertThat(collector(objects).runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(objects.deleted).isEmpty();
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE scope_ref = ?",
                byte[].class, scope)).isNull();
    }

    @Test
    void collectionPreservesOtherPublicationsMessagesAndCheckpoints() {
        addObject("target-result", null, new byte[] {2});
        addPublication("pub-2", session);
        addCaptureObject(scope, "pub-2", session, "sibling-result", "sibling-result", null, new byte[] {2}, "VERIFIED");

        for (String resource : List.of("target-result", "sibling-result")) {
            jdbc.update("UPDATE ma_resource SET state = 'REFERENCED', publish_command_id = 'publish' WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                    tenant, session, resource);
        }
        for (String resource : List.of("message-1", "checkpoint-1")) {
            jdbc.update("INSERT INTO ma_resource (tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, 'workspace-1', ?, ?, ?, 1, 1, ?, 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                    tenant, session, resource,
                    resource.equals("message-1") ? "managed-message" : "managed-checkpoint", "c".repeat(64), new byte[] {2});
        }
        long used = jdbc.queryForObject("SELECT capture_used_bytes + producer_used_bytes + admission_used_bytes"
                + " FROM ma_output_capture WHERE scope_ref = ? AND publication_id = 'pub-1'", Long.class, scope);
        retire();
        jdbc.update("UPDATE ma_operation SET available_at = 1 WHERE operation_kind = 'CAPTURE_GC'"
                + " AND scope_kind = 'PUBLICATION' AND scope_id = ? AND publication_id = ?", scope, "pub-2");
        assertThat(collector(new DeletingObjects()).runOnce()).isTrue();
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource"
                + " WHERE resource_id = X'7461726765742d726573756c74'", byte[].class)).isNull();
        for (String resource : List.of("sibling-result", "message-1", "checkpoint-1")) {
            assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource"
                    + " WHERE resource_id = ?", byte[].class, resource)).containsExactly(2);
        }
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource"
                + " WHERE publication_id = 'pub-2'", byte[].class)).containsExactly(2);
        assertThat(jdbc.queryForObject("SELECT retention_state FROM ma_output_capture"
                + " WHERE publication_id = 'pub-2'", String.class)).isEqualTo("RETIRING");
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes + producer_used_bytes + admission_used_bytes"
                + " FROM ma_output_capture WHERE publication_id = 'pub-2'", Long.class)).isEqualTo(used);
        assertThat(used).isPositive();
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes + producer_used_bytes + admission_used_bytes"
                + " FROM ma_output_capture WHERE publication_id = 'pub-1'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT collected_bytes FROM ma_output_capture"
                + " WHERE publication_id = 'pub-1'", Long.class)).isEqualTo(used);
    }

    @Test
    void aFailingPublicationDoesNotStarveTheNextPublication() {
        jdbc.update("INSERT INTO ma_output_capture (scope_ref, tenant_id, workspace_id, session_id,"
                        + " publication_id, execution_call_id, capture_id, binding_json, binding_digest, token_hash, state,"
                        + " capture_bytes, producer_bytes, admission_bytes, producer_phase, is_write_evidence, is_accepted_complete,"
                        + " capture_held_bytes, producer_held_bytes, admission_held_bytes, capture_used_bytes)"
                        + " VALUES (?, ?, 'workspace-1', ?, 'pub-2', 'execution-pub-2', 'capture-2', '{}', ?, ?, 'FENCED',"
                        + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE, 1000, 1000, 1000, 123)",
                scope, tenant, session, ManagedSchemaKeys.key("binding"), ManagedSchemaKeys.key("token"));
        addObject("one", "failing", null);
        addCaptureObject(scope, "pub-2", session, "two", "two", "healthy", null, "VERIFIED");

        retire();
        jdbc.update("UPDATE ma_operation SET available_at = 1 WHERE operation_kind = 'CAPTURE_GC'"
                + " AND scope_kind = 'PUBLICATION' AND scope_id = ? AND publication_id = ?", scope, "pub-2");
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                if ("failing".equals(key)) {
                    throw new IllegalStateException("permission denied");
                }
                super.deleteIfPresent(key);
            }
        };
        var gc = collector(objects);
        assertThatThrownBy(gc::runOnce).isInstanceOf(IllegalStateException.class);
        assertThat(gc.runOnce()).isTrue();
        assertThat(objects.deleted).containsExactly("healthy");
        assertThat(jdbc.queryForObject("SELECT retention_state FROM ma_output_capture"
                + " WHERE scope_ref = ? AND publication_id = 'pub-1'", String.class, scope)).isEqualTo("DELETING");
        assertThat(jdbc.queryForObject("SELECT retention_state FROM ma_output_capture"
                + " WHERE scope_ref = ? AND publication_id = 'pub-2'", String.class, scope)).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM ma_output_capture"
                + " WHERE scope_ref = ? AND publication_id = 'pub-1'", Long.class, scope)).isEqualTo(1000);
    }

    @Test
    void pagesExactKeysAndReleasesQuotaOnlyAfterAllObjectsAreConfirmed() {
        var objects = new DeletingObjects();
        objects.bytes.put("outside-catalog", new byte[] {9});
        for (int index = 0; index < 201; index++) {
            String slot = "segment-" + String.format("%04d", index);
            addObject(slot, "exact/" + slot, null);
            objects.bytes.put("exact/" + slot, new byte[] {1});
        }
        addObject("z-inline", null, new byte[] {2});
        jdbc.update("UPDATE ma_resource SET state = 'REFERENCED', publish_command_id = 'publish' WHERE scope_ref = ? AND slot_key = ?", scope, "z-inline");
        retire();
        var gc = collector(objects);
        assertThat(gc.runOnce()).isTrue();
        assertThat(objects.deleted).hasSize(100);
        assertThat(state()).isEqualTo("DELETING");
        assertThat(held()).isEqualTo(3000);
        assertThat(gc.runOnce()).isTrue();
        assertThat(objects.deleted).hasSize(200);
        assertThat(held()).isEqualTo(3000);
        assertThat(gc.runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(objects.deleted).hasSize(201);
        assertThat(objects.bytes).containsOnlyKeys("outside-catalog");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE scope_ref = ?"
                + " AND inline_bytes IS NOT NULL", Long.class, scope)).isZero();
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE publication_id IS NOT NULL AND slot_key = 'z-inline' AND tenant_id = ?",
                byte[].class, tenant)).isNull();
        assertThat(jdbc.queryForObject("SELECT released_held_bytes FROM ma_output_capture WHERE scope_ref = ?",
                Long.class, scope)).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT producer_phase FROM ma_output_capture WHERE scope_ref = ?",
                String.class, scope)).isEqualTo("REFERENCED");
        assertThat(gc.runOnce()).isFalse();
        assertThat(held()).isZero();
    }

    @Test
    void lostDeleteResponseRetriesSameKeyWithoutReleasingQuota() {
        var objects = new DeletingObjects() {
            private boolean first = true;
            @Override public void deleteIfPresent(String key) {
                super.deleteIfPresent(key);
                if (first) {
                    first = false;
                    throw new IllegalStateException("response lost after deletion");
                }
            }
        };
        addObject("one", "exact/one", null);
        objects.bytes.put("exact/one", new byte[] {1});
        retire();
        var gc = collector(objects);
        assertThatThrownBy(gc::runOnce).isInstanceOf(IllegalStateException.class);
        assertThat(state()).isEqualTo("DELETING");
        assertThat(held()).isEqualTo(3000);
        assertThat(gc.runOnce()).isFalse();
        retryNow();
        assertThat(gc.runOnce()).isTrue();
        assertThat(objects.deleted).containsExactly("exact/one", "exact/one");
        assertThat(state()).isEqualTo("COLLECTED");
    }

    @Test
    void newerWorkerCanTakeOverButOldGenerationCannotConfirm() {
        addObject("one", "exact/one", null);
        retire();
        var second = collector(new DeletingObjects());
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                assertThat(second.runOnce()).isFalse();
                jdbc.update("UPDATE ma_operation SET claim_until = 0 WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", scope);
                assertThat(second.runOnce()).isTrue();
                super.deleteIfPresent(key);
            }
        };
        assertThat(collector(objects).runOnce()).isFalse();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, scope)).isEqualTo(2);
    }

    @Test
    void partialPageCrashPreservesCursorAndAReplacementRetriesThePage() {
        for (String slot : List.of("a", "b", "c")) {
            addObject(slot, "exact/" + slot, null);
        }
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                if ("exact/b".equals(key)) {
                    throw new IllegalStateException("worker stopped");
                }
                super.deleteIfPresent(key);
            }
        };
        retire();
        assertThatThrownBy(() -> collector(objects).runOnce()).isInstanceOf(IllegalStateException.class);
        assertThat(objects.deleted).containsExactly("exact/a");
        assertThat(cursor()).isEmpty();
        assertThat(held()).isEqualTo(3000);
        retryNow();
        var replacement = new DeletingObjects();
        assertThat(collector(replacement).runOnce()).isTrue();
        assertThat(replacement.deleted).containsExactly("exact/a", "exact/b", "exact/c");
        assertThat(held()).isZero();
    }

    @Test
    void sqlConfirmationFailureRollsBackInlineCleanupAndQuotaRelease() {
        addObject("inline", null, new byte[] {4});
        retire();
        var fail = new AtomicBoolean(true);
        var template = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("UPDATE ma_output_capture SET ")
                        && sql.contains("retention_state = 'COLLECTED'") && fail.getAndSet(false)) {
                    throw new org.springframework.dao.DataAccessResourceFailureException("SQL confirm failed");
                }
                return super.update(sql, args);
            }
        };
        var gc = collector(template, new DeletingObjects(), true);
        assertThatThrownBy(gc::runOnce).isInstanceOf(org.springframework.dao.DataAccessResourceFailureException.class);
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE scope_ref = ?",
                byte[].class, scope)).containsExactly((byte) 4);
        retryNow();
        assertThat(gc.runOnce()).isTrue();
        assertThat(held()).isZero();
    }

    @Test
    void expiredClaimStopsBeforeDeletingTheNextObject() {
        addObject("a", "exact/a", null);
        addObject("b", "exact/b", null);
        var expire = new AtomicBoolean(true);
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                super.deleteIfPresent(key);
                if (expire.getAndSet(false)) {
                    jdbc.update("UPDATE ma_operation SET claim_until = 0 WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", scope);
                }
            }
        };
        retire();
        long before = ToolPublicationRetentionStore.now(jdbc);
        assertThat(collector(objects).runOnce()).isFalse();
        long after = ToolPublicationRetentionStore.now(jdbc);
        assertThat(objects.deleted).containsExactly("exact/a");
        assertThat(state()).isEqualTo("DELETING");
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                String.class, scope)).isEqualTo("collection_retry");
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                Long.class, scope)).isBetween(before + 60000, after + 60000);
        assertThat(collector(objects).runOnce()).isFalse();
        assertThat(objects.deleted).containsExactly("exact/a");
        retryNow();
        assertThat(collector(objects).runOnce()).isTrue();
        assertThat(objects.deleted).containsExactly("exact/a", "exact/a", "exact/b");
        assertThat(held()).isZero();
    }

    @Test
    void expiredClaimCannotConfirmTheLastPhysicalDeletion() {
        addObject("one", "exact/one", null);
        var expire = new AtomicBoolean(true);
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                super.deleteIfPresent(key);
                if (expire.getAndSet(false)) {
                    jdbc.update("UPDATE ma_operation SET claim_until = 0 WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?", scope);
                }
            }
        };
        retire();
        var gc = collector(objects);
        assertThat(gc.runOnce()).isFalse();
        assertThat(state()).isEqualTo("DELETING");
        assertThat(held()).isEqualTo(3000);
        assertThat(gc.runOnce()).isFalse();
        retryNow();
        assertThat(collector(objects).runOnce()).isTrue();
        assertThat(objects.deleted).containsExactly("exact/one", "exact/one");
        assertThat(held()).isZero();
    }

    @org.springframework.context.annotation.Configuration
    @org.springframework.scheduling.annotation.EnableScheduling
    static class SchedulingHarness {}

    @Test
    void slowCollectionDoesNotStallMessageMaterializer() throws Exception {
        addObject("one", "exact/one", null);
        retire();
        var entered = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var advanced = new java.util.concurrent.CountDownLatch(1);
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                entered.countDown();
                try {
                    assertThat(release.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    throw new IllegalStateException(error);
                }
                super.deleteIfPresent(key);
            }
        };
        var state = org.mockito.Mockito.mock(AgentStateStore.class);
        org.mockito.Mockito.when(state.findMaterializationTargets(org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(new StoreModels.MaterializationTarget(tenant, "other-session")));
        org.mockito.Mockito.doAnswer(invocation -> {
            if (entered.getCount() == 0) {
                advanced.countDown();
            }
            return null;
        }).when(state).materializeNextBatch(org.mockito.ArgumentMatchers.eq(tenant),
                org.mockito.ArgumentMatchers.eq("other-session"), org.mockito.ArgumentMatchers.anyInt());
        try (var context = new org.springframework.context.annotation.AnnotationConfigApplicationContext()) {
            context.register(SchedulingHarness.class,
                    org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration.class,
                    com.alibaba.qwen.code.managedagent.config.ManagedArtifactConfiguration.class);
            context.registerBean(ManagedAgentProperties.class, ManagedAgentProperties::new);
            context.registerBean("managedToolOutputScheduler",
                    org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler.class,
                    () -> new com.alibaba.qwen.code.managedagent.config.ToolPublicationConfiguration()
                            .managedToolOutputScheduler(new org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder()));
            context.registerBean("collector", ToolPublicationCollector.class, () -> collector(objects));
            context.registerBean("materializer",
                    com.alibaba.qwen.code.managedagent.event.MessageMaterializer.class,
                    () -> new com.alibaba.qwen.code.managedagent.event.MessageMaterializer(
                            state));
            try {
                context.refresh();
                assertThat(entered.await(3, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThat(advanced.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    void scheduledFailureRetainsQuotaAndLogsTheCause() {
        addObject("one", "exact/one", null);
        retire();
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) { throw new IllegalStateException("denied"); }
        };
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(ToolPublicationCollector.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        try {
            collector(objects).tick();
            assertThat(appender.list).singleElement().satisfies(event -> {
                assertThat(event.getLevel()).isEqualTo(ch.qos.logback.classic.Level.WARN);
                assertThat(event.getThrowableProxy()).isNotNull();
            });
            assertThat(state()).isEqualTo("DELETING");
            assertThat(held()).isEqualTo(3000);
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void disabledGcAndProtectedPublicationNeverDeleteObjects() {
        addObject("one", "exact/one", null);
        retire();
        var objects = new DeletingObjects();
        assertThat(collector(jdbc, objects, false).runOnce()).isFalse();
        assertThat(jdbc.queryForList("SELECT operation_kind FROM ma_operation WHERE state = 'PENDING'", String.class))
                .containsExactlyInAnyOrder("CAPTURE_GC", "SESSION_RESOURCE_GC");
        jdbc.update("UPDATE ma_output_capture SET is_write_evidence = FALSE WHERE scope_ref = ?", scope);
        assertThat(collector(objects).runOnce()).isFalse();
        assertThat(objects.deleted).isEmpty();
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT failure_code FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND scope_kind = 'PUBLICATION' AND scope_id = ?",
                String.class, scope)).isEqualTo("legacy_write_evidence_missing");
    }
}
