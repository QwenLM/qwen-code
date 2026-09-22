package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.SecretProtector;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import java.util.concurrent.CompletableFuture;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RuntimeBrokerConfiguration {
    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public SecretProtector runtimeCredentialProtector(
            ManagedAgentProperties properties) {
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        require(broker.getCredentialKeyId(),
                "Runtime Broker credential key ID");
        require(broker.getCredentialKey(),
                "Runtime Broker credential key");
        return AesGcmSecretProtector.fromBase64(
                broker.getCredentialKeyId(), broker.getCredentialKey());
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public RuntimeBindingRepository runtimeBindingRepository(
            DataSource dataSource, SecretProtector secretProtector) {
        return new JdbcRuntimeBindingRepository(dataSource, secretProtector);
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public RuntimeSessionRepository runtimeSessionRepository(
            DataSource dataSource) {
        return new JdbcRuntimeSessionRepository(dataSource);
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public ToolExecutionRepository toolExecutionRepository(
            DataSource dataSource) {
        return new JdbcToolExecutionRepository(dataSource);
    }

    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public EmbeddedRuntimeBroker embeddedRuntimeBroker(
            AgentStateStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository) {
        return new EmbeddedRuntimeBroker(store, properties,
                bindingRepository, sessionRepository, executionRepository);
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
            public CompletableFuture<Void> warm(String sessionId) {
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public CompletableFuture<Void> drain(String sessionId) {
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public void resume(String sessionId) {
            }
        };
    }

    private static void require(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
    }
}
