package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit;
import com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles;
import com.alibaba.qwen.code.managedagent.adapters.workspace.SessionWorktreeGit;
import com.alibaba.qwen.code.managedagent.config.runtime.RuntimeProviderRegistry;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelSegmentRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.PrWatchInjectionRepository;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.contracts.workspace.LocalWorkspaceFiles;
import com.alibaba.qwen.code.managedagent.contracts.workspace.SessionWorktreeOperations;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelSegmentRepository;
import com.alibaba.qwen.code.managedagent.persistence.JdbcPrWatchInjectionRepository;
import com.alibaba.qwen.code.runtimebroker.host.WorkspaceFileProcess;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.provisioning.NativeStorageIdentityReader;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeBackendSelection;
import com.alibaba.qwen.code.runtimebroker.spi.SshConnections;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.AutoConfigurationExcludeFilter;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.context.TypeExcludeFilter;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.DeferredImportSelector;
import org.springframework.context.annotation.FilterType;
import org.springframework.context.annotation.Import;
import org.springframework.core.type.AnnotationMetadata;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.stereotype.Controller;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.web.bind.annotation.ControllerAdvice;

import java.net.URI;
import java.util.ArrayList;

/**
 * Explicitly imports the control plane into the caller's application context, without servlet
 * endpoints.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ManagedAgentProperties.class)
@EnableScheduling
@EnableTransactionManagement(proxyTargetClass = true)
@ImportAutoConfiguration(ExtensionArchiveStorageAutoConfiguration.class)
@Import({
    ManagedAgentConfiguration.PersistenceImport.class,
    ExecutionConfiguration.class,
    HarnessConfiguration.class,
    RuntimeBrokerConfiguration.class,
    RuntimeRetentionConfiguration.class,
    ParkedMcpReclamationConfiguration.class,
    ManagedArtifactConfiguration.class,
    ToolPublicationConfiguration.class,
    EventTransportConfiguration.class,
    ManagedMemoryConfiguration.class,
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
            "com.alibaba.qwen.code.managedagent.memory",
            "com.alibaba.qwen.code.managedagent.persistence",
            "com.alibaba.qwen.code.managedagent.adapters.extensions"
        },
        excludeFilters = {
            @ComponentScan.Filter(
                    type = FilterType.ANNOTATION,
                    classes = {
                        Configuration.class,
                        Controller.class,
                        ControllerAdvice.class
                    }),
            @ComponentScan.Filter(
                    type = FilterType.CUSTOM,
                    classes = TypeExcludeFilter.class),
            @ComponentScan.Filter(
                    type = FilterType.CUSTOM,
                    classes = AutoConfigurationExcludeFilter.class),
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
    @Bean
    public WorktreeFiles managedWorktreeFiles() {
        return new LocalWorktreeFiles();
    }

    @Bean
    public SessionWorktreeOperations.Factory managedWorktreeFactory() {
        return (git, timeout) -> new SessionWorktreeGit(
                new ChildWorktreeGit(git, timeout));
    }

    @Bean
    public StorageIdentityReader managedStorageIdentityReader() {
        return new NativeStorageIdentityReader();
    }

    @Bean
    public LocalWorkspaceFiles managedLocalWorkspaceFiles() {
        return new WorkspaceFileProcess();
    }

    @Bean(destroyMethod = "close")
    public SshConnections managedSshConnections(ManagedAgentProperties properties) {
        if (!RuntimeBackendSelection.from(properties)
                .includes(RuntimeProviderKinds.SSH_PROCESS)) {
            return null;
        }
        var registry = new RuntimeProviderRegistry();
        registry.validateSelected(properties);
        return registry.ssh().createConnections(URI.create(properties.getToolPublication().getServiceBaseUrl()));
    }

    @Bean
    public ChannelRouteRepository managedChannelRoutes(
            @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        return new JdbcChannelRouteRepository(jdbc);
    }

    @Bean
    public ChannelDeliveryRepository managedChannelDeliveries(
            @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        return new JdbcChannelDeliveryRepository(jdbc);
    }

    @Bean
    public ChannelSegmentRepository managedChannelSegments(
            @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        return new JdbcChannelSegmentRepository(jdbc);
    }

    @Bean
    public PrWatchInjectionRepository managedPrWatchInjections(
            @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        return new JdbcPrWatchInjectionRepository(jdbc);
    }

    @Bean
    public RequestDigests managedRequestDigests() {
        return new RequestDigests();
    }

    @Bean
    public WriterCredentialPolicy managedWriterCredentialPolicy(
            ManagedAgentProperties properties) {
        return new WriterCredentialPolicy(properties);
    }

    public ManagedAgentConfiguration(ManagedAgentProperties properties) {
        properties.validateRuntimeProvider();
        BrokerSecurity.checkPublicationTransport(properties, new ArrayList<>());
    }

    static class PersistenceImport implements DeferredImportSelector {
        @Override
        public String[] selectImports(AnnotationMetadata metadata) {
            return new String[] {ManagedAgentPersistenceConfiguration.class.getName()};
        }
    }
}
