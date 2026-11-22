package com.alibaba.qwen.code.managedagent.persistence;
public final class PersistenceTestAccess {
    private PersistenceTestAccess() { }
    public static String descriptorRef(String tenant, String workspace) { return JdbcManagedWorkspaceRegistry.descriptorRef(tenant, workspace); }
    public static boolean blocked(org.springframework.jdbc.core.JdbcTemplate jdbc, String tenant, String session) { return ManagedConfigStore.blocked(jdbc, tenant, session); }
}
