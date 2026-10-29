package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessDiscovery;
import com.alibaba.qwen.code.managedagent.harness.HarnessPoolConnector;
import com.alibaba.qwen.code.managedagent.harness.KubernetesHarnessDiscovery;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
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
            ManagedSessionStore resources, SshWorkspaceStore ssh, HarnessPlacementStore placements,
            ManagedSessionSkills skills, @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore extensionRecords) {
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
                return new HarnessPoolConnector(properties, placements, discovery,
                        endpoint -> {
                            var connector = new QwenHostedHarnessConnector(properties, sessions, workspaceExecution,
                                    actions, definitions, resources, ssh);
                            connector.configureExtensionResources(extensionRecords, json);
                            return connector;
                        }, skills);
            } catch (RuntimeException error) {
                discovery.close();
                throw error;
            }
        }
        return new QwenHostedHarnessConnector(properties, sessions, workspaceExecution, actions, definitions, resources, ssh);
    }

    @Bean
    @ConditionalOnMissingBean(HarnessConnector.class)
    public HarnessConnector unavailableHarnessConnector() {
        return new UnavailableHarnessConnector();
    }
}
