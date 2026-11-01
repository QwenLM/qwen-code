package com.alibaba.qwen.code.managedagent.persistence;
public final class PersistenceTestAccess {
    private PersistenceTestAccess() { }
    public static String descriptorRef(String tenant, String workspace) { return ManagedWorkspaceRegistry.descriptorRef(tenant, workspace); }
    public static com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest requireCsiRequest(ManagedAgentStore store, com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration registration, String key) { return store.requireCsiRequest(registration, key); }
    public static boolean blocked(org.springframework.jdbc.core.JdbcTemplate jdbc, String tenant, String session) { return ManagedConfigStore.blocked(jdbc, tenant, session); }
}
