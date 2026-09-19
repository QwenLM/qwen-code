package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import java.util.concurrent.CompletableFuture;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RuntimeBrokerConfiguration {
    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public EmbeddedRuntimeBroker embeddedRuntimeBroker(
            ManagedAgentStore store, ManagedAgentProperties properties) {
        return new EmbeddedRuntimeBroker(store, properties);
    }

    @Bean
    @ConditionalOnMissingBean(RuntimeWarmer.class)
    public RuntimeWarmer runtimeWarmer() {
        return new RuntimeWarmer() {
            @Override
            public boolean isEnabled() {
                return false;
            }

            @Override
            public CompletableFuture<Void> warm(String harnessSessionId) {
                return CompletableFuture.completedFuture(null);
            }
        };
    }
}
