package com.alibaba.qwen.code.managedagent.config;

import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/** The standalone server's public and internal servlet surfaces. */
@Configuration(proxyBeanMethods = false)
@ComponentScan(basePackages = "com.alibaba.qwen.code.managedagent.api", excludeFilters = {
        @ComponentScan.Filter(type = org.springframework.context.annotation.FilterType.CUSTOM,
                classes = org.springframework.boot.context.TypeExcludeFilter.class),
        @ComponentScan.Filter(type = org.springframework.context.annotation.FilterType.ANNOTATION, classes = Configuration.class),
        @ComponentScan.Filter(type = org.springframework.context.annotation.FilterType.ASSIGNABLE_TYPE,
                classes = com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler.class)
})
@Import({BrokerSecurity.class, WebConfiguration.class, ManagedSessionJsonConfiguration.class,
        InternalSurfaceConfiguration.class, InternalSurfaceConfiguration.RoutingFilter.class,
        ManagedAgentWebConfiguration.StandaloneExceptionHandler.class})
public class ManagedAgentWebConfiguration {
    @org.springframework.web.bind.annotation.RestControllerAdvice
    public static class StandaloneExceptionHandler extends com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler {
    }
}
