package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.fasterxml.jackson.databind.node.ObjectNode;
import db.migration.V29__managed_hook_admission_backfill;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.Configuration;
import org.flywaydb.core.api.migration.Context;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Hook admission checks once keys, occurrence ordinals and catalog pins
 * through indexed projections, on H2 in MySQL mode; ManagedAgentMySqlIT runs
 * the same history and upgrade on MySQL.
 */
class ManagedHookAdmissionIndexTest {
    private static final String TENANT = "tenant-hook-index";
    private static final String WORKSPACE = "workspace-hook-index";
    private static final String PROJECTION = "SELECT record_key, hook_once_key_hash,"
            + " hook_occurrence_hash, hook_ordinal, hook_definition_hash FROM"
            + " qwen_managed_session_extension_record WHERE session_id = ?"
            + " ORDER BY record_key";

    @Test
    void admitsWithoutReadingTheAccumulatedHistory() throws Exception {
        JdbcDataSource dataSource = migrated();
        HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                TENANT, WORKSPACE, UUID.randomUUID().toString());
        // Equal modulo 4: both are ordinal 1 of their occurrence, beside a
        // committed sibling, and both consume a once key.
        HookAdmissionHistory.Admission early = history.admitUntil(10);
        HookAdmissionHistory.Admission late = history.admitUntil(402);
        assertThat(early.history()).isEqualTo(9);
        assertThat(late.history()).isEqualTo(401);
        assertThat(early.selects()).as("lookups admitting execution %d",
                early.history()).isPositive();
        assertThat(early.statements()).isPositive();
        assertThat(late.selects()).as("SELECTs of execution %d vs %d",
                late.history(), early.history()).isEqualTo(early.selects());
        assertThat(late.statements()).isEqualTo(early.statements());
    }

    @Test
    void refusesConsumedOnceKeysAndOrdinalsAcrossALongHistory() throws Exception {
        JdbcDataSource dataSource = migrated();
        String sessionId = UUID.randomUUID().toString();
        HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                TENANT, WORKSPACE, sessionId);
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
        moved.put("occurrenceId", "occurrence-0").put("ordinal", 9)
                .put("eventName", "AfterTool");
        assertRefused(history, "moved-event", moved, "unique ordinals");
        // A plan that exists, but is not the occurrence's.
        byte[] other = "{\"hooks\":[]}".getBytes(StandardCharsets.UTF_8);
        CommitResource plan = new CommitResource("other-plan", "hook-data", 1,
                other.length, ExtensionRecordJournal.sha256(other),
                Base64.getEncoder().encodeToString(other));
        ObjectNode replanned = history.execution(1000);
        replanned.put("occurrenceId", "occurrence-0").put("ordinal", 9);
        replanned.withObject("/planRef").put("resourceId", plan.resourceId())
                .put("byteLength", plan.byteLength()).put("digest", plan.digest());
        assertThatThrownBy(() -> history.commit("replanned", "hook_execution",
                replanned, List.of(plan))).as("replanned")
                .isInstanceOf(ApiException.class).hasMessageContaining("unique ordinals");
        assertThat(revisions(jdbc, sessionId)).isEqualTo(committed);

        // After a catalog replacement, new occurrences bind to the new
        // registration while an existing occurrence keeps its own.
        ObjectNode replaced = history.replaceCatalog("registration-2", "catalog-2");
        committed = revisions(jdbc, sessionId);
        ObjectNode rebound = replaced.deepCopy();
        rebound.put("hookExecutionId", "rebound").put("occurrenceId", "occurrence-0")
                .put("ordinal", 9).putNull("onceKey");
        rebound.withObject("/run").put("effectId", "rebound");
        assertRefused(history, "rebound", rebound, "unique ordinals");
        ObjectNode fresh = replaced.deepCopy();
        fresh.put("hookExecutionId", "fresh").put("occurrenceId", "occurrence-new")
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
        List<String> sessions = List.of(UUID.randomUUID().toString(),
                UUID.randomUUID().toString());
        for (String sessionId : sessions) {
            new HookAdmissionHistory(dataSource, TENANT, WORKSPACE, sessionId)
                    .admitUntil(4);
        }
        for (String sessionId : sessions) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_id = ? AND hook_once_key_hash IS NOT NULL",
                    Integer.class, sessionId)).isEqualTo(2);
        }
    }

    @Test
    void theUniqueIndexesRefuseADuplicateTheChecksMissed() throws Exception {
        JdbcDataSource dataSource = migrated();
        String sessionId = UUID.randomUUID().toString();
        new HookAdmissionHistory(dataSource, TENANT, WORKSPACE, sessionId)
                .admitUntil(4);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        // A row written past the store's checks, as a concurrent writer
        // that skipped them would, collides with the committed projection.
        for (String column : List.of("hook_once_key_hash", "hook_occurrence_hash")) {
            assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                            + " qwen_managed_session_extension_record"
                            + " (session_scope_key, record_key, tenant_id,"
                            + " workspace_id, session_id, domain, record_id,"
                            + " operation_hash, revision, record_resource_id,"
                            + " created_at, hook_once_key_hash,"
                            + " hook_occurrence_hash, hook_ordinal)"
                            + " SELECT session_scope_key, ?, tenant_id,"
                            + " workspace_id, session_id, domain, 'duplicate',"
                            + " ?, 1, record_resource_id, created_at, "
                            + (column.equals("hook_once_key_hash")
                                    ? "hook_once_key_hash, 'x', 0"
                                    : "NULL, hook_occurrence_hash, hook_ordinal")
                            + " FROM qwen_managed_session_extension_record"
                            + " WHERE session_id = ? AND record_id = 'execution-1'",
                    ExtensionRecordJournal.sha256("duplicate-" + column),
                    ExtensionRecordJournal.sha256("operation-" + column), sessionId))
                    .as(column).isInstanceOf(DuplicateKeyException.class);
        }
    }

    @Test
    void refusesAndRollsBackAnAdmissionThatLosesARaceToTheIndex() throws Exception {
        JdbcDataSource dataSource = migrated();
        String sessionId = UUID.randomUUID().toString();
        HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                TENANT, WORKSPACE, sessionId);
        history.admitUntil(4);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        int rows = jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " qwen_managed_session_extension_record WHERE session_id = ?",
                Integer.class, sessionId);
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
        assertThat(logged.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getThrowableProxy().getMessage())
                    .containsIgnoringCase("uq_managed_session_hook_once");
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " qwen_managed_session_extension_record WHERE session_id = ?",
                Integer.class, sessionId)).isEqualTo(rows);
        history.commit("after-race", "hook_execution", execution, List.of());
        assertThat(jdbc.queryForList("SELECT record_id FROM"
                + " qwen_managed_session_extension_record WHERE session_id = ?",
                String.class, sessionId)).hasSize(rows + 1)
                .contains("execution-5").doesNotContain("intruder");
    }

    @Test
    void backfillsTheProjectionTheStoreWrites() throws Exception {
        JdbcDataSource dataSource = migrated();
        String sessionId = UUID.randomUUID().toString();
        HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                TENANT, WORKSPACE, sessionId);
        history.admitUntil(1200);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        List<Map<String, Object>> written = jdbc.queryForList(PROJECTION, sessionId);
        assertThat(written).hasSize(1201);
        assertThat(written).filteredOn(row -> row.get("hook_occurrence_hash") != null)
                .hasSize(1200);
        assertThat(written).filteredOn(row -> row.get("hook_once_key_hash") != null)
                .hasSize(600);
        assertThat(written).filteredOn(row -> row.get("hook_definition_hash") != null)
                .hasSize(1);

        // Rows written before V28 hold no projection; the backfill, which
        // pages through more rows than one query reads, restores it exactly.
        clearProjection(jdbc);
        backfill(dataSource);
        assertThat(jdbc.queryForList(PROJECTION, sessionId)).isEqualTo(written);

        ObjectNode once = history.execution(5000);
        once.put("onceKey", "once-3");
        assertRefused(history, "backfilled-once", once, "onceKey");
    }

    @Test
    void blocksOnlyTheSessionsWhoseRecordBodyCannotBeVerified() throws Exception {
        JdbcDataSource dataSource = migrated();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String healthy = UUID.randomUUID().toString();
        HookAdmissionHistory kept = new HookAdmissionHistory(dataSource, TENANT,
                WORKSPACE, healthy);
        kept.admitUntil(3);
        String notAnExecution = "{\"hookExecutionId\":\"execution-2\"}";
        record Damaged(String damage, String sessionId, HookAdmissionHistory history) {
        }
        List<Damaged> damaged = new ArrayList<>();
        for (String damage : List.of("flipped", "deleted", "kind", "invalid",
                "duplicate", "object", "foreign", "digest", "length", "missing")) {
            String sessionId = UUID.randomUUID().toString();
            HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                    TENANT, WORKSPACE, sessionId);
            history.admitUntil(3);
            String resourceId = jdbc.queryForObject("SELECT record_resource_id FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_id = ? AND record_id = 'execution-2'",
                    String.class, sessionId);
            byte[] flipped = jdbc.queryForObject("SELECT inline_bytes FROM"
                            + " qwen_managed_session_resource WHERE session_id = ?"
                            + " AND resource_id = ?",
                    byte[].class, sessionId, resourceId);
            flipped[flipped.length - 2] ^= 1;
            String where = " WHERE session_id = '" + sessionId
                    + "' AND resource_id = '" + resourceId + "'";
            switch (damage) {
                case "flipped" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET inline_bytes = ?" + where, (Object) flipped);
                case "deleted" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET state = 'DELETED'" + where);
                case "kind" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET kind = 'managed-hook_registration'" + where);
                case "object" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET encryption_key_id = 'key-1'" + where);
                case "foreign" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET session_id = 'another-session'" + where);
                case "duplicate" -> {
                    // Valid once parsed leniently, but not as the store reads it.
                    String body = new String(ExtensionRecordJournal.bytes(
                            history.execution(2)), StandardCharsets.UTF_8)
                            .replaceFirst("\\{", "{\"onceKey\":\"shadow\",");
                    jdbc.update("UPDATE qwen_managed_session_resource SET"
                            + " inline_bytes = ?, byte_length = ?, sha256 = ?" + where,
                            body.getBytes(StandardCharsets.UTF_8),
                            body.getBytes(StandardCharsets.UTF_8).length,
                            ExtensionRecordJournal.sha256(body));
                }
                case "invalid" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET inline_bytes = ?, byte_length = ?, sha256 = ?" + where,
                        notAnExecution.getBytes(StandardCharsets.UTF_8),
                        notAnExecution.length(),
                        ExtensionRecordJournal.sha256(notAnExecution));
                // The body is intact; only what it was recorded as changes.
                case "digest" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET sha256 = ?" + where,
                        ExtensionRecordJournal.sha256("another body"));
                case "length" -> jdbc.update("UPDATE qwen_managed_session_resource"
                        + " SET byte_length = byte_length + 1" + where);
                case "missing" -> jdbc.update("DELETE FROM qwen_managed_session_resource" + where);
                default -> throw new AssertionError("No damage named " + damage);
            }
            damaged.add(new Damaged(damage, sessionId, history));
        }
        clearProjection(jdbc);
        backfill(dataSource);

        for (Damaged entry : damaged) {
            String sessionId = entry.sessionId();
            // The unverifiable record keeps no keys; the others are indexed.
            assertThat(jdbc.queryForList("SELECT record_id FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_id = ? AND domain = 'hook_execution'"
                            + " AND hook_occurrence_hash IS NULL",
                    String.class, sessionId)).as(entry.damage())
                    .containsExactly("execution-2");
            assertThat(jdbc.queryForMap("SELECT recovery_status,"
                            + " recovery_detail_code FROM"
                            + " qwen_managed_session_journal_head WHERE session_id = ?",
                    sessionId)).as(entry.damage()).containsValues("BLOCKED_RESOURCE",
                    "hook_admission_record_unverified");
            // No admission can follow, so none can reuse its once key.
            assertThatThrownBy(() -> entry.history().commit("after-backfill",
                    "hook_execution", entry.history().execution(7), List.of()))
                    .as(entry.damage())
                    .isInstanceOfSatisfying(ApiException.class, error ->
                            assertThat(error.getCode())
                                    .isEqualTo("managed_session_recovery_blocked"));
        }
        assertThat(jdbc.queryForObject("SELECT recovery_status FROM"
                + " qwen_managed_session_journal_head WHERE session_id = ?",
                String.class, healthy)).isEqualTo("READY");
        kept.admitUntil(4);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_id = ? AND hook_occurrence_hash IS NOT NULL",
                Integer.class, healthy)).isEqualTo(4);
    }

    @Test
    void blocksOnlyTheSessionsWhoseRecordsRepeatAKeyOfTheirSession() throws Exception {
        JdbcDataSource dataSource = migrated();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String healthy = UUID.randomUUID().toString();
        new HookAdmissionHistory(dataSource, TENANT, WORKSPACE, healthy).admitUntil(4);
        List<String> repeating = new ArrayList<>();
        for (String field : List.of("onceKey", "ordinal")) {
            String sessionId = UUID.randomUUID().toString();
            HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                    TENANT, WORKSPACE, sessionId);
            history.admitUntil(4);
            // Written past admission: execution 3 repeats execution 1's once
            // key or ordinal, in a body that verifies.
            ObjectNode repeated = history.execution(3);
            if (field.equals("onceKey")) {
                repeated.put("onceKey", "once-1");
            } else {
                repeated.put("ordinal", 1);
            }
            rewrite(jdbc, sessionId, "execution-3", repeated);
            repeating.add(sessionId);
        }
        clearProjection(jdbc);
        backfill(dataSource);

        for (String sessionId : repeating) {
            // One of the two keeps the key; the other none, and its Session
            // admits nothing more.
            assertThat(jdbc.queryForList("SELECT record_id FROM"
                            + " qwen_managed_session_extension_record WHERE"
                            + " session_id = ? AND domain = 'hook_execution'"
                            + " AND hook_occurrence_hash IS NULL",
                    String.class, sessionId)).singleElement()
                    .isIn("execution-1", "execution-3");
            assertThat(jdbc.queryForMap("SELECT recovery_status,"
                            + " recovery_detail_code FROM"
                            + " qwen_managed_session_journal_head WHERE session_id = ?",
                    sessionId)).containsValues("BLOCKED_RESOURCE",
                    "hook_admission_record_duplicate");
        }
        assertThat(jdbc.queryForObject("SELECT recovery_status FROM"
                + " qwen_managed_session_journal_head WHERE session_id = ?",
                String.class, healthy)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_id = ? AND hook_occurrence_hash IS NOT NULL",
                Integer.class, healthy)).isEqualTo(4);
    }

    @Test
    void blocksASessionWhoseRepeatedKeySpansBackfillPages() throws Exception {
        JdbcDataSource dataSource = migrated();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String sessionId = UUID.randomUUID().toString();
        HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                TENANT, WORKSPACE, sessionId);
        history.admitUntil(600);
        // The first and last executions the backfill reads, more than a page
        // apart: the last repeats the first's occurrence ordinal.
        List<String> order = jdbc.queryForList("SELECT record_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_id = ? AND domain = 'hook_execution'"
                        + " ORDER BY record_key",
                String.class, sessionId);
        int first = Integer.parseInt(order.get(0).substring("execution-".length()));
        int last = Integer.parseInt(order.get(order.size() - 1)
                .substring("execution-".length()));
        ObjectNode repeated = history.execution(last);
        repeated.put("occurrenceId", "occurrence-" + first / 4).put("ordinal", first % 4);
        rewrite(jdbc, sessionId, order.get(order.size() - 1), repeated);
        clearProjection(jdbc);
        backfill(dataSource);

        assertThat(jdbc.queryForList("SELECT record_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_id = ? AND domain = 'hook_execution'"
                        + " AND hook_occurrence_hash IS NULL",
                String.class, sessionId)).containsExactly(order.get(order.size() - 1));
        assertThat(jdbc.queryForMap("SELECT recovery_status,"
                        + " recovery_detail_code FROM"
                        + " qwen_managed_session_journal_head WHERE session_id = ?",
                sessionId)).containsValues("BLOCKED_RESOURCE",
                "hook_admission_record_duplicate");
    }

    @Test
    void upgradesHookRecordsWrittenUnderV27() throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:hook-index-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("27")).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        LegacyHookRecords.insert(jdbc, "legacy-tenant", "legacy-session");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        LegacyHookRecords.assertBackfilled(jdbc, "legacy-tenant", "legacy-session");
    }

    private static void assertRefused(HookAdmissionHistory history, String commandId,
            ObjectNode execution, String message) {
        assertThatThrownBy(() -> history.commit(commandId, "hook_execution",
                execution, List.of())).as(commandId)
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedExtensionRecordStore.ERROR_REJECTED))
                .hasMessageContaining(message);
    }

    /** Replaces a record's committed body with a valid one, past admission. */
    private static void rewrite(JdbcTemplate jdbc, String sessionId, String recordId,
            ObjectNode record) {
        byte[] body = ExtensionRecordJournal.bytes(record);
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ?,"
                        + " byte_length = ?, sha256 = ? WHERE session_id = ? AND"
                        + " resource_id = (SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_id = ? AND record_id = ?)",
                body, body.length, ExtensionRecordJournal.sha256(body), sessionId,
                sessionId, recordId);
    }

    private static JdbcDataSource migrated() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:hook-index-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        return dataSource;
    }

    private static void clearProjection(JdbcTemplate jdbc) {
        jdbc.update("UPDATE qwen_managed_session_extension_record SET"
                + " hook_once_key_hash = NULL, hook_occurrence_hash = NULL,"
                + " hook_ordinal = NULL, hook_definition_hash = NULL");
    }

    private static void backfill(JdbcDataSource dataSource) throws Exception {
        try (Connection connection = dataSource.getConnection()) {
            new V29__managed_hook_admission_backfill().migrate(new Context() {
                @Override
                public Configuration getConfiguration() {
                    return null;
                }

                @Override
                public Connection getConnection() {
                    return connection;
                }
            });
        }
    }

    private static int revisions(JdbcTemplate jdbc, String sessionId) {
        Integer total = jdbc.queryForObject("SELECT COALESCE(SUM(revision), 0)"
                        + " FROM qwen_managed_session_extension_record"
                        + " WHERE session_id = ?", Integer.class, sessionId);
        return total == null ? 0 : total;
    }
}
