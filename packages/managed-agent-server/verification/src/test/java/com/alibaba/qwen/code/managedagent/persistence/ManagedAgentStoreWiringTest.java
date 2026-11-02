package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.aop.framework.Advised;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Lazy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import javax.sql.DataSource;

import java.lang.reflect.Modifier;
import java.time.Clock;
import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class ManagedAgentStoreWiringTest {
    private ApplicationContextRunner runner(String missing) {
        ApplicationContextRunner runner = new ApplicationContextRunner()
                .withInitializer(context -> ((DefaultListableBeanFactory) context.getBeanFactory())
                        .setAllowCircularReferences(false))
                .withUserConfiguration(StoreConfiguration.class)
                .withBean("managedJdbcTemplate", JdbcTemplate.class, () -> new JdbcTemplate(mock(DataSource.class)))
                .withBean("managedAgentObjectMapper", ObjectMapper.class, ObjectMapper::new)
                .withBean("managedAgentClock", Clock.class, Clock::systemUTC)
                .withBean(CommittedEventPublisher.class, () -> events -> {})
                .withBean(ManagedWorkspaceRegistry.class, () -> mock(ManagedWorkspaceRegistry.class))
                .withBean(ManagedAgentSettings.class, ManagedAgentProperties::new)
                .withBean(HarnessRules.class, () -> mock(HarnessRules.class));
        if (!"worktreeFiles".equals(missing)) {
            runner = runner.withBean(WorktreeFiles.class, () -> mock(WorktreeFiles.class));
        }
        if (!"creationSkills".equals(missing)) {
            runner = runner.withBean(ManagedSessionSkills.class, () -> mock(ManagedSessionSkills.class));
        }
        if (!"extensionPackages".equals(missing)) {
            runner = runner.withBean(ExtensionPackages.class, () -> mock(ExtensionPackages.class));
        }
        return runner;
    }

    @Test
    void optionalCollaboratorsCanBeAbsentWithoutSelectingTheStandaloneConstructor() {
        runner("").run(context -> {
            assertThat(context).hasNotFailed();
            var store = context.getBean(ManagedAgentStore.class);
            assertThat(AopUtils.isAopProxy(store)).isTrue();
            Object target = AopTestUtils.getUltimateTargetObject(store);
            assertThat(ReflectionTestUtils.getField(target, "creationSkills"))
                    .isSameAs(context.getBean(ManagedSessionSkills.class));
            assertThat(ReflectionTestUtils.getField(target, "worktreeFiles"))
                    .isSameAs(context.getBean(WorktreeFiles.class));
            assertThat(ReflectionTestUtils.getField(target, "extensionPackages"))
                    .isSameAs(context.getBean(ExtensionPackages.class));
            for (String name : List.of("lifecycle", "definitions", "sessionWorktrees", "journalEventTransport")) {
                assertThat(ReflectionTestUtils.getField(target, name)).as(name).isNull();
            }
            assertThat(AopUtils.isAopProxy(ReflectionTestUtils.getField(target, "configRecords"))).isTrue();
        });
    }

    @ParameterizedTest
    @ValueSource(strings = {"worktreeFiles", "creationSkills", "extensionPackages"})
    void missingRequiredCollaboratorsStillFailSpringStartup(String missing) {
        runner(missing).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("No qualifying bean of type");
            String type = switch (missing) {
                case "worktreeFiles" -> WorktreeFiles.class.getName();
                case "creationSkills" -> ManagedSessionSkills.class.getName();
                default -> ExtensionPackages.class.getName();
            };
            assertThat(context.getStartupFailure()).hasStackTraceContaining(type);
        });
    }

    @Test
    void lazyRecordStoreResolvesItsBackReferenceToTheCompletedTransactionProxy() {
        runner("").withUserConfiguration(RecordConfiguration.class).run(context -> {
            assertThat(context).hasNotFailed();
            var store = context.getBean(ManagedAgentStore.class);
            Object target = AopTestUtils.getUltimateTargetObject(store);
            var records = (Advised) ReflectionTestUtils.getField(target, "configRecords");
            assertThat(context.getBeanFactory().containsSingleton("recordStore")).isFalse();
            Object resolved = records.getTargetSource().getTarget();
            assertThat(context.getBeanFactory().containsSingleton("recordStore")).isTrue();
            assertThat(resolved).isSameAs(context.getBean(ManagedExtensionRecordStore.class));
            assertThat(ReflectionTestUtils.getField(resolved, "sessions")).isSameAs(store);
            assertThat(AopUtils.isAopProxy(store)).isTrue();
        });
    }

    @Test
    void dependencyReferencesAreFinalAndHaveNoPostConstructionInjection() throws Exception {
        for (String name : List.of("worktreeFiles", "creationSkills", "extensionPackages", "lifecycle",
                "definitions", "sessionWorktrees", "journalEventTransport", "configRecords")) {
            var field = ManagedAgentStore.class.getDeclaredField(name);
            assertThat(Modifier.isFinal(field.getModifiers())).as(name).isTrue();
            assertThat(field.isAnnotationPresent(Autowired.class)).as(name).isFalse();
        }
        assertThat(Arrays.stream(ManagedAgentStore.class.getDeclaredMethods())
                .filter(method -> method.isAnnotationPresent(Autowired.class))).isEmpty();
        assertThat(Arrays.stream(ManagedAgentStore.class.getDeclaredMethods()).map(java.lang.reflect.Method::getName))
                .doesNotContain("configureWorktreeFiles", "setWorkspaceLifecycleStore", "setManagedAgentDefinitionStore",
                        "setSessionWorktrees", "setExtensionPackages", "setManagedSessionSkills", "setJournalEventTransport");
        assertThat(Arrays.stream(ManagedAgentStore.class.getDeclaredConstructors())
                .filter(constructor -> constructor.isAnnotationPresent(Autowired.class))).hasSize(1);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableTransactionManagement(proxyTargetClass = true)
    @Import(ManagedAgentStore.class)
    static class StoreConfiguration {
        @Bean
        PlatformTransactionManager managedAgentTransactionManager(JdbcTemplate jdbc) {
            return new DataSourceTransactionManager(jdbc.getDataSource());
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class RecordConfiguration {
        @Bean
        @Lazy
        ManagedExtensionRecordStore recordStore(JdbcTemplate jdbc, AgentStateStore sessions) {
            return new ManagedExtensionRecordStore(jdbc, sessions, new ManagedTaskEventStore(jdbc));
        }
    }
}
