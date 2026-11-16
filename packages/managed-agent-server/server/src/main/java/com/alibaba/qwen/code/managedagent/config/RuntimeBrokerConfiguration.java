package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

import java.util.concurrent.CompletableFuture;

@Configuration
public class RuntimeBrokerConfiguration {
    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent", name = {"session-store.enabled", "runtime-broker.enabled"}, havingValue = "true")
    public com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationStore workspaceCsiApplicationStore(
            @Qualifier("managedJdbcTemplate") org.springframework.jdbc.core.JdbcTemplate jdbc, @Qualifier("managedAgentTransactionManager") org.springframework.transaction.PlatformTransactionManager manager,
            JdbcManagedSessionStore nativeStore,
            RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            org.springframework.beans.factory.ObjectProvider<com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore> objects) {
        if (!(bindings instanceof JdbcRuntimeBindingRepository jdbcBindings)
                || !(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)) {
            throw new IllegalStateException("Original JDBC repositories are required for CSI retirement");
        }
        return new com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationStore(jdbc, manager, nativeStore, jdbcBindings, jdbcSessions, new com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport(), objects.getIfAvailable());
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public SecretProtector runtimeCredentialProtector(
            ManagedAgentProperties properties) {
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        require(broker.getCredentialKeyId(),
                "Runtime Broker credential key ID");
        require(broker.getCredentialKey(),
                "Runtime Broker credential key");
        return AesGcmSecretProtector.fromBase64(
                broker.getCredentialKeyId(), broker.getCredentialKey(),
                broker.getPreviousCredentialKeys());
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public RuntimeBindingRepository runtimeBindingRepository(
            @Qualifier("managedAgentDataSource") DataSource dataSource, SecretProtector secretProtector,
            @Qualifier("managedJdbcTemplate") org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.beans.factory.ObjectProvider<com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore> objects,
            org.springframework.beans.factory.ObjectProvider<com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings> settings) {
        // Same bundle construction as JdbcManagedSessionStore: without session-resource
        // settings the bundle stays null and CSI admission keeps its fail-closed behavior.
        var sessionResourceSettings = settings.getIfAvailable();
        return new JdbcRuntimeBindingRepository(dataSource, secretProtector,
                sessionResourceSettings == null ? null
                        : new com.alibaba.qwen.code.managedagent.persistence.JdbcJournalPacks(
                                jdbc, objects.getIfAvailable(), sessionResourceSettings));
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public RuntimeSessionRepository runtimeSessionRepository(
            @Qualifier("managedAgentDataSource") DataSource dataSource) {
        return new JdbcRuntimeSessionRepository(dataSource);
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public ToolExecutionRepository toolExecutionRepository(
            @Qualifier("managedAgentDataSource") DataSource dataSource, RuntimeBindingRepository bindings) {
        return new JdbcToolExecutionRepository(dataSource,
                bindings instanceof JdbcRuntimeBindingRepository original ? original : null);
    }

    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public EmbeddedRuntimeBroker embeddedRuntimeBroker(
            AgentStateStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            JdbcWorkspaceExecutionStore workspaceExecutionStore,
            org.springframework.beans.factory.ObjectProvider<ToolPublicationStore> publications,
            org.springframework.beans.factory.ObjectProvider<ToolPublicationDataStore> publicationData,
            @Qualifier("managedJdbcTemplate") org.springframework.jdbc.core.JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") org.springframework.transaction.PlatformTransactionManager manager,
            com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService ssh,
            com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService extensions,
            com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionCommandVerifier extensionCommands) {
        var broker = new EmbeddedRuntimeBroker(store, properties,
                bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications.getIfAvailable(),
                publicationData.getIfAvailable(), jdbc, manager, ssh);
        broker.configureExtensions(extensions);
        broker.service().configureExtensionCommandVerifier(extensionCommands);
        return broker;
    }

    // The child result relay and the close cascade probe bindings across
    // this Broker: it must be a bean, but its lifecycle stays with the
    // owning EmbeddedRuntimeBroker — destroyMethod "" keeps Spring from
    // closing the same service a second time.
    @Bean(destroyMethod = "")
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService runtimeBrokerService(
            EmbeddedRuntimeBroker broker) {
        return broker.service();
    }

    // The terminal capability hint must resolve placement through the same
    // authority the Broker uses. Expose the resolver the Broker already built
    // (null when there is no workspace execution store) so the ObjectProvider
    // in ManagedAgentService finds it instead of always yielding null and
    // pinning capabilities.terminal to false.
    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRuntimeResolver workspaceRuntimeResolver(
            EmbeddedRuntimeBroker broker) {
        return broker.workspaceRuntimeResolver();
    }

    @Bean
    @ConditionalOnMissingBean(RuntimeWarmer.class)
    public RuntimeWarmer runtimeWarmer() {
        return new RuntimeWarmer() {
            @Override
            public boolean isEnabled() {
                return false;
            }

            @Override
            public CompletableFuture<Void> warm(String sessionId) {
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public CompletableFuture<Void> drain(String sessionId) {
                return CompletableFuture.completedFuture(null);
            }
        };
    }

    private static void require(String value, String name) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException(name + " is required");
        }
    }
}
