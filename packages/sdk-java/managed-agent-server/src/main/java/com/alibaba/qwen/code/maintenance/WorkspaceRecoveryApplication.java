package com.alibaba.qwen.code.maintenance;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/** Separate Boot configuration so maintenance cannot component-scan the service. */
@SpringBootConfiguration
@EnableAutoConfiguration(exclude = FlywayAutoConfiguration.class)
@EnableConfigurationProperties(ManagedAgentProperties.class)
public class WorkspaceRecoveryApplication {
}
