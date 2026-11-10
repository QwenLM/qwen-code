package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStores;
import com.alibaba.qwen.code.managedagent.contracts.storage.ToolPublicationObjectStoreAdapter;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "qwen.managed-agent.object-store", name = "provider")
public class ImmutableObjectStorageConfiguration {
    @Bean(destroyMethod = "close")
    @ConditionalOnMissingBean(ImmutableObjectStore.class)
    public ImmutableObjectStore immutableObjectStore(ManagedAgentProperties properties) {
        var settings = properties.getObjectStore();
        if (settings.getDeletionGrace() == null || settings.getDeletionGrace().isNegative()) {
            throw new IllegalArgumentException("Object deletion grace must be nonnegative");
        }
        return new ImmutableObjectStores().create(settings.getProvider(), settings.getProviderOptions());
    }

    @Bean
    @ConditionalOnMissingBean(ToolPublicationObjectStore.class)
    public ToolPublicationObjectStore immutableToolPublicationObjects(ImmutableObjectStore store) {
        return new ToolPublicationObjectStoreAdapter(store);
    }
}
