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
    @Bean(destroyMethod = "shutdown")
    public com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient toolPublicationOss(ManagedAgentProperties properties) throws Exception {
        return com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient.environment(properties);
    }
    @Bean
    public ToolPublicationObjectStore toolPublicationObjects(com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient toolPublicationOss,
            ManagedAgentProperties properties) {
        return toolPublicationOss.objects(properties.getToolPublication().getOssBucket());
    }
}
