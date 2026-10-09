package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** H2/API construction fixture; its original Session is made by the private CREATE producer. */
public final class WorkspaceCsiRuntimeConstructionFixture {
    private WorkspaceCsiRuntimeConstructionFixture() {
    }

    public static RuntimeProvisionRequest create(DataSource source, WorkspaceCsiRegistration registration) {
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var json = new ObjectMapper();
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 1, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("construction-fixture/1");
        var created = WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null,
                        new WorkspaceSelection("workspace", ".")));
        var managed = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> { },
                new ManagedWorkspaceRegistry(jdbc), properties);
        return new TransactionTemplate(manager).execute(status -> managed.requireCsiRequest(registration, created.sessionId()));
    }
}
