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
    private final ObjectMapper protocol;

    public ManagedSessionJsonConfiguration(
            @org.springframework.beans.factory.annotation.Qualifier("managedAgentObjectMapper") ObjectMapper protocol) {
        this.protocol = protocol;
    }

    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        ObjectMapper internal = protocol.copy();
        internal.getFactory().setStreamReadConstraints(internal.getFactory().streamReadConstraints()
                .rebuild().maxStringLength(ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BASE64_CHARS).build());
        converters.addFirst(new InternalProtocolConverter(internal));
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jackson) {
                ObjectMapper commits = protocol.copy();
                commits.getFactory().setStreamReadConstraints(commits.getFactory().streamReadConstraints()
                        .rebuild().maxStringLength(ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BASE64_CHARS).build());
                jackson.registerObjectMappersForType(CommitTransactionRequest.class,
                        mappings -> jackson.getSupportedMediaTypes().forEach(type -> mappings.put(type, commits)));
            }
        }
    }

    private static class InternalProtocolConverter extends MappingJackson2HttpMessageConverter {
        InternalProtocolConverter(ObjectMapper mapper) {
            super(mapper);
        }

        private boolean internalRequest() {
            var attributes = org.springframework.web.context.request.RequestContextHolder.getRequestAttributes();
            return attributes instanceof org.springframework.web.context.request.ServletRequestAttributes servlet
                    && com.alibaba.qwen.code.managedagent.security.PublicSurface.pathWithinApplication(servlet.getRequest())
                    .startsWith("/internal/managed-session-store/v1/");
        }

        @Override
        public boolean canRead(java.lang.reflect.Type type, Class<?> context, org.springframework.http.MediaType mediaType) {
            return internalRequest() && super.canRead(type, context, mediaType);
        }

        @Override
        public boolean canWrite(java.lang.reflect.Type type, Class<?> target, org.springframework.http.MediaType mediaType) {
            return internalRequest() && super.canWrite(type, target, mediaType);
        }

        @Override
        public boolean canRead(Class<?> target, org.springframework.http.MediaType mediaType) {
            return internalRequest() && super.canRead(target, mediaType);
        }

        @Override
        public boolean canWrite(Class<?> target, org.springframework.http.MediaType mediaType) {
            return internalRequest() && super.canWrite(target, mediaType);
        }
    }
}
