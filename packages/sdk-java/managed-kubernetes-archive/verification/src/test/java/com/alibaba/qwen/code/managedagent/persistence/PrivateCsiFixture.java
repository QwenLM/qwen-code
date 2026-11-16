package com.alibaba.qwen.code.managedagent.persistence;
public final class PrivateCsiFixture {
    private PrivateCsiFixture() { }
    public static com.alibaba.qwen.code.managedagent.contracts.workspace.PrivateCsiSession.Created create(
            org.springframework.jdbc.core.JdbcTemplate jdbc, org.springframework.transaction.PlatformTransactionManager manager,
            com.fasterxml.jackson.databind.ObjectMapper json, com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings settings,
            com.alibaba.qwen.code.managedagent.contracts.workspace.PrivateCsiSession.Request request) {
        return WorkspaceCsiSessionCommands.create(jdbc, manager, json, settings, request, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
    }
}
