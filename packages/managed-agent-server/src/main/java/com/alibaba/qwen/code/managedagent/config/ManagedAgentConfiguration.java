package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.FilterType;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/** Explicitly imports the control plane into the caller's application context, without servlet endpoints. */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ManagedAgentProperties.class)
@EnableScheduling
@EnableTransactionManagement(proxyTargetClass = true)
@Import({ManagedAgentConfiguration.PersistenceImport.class, ExecutionConfiguration.class, HarnessConfiguration.class,
        RuntimeBrokerConfiguration.class, RuntimeRetentionConfiguration.class, ManagedArtifactConfiguration.class,
        ToolPublicationConfiguration.class, EventTransportConfiguration.class, AliyunToolPublicationStorageAutoConfiguration.class})
@ComponentScan(basePackages = "com.alibaba.qwen.code.managedagent", excludeFilters = {
        @ComponentScan.Filter(type = FilterType.ANNOTATION, classes = {Configuration.class,
                org.springframework.stereotype.Controller.class, org.springframework.web.bind.annotation.ControllerAdvice.class}),
        @ComponentScan.Filter(type = FilterType.CUSTOM, classes = org.springframework.boot.context.TypeExcludeFilter.class),
        @ComponentScan.Filter(type = FilterType.CUSTOM, classes = org.springframework.boot.autoconfigure.AutoConfigurationExcludeFilter.class),
        @ComponentScan.Filter(type = FilterType.REGEX, pattern = "com\\.alibaba\\.qwen\\.code\\.managedagent\\.api\\..*"),
        @ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE, classes = {
                ManagedAgentServerApplication.class, ManagedAgentWebConfiguration.class,
                ManagedAgentInternalConfiguration.class, ManagedSchemaConfiguration.class,
                ManagedLocalConfiguration.class, WebConfiguration.class, ManagedSessionJsonConfiguration.class,
                InternalSurfaceConfiguration.class, InternalSurfaceConfiguration.RoutingFilter.class,
                BrokerSecurity.class
        })
})
public class ManagedAgentConfiguration {
    public ManagedAgentConfiguration(ManagedAgentProperties properties) {
        BrokerSecurity.checkPublicationTransport(properties, new java.util.ArrayList<>());
    }

    static class PersistenceImport implements org.springframework.context.annotation.DeferredImportSelector {
        @Override
        public String[] selectImports(org.springframework.core.type.AnnotationMetadata metadata) {
            return new String[] {ManagedAgentPersistenceConfiguration.class.getName()};
        }
    }
}
