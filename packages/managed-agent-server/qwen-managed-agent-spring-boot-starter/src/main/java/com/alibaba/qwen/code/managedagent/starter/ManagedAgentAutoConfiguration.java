package com.alibaba.qwen.code.managedagent.starter;

import com.alibaba.qwen.code.managedagent.config.EmbeddedManagedAgentBootstrap;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import org.springframework.beans.factory.FactoryBean;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.ConfigurableEnvironment;

@AutoConfiguration
@ConditionalOnProperty(prefix = "qwen.managed-agent", name = "enabled", havingValue = "true")
@ConditionalOnMissingBean(ManagedAgentService.class)
public class ManagedAgentAutoConfiguration {
    @Bean(destroyMethod = "close")
    EmbeddedManagedAgentBootstrap embeddedManagedAgentBootstrap(
            ApplicationContext applicationContext, ConfigurableEnvironment environment) {
        return new EmbeddedManagedAgentBootstrap(applicationContext, environment);
    }

    @Bean(name = "managedAgentService", destroyMethod = "")
    FactoryBean<ManagedAgentService> managedAgentService(EmbeddedManagedAgentBootstrap bootstrap) {
        return bootstrap.bridge(ManagedAgentService.class);
    }

    @Bean(name = "managedDefinitionPreparationService", destroyMethod = "")
    FactoryBean<ManagedAgentDefinitionPreparation> managedDefinitionPreparationService(EmbeddedManagedAgentBootstrap bootstrap) {
        return bootstrap.bridge(ManagedAgentDefinitionPreparation.class);
    }

    @Bean(name = "managedAgentBootstrapPreparationService", destroyMethod = "")
    FactoryBean<ManagedAgentBootstrapPreparation> managedAgentBootstrapPreparationService(EmbeddedManagedAgentBootstrap bootstrap) {
        return bootstrap.bridge(ManagedAgentBootstrapPreparation.class);
    }
}
