package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedSessionReaderVersion;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.lang.Nullable;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import javax.sql.DataSource;

import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedSessionStoreWiringTest {
    private final DataSource source = mock(DataSource.class);

    private ApplicationContextRunner runner(boolean factory, String missing) {
        var runner = new ApplicationContextRunner()
                .withUserConfiguration(Transactions.class, factory ? Factory.class : Imported.class)
                .withBean("managedJdbcTemplate", JdbcTemplate.class, () -> new JdbcTemplate(source));
        if (!missing.equals("records")) {
            runner = runner.withBean(ManagedExtensionRecordStore.class, () -> mock(ManagedExtensionRecordStore.class));
        }
        if (!missing.equals("actions")) {
            runner = runner.withBean(ManagedActionStore.class, () -> mock(ManagedActionStore.class));
        }
        if (!missing.equals("rules")) {
            runner = runner.withBean(HarnessRules.class, () -> mock(HarnessRules.class));
        }
        if (!missing.equals("reader")) {
            runner = runner.withBean(StorageReadPolicy.class, ManagedSessionReaderVersion::new);
        }
        if (!missing.equals("credentials")) {
            runner = runner.withBean(WriterCredentialPolicy.class, WriterCredentialPolicy::unbound);
        }
        return runner;
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void springAndFactoryConstructionKeepRequiredDependenciesAndTransactionProxy(boolean factory) {
        runner(factory, "").run(context -> {
            assertThat(context).hasNotFailed();
            var store = context.getBean(ManagedSessionStore.class);
            assertThat(AopUtils.isAopProxy(store)).isTrue();
            Object target = AopTestUtils.getUltimateTargetObject(store);
            assertThat(field(target, "lifecycleAuthorization", "harnessRules")).isSameAs(context.getBean(HarnessRules.class));
            assertThat(field(target, "storeRows", "readerVersion")).isSameAs(context.getBean(StorageReadPolicy.class));
            assertThat(field(target, "fencing", "credentials")).isSameAs(context.getBean(WriterCredentialPolicy.class));
            assertThat(field(target, "lifecycleAuthorization", "lifecycleExecution")).isNull();
            assertThat(field(target, "lifecycleAuthorization", "lifecycleSessions")).isNull();
            assertThat(field(target, "resourceReads", "publicationObjects")).isNull();
            assertThat(field(target, "commits", "toolResults")).isNull();
            assertThat(field(target, "fencing", "csiBindings")).isNull();
            assertThat(field(target, "commits", "journalEventTransport")).isNull();
        });
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void optionalDependenciesReachTheirOwners(boolean factory) {
        var objects = mock(ToolPublicationObjectStore.class);
        var results = mock(ManagedToolResultStore.class);
        var transport = mock(JournalEventTransport.class);
        runner(factory, "")
                .withBean(ToolPublicationObjectStore.class, () -> objects)
                .withBean(ManagedToolResultStore.class, () -> results)
                .withBean(JournalEventTransport.class, () -> transport)
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    Object target = AopTestUtils.getUltimateTargetObject(context.getBean(ManagedSessionStore.class));
                    assertThat(field(target, "resourceReads", "publicationObjects")).isSameAs(objects);
                    assertThat(field(target, "commits", "toolResults")).isSameAs(results);
                    assertThat(field(target, "commits", "journalEventTransport")).isSameAs(transport);
                    assertThat(field(target, "fencing", "journalEventTransport")).isSameAs(transport);
                });
    }

    @ParameterizedTest
    @ValueSource(strings = {"records", "actions", "rules", "reader", "credentials"})
    void requiredDependenciesStillFailStartup(String missing) {
        for (boolean factory : new boolean[] {false, true}) {
            runner(factory, missing).run(context -> assertThat(context).hasFailed());
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {0, 1, 2, 3})
    void lifecycleDependenciesAreEnabledOnlyAsAPair(int present) {
        for (boolean factory : new boolean[] {false, true}) {
            var runner = runner(factory, "");
            var execution = mock(WorkspaceExecutionStore.class);
            var sessions = mock(SessionQueryStore.class);
            if ((present & 1) != 0) {
                runner = runner.withBean(WorkspaceExecutionStore.class, () -> execution)
                        .withBean(com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles.class,
                                () -> mock(com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles.class));
            }
            if ((present & 2) != 0) {
                runner = runner.withBean(SessionQueryStore.class, () -> sessions);
            }
            runner.run(context -> {
                assertThat(context).hasNotFailed();
                Object target = AopTestUtils.getUltimateTargetObject(context.getBean(ManagedSessionStore.class));
                assertThat(field(target, "lifecycleAuthorization", "lifecycleExecution")).isSameAs(present == 3 ? execution : null);
                assertThat(field(target, "lifecycleAuthorization", "lifecycleSessions")).isSameAs(present == 3 ? sessions : null);
            });
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"same", "foreign", "non-jdbc"})
    void csiRequiresTheOriginalJdbcDataSource(String kind) {
        RuntimeBindingRepository bindings;
        if (kind.equals("non-jdbc")) {
            bindings = mock(RuntimeBindingRepository.class);
        } else {
            var jdbcBindings = mock(JdbcRuntimeBindingRepository.class);
            when(jdbcBindings.usesDataSource(source)).thenReturn(kind.equals("same"));
            bindings = jdbcBindings;
        }
        runner(false, "").withBean(RuntimeBindingRepository.class, () -> bindings).run(context -> {
            assertThat(context).hasNotFailed();
            Object target = AopTestUtils.getUltimateTargetObject(context.getBean(ManagedSessionStore.class));
            assertThat(field(target, "fencing", "csiBindings")).isSameAs(kind.equals("same") ? bindings : null);
        });
    }

    @Test
    void standaloneDefaultsRemainAndPostConstructionInjectionIsGone() {
        var store = new ManagedSessionStore(new JdbcTemplate(source));
        assertThat(field(store, "lifecycleAuthorization", "harnessRules")).isNull();
        assertThat(field(store, "storeRows", "readerVersion")).isNotNull();
        ((WriterCredentialPolicy) field(store, "fencing", "credentials")).require("tenant", "workspace", "session", "token");
        assertThat(Arrays.stream(ManagedSessionStore.class.getDeclaredMethods()))
                .noneMatch(method -> method.isAnnotationPresent(Autowired.class));
        assertThat(Arrays.stream(ManagedSessionStore.class.getDeclaredConstructors())
                .filter(constructor -> constructor.isAnnotationPresent(Autowired.class))).hasSize(1);
    }

    private static Object field(Object store, String component, String name) {
        return ReflectionTestUtils.getField(ReflectionTestUtils.getField(store, component), name);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableTransactionManagement(proxyTargetClass = true)
    static class Transactions {
        @Bean
        PlatformTransactionManager managedAgentTransactionManager(JdbcTemplate jdbc) {
            return new DataSourceTransactionManager(jdbc.getDataSource());
        }
    }

    @Configuration(proxyBeanMethods = false)
    @Import(ManagedSessionStore.class)
    static class Imported { }

    @Configuration(proxyBeanMethods = false)
    static class Factory {
        @Bean
        ManagedSessionStore journal(JdbcTemplate jdbc, ManagedExtensionRecordStore records, ManagedActionStore actions,
                HarnessRules rules, StorageReadPolicy reader, WriterCredentialPolicy credentials,
                @Nullable WorkspaceExecutionStore execution, @Nullable SessionQueryStore sessions,
                @Nullable ToolPublicationObjectStore objects, @Nullable ManagedToolResultStore results,
                @Nullable JournalEventTransport transport, @Nullable RuntimeBindingRepository bindings) {
            return new ManagedSessionStore(jdbc, records, actions, rules, reader, execution, sessions,
                    objects, results, transport, credentials, bindings);
        }
    }
}
