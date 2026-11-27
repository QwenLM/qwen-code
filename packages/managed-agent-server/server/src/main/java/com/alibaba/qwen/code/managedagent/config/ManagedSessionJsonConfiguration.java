package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchCreateRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchInjectRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchRetireRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.security.PublicSurface;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.lang.reflect.Type;
import java.util.List;

@Configuration
public class ManagedSessionJsonConfiguration implements WebMvcConfigurer {
    private final ObjectMapper protocol;

    public ManagedSessionJsonConfiguration(
            @Qualifier("managedAgentObjectMapper") ObjectMapper protocol) {
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
                // The three pr-watch wire records bind integers exactly (TS
                // parity): a fractional prNumber/episode must fail body binding
                // with a 400, never truncate into the route's long fields. The
                // strictness is scoped to these records so the rest of the MVC
                // surface (public /v1/** included) keeps its default binding.
                ObjectMapper strictInts = jackson.getObjectMapper().copy()
                        .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
                for (Class<?> record : new Class<?>[] {PrWatchCreateRequest.class,
                        PrWatchInjectRequest.class, PrWatchRetireRequest.class}) {
                    jackson.registerObjectMappersForType(record,
                            mappings -> jackson.getSupportedMediaTypes().forEach(type -> mappings.put(type, strictInts)));
                }
            }
        }
    }

    private static class InternalProtocolConverter extends MappingJackson2HttpMessageConverter {
        InternalProtocolConverter(ObjectMapper mapper) {
            super(mapper);
        }

        private boolean internalRequest() {
            var attributes = RequestContextHolder.getRequestAttributes();
            return attributes instanceof ServletRequestAttributes servlet
                    && PublicSurface.pathWithinApplication(servlet.getRequest())
                    .startsWith("/internal/managed-session-store/v1/");
        }

        @Override
        public boolean canRead(Type type, Class<?> context, MediaType mediaType) {
            return internalRequest() && super.canRead(type, context, mediaType);
        }

        @Override
        public boolean canWrite(Type type, Class<?> target, MediaType mediaType) {
            return internalRequest() && super.canWrite(type, target, mediaType);
        }

        @Override
        public boolean canRead(Class<?> target, MediaType mediaType) {
            return internalRequest() && super.canRead(target, mediaType);
        }

        @Override
        public boolean canWrite(Class<?> target, MediaType mediaType) {
            return internalRequest() && super.canWrite(target, mediaType);
        }
    }
}
