package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

/**
 * The RR witness of the verdict/mint seam: under REPEATABLE READ the
 * committing transaction's snapshot is established by its ordinary reads
 * long before the verdict's row lock, so a lineage read must itself be a
 * locking read to see a mint committed after that snapshot. A plain read
 * misses it on actual InnoDB (R23's production topology); READ COMMITTED
 * and the H2 controls could never show the miss. The race is driven with
 * two live connections: no synthetic read the production path lacks.
 */
class ManagedExtensionRecordVerdictReconcileMySqlIT {
    private static final String TENANT = "tenant-rr";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void theVerdictSeesAMintCommittedAfterTheSnapshotOnRepeatableRead()
            throws Exception {
        DriverManagerDataSource source = new DriverManagerDataSource(
                required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", ""));
        Flyway.configure().dataSource(source)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate shared = new JdbcTemplate(source);
        String parent = UUID.randomUUID().toString();
        String runId = "run-" + UUID.randomUUID();
        try {
            shared.update("INSERT INTO managed_agent_session (tenant_id,"
                            + " session_id, agent_id, status, created_at,"
                            + " updated_at) VALUES (?, ?, 'qwen-code',"
                            + " 'ACTIVE', 1, 1)",
                    TENANT, parent);
            shared.update("INSERT INTO qwen_managed_session_extension_record"
                            + " (session_scope_key, record_key, tenant_id,"
                            + " workspace_id, session_id, domain, record_id,"
                            + " operation_hash, revision,"
                            + " record_resource_id, task_kind, task_state,"
                            + " delivery_target, delivery_state, created_at)"
                            + " VALUES (?, ?, ?, 'workspace', ?, 'child_run',"
                            + " ?, 'h', 1, 'res-x', 'child_agent', 'running',"
                            + " 'session', 'planned', 1)",
                    "scope-" + parent,
                    ManagedExtensionProjection.recordKey(parent, "child_run",
                            runId), TENANT, parent, runId);
            String childId = "child-" + UUID.randomUUID();
            try (Connection gate = source.getConnection();
                    Connection mint = source.getConnection()) {
                gate.setAutoCommit(false);
                gate.setTransactionIsolation(
                        Connection.TRANSACTION_REPEATABLE_READ);
                mint.setAutoCommit(false);
                JdbcTemplate gateJdbc = new JdbcTemplate(
                        new SingleConnectionDataSource(gate, true));
                JdbcTemplate mintJdbc = new JdbcTemplate(
                        new SingleConnectionDataSource(mint, true));
                try {
                    ManagedExtensionRecordStore records =
                            new ManagedExtensionRecordStore(gateJdbc);
                    // The production ordinary reads ahead of the commit:
                    // the transaction snapshot is established here.
                    gateJdbc.queryForObject(
                            "SELECT COUNT(*) FROM"
                                    + " qwen_managed_session_extension_record",
                            Long.class);
                    // The mint lands only after that snapshot.
                    mintJdbc.update("INSERT INTO managed_agent_session"
                                    + " (tenant_id, session_id, agent_id,"
                                    + " status, created_at, updated_at,"
                                    + " parent_session_id,"
                                    + " parent_child_run_id) VALUES (?, ?,"
                                    + " 'qwen-code', 'ACTIVE', 1, 1, ?, ?)",
                            TENANT, childId, parent, runId);
                    mint.commit();
                    assertThatThrownBy(() -> records
                            .reconcileNeverStartedVerdict(TENANT, parent,
                                    "child_run", runId, verdict(null)))
                            .isInstanceOf(ApiException.class);
                } finally {
                    gate.rollback();
                    mint.rollback();
                }
            }
        } finally {
            shared.update("DELETE FROM managed_agent_session"
                            + " WHERE tenant_id = ? AND session_id = ?",
                    TENANT, parent);
            shared.update("DELETE FROM managed_agent_session"
                            + " WHERE tenant_id = ? AND parent_session_id = ?"
                            + " AND parent_child_run_id = ?",
                    TENANT, parent, runId);
            shared.update("DELETE FROM qwen_managed_session_extension_record"
                            + " WHERE tenant_id = ? AND session_id = ?"
                            + " AND domain = 'child_run' AND record_id = ?",
                    TENANT, parent, runId);
        }
    }

    private static JsonNode verdict(String namedId) {
        var record = JSON.createObjectNode();
        record.put("kind", "child_agent");
        if (namedId != null) {
            record.put("childSessionId", namedId);
        }
        record.putObject("run").put("state", "failed")
                .put("execution", "not_started_proven");
        return record;
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
