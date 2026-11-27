package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import org.springframework.boot.context.TypeExcludeFilter;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.FilterType;
import org.springframework.context.annotation.Import;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** The standalone server's public and internal servlet surfaces. */
@Configuration(proxyBeanMethods = false)
@ComponentScan(basePackages = "com.alibaba.qwen.code.managedagent.api", excludeFilters = {
        @ComponentScan.Filter(type = FilterType.CUSTOM,
                classes = TypeExcludeFilter.class),
        @ComponentScan.Filter(type = FilterType.ANNOTATION, classes = Configuration.class),
        @ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE,
                classes = ApiExceptionHandler.class)
})
@Import({BrokerSecurity.class, WebConfiguration.class, ManagedSessionJsonConfiguration.class,
        InternalSurfaceConfiguration.class, InternalSurfaceConfiguration.RoutingFilter.class,
        TerminalWebSocketConfig.class,
        ManagedAgentWebConfiguration.StandaloneExceptionHandler.class})
public class ManagedAgentWebConfiguration {
    @RestControllerAdvice
    public static class StandaloneExceptionHandler extends ApiExceptionHandler {
    }
}
