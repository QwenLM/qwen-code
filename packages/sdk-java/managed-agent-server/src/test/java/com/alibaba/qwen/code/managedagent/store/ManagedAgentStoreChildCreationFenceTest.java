package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The child-creation fence at {@link ManagedAgentStore#insertChildSessionCommand}:
 * a child run whose record already terminal-settled owes no Session — the
 * relay's give-up can commit that verdict and retire the ledger while a
 * lease-losing creator is still about to mint. The same entry mints on a
 * live run and on no record row at all, and the replay of a minted
 * admission always answers.
 */
class ManagedAgentStoreChildCreationFenceTest {

    private JdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private ManagedAgentStore store;
    private String parent;

    @BeforeEach
    void setUp() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:creation-fence-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source)
                .locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc), properties);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES ('tenant', 'workspace', 1, 'storage',"
                        + " 'Workspace', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES ('tenant', 'workspace', ?, TRUE, TRUE)",
                "owner".getBytes(StandardCharsets.UTF_8));
        transactions = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        parent = transactions.execute(ignored -> store
                .insertWorkspaceSessionCommand("tenant", "owner", "create",
                        "digest", "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("workspace", "."))
                .sessionId());
    }

    private void plantRun(String childRunId, String deliveryState,
            String taskState) {
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, created_at)"
                        + " VALUES ('scope-x', ?, 'tenant', 'workspace', ?,"
                        + " 'child_run', ?, 'h', 1, ?, 'child_agent', ?,"
                        + " 'session', ?, 1)",
                childRunId + "-key", parent, childRunId,
                "resource-" + childRunId, taskState, deliveryState);
    }

    private StoreModels.Admission mint(String childRunId) {
        return transactions.execute(ignored -> store
                .insertChildSessionCommand("tenant", parent, "create-" + childRunId,
                        "digest-" + childRunId, "audit", List.of(), null,
                        new StoreModels.SessionLineage(parent, parent,
                                childRunId, 1)));
    }

    @Test
    void refusesToMintAfterTheTerminalVerdictLanded() {
        plantRun("run-settled", "cancelled", "failed");
        assertThatThrownBy(() -> mint("run-settled"))
                .isInstanceOf(ApiException.class)
                .extracting(error -> ((ApiException) error).getCode())
                .isEqualTo("child_run_settled");
        // And no Session row was minted for it: the fence rolls the
        // whole transaction back, never a half-created child.
        assertThat(jdbc.query("SELECT session_id FROM managed_agent_session"
                        + " WHERE tenant_id = 'tenant' AND parent_child_run_id = 'run-settled'",
                (result, row) -> result.getString(1))).isEmpty();
    }

    @Test
    void mintsOnALiveRunAndAnswersItsReplay() {
        plantRun("run-live", "planned", "pending");
        StoreModels.Admission admission = mint("run-live");
        assertThat(admission.sessionId()).isNotBlank();
        assertThat(transactions.execute(ignored -> store
                .replayChildSessionCommand("tenant", parent, "create-run-live",
                        "digest-run-live")).sessionId())
                .isEqualTo(admission.sessionId());
    }

    @Test
    void mintsWhenNoRunRowExistsYet() {
        assertThat(mint("run-fresh").sessionId()).isNotBlank();
    }
}
