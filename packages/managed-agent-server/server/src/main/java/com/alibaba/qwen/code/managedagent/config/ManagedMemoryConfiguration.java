package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.adapter.memory.HoloMemoryProvider;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryProvider;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class ManagedMemoryConfiguration {
    @Bean
    MemoryProvider managedMemoryProvider(ManagedAgentProperties properties,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        var memory = properties.getMemory();
        if (!memory.isEnabled()) {
            return (namespace, query) -> Result.status("unavailable");
        }
        if (!properties.getSessionStore().isEnabled() || memory.getEndpoint() == null) {
            throw new IllegalArgumentException("Personal memory requires Session Store and a Holo endpoint.");
        }
        return new HoloMemoryProvider(memory.getEndpoint(), memory.getApiKey(), json);
    }
}
