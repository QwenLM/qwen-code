package com.alibaba.qwen.code.managedagent.starter;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentConfiguration;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Import;

@AutoConfiguration
@Import(ManagedAgentConfiguration.class)
@ConditionalOnProperty(prefix = "qwen.managed-agent", name = "enabled", havingValue = "true")
public class ManagedAgentAutoConfiguration {
}
