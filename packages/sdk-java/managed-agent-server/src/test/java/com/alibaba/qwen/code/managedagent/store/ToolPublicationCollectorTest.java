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

    private String addPublication(String publication, String sessionId) {
        String publicationScope = ToolPublicationRetentionStore.hash(tenant + sessionId);
        jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                        + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                        + " capture_bytes, producer_bytes, admission_bytes, producer_phase, write_evidence, accepted_complete,"
                        + " capture_held_bytes, producer_held_bytes, admission_held_bytes, capture_used_bytes)"
                        + " SELECT ?, tenant_key, tenant_id, workspace_id, ?, ?, ?, ?, binding_json, binding_digest,"
                        + " token_hash, state, capture_bytes, producer_bytes, admission_bytes, producer_phase,"
                        + " write_evidence, accepted_complete, capture_held_bytes, producer_held_bytes, admission_held_bytes,"
                        + " capture_used_bytes FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = 'pub-1'",
                publicationScope, sessionId, publication, ToolPublicationRetentionStore.hash(publicationScope + publication),
                "capture-" + publication, scope);
        return publicationScope;
    }

    @Test
    void graceCandidatesYieldToAnEligiblePublicationAndWaitUntilTheirDeadline() {
        String heldSession = "held-session";
        for (int index = 0; index < 150; index++) { addPublication("held-" + index, heldSession); }
        addObject("one", "eligible/one", null);
        retire();
        Duration grace = Duration.ofHours(24);
        jdbc.update("UPDATE qwen_output_session_retirement SET retired_at = ? WHERE tenant_id = ? AND session_id = ?",
                ToolPublicationRetentionStore.now(jdbc) - grace.toMillis() - 1000, tenant, session);
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, heldSession);
            ToolPublicationRetentionStore.retire(jdbc, tenant, heldSession, "delete-held");
        });
        long deadline = jdbc.queryForObject("SELECT retired_at FROM qwen_output_session_retirement"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, heldSession) + grace.toMillis();
        jdbc.update("UPDATE qwen_tool_publication SET gc_next_at = 1 WHERE scope_key = ?", scope);
        var properties = new ManagedAgentProperties();
        properties.getToolPublication().setGcEnabled(true);
        properties.getToolPublication().setDeletionGrace(grace);
        var objects = new DeletingObjects();
        var gc = new ToolPublicationCollector(jdbc, manager, retention, objects, properties);
        gc.runOnce();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication WHERE session_id = ?"
                + " AND gc_blocker IS NOT NULL", Long.class, heldSession)).isBetween(2L, 32L);
        for (int tick = 1; tick < 5 && !"COLLECTED".equals(state()); tick++) { gc.runOnce(); }
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(objects.deleted).containsExactly("eligible/one");
        assertThat(held()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication WHERE session_id = ?"
                        + " AND retention_state = 'RETIRING' AND gc_blocker = 'grace_period' AND gc_next_at = ?"
                        + " AND capture_held_bytes + producer_held_bytes + admission_held_bytes = 3000",
                Long.class, heldSession, deadline)).isEqualTo(150);
    }

    @Test
    void inlinePublicationReleasesQuotaWhenTheObjectStoreIsUnavailable() {
        addObject("inline", null, new byte[] {4});
        retire();
        var objects = new DeletingObjects() {
            @Override public void requireUnversioned() {
                throw new IllegalStateException("OSS versioning unavailable");
            }
        };
        assertThat(collector(objects).runOnce()).isTrue();
        assertThat(state()).isEqualTo("COLLECTED");
        assertThat(held()).isZero();
        assertThat(objects.deleted).isEmpty();
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM qwen_tool_publication_object WHERE scope_key = ?",
                byte[].class, scope)).isNull();
    }

    @Test
    void collectionPreservesOtherPublicationsMessagesAndCheckpoints() {
        addObject("target-result", null, new byte[] {2});
        addPublication("pub-2", session);
        jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key, resource_id,"
                        + " resource_kind, byte_length, sha256, inline_bytes, state, operation_id, created_at)"
                        + " VALUES (?, 'pub-2', 'sibling-result', 'sibling-result', 'managed-tool-result-content',"
                        + " 1, ?, ?, 'VERIFIED', 'op', CURRENT_TIMESTAMP(6))", scope, scope, new byte[] {2});
        for (String resource : List.of("target-result", "sibling-result", "message-1", "checkpoint-1")) {
            String kind = resource.equals("message-1") ? "managed-message"
                    : resource.equals("checkpoint-1") ? "managed-checkpoint" : "managed-tool-result-content";
            jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id, session_id,"
                            + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes,"
                            + " publish_command_id, state, created_at) VALUES (?, ?, 'workspace-1', ?, ?, ?,"
                            + " 1, 1, ?, 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', CURRENT_TIMESTAMP(6))",
                    ManagedSessionStore.sessionScopeKey(tenant, session), tenant, session, resource, kind, scope, new byte[] {2});
        }
        long used = jdbc.queryForObject("SELECT capture_used_bytes + producer_used_bytes + admission_used_bytes"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = 'pub-1'", Long.class, scope);
        retire();
        assertThat(collector(new DeletingObjects()).runOnce()).isTrue();
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource"
                + " WHERE resource_id = 'target-result'", byte[].class)).isNull();
        for (String resource : List.of("sibling-result", "message-1", "checkpoint-1")) {
            assertThat(jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource"
                    + " WHERE resource_id = ?", byte[].class, resource)).containsExactly(2);
        }
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM qwen_tool_publication_object"
                + " WHERE publication_id = 'pub-2'", byte[].class)).containsExactly(2);
        assertThat(jdbc.queryForObject("SELECT retention_state FROM qwen_tool_publication"
                + " WHERE publication_id = 'pub-2'", String.class)).isEqualTo("RETIRING");
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes + producer_used_bytes + admission_used_bytes"
                + " FROM qwen_tool_publication WHERE publication_id = 'pub-2'", Long.class)).isEqualTo(used);
        assertThat(used).isPositive();
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes + producer_used_bytes + admission_used_bytes"
                + " FROM qwen_tool_publication WHERE publication_id = 'pub-1'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT collected_bytes FROM qwen_tool_publication"
                + " WHERE publication_id = 'pub-1'", Long.class)).isEqualTo(used);
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
                ManagedSessionStore.sessionScopeKey(tenant, session), tenant, session, scope, new byte[] {2});
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
    void expiredClaimStopsBeforeDeletingTheNextObject() {
        addObject("a", "exact/a", null);
        addObject("b", "exact/b", null);
        var expire = new AtomicBoolean(true);
        var objects = new DeletingObjects() {
            @Override public void deleteIfPresent(String key) {
                super.deleteIfPresent(key);
                if (expire.getAndSet(false)) {
                    jdbc.update("UPDATE qwen_tool_publication SET gc_claim_until = 0 WHERE scope_key = ?", scope);
                }
            }
        };
        retire();
        assertThat(collector(objects).runOnce()).isFalse();
        assertThat(objects.deleted).containsExactly("exact/a");
        assertThat(state()).isEqualTo("DELETING");
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT gc_blocker FROM qwen_tool_publication WHERE scope_key = ?",
                String.class, scope)).isEqualTo("collection_retry");
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
                    jdbc.update("UPDATE qwen_tool_publication SET gc_claim_until = 0 WHERE scope_key = ?", scope);
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
                try { assertThat(release.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue(); }
                catch (InterruptedException error) { throw new IllegalStateException(error); }
                super.deleteIfPresent(key);
            }
        };
        var state = org.mockito.Mockito.mock(AgentStateStore.class);
        org.mockito.Mockito.when(state.findMaterializationTargets(org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(new StoreModels.MaterializationTarget(tenant, "other-session")));
        org.mockito.Mockito.doAnswer(invocation -> {
            if (entered.getCount() == 0) { advanced.countDown(); }
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
            context.registerBean("materializer", com.alibaba.qwen.code.managedagent.service.MessageMaterializer.class,
                    () -> new com.alibaba.qwen.code.managedagent.service.MessageMaterializer(state));
            try {
                context.refresh();
                assertThat(entered.await(3, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThat(advanced.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            } finally { release.countDown(); }
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
        jdbc.update("UPDATE qwen_tool_publication SET write_evidence = FALSE WHERE scope_key = ?", scope);
        assertThat(collector(objects).runOnce()).isFalse();
        assertThat(objects.deleted).isEmpty();
        assertThat(held()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT gc_blocker FROM qwen_tool_publication WHERE scope_key = ?",
                String.class, scope)).isEqualTo("legacy_write_evidence_missing");
    }
}
