package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;

@Configuration
public class HarnessConfiguration {
    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(
            prefix = "qwen.managed-agent.harness",
            name = "enabled",
            havingValue = "true")
    public HarnessConnector hostedHarnessConnector(
            ManagedAgentProperties properties,
            AgentStateStore sessions,
            WorkspaceExecutionStore workspaceExecution,
            ManagedActionStore actions) {
        return new QwenHostedHarnessConnector(properties, sessions, workspaceExecution, actions);
    }

    @Bean
    @ConditionalOnMissingBean(HarnessConnector.class)
    public HarnessConnector unavailableHarnessConnector() {
        return new UnavailableHarnessConnector();
    }
}
