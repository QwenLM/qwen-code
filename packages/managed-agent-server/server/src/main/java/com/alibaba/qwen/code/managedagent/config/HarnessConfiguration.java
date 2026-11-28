package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.harness.HarnessDiscovery;
import com.alibaba.qwen.code.managedagent.harness.HarnessPoolConnector;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessBoundary;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.persistence.JdbcHarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedActionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcSshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashSet;

@Configuration
public class HarnessConfiguration {
    @Bean
    public HarnessRules managedHarnessRules() {
        return new SdkHarnessRules();
    }

    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(
            prefix = "qwen.managed-agent.harness",
            name = "enabled",
            havingValue = "true")
    public HarnessConnector hostedHarnessConnector(
            ManagedAgentProperties properties,
            AgentStateStore sessions,
            JdbcWorkspaceExecutionStore workspaceExecution,
            JdbcManagedActionStore actions, JdbcManagedAgentDefinitionStore definitions,
            JdbcManagedSessionStore resources, JdbcSshWorkspaceStore ssh, JdbcHarnessPlacementStore placements,
            JdbcManagedSessionSkills skills, @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            JdbcManagedExtensionRecordStore extensionRecords,
            @Value("${qwen.managed-agent.harness-pull.enabled:false}") boolean workPull) {
        BrokerSecurity.checkHarnessTransport(properties, new ArrayList<>());
        var pool = properties.getHarness().getPool();
        if (workPull && !pool.isEnabled()) {
            throw new IllegalStateException(
                    "qwen.managed-agent.harness-pull.enabled requires qwen.managed-agent.harness.pool.enabled");
        }
        if (pool.isEnabled()) {
            HarnessDiscovery discovery;
            if ("static".equals(pool.getDiscovery())) {
                if (pool.getInstances().isEmpty() || pool.getInstances().size() > 256) {
                    throw new IllegalStateException("Static Harness pool requires 1..256 instances");
                }
                var identities = new HashSet<String>();
                var endpoints = pool.getInstances().stream().map(instance -> {
                    if (!identities.add(instance.getInstanceId())) {
                        throw new IllegalStateException("Duplicate Harness instance identity");
                    }
                    return new HarnessDiscovery.Endpoint(instance.getInstanceId(), URI.create(instance.getBaseUrl()), true);
                }).toList();
                discovery = () -> new HarnessDiscovery.Snapshot(endpoints, true);
            } else {
                throw new IllegalStateException("Harness pool discovery must be static");
            }
            try {
                var pooled = new HarnessPoolConnector(properties, placements, discovery,
                        endpoint -> {
                            var connector = new QwenHostedHarnessConnector(properties, sessions, workspaceExecution,
                                    actions, definitions, resources, ssh);
                            connector.configureExtensionResources(extensionRecords, json);
                            return connector;
                        }, skills);
                if (workPull) {
                    pooled.enableWorkPull();
                }
                return new SdkHarnessBoundary(pooled);
            } catch (RuntimeException error) {
                discovery.close();
                throw error;
            }
        }
        var connector = new QwenHostedHarnessConnector(properties, sessions, workspaceExecution, actions, definitions, resources, ssh);
        connector.configureSessionSkills(skills);
        connector.configureExtensionResources(extensionRecords, json);
        return new SdkHarnessBoundary(connector);
    }

    @Bean
    @ConditionalOnMissingBean(HarnessConnector.class)
    public HarnessConnector unavailableHarnessConnector() {
        return new UnavailableHarnessConnector();
    }
}
