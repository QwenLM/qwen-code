package com.alibaba.qwen.code.managedagent;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Hook admission checks once keys, occurrence ordinals and catalog pins through indexed
 * projections, on H2 in MySQL mode; ManagedAgentMySqlIT runs the same current admission contracts
 * on MySQL.
 */
class ManagedHookAdmissionIndexTest {
    private static final String TENANT = "tenant-hook-index";
    private static final String WORKSPACE = "workspace-hook-index";

    @Test
    void admitsWithoutReadingTheAccumulatedHistory() throws Exception {
        JdbcDataSource dataSource = migrated();
        HookAdmissionHistory history =
                new HookAdmissionHistory(
                        dataSource, TENANT, WORKSPACE, UUID.randomUUID().toString());
        // Equal modulo 4: both are ordinal 1 of their occurrence, beside a
        // committed sibling, and both consume a once key.
        HookAdmissionHistory.Admission early = history.admitUntil(10);
        HookAdmissionHistory.Admission late = history.admitUntil(402);
        assertThat(early.history()).isEqualTo(9);
        assertThat(late.history()).isEqualTo(401);
        assertThat(early.selects())
                .as("lookups admitting execution %d", early.history())
                .isPositive();
        assertThat(early.statements()).isPositive();
        assertThat(late.selects())
                .as("SELECTs of execution %d vs %d", late.history(), early.history())
                .isEqualTo(early.selects());
        assertThat(late.statements()).isEqualTo(early.statements());
    }

    @Test
    void refusesConsumedOnceKeysAndOrdinalsAcrossALongHistory() throws Exception {
        JdbcDataSource dataSource = migrated();
        String sessionId = UUID.randomUUID().toString();
        HookAdmissionHistory history =
                new HookAdmissionHistory(dataSource, TENANT, WORKSPACE, sessionId);
        history.admitUntil(200);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        int committed = revisions(jdbc, sessionId);

        // The oldest once key, not only a recent one, is still consumed.
        ObjectNode once = history.execution(1000);
        once.put("onceKey", "once-1");
        assertRefused(history, "reuse-once", once, "onceKey");
        // Ordinal 2 of the first occurrence is taken; its next one is not
        // when it keeps the occurrence's registration, event and plan.
        ObjectNode ordinal = history.execution(1000);
        ordinal.put("occurrenceId", "occurrence-0").put("ordinal", 2);
        assertRefused(history, "reuse-ordinal", ordinal, "unique ordinals");
        ObjectNode moved = history.execution(1000);
        moved.put("occurrenceId", "occurrence-0").put("ordinal", 9).put("eventName", "AfterTool");
        assertRefused(history, "moved-event", moved, "unique ordinals");
        // A plan that exists, but is not the occurrence's.
        byte[] other = "{\"hooks\":[]}".getBytes(StandardCharsets.UTF_8);
        CommitResource plan =
                new CommitResource(
                        "other-plan",
                        "hook-data",
                        1,
                        other.length,
                        ExtensionRecordJournal.sha256(other),
                        Base64.getEncoder().encodeToString(other));
        ObjectNode replanned = history.execution(1000);
        replanned.put("occurrenceId", "occurrence-0").put("ordinal", 9);
        replanned
                .withObject("/planRef")
                .put("resourceId", plan.resourceId())
                .put("byteLength", plan.byteLength())
                .put("digest", plan.digest());
        assertThatThrownBy(
                        () ->
                                history.commit(
                                        "replanned", "hook_execution", replanned, List.of(plan)))
                .as("replanned")
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("unique ordinals");
        assertThat(revisions(jdbc, sessionId)).isEqualTo(committed);

        // After a catalog replacement, new occurrences bind to the new
        // registration while an existing occurrence keeps its own.
        ObjectNode replaced = history.replaceCatalog("registration-2", "catalog-2");
        committed = revisions(jdbc, sessionId);
        ObjectNode rebound = replaced.deepCopy();
        rebound.put("hookExecutionId", "rebound")
                .put("occurrenceId", "occurrence-0")
                .put("ordinal", 9)
                .putNull("onceKey");
        rebound.withObject("/run").put("effectId", "rebound");
        assertRefused(history, "rebound", rebound, "unique ordinals");
        ObjectNode fresh = replaced.deepCopy();
        fresh.put("hookExecutionId", "fresh")
                .put("occurrenceId", "occurrence-new")
                .put("onceKey", "once-new");
        fresh.withObject("/run").put("effectId", "fresh");
        history.commit("fresh", "hook_execution", fresh, List.of());
        ObjectNode next = history.execution(1001);
        next.put("occurrenceId", "occurrence-0").put("ordinal", 9).putNull("onceKey");
        history.commit("next-ordinal", "hook_execution", next, List.of());
        assertThat(revisions(jdbc, sessionId)).isEqualTo(committed + 2);
    }

    @Test
    void consumesOnceKeysAndOrdinalsPerSession() throws Exception {
        JdbcDataSource dataSource = migrated();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        // Two Sessions of one tenant name the same once keys and occurrences.
        List<String> sessions = List.of(UUID.randomUUID().toString(), UUID.randomUUID().toString());
        for (String sessionId : sessions) {
            new HookAdmissionHistory(dataSource, TENANT, WORKSPACE, sessionId).admitUntil(4);
        }
        for (String sessionId : sessions) {
            assertThat(
                            jdbc.queryForObject(
                                    "SELECT COUNT(*) FROM"
                                            + " ma_session_record WHERE"
                                            + " session_id = ? AND hook_once_key_hash IS NOT NULL",
                                    Integer.class,
                                    sessionId))
                    .isEqualTo(2);
        }
    }

