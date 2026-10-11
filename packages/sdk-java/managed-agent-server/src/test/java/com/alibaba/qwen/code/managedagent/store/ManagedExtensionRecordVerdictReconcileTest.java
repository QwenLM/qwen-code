package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The never-started verdict's mint arbitration: a terminal revision
 * proving nothing ever started must name exactly the Session the
 * lineage mints — unnamed orphans the mint (the R21 inverse race),
 * mismatched forges one — and null exactly when no lineage exists.
 * The decision table runs here; the FOR UPDATE serialization it rides
 * binds inside the production commit transaction, whose mint side the
 * creation-fence suite already pins.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:verdict-reconcile;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedExtensionRecordVerdictReconcileTest {
    private static final String TENANT = "tenant-verdict";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private ManagedExtensionRecordStore records;

    @Autowired
    private JdbcTemplate jdbc;

    private String plantRunRow() {
        String sessionId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, created_at)"
                        + " VALUES (?, ?, ?, 'workspace', ?, 'child_run',"
                        + " 'run-1', 'h', 1, 'res-x', 'child_agent',"
                        + " 'running', 'session', 'planned', 1)",
                "scope-" + sessionId,
                ManagedExtensionProjection.recordKey(sessionId, "child_run",
                        "run-1"), TENANT, sessionId);
        return sessionId;
    }

    private void plantLineage(String sessionId, String childId) {
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at, parent_session_id,"
                        + " parent_child_run_id) VALUES (?, ?, 'qwen-code',"
                        + " 'ACTIVE', 1, 1, ?, 'run-1')",
                TENANT, childId, sessionId);
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

    @Test
    void aMintedLineageVerdictNamesItsSession() {
        String parent = plantRunRow();
        plantLineage(parent, "child-named");
        assertThatCode(() -> records.reconcileNeverStartedVerdict(TENANT,
                parent, "child_run", "run-1", verdict("child-named")))
                .doesNotThrowAnyException();
    }

    @Test
    void aMintedLineageVerdictUnnamedIsRefused() {
        String parent = plantRunRow();
        plantLineage(parent, "child-unnamed");
        assertThatThrownBy(() -> records.reconcileNeverStartedVerdict(
                TENANT, parent, "child_run", "run-1", verdict(null)))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    // The wire code the Hosted writer classifies as a
                    // rollbackable non-commit (R24) — never the generic
                    // record rejection that latches write failures.
                    org.assertj.core.api.Assertions.assertThat(error
                            .getCode()).isEqualTo("child_run_lineage_minted");
                    org.assertj.core.api.Assertions.assertThat(error
                            .getMessage()).contains("does not name the"
                                    + " Session its creation minted");
                });
    }

    @Test
    void aMintedLineageVerdictMisnamedIsRefused() {
        String parent = plantRunRow();
        plantLineage(parent, "child-mis");
        assertThatThrownBy(() -> records.reconcileNeverStartedVerdict(
                TENANT, parent, "child_run", "run-1", verdict("child-other")))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> org.assertj.core.api.Assertions
                                .assertThat(error.getCode()).isEqualTo(
                                        "child_run_lineage_minted"));
    }

    @Test
    void aNeverMintedVerdictStaysUnnamed() {
        String parent = plantRunRow();
        assertThatCode(() -> records.reconcileNeverStartedVerdict(TENANT,
                parent, "child_run", "run-1", verdict(null)))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> records.reconcileNeverStartedVerdict(
                TENANT, parent, "child_run", "run-1", verdict("child-ghost")))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> org.assertj.core.api.Assertions
                                .assertThat(error.getCode()).isEqualTo(
                                        "child_run_lineage_minted"));
    }
}
