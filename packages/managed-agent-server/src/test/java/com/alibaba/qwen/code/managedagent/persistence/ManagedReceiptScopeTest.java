package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceActor;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedReceiptScopeTest {
    @Test
    void workspaceCreationAndReplaySupportTheFullUnicodeActorLimit() {
        try (var fixture = ConsolidatedStoreFixture.open("receipt_scope")) {
            ManagedSchema.initialize(fixture.source());
            var jdbc = new ManagedSchemaJdbcTemplate(fixture.source());
            var tx = new TransactionTemplate(new DataSourceTransactionManager(fixture.source()));
            var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                    new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
            for (int size : List.of(384, 385, 512)) {
                String tenant = "tenant-" + size;
                String actor = new WorkspaceActor(tenant, "😀".repeat(size)).getActorId();
                byte[] actorBytes = actor.getBytes(StandardCharsets.UTF_8);
                jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                                + " display_name, config_ref, policy_ref, state)"
                                + " VALUES (?, 'workspace', 1, 'storage', 'workspace', 'config', 'policy', 'ACTIVE')",
                        tenant);
                jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                                + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, actorBytes);
                var admission = tx.execute(status -> store.insertWorkspaceSessionCommand(tenant, actor, "create",
                        "digest", "qwen-code", null, "title", List.of(), null,
                        new WorkspaceSelection("workspace", ".")));
                var replay = tx.execute(status -> store.insertWorkspaceSessionCommand(tenant, actor, "create",
                        "digest", "qwen-code", null, "title", List.of(), null,
                        new WorkspaceSelection("workspace", ".")));
                assertThat(replay.sessionId()).isEqualTo(admission.sessionId());
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?",
                        Integer.class, tenant)).isOne();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id = ?",
                        Integer.class, tenant)).isEqualTo(2);
                assertThat(ManagedReceipts.creation(jdbc, tenant, actorBytes, "create").sessionId())
                        .isEqualTo(admission.sessionId());
            }
        }
    }

    @Test
    void actorReceiptScopesPreserveCaseAndTrailingSpace() {
        try (var fixture = ConsolidatedStoreFixture.open("receipt_identity")) {
            ManagedSchema.initialize(fixture.source());
            var jdbc = new ManagedSchemaJdbcTemplate(fixture.source());
            for (String actor : List.of("actor", "Actor", "actor ")) {
                byte[] bytes = new WorkspaceActor("tenant", actor).getActorId().getBytes(StandardCharsets.UTF_8);
                ManagedReceipts.insertCreation(jdbc, "tenant", bytes, "same-key", "digest", actor, null, 1);
            }
            for (String actor : List.of("actor", "Actor", "actor ")) {
                assertThat(ManagedReceipts.creation(jdbc, "tenant", actor.getBytes(StandardCharsets.UTF_8), "same-key")
                        .sessionId()).isEqualTo(actor);
            }
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isEqualTo(3);
        }
    }
}
