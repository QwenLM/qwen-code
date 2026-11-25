package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

@AutoConfiguration
@ConditionalOnProperty(prefix = "qwen.managed-agent.object-storage",
        name = "enabled", havingValue = "true")
@ConditionalOnMissingBean(ToolPublicationObjectStore.class)
public class AliyunToolPublicationStorageAutoConfiguration {
    @Bean(destroyMethod = "shutdown")
    public AliyunObjectStoreClient toolPublicationOss(ManagedAgentProperties properties) throws Exception {
        return AliyunObjectStoreClient.environment(properties);
    }
    @Bean
    public ToolPublicationObjectStore toolPublicationObjects(AliyunObjectStoreClient toolPublicationOss,
            ManagedAgentProperties properties) {
        return toolPublicationOss.objects(properties.getToolPublication().getOssBucket());
    }
}
