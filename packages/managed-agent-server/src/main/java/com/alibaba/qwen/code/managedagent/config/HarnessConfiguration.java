package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

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
            ManagedActionStore actions, ManagedAgentDefinitionStore definitions,
            ManagedSessionStore resources, SshWorkspaceStore ssh) {
        return new QwenHostedHarnessConnector(properties, sessions, workspaceExecution, actions, definitions, resources, ssh);
    }

    @Bean
    @ConditionalOnMissingBean(HarnessConnector.class)
    public HarnessConnector unavailableHarnessConnector() {
        return new UnavailableHarnessConnector();
    }
}
