package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronizationManager;

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
        jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key, resource_id,"
                        + " resource_kind, byte_length, sha256, object_key, inline_bytes, state, operation_id, created_at)"
                        + " VALUES (?, 'pub-1', ?, ?, 'managed-tool-result-content', ?, ?, ?, ?, 'VERIFIED', 'op', CURRENT_TIMESTAMP(6))",
                scope, slot, slot, inline == null ? 1 : inline.length,
                ToolPublicationRetentionStore.hash(slot), objectKey, inline);
    }

    protected String state() {
        return jdbc.queryForObject("SELECT retention_state FROM qwen_tool_publication WHERE scope_key = ?", String.class, scope);
    }

    protected long held() {
        return jdbc.queryForObject("SELECT capture_held_bytes + producer_held_bytes + admission_held_bytes FROM"
                + " qwen_tool_publication WHERE scope_key = ?", Long.class, scope);
    }

    protected void retryNow() {
        jdbc.update("UPDATE qwen_tool_publication SET gc_next_at = 0, gc_claim_until = 0 WHERE scope_key = ?", scope);
    }

    @Test
    void aFailingPublicationDoesNotStarveTheNextPublication() {
        jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                        + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                        + " capture_bytes, producer_bytes, admission_bytes, producer_phase, write_evidence, accepted_complete,"
                        + " capture_held_bytes, producer_held_bytes, admission_held_bytes, capture_used_bytes)"
                        + " VALUES (?, ?, ?, 'workspace-1', ?, 'pub-2', ?, 'capture-2', '{}', ?, ?, 'FENCED',"
                        + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE, 1000, 1000, 1000, 123)",
                scope, ToolPublicationRetentionStore.hash(tenant), tenant, session, ToolPublicationRetentionStore.hash(scope + "2"), scope, scope);
        addObject("one", "failing", null);
        jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key, resource_id,"
                        + " resource_kind, byte_length, sha256, object_key, state, operation_id, created_at)"
                        + " VALUES (?, 'pub-2', 'two', 'two', 'managed-tool-result-content', 1, ?, 'healthy',"
                        + " 'VERIFIED', 'op', CURRENT_TIMESTAMP(6))", scope, scope);
        retire();
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                if ("failing".equals(key)) { throw new IllegalStateException("permission denied"); }
                super.deleteIfPresent(key);
            }
        };
        var gc = collector(objects);
        assertThatThrownBy(gc::runOnce).isInstanceOf(IllegalStateException.class);
        assertThat(gc.runOnce()).isTrue();
        assertThat(objects.deleted).containsExactly("healthy");
        assertThat(jdbc.queryForObject("SELECT retention_state FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = 'pub-1'", String.class, scope)).isEqualTo("DELETING");
        assertThat(jdbc.queryForObject("SELECT retention_state FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = 'pub-2'", String.class, scope)).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("SELECT capture_held_bytes FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = 'pub-1'", Long.class, scope)).isEqualTo(1000);
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
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id, session_id,"
                        + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, created_at) VALUES (?, ?, 'workspace-1', ?, 'z-inline',"
                        + " 'managed-tool-result-content', 1, 1, ?, 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', CURRENT_TIMESTAMP(6))",
                scope, tenant, session, scope, new byte[] {2});
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_object WHERE scope_key = ?"
                + " AND inline_bytes IS NOT NULL", Long.class, scope)).isZero();
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource WHERE tenant_id = ?",
                byte[].class, tenant)).isNull();
        assertThat(jdbc.queryForObject("SELECT released_held_bytes FROM qwen_tool_publication WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT producer_phase FROM qwen_tool_publication WHERE scope_key = ?",
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
                if (first) { first = false; throw new IllegalStateException("response lost after deletion"); }
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
                jdbc.update("UPDATE qwen_tool_publication SET gc_claim_until = 0 WHERE scope_key = ?", scope);
                assertThat(second.runOnce()).isTrue();
                super.deleteIfPresent(key);
            }
        };
        assertThat(collector(objects).runOnce()).isFalse();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(jdbc.queryForObject("SELECT gc_generation FROM qwen_tool_publication WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(2);
    }

    @Test
    void partialPageCrashPreservesCursorAndAReplacementRetriesThePage() {
        for (String slot : List.of("a", "b", "c")) { addObject(slot, "exact/" + slot, null); }
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                if ("exact/b".equals(key)) { throw new IllegalStateException("worker stopped"); }
                super.deleteIfPresent(key);
            }
        };
        retire();
        assertThatThrownBy(() -> collector(objects).runOnce()).isInstanceOf(IllegalStateException.class);
        assertThat(objects.deleted).containsExactly("exact/a");
        assertThat(jdbc.queryForObject("SELECT gc_cursor FROM qwen_tool_publication WHERE scope_key = ?",
                String.class, scope)).isEmpty();
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
        var template = new org.springframework.jdbc.core.JdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("UPDATE qwen_tool_publication SET retention_state = 'COLLECTED'") && fail.getAndSet(false)) {
                    throw new org.springframework.dao.DataAccessResourceFailureException("SQL confirm failed");
                }
                return super.update(sql, args);
            }
        };
        var gc = collector(template, new DeletingObjects(), true);
        assertThatThrownBy(gc::runOnce).isInstanceOf(org.springframework.dao.DataAccessResourceFailureException.class);
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM qwen_tool_publication_object WHERE scope_key = ?",
                byte[].class, scope)).containsExactly((byte) 4);
        retryNow();
        assertThat(gc.runOnce()).isTrue();
        assertThat(held()).isZero();
    }

    @Test
    void disabledGcAndProtectedPublicationNeverDeleteObjects() {
        addObject("one", "exact/one", null);
        retire();
        var objects = new DeletingObjects();
        assertThat(collector(jdbc, objects, false).runOnce()).isFalse();
        jdbc.update("UPDATE qwen_tool_publication SET write_evidence = FALSE WHERE scope_key = ?", scope);
        assertThat(collector(objects).runOnce()).isFalse();
        assertThat(objects.deleted).isEmpty();
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT gc_blocker FROM qwen_tool_publication WHERE scope_key = ?",
                String.class, scope)).isEqualTo("legacy_write_evidence_missing");
    }
}