    @Test
    void theUniqueIndexesRefuseADuplicateTheChecksMissed() throws Exception {
        JdbcDataSource dataSource = migrated();
        String sessionId = UUID.randomUUID().toString();
        new HookAdmissionHistory(dataSource, TENANT, WORKSPACE, sessionId).admitUntil(4);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        // A row written past the store's checks, as a concurrent writer
        // that skipped them would, collides with the committed projection.
        for (String column : List.of("hook_once_key_hash", "hook_occurrence_hash")) {
            assertThatThrownBy(
                            () ->
                                    jdbc.update(
                                            "INSERT INTO ma_session_record (session_scope_key,"
                                                + " record_key, tenant_id, workspace_id,"
                                                + " session_id, domain, record_id, operation_hash,"
                                                + " revision, record_resource_id, gmt_create,"
                                                + " hook_once_key_hash, hook_occurrence_hash,"
                                                + " hook_ordinal) SELECT session_scope_key, ?,"
                                                + " tenant_id, workspace_id, session_id, domain,"
                                                + " 'duplicate', ?, 1, record_resource_id,"
                                                + " gmt_create, "
                                                    + (column.equals("hook_once_key_hash")
                                                            ? "hook_once_key_hash, 'x', 0"
                                                            : "NULL, hook_occurrence_hash,"
                                                                  + " hook_ordinal")
                                                    + " FROM ma_session_record"
                                                    + " WHERE session_id = ? AND record_id = ?",
                                            ExtensionRecordJournal.sha256("duplicate-" + column),
                                            ExtensionRecordJournal.sha256("operation-" + column),
                                            sessionId,
                                            "execution-1"))
                    .as(column)
                    .isInstanceOf(DuplicateKeyException.class);
        }
    }

    @Test
    void refusesAndRollsBackAnAdmissionThatLosesARaceToTheIndex() throws Exception {
        JdbcDataSource dataSource = migrated();
        String sessionId = UUID.randomUUID().toString();
        HookAdmissionHistory history =
                new HookAdmissionHistory(dataSource, TENANT, WORKSPACE, sessionId);
        history.admitUntil(4);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        int rows =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM" + " ma_session_record WHERE session_id = ?",
                        Integer.class,
                        sessionId);
        // A once key the checks found free is taken before the insert lands.
        ObjectNode execution = history.execution(5);
        history.interleaveOnceKey("once-5");
        Logger log = (Logger) LoggerFactory.getLogger(ManagedExtensionRecordStore.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        log.addAppender(logged);
        try {
            assertRefused(history, "race", execution, "repeats a record or a Hook once key");
        } finally {
            log.detachAppender(logged);
        }
        // Only the log names the index; the refusal does not.
        assertThat(logged.list)
                .singleElement()
                .satisfies(
                        event -> {
                            assertThat(event.getLevel()).isEqualTo(Level.WARN);
                            assertThat(event.getThrowableProxy().getMessage())
                                    .containsIgnoringCase("uq_ma_hook_once");
                        });
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM" + " ma_session_record WHERE session_id = ?",
                                Integer.class,
                                sessionId))
                .isEqualTo(rows);
        history.commit("after-race", "hook_execution", execution, List.of());
        assertThat(
                        jdbc.queryForList(
                                "SELECT record_id FROM" + " ma_session_record WHERE session_id = ?",
                                String.class,
                                sessionId))
                .hasSize(rows + 1)
                .contains("execution-5")
                .doesNotContain("intruder");
    }

    @Test
    void reinitializationPreservesHookKeysAndDoesNotRebuildHistory() throws Exception {
        JdbcDataSource source = migrated();
        String session = UUID.randomUUID().toString();
        HookAdmissionHistory history = new HookAdmissionHistory(source, TENANT, WORKSPACE, session);
        history.admitUntil(40);
        JdbcTemplate jdbc = new JdbcTemplate(source);
        int before = revisions(jdbc, session);
        ManagedSchema.initialize(source);
        assertThat(revisions(jdbc, session)).isEqualTo(before);
        ObjectNode reused = history.execution(100);
        reused.put("onceKey", "once-1");
        assertRefused(history, "reused-after-init", reused, "onceKey");
    }

    @Test
    void refusesLegacyHookCatalogBeforeAttemptingAnyBackfill() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:hook-legacy-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcTemplate jdbc = new JdbcTemplate(source);
        jdbc.execute("CREATE TABLE qwen_managed_session_extension_record (witness INT)");
        jdbc.update("INSERT INTO qwen_managed_session_extension_record VALUES (42)");
        assertThatThrownBy(() -> ManagedSchema.initialize(source))
                .isInstanceOf(IllegalStateException.class);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT witness FROM qwen_managed_session_extension_record",
                                Integer.class))
                .isEqualTo(42);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM information_schema.tables WHERE"
                                    + " table_schema='public'",
                                Integer.class))
                .isEqualTo(1);
    }

    private static void assertRefused(
            HookAdmissionHistory history, String commandId, ObjectNode execution, String message) {
        assertThatThrownBy(() -> history.commit(commandId, "hook_execution", execution, List.of()))
                .as(commandId)
                .isInstanceOfSatisfying(
                        ApiException.class,
                        error ->
                                assertThat(error.getCode())
                                        .isEqualTo(ManagedExtensionRecordStore.ERROR_REJECTED))
                .hasMessageContaining(message);
    }

    private static JdbcDataSource migrated() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:hook-index-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        return source;
    }

    private static int revisions(JdbcTemplate jdbc, String sessionId) {
        Integer total =
                jdbc.queryForObject(
                        "SELECT COALESCE(SUM(revision),0) FROM ma_session_record"
                                + " WHERE record_kind='DOMAIN' AND session_id=?",
                        Integer.class,
                        sessionId);
        return total == null ? 0 : total;
    }
}
