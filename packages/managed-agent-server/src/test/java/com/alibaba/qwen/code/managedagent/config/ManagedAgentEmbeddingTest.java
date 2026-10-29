package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedAgentEmbeddingTest {
    private ApplicationContextRunner runner() {
        return new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(JacksonAutoConfiguration.class, TaskSchedulingAutoConfiguration.class))
                .withUserConfiguration(ManagedAgentConfiguration.class, Host.class);
    }

    @Test
    void coreRejectsRemotePlaintextHarnessBeforeCreatingTheConnector() {
        var connectorsCreated = new java.util.concurrent.atomic.AtomicInteger();
        runner().withInitializer(context -> context.getBeanFactory().addBeanPostProcessor(
                new org.springframework.beans.factory.config.BeanPostProcessor() {
                    @Override
                    public Object postProcessAfterInitialization(Object bean, String name) {
                        if ("hostedHarnessConnector".equals(name)) {
                            connectorsCreated.incrementAndGet();
                        }
                        return bean;
                    }
                })).withPropertyValues("qwen.managed-agent.datasource.url=" + url(),
                        "qwen.managed-agent.harness.enabled=true",
                        "qwen.managed-agent.harness.base-url=http://192.0.2.1:9",
                        "qwen.managed-agent.harness.token=test-harness-token",
                        "qwen.managed-agent.harness.capability-digest=sha256:" + "a".repeat(64),
                        "qwen.managed-agent.session-store.enabled=true",
                        "qwen.managed-agent.session-store.base-url=https://callbacks.example.invalid",
                        "qwen.managed-agent.session-store.binding-key=" + "k".repeat(32))
                .run(context -> {
                    assertThat(context).hasFailed();
                    assertThat(context.getStartupFailure()).hasStackTraceContaining(
                            "qwen.managed-agent.harness.base-url uses plaintext http on a non-loopback host");
                    assertThat(connectorsCreated).hasValue(0);
                });
    }

    @Test
    void coreRejectsRemotePlaintextPublicationEndpoint() {
        runner().withPropertyValues("qwen.managed-agent.datasource.url=" + url(),
                        "qwen.managed-agent.tool-publication.enabled=true",
                        "qwen.managed-agent.tool-publication.service-base-url=http://192.0.2.1:8080")
                .run(context -> {
                    assertThat(context).hasFailed();
                    assertThat(context.getStartupFailure()).hasStackTraceContaining(
                            "qwen.managed-agent.tool-publication.service-base-url uses plaintext http");
                });
    }

    @Test
    void ownsDedicatedPoolAndLeavesUnqualifiedHostBeansAlone() {
        runner().withPropertyValues("qwen.managed-agent.datasource.url=" + url()).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(ManagedAgentService.class)).isNotNull();
            var host = context.getBean(HostDependencies.class);
            assertThat(host.source()).isSameAs(context.getBean("businessSource"));
            assertThat(host.jdbc()).isSameAs(context.getBean("businessJdbc"));
            assertThat(host.manager()).isSameAs(context.getBean("businessTransaction"));
            assertThat(host.mapper()).isNotSameAs(context.getBean("managedAgentObjectMapper"));
            assertThat(host.clock()).isSameAs(context.getBean("businessClock"));
            var managed = context.getBean("managedJdbcTemplate", JdbcTemplate.class);
            assertThat(managed.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isZero();
            assertThat(context.getBeansWithAnnotation(org.springframework.web.bind.annotation.RestController.class)).isEmpty();
            assertThat(context.getBean("businessJdbc", JdbcTemplate.class).queryForObject("SELECT COUNT(*) FROM business_record", Integer.class)).isZero();
            var source = context.getBean("managedAgentDataSource", DruidDataSource.class);
            context.close();
            assertThat(source.isClosed()).isTrue();
        });
    }

    @Test
    void cleanupDebtStoreQueriesTheDedicatedDatabaseNotTheHostOne() {
        runner().withPropertyValues("qwen.managed-agent.datasource.url=" + url()).run(context -> {
            assertThat(context).hasNotFailed();
            var store = context.getBean(HostedCleanupDebtStore.class);
            // The host business database has no ma_resource_ref. An unqualified
            // JdbcTemplate would bind it and throw "Table not found" here; the
            // dedicated database carries the schema, so the scan returns an
            // empty page instead of failing every tick against the wrong DB.
            assertThat(store.findOwed(20, -1, "").debts()).isEmpty();
        });
    }

    @Test
    void failsWithoutDedicatedConfigurationInsteadOfUsingBusinessDatabase() {
        runner().run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("qwen.managed-agent.datasource.url");
        });
    }

    @Test
    void usesExplicitBorrowedSourceWithoutAnAdditionalCloseRegistration() {
        var source = new DruidDataSource();
        source.setUrl(url());
        try {
            runner().withBean("managedAgentDataSource", DataSource.class, () -> source,
                    definition -> {
                        ((org.springframework.beans.factory.support.AbstractBeanDefinition) definition).setDefaultCandidate(false);
                        definition.setDestroyMethodName("");
                    })
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        assertThat(context.getBean("managedJdbcTemplate", JdbcTemplate.class).getDataSource()).isSameAs(source);
                    });
            assertThat(source.isClosed()).isFalse();
        } finally {
            source.close();
        }
    }

    @Test
    void selectedManagerRollsBackManagedRepositoryWithoutTouchingBusinessTransaction() {
        runner().withPropertyValues("qwen.managed-agent.datasource.url=" + url()).run(context -> {
            assertThat(context).hasNotFailed();
            var managed = context.getBean("managedJdbcTemplate", JdbcTemplate.class);
            var repository = context.getBean(ManagedAgentDefinitionStore.class);
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> repository.create(
                    "tenant", "key", "x".repeat(1000), "agent", "digest", "{}", 1))
                    .isInstanceOf(org.springframework.dao.DataAccessException.class);
            assertThat(managed.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isZero();
            assertThat(managed.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isZero();
            var business = context.getBean("businessJdbc", JdbcTemplate.class);
            new TransactionTemplate(context.getBean("businessTransaction", DataSourceTransactionManager.class))
                    .executeWithoutResult(status -> business.update("INSERT INTO business_record VALUES (1)"));
            assertThat(business.queryForObject("SELECT COUNT(*) FROM business_record", Integer.class)).isEqualTo(1);
        });
    }

    private static String url() {
        return "jdbc:h2:mem:embedding-" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    }

    record HostDependencies(DataSource source, JdbcTemplate jdbc, DataSourceTransactionManager manager,
            ObjectMapper mapper, Clock clock) { }

    @Configuration(proxyBeanMethods = false)
    static class Host {
        @Bean
        HostDependencies hostDependencies(DataSource source, JdbcTemplate jdbc, DataSourceTransactionManager manager,
                ObjectMapper mapper, Clock clock) {
            return new HostDependencies(source, jdbc, manager, mapper, clock);
        }

        @Bean(destroyMethod = "close")
        DruidDataSource businessSource() {
            var source = new DruidDataSource();
            source.setUrl(url());
            new JdbcTemplate(source).execute("CREATE TABLE business_record (id INTEGER PRIMARY KEY)");
            return source;
        }

        @Bean
        JdbcTemplate businessJdbc(DataSource source) {
            return new JdbcTemplate(source);
        }

        @Bean
        DataSourceTransactionManager businessTransaction(DataSource source) {
            return new DataSourceTransactionManager(source);
        }

        @Bean
        Clock businessClock() {
            return Clock.systemUTC();
        }

        @Bean(destroyMethod = "close")
        ExecutorService businessExecutor() {
            return Executors.newVirtualThreadPerTaskExecutor();
        }
    }
}
