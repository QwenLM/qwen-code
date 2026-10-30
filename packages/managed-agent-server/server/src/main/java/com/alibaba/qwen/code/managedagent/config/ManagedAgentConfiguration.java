package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.FilterType;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/**
 * Explicitly imports the control plane into the caller's application context, without servlet
 * endpoints.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ManagedAgentProperties.class)
@EnableScheduling
@EnableTransactionManagement(proxyTargetClass = true)
@Import({
    ManagedAgentConfiguration.PersistenceImport.class,
    ExecutionConfiguration.class,
    HarnessConfiguration.class,
    RuntimeBrokerConfiguration.class,
    RuntimeRetentionConfiguration.class,
    ManagedArtifactConfiguration.class,
    ToolPublicationConfiguration.class,
    EventTransportConfiguration.class,
    AliyunToolPublicationStorageAutoConfiguration.class
})
@ComponentScan(
        basePackages = {
            "com.alibaba.qwen.code.managedagent.catalog",
            "com.alibaba.qwen.code.managedagent.workspace",
            "com.alibaba.qwen.code.managedagent.extensions",
            "com.alibaba.qwen.code.managedagent.channel",
            "com.alibaba.qwen.code.managedagent.artifact",
            "com.alibaba.qwen.code.managedagent.automation",
            "com.alibaba.qwen.code.managedagent.event",
            "com.alibaba.qwen.code.managedagent.session",
            "com.alibaba.qwen.code.managedagent.persistence",
            "com.alibaba.qwen.code.managedagent.adapters.extensions"
        },
        excludeFilters = {
            @ComponentScan.Filter(
                    type = FilterType.ANNOTATION,
                    classes = {
                        Configuration.class,
                        org.springframework.stereotype.Controller.class,
                        org.springframework.web.bind.annotation.ControllerAdvice.class
                    }),
            @ComponentScan.Filter(
                    type = FilterType.CUSTOM,
                    classes = org.springframework.boot.context.TypeExcludeFilter.class),
            @ComponentScan.Filter(
                    type = FilterType.CUSTOM,
                    classes =
                            org.springframework.boot.autoconfigure.AutoConfigurationExcludeFilter
                                    .class),
            @ComponentScan.Filter(
                    type = FilterType.REGEX,
                    pattern = "com\\.alibaba\\.qwen\\.code\\.managedagent\\.api\\..*"),
            @ComponentScan.Filter(
                    type = FilterType.ASSIGNABLE_TYPE,
                    classes = {
                        ManagedAgentServerApplication.class,
                        ManagedAgentWebConfiguration.class,
                        ManagedAgentInternalConfiguration.class,
                        ManagedSchemaConfiguration.class,
                        ManagedLocalConfiguration.class,
                        WebConfiguration.class,
                        ManagedSessionJsonConfiguration.class,
                        InternalSurfaceConfiguration.class,
                        InternalSurfaceConfiguration.RoutingFilter.class,
                        BrokerSecurity.class
                    })
        })
public class ManagedAgentConfiguration {
    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles managedWorktreeFiles() {
        return new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles();
    }
    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.workspace.SessionWorktreeOperations.Factory managedWorktreeFactory() {
        return (git, timeout) -> new com.alibaba.qwen.code.managedagent.adapters.workspace.SessionWorktreeGit(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit(git, timeout));
    }
    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader managedStorageIdentityReader() {
        return new com.alibaba.qwen.code.runtimebroker.provisioning.NativeStorageIdentityReader();
    }
    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.workspace.LocalWorkspaceFiles managedLocalWorkspaceFiles() {
        return new com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess();
    }
    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy managedSessionReaderVersion() {
        return new ManagedSessionReaderVersion();
    }
    @org.springframework.context.annotation.Bean(destroyMethod = "")
    public com.alibaba.qwen.code.runtimebroker.spi.SshConnections managedSshConnections(ManagedAgentProperties properties) {
        return properties.getRuntimeBroker().getSsh().getNodes().isEmpty() ? null
                : new com.alibaba.qwen.code.runtimebroker.provisioning.SshConnectionManager(
                    java.net.URI.create(properties.getToolPublication().getServiceBaseUrl()));
    }
    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelRouteRepository managedChannelRoutes(
            @org.springframework.beans.factory.annotation.Qualifier("managedJdbcTemplate") org.springframework.jdbc.core.JdbcTemplate jdbc) {
        return new com.alibaba.qwen.code.managedagent.persistence.JdbcChannelRouteRepository(jdbc);
    }
    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelDeliveryRepository managedChannelDeliveries(
            @org.springframework.beans.factory.annotation.Qualifier("managedJdbcTemplate") org.springframework.jdbc.core.JdbcTemplate jdbc) {
        return new com.alibaba.qwen.code.managedagent.persistence.JdbcChannelDeliveryRepository(jdbc);
    }

    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.model.RequestDigests managedRequestDigests() {
        return new com.alibaba.qwen.code.managedagent.model.RequestDigests();
    }

    @org.springframework.context.annotation.Bean
    public com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy managedWriterCredentialPolicy(
            ManagedAgentProperties properties) {
        return new com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy(properties);
    }

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
