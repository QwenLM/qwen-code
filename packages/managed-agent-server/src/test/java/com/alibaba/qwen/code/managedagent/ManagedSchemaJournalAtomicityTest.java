package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSchemaJournalAtomicityTest {
    private FaultJdbc jdbc;
    private TransactionTemplate transactions;
    private ExtensionRecordJournal journal;
    private AutomationLedgerStore automationLedger;
    private final String tenant = "atomic-tenant";
    private final String session = "atomic-session";

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:atomic32-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new FaultJdbc(source);
        automationLedger = new AutomationLedgerStore(jdbc);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        journal =
                new ExtensionRecordJournal(
                        new ManagedSessionStore(jdbc), tenant, "workspace", session);
        transactions.executeWithoutResult(status -> journal.open());
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "INSERT INTO ma_resource ",
                "INSERT INTO ma_resource_ref ",
                "INSERT INTO ma_session_record ",
                "INSERT INTO ma_session_journal_tx ",
                "UPDATE ma_session_head SET journal_revision"
            })
    void failureAfterEveryPersistenceBoundaryLeavesOnlyTheCompletePrefix(String boundary)
            throws Exception {
        var revision =
                ManagedExtensionProjectionContractTest.fixtures()
                        .required("monitorChainCases")
                        .get(0)
                        .required("revisions")
                        .get(0);
        var request =
                journal.request(
                        "atomic-command",
                        revision.required("monitorRun"),
                        revision.required("occurredAt").longValue());
        jdbc.boundary = boundary;
        assertThatThrownBy(
                        () -> transactions.executeWithoutResult(status -> journal.commit(request)))
                .isInstanceOf(SimulatedCrash.class);
        assertThat(jdbc.injected).isTrue();
        for (String table : new String[] {"ma_resource", "ma_resource_ref", "ma_session_record"}) {
            assertThat(
                            jdbc.queryForObject(
                                    "SELECT COUNT(*) FROM "
                                            + table
                                            + " WHERE tenant_id = ? AND session_id = ?",
                                    Integer.class,
                                    tenant,
                                    session))
                    .as(table)
                    .isZero();
        }
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ? AND"
                                    + " session_id = ?",
                                Integer.class,
                                tenant,
                                session))
                .isEqualTo(1);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT journal_revision FROM ma_session_head WHERE tenant_id = ?"
                                    + " AND session_id = ?",
                                Long.class,
                                tenant,
                                session))
                .isEqualTo(1);
        jdbc.boundary = null;
        var committed = transactions.execute(status -> journal.commit(request));
        assertThat(committed.journalRevision()).isEqualTo(2);
        assertThat(transactions.execute(status -> journal.commit(request)).replayed()).isTrue();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ? AND"
                                    + " session_id = ?",
                                Integer.class,
                                tenant,
                                session))
                .isEqualTo(2);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session_record WHERE tenant_id = ? AND"
                                    + " session_id = ?",
                                Integer.class,
                                tenant,
                                session))
                .isPositive();
    }

    @Test
    void scheduleProjectionRollsBackWithJournalResourcesAndHead() throws Exception {
        ObjectNode schedule = ((ObjectNode) ManagedAutomationRecordContractTest
                .fixtures().get("templates").get("schedule")).deepCopy();
        schedule.put("scheduleId", "schedule-" + session);
        schedule.put("targetSessionId", session);
        CommitResource prompt = hookResource("schedule-prompt", "managed-automation-prompt",
                "Run it.".getBytes(StandardCharsets.UTF_8));
        schedule.set("promptRef", hookRef(prompt));
        var request = journal.requestDomain("schedule-open", "schedule", schedule,
                List.of(prompt), 1_000);
        assertThatThrownBy(() -> transactions
                .executeWithoutResult(status -> {
                    journal.commit(request);
                    assertThat(automationLedger.findSchedule(tenant, schedule.get("scheduleId").asText()))
                            .isPresent();
                    throw new IllegalStateException("crash before journal transaction commit");
                })).isInstanceOf(IllegalStateException.class);
        assertThat(automationLedger.findSchedule(tenant, schedule.get("scheduleId").asText())).isEmpty();
        for (String table : List.of("ma_resource", "ma_resource_ref", "ma_session_record")) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table
                    + " WHERE tenant_id = ? AND session_id = ?", Integer.class, tenant, session))
                    .as(table).isZero();
        }
        assertThat(jdbc.queryForObject("SELECT journal_revision FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ?", Integer.class, tenant, session)).isEqualTo(1);
        transactions.executeWithoutResult(status -> journal.commit(request));
        journal.committed(request);
        var projected = automationLedger.findSchedule(tenant, schedule.get("scheduleId").asText()).orElseThrow();
        assertThat(projected.recordRevision()).isEqualTo(1);
        assertThat(projected.goal()).isEqualTo(schedule.get("goal").asText());
        assertThat(projected.armedAt()).isGreaterThan(1_000);
        assertThat(transactions.execute(status -> journal.commit(request)).replayed()).isTrue();
        assertThat(automationLedger.findSchedule(tenant, projected.scheduleId()).orElseThrow()).isEqualTo(projected);
    }

    @Test
    void definitionCommitKeepsScannerOwnershipAndRearmsOnlyWhenEnabled() throws Exception {
        ObjectNode schedule = ((ObjectNode) ManagedAutomationRecordContractTest
                .fixtures().get("templates").get("schedule")).deepCopy();
        String id = "schedule-" + session;
        schedule.put("scheduleId", id).put("targetSessionId", session).put("enabled", true);
        CommitResource prompt = hookResource("schedule-prompt", "managed-automation-prompt",
                "Run it.".getBytes(StandardCharsets.UTF_8));
        schedule.set("promptRef", hookRef(prompt));
        commitSchedule("schedule-open", "schedule", schedule, List.of(prompt));
        jdbc.update("UPDATE ma_schedule SET armed_at = 10 WHERE tenant_id = ? AND schedule_id = ?", tenant, id);
        long fence = automationLedger.claim(tenant, id, "scanner", Long.MAX_VALUE, 20);
        automationLedger.advanceWatermark(tenant, id, "scanner", fence, 77, 20);
        ObjectNode disabled = schedule.deepCopy().put("enabled", false)
                .put("definitionRevision", 2).put("definitionDigest", "b".repeat(64));
        commitSchedule("schedule-disable", "schedule", disabled, List.of());
        assertThat(automationLedger.findSchedule(tenant, id).orElseThrow().armedAt()).isEqualTo(10);
        ObjectNode enabled = disabled.deepCopy().put("enabled", true)
                .put("definitionRevision", 3).put("definitionDigest", "c".repeat(64));
        commitSchedule("schedule-enable", "schedule", enabled, List.of());
        var row = automationLedger.findSchedule(tenant, id).orElseThrow();
        assertThat(row.armedAt()).isGreaterThan(10);
        assertThat(row.recordRevision()).isEqualTo(3);
        assertThat(row.leaseOwner()).isEqualTo("scanner");
        assertThat(row.leaseUntil()).isEqualTo(Long.MAX_VALUE);
        assertThat(row.fence()).isEqualTo(fence);
        assertThat(row.watermarkSlot()).isEqualTo(77);
    }

    @ParameterizedTest
    @ValueSource(strings = {"INSERT INTO ma_schedule ", "INSERT INTO ma_session_journal_tx ",
            "UPDATE ma_session_head SET journal_revision"})
    void failureAfterScheduleProjectionRollsBackTheDefinition(String boundary) throws Exception {
        ObjectNode schedule = schedule();
        CommitResource prompt = prompt();
        schedule.set("promptRef", hookRef(prompt));
        var request = journal.requestDomain("schedule-open", "schedule", schedule, List.of(prompt), 1_000);
        jdbc.boundary = boundary;
        assertThatThrownBy(() -> transactions.executeWithoutResult(status -> journal.commit(request)))
                .isInstanceOf(SimulatedCrash.class);
        assertThat(jdbc.injected).isTrue();
        assertThat(automationLedger.findSchedule(tenant, schedule.get("scheduleId").asText())).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT journal_revision FROM ma_session_head", Long.class)).isEqualTo(1);
        jdbc.boundary = null;
        transactions.executeWithoutResult(status -> journal.commit(request));
        assertThat(automationLedger.findSchedule(tenant, schedule.get("scheduleId").asText()))
                .isPresent();
    }

    @Test
    void scheduleProjectionPreservesPrivateDefinitionSizeContract() throws Exception {
        ObjectNode schedule = schedule();
        String cron = "0,".repeat(2042) + "0000 * * * *";
        String timezone = "A".repeat(64) + "/" + "B".repeat(64) + "/" + "C".repeat(64);
        assertThat(cron.length()).isEqualTo(4096);
        assertThat(timezone.length()).isEqualTo(194);
        schedule.put("cron", cron).put("timezone", timezone).put("goal", "g".repeat(4096));
        CommitResource prompt = prompt();
        schedule.set("promptRef", hookRef(prompt));
        commitSchedule("long-schedule", "schedule", schedule, List.of(prompt));
        var row = automationLedger.findSchedule(tenant, schedule.get("scheduleId").asText()).orElseThrow();
        assertThat(row.cron()).isEqualTo(cron);
        assertThat(row.timezone()).isEqualTo(timezone);
        assertThat(row.goal()).hasSize(4096);
    }

    private ObjectNode schedule() throws Exception {
        return ((ObjectNode) ManagedAutomationRecordContractTest.fixtures()
                .get("templates").get("schedule")).deepCopy()
                .put("scheduleId", "schedule-" + session).put("targetSessionId", session);
    }

    private CommitResource prompt() {
        return hookResource("schedule-prompt", "managed-automation-prompt",
                "Run it.".getBytes(StandardCharsets.UTF_8));
    }

    private void commitSchedule(String commandId, String domain, ObjectNode schedule,
            List<CommitResource> resources) {
        var request = journal.requestDomain(commandId, domain, schedule, resources, 1_000);
        transactions.executeWithoutResult(status -> journal.commit(request));
        journal.committed(request);
    }

    private static CommitResource hookResource(String id, String kind, byte[] bytes) {
        return new CommitResource(id, kind, 1, bytes.length, ExtensionRecordJournal.sha256(bytes),
                Base64.getEncoder().encodeToString(bytes));
    }

    private static ObjectNode hookRef(CommitResource resource) {
        return JsonNodeFactory.instance.objectNode().put("resourceId", resource.resourceId())
                .put("kind", resource.kind()).put("schemaVersion", resource.schemaVersion())
                .put("byteLength", resource.byteLength()).put("digest", resource.digest());
    }

    private static final class SimulatedCrash extends RuntimeException {}

    private static final class FaultJdbc extends ManagedSchemaJdbcTemplate {
        private String boundary;
        private boolean injected;

        FaultJdbc(DataSource source) {
            super(source);
        }

        @Override
        public int update(String sql, Object... arguments) {
            int changed = super.update(sql, arguments);
            if (boundary != null && sql.replaceAll("\\s+", " ").startsWith(boundary)) {
                injected = true;
                throw new SimulatedCrash();
            }
            return changed;
        }
    }
}
