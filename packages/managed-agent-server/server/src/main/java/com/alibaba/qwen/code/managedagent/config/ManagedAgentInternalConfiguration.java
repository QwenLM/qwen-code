package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.ManagedAutomationSessionController;
import com.alibaba.qwen.code.managedagent.api.ManagedMemorySessionController;
import com.alibaba.qwen.code.managedagent.api.ManagedSessionStoreController;
import com.alibaba.qwen.code.managedagent.api.ManagedSideQueryStoreController;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.ToolPublicationController;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/** Opt-in native journal callbacks; each operation retains its writer-credential check. */
@Configuration(proxyBeanMethods = false)
@Import({ManagedSessionStoreController.class, ManagedMemorySessionController.class, ManagedSideQueryStoreController.class,
        ManagedAutomationSessionController.class, ToolPublicationController.class, TenantContextArgumentResolver.class,
        WebConfiguration.class, ManagedSessionJsonConfiguration.class, ApiExceptionHandler.class})
public class ManagedAgentInternalConfiguration {
    @org.springframework.context.annotation.Bean
    TenantContextFilter tenantContextFilter(
            @org.springframework.beans.factory.annotation.Qualifier("managedAgentObjectMapper") com.fasterxml.jackson.databind.ObjectMapper mapper) {
        return new TenantContextFilter(mapper) {
            @Override
            protected boolean shouldNotFilter(jakarta.servlet.http.HttpServletRequest request) {
                String path = com.alibaba.qwen.code.managedagent.security.PublicSurface.pathWithinApplication(request);
                return !path.startsWith("/internal/managed-session-store/v1/")
                        && !path.startsWith("/internal/managed-tool-publications/v1/");
            }
        };
    }

    public ManagedAgentInternalConfiguration(com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy credentials) {
        if (!credentials.isBound()) {
            throw new IllegalStateException("Embedded callbacks require qwen.managed-agent.session-store.binding-key");
        }
    }
}
