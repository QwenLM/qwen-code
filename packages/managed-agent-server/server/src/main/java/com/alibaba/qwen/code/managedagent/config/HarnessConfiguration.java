package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.harness.HarnessDiscovery;
import com.alibaba.qwen.code.managedagent.harness.HarnessPoolConnector;
import com.alibaba.qwen.code.managedagent.harness.KubernetesHarnessDiscovery;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
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
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.net.URI;
import java.util.HashSet;

@Configuration
public class HarnessConfiguration {
    @Bean
    public com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules managedHarnessRules() {
        return new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules();
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
            JdbcManagedExtensionRecordStore extensionRecords) {
        BrokerSecurity.checkHarnessTransport(properties, new java.util.ArrayList<>());
        var pool = properties.getHarness().getPool();
        if (pool.isEnabled()) {
            if ("kubernetes-workspace".equals(properties.getRuntimeBroker().getProvisioner())) {
                throw new IllegalStateException("Harness pool does not admit CSI resident Runtime ownership");
            }
            HarnessDiscovery discovery;
            if ("kubernetes".equals(pool.getDiscovery())) {
                if (!pool.getInstances().isEmpty()) {
                    throw new IllegalStateException("Kubernetes Harness discovery cannot combine with static instances");
                }
                discovery = new KubernetesHarnessDiscovery(pool, json);
            } else if ("static".equals(pool.getDiscovery())) {
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
                throw new IllegalStateException("Harness pool discovery must be static or kubernetes");
            }
            try {
                return new com.alibaba.qwen.code.managedagent.harness.SdkHarnessBoundary(new HarnessPoolConnector(properties, placements, discovery,
                        endpoint -> {
                            var connector = new QwenHostedHarnessConnector(properties, sessions, workspaceExecution,
                                    actions, definitions, resources, ssh);
                            connector.configureExtensionResources(extensionRecords, json);
                            return connector;
                        }, skills));
            } catch (RuntimeException error) {
                discovery.close();
                throw error;
            }
        }
        var connector = new QwenHostedHarnessConnector(properties, sessions, workspaceExecution, actions, definitions, resources, ssh);
        connector.configureSessionSkills(skills);
        connector.configureExtensionResources(extensionRecords, json);
        return new com.alibaba.qwen.code.managedagent.harness.SdkHarnessBoundary(connector);
    }

    @Bean
    @ConditionalOnMissingBean(HarnessConnector.class)
    public HarnessConnector unavailableHarnessConnector() {
        return new UnavailableHarnessConnector();
    }
}
