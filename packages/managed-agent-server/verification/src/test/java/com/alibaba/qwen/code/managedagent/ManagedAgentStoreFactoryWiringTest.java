package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.ManagedTaskEventStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceLifecycleStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceProfileLifecycleVerifier;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.aop.framework.Advised;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Lazy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.Map;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class ManagedAgentStoreFactoryWiringTest {
    static Stream<Class<?>> factoryConfigurations() {
        return Stream.of(WorkspaceSessionCloseTest.Configuration.class,
                WorkspaceSessionRetentionTest.Configuration.class, ManagedActionsTest.Configuration.class);
    }

    @ParameterizedTest
    @MethodSource("factoryConfigurations")
    void springFactoriesKeepTheirCollaboratorsAndLazyTransactionProxy(Class<?> factory) {
        var source = mock(DataSource.class);
        new ApplicationContextRunner()
                .withInitializer(context -> ((DefaultListableBeanFactory) context.getBeanFactory())
                        .setAllowCircularReferences(false))
                .withUserConfiguration(TransactionConfiguration.class, factory)
                .withBean(DataSource.class, () -> source)
                .withBean("managedJdbcTemplate", JdbcTemplate.class, () -> new JdbcTemplate(source))
                .withBean("managedAgentObjectMapper", ObjectMapper.class, ObjectMapper::new)
                .withBean("managedAgentClock", Clock.class, Clock::systemUTC)
                .withBean(ManagedAgentSettings.class, ManagedAgentProperties::new)
                .withBean(CommittedEventPublisher.class, () -> events -> {})
                .withBean(ManagedWorkspaceRegistry.class, () -> mock(ManagedWorkspaceRegistry.class))
                .withBean(WorktreeFiles.class, () -> mock(WorktreeFiles.class))
                .withBean(ManagedSessionSkills.class, () -> mock(ManagedSessionSkills.class))
                .withBean(ExtensionPackages.class, () -> mock(ExtensionPackages.class))
                .withBean(WorkspaceLifecycleStore.class, () -> mock(WorkspaceLifecycleStore.class))
                .withBean(WorkspaceProfileLifecycleVerifier.class, () -> mock(WorkspaceProfileLifecycleVerifier.class))
                .withBean(ManagedAgentDefinitionStore.class, () -> mock(ManagedAgentDefinitionStore.class))
                .withBean(SessionWorktreeStore.class, () -> mock(SessionWorktreeStore.class))
                .withBean(JournalEventTransport.class, () -> mock(JournalEventTransport.class))
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    var store = context.getBean(ManagedAgentStore.class);
                    assertThat(AopUtils.isAopProxy(store)).isTrue();
                    Object target = AopTestUtils.getUltimateTargetObject(store);
                    Map.of("worktreeFiles", WorktreeFiles.class,
                            "creationSkills", ManagedSessionSkills.class,
                            "extensionPackages", ExtensionPackages.class,
                            "lifecycle", WorkspaceLifecycleStore.class,
                            "definitions", ManagedAgentDefinitionStore.class,
                            "sessionWorktrees", SessionWorktreeStore.class,
                            "journalEventTransport", JournalEventTransport.class)
                            .forEach((field, type) -> assertThat(com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, field))
                                    .as(field).isSameAs(context.getBean(type)));
                    var records = (Advised) com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "configRecords");
                    assertThat(records).isNotNull();
                    assertThat(context.getBeanFactory().containsSingleton("factoryRecordStore")).isFalse();
                    Object resolved = records.getTargetSource().getTarget();
                    assertThat(resolved).isSameAs(context.getBean(ManagedExtensionRecordStore.class));
                    assertThat(ReflectionTestUtils.getField(resolved, "sessions")).isSameAs(store);
                });
    }

    @Configuration(proxyBeanMethods = false)
    @EnableTransactionManagement(proxyTargetClass = true)
    static class TransactionConfiguration {
        @Bean
        PlatformTransactionManager managedAgentTransactionManager(JdbcTemplate jdbc) {
            return new DataSourceTransactionManager(jdbc.getDataSource());
        }

        @Bean
        @Lazy
        ManagedExtensionRecordStore factoryRecordStore(JdbcTemplate jdbc, AgentStateStore sessions) {
            return new ManagedExtensionRecordStore(jdbc, sessions, new ManagedTaskEventStore(jdbc));
        }
    }
}
