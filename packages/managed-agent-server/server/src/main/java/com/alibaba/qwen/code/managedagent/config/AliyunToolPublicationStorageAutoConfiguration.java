package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

@AutoConfiguration
@ConditionalOnProperty(prefix = "qwen.managed-agent.tool-publication",
        name = "enabled", havingValue = "true")
@ConditionalOnBean(ToolPublicationConfiguration.class)
@ConditionalOnMissingBean(ToolPublicationObjectStore.class)
public class AliyunToolPublicationStorageAutoConfiguration {
    @Bean(destroyMethod = "close")
    public com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore legacyPublicationObjectStore(ManagedAgentProperties properties) {
        var settings = properties.getToolPublication();
        return new com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStores().create("aliyun-oss",
                java.util.Map.of("endpoint", required(settings.getOssEndpoint(), "endpoint"),
                        "region", required(settings.getOssRegion(), "region"), "bucket", required(settings.getOssBucket(), "bucket")));
    }

    @Bean
    public ToolPublicationObjectStore toolPublicationObjects(com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore store) {
        return new com.alibaba.qwen.code.managedagent.contracts.storage.ToolPublicationObjectStoreAdapter(store, true);
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("OSS " + name + " is required");
        }
        return value;
    }
}
