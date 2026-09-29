package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class HarnessConfiguration {
    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(prefix = "qwen.managed-agent.harness",
            name = "enabled", havingValue = "true")
    public HarnessConnector hostedHarnessConnector(
            ManagedAgentProperties properties) {
        return new QwenHostedHarnessConnector(properties);
    }

    @Bean
    @ConditionalOnMissingBean(HarnessConnector.class)
    public HarnessConnector unavailableHarnessConnector() {
        return new UnavailableHarnessConnector();
    }
}
