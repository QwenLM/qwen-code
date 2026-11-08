package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.ManagedSessionStoreController;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/** Opt-in native journal callbacks; each operation retains its writer-credential check. */
@Configuration(proxyBeanMethods = false)
@Import({ManagedSessionStoreController.class, TenantContextArgumentResolver.class,
        WebConfiguration.class, ManagedSessionJsonConfiguration.class, ApiExceptionHandler.class})
public class ManagedAgentInternalConfiguration {
    @org.springframework.context.annotation.Bean
    TenantContextFilter tenantContextFilter(
            @org.springframework.beans.factory.annotation.Qualifier("managedAgentObjectMapper") com.fasterxml.jackson.databind.ObjectMapper mapper) {
        return new TenantContextFilter(mapper) {
            @Override
            protected boolean shouldNotFilter(jakarta.servlet.http.HttpServletRequest request) {
                return !com.alibaba.qwen.code.managedagent.security.PublicSurface.pathWithinApplication(request)
                        .startsWith("/internal/managed-session-store/v1/");
            }
        };
    }

    public ManagedAgentInternalConfiguration(com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy credentials) {
        if (!credentials.isBound()) {
            throw new IllegalStateException("Embedded callbacks require qwen.managed-agent.session-store.binding-key");
        }
    }
}
