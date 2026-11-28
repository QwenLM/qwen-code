package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.ManagedAutomationSessionController;
import com.alibaba.qwen.code.managedagent.api.ManagedMemorySessionController;
import com.alibaba.qwen.code.managedagent.api.ManagedSessionStoreController;
import com.alibaba.qwen.code.managedagent.api.ManagedSideQueryStoreController;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.security.PublicSurface;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/** Opt-in native journal callbacks; each operation retains its writer-credential check. */
@Configuration(proxyBeanMethods = false)
@Import({ManagedSessionStoreController.class, ManagedMemorySessionController.class, ManagedSideQueryStoreController.class,
        ManagedAutomationSessionController.class, TenantContextArgumentResolver.class,
        WebConfiguration.class, ManagedSessionJsonConfiguration.class, ApiExceptionHandler.class})
public class ManagedAgentInternalConfiguration {
    @Bean
    TenantContextFilter tenantContextFilter(
            @Qualifier("managedAgentObjectMapper") ObjectMapper mapper) {
        return new TenantContextFilter(mapper) {
            @Override
            protected boolean shouldNotFilter(HttpServletRequest request) {
                return !PublicSurface.pathWithinApplication(request)
                        .startsWith("/internal/managed-session-store/v1/");
            }
        };
    }

    public ManagedAgentInternalConfiguration(WriterCredentialPolicy credentials) {
        if (!credentials.isBound()) {
            throw new IllegalStateException("Embedded callbacks require qwen.managed-agent.session-store.binding-key");
        }
    }
}
