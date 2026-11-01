package com.alibaba.qwen.code.managedagent.config.runtime;
public final class EmbeddedBrokerFixture {
    private EmbeddedBrokerFixture() { }
    public static EmbeddedRuntimeBroker create(com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore store,
            com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties properties,
            com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository bindings,
            com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository sessions,
            com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository executions,
            com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore workspaces,
            com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore publications,
            com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore data,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager,
            com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner provisioner) {
        return new EmbeddedRuntimeBroker(store, properties, bindings, sessions, executions, workspaces, publications, data, jdbc, manager, provisioner);
    }
}
