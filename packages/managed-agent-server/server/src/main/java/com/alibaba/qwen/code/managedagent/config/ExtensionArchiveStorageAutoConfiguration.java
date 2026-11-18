package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.adapters.extensions.DirectoryExtensionArchiveStorage;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchiveStorage;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

@AutoConfiguration
@ConditionalOnBean(ManagedAgentProperties.class)
public class ExtensionArchiveStorageAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean(ExtensionArchiveStorage.class)
    public ExtensionArchiveStorage extensionArchiveStorage(ManagedAgentProperties properties) {
        return new DirectoryExtensionArchiveStorage(properties);
    }
}
