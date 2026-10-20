package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

@Configuration
public class ManagedSessionJsonConfiguration implements WebMvcConfigurer {
    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jackson) {
                ObjectMapper commits = jackson.getObjectMapper().copy();
                commits.getFactory().setStreamReadConstraints(commits.getFactory().streamReadConstraints()
                        .rebuild().maxStringLength(ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BASE64_CHARS).build());
                jackson.registerObjectMappersForType(CommitTransactionRequest.class,
                        mappings -> jackson.getSupportedMediaTypes().forEach(type -> mappings.put(type, commits)));
            }
        }
    }
}
