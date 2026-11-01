package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;

/** H2/API construction fixture; its original Session is made by the private CREATE producer. */
public final class WorkspaceCsiRuntimeConstructionFixture {
    private WorkspaceCsiRuntimeConstructionFixture() {
    }

    public static RuntimeProvisionRequest create(DataSource source, WorkspaceCsiRegistration registration) {
        var jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var json = new ObjectMapper();
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 1, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update(
                "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("construction-fixture/1");
        var created = com.alibaba.qwen.code.managedagent.persistence.PrivateCsiFixture.create(jdbc, manager, json, properties,
                new com.alibaba.qwen.code.managedagent.contracts.workspace.PrivateCsiSession.Request(registration, "actor", "create", null, null,
                        new WorkspaceSelection("workspace", ".")));
        var managed = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        return new TransactionTemplate(manager).execute(status -> managed.requireCsiRequest(registration, created.sessionId()));
    }
}
