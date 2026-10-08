package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.alibaba.qwen.code.managedagent.service.RuntimeRetentionJob;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import java.time.Duration;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class RuntimeRetentionConfigurationTest {
    private ApplicationContextRunner context() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:retention-config;MODE=MySQL");
        return new ApplicationContextRunner()
                .withUserConfiguration(Properties.class, RuntimeRetentionConfiguration.class)
                .withBean(DataSource.class, () -> source)
                .withBean(RuntimeBindingRepository.class,
                        () -> new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32])))
                .withBean(RuntimeSessionRepository.class, () -> new JdbcRuntimeSessionRepository(source))
                .withBean(ToolExecutionRepository.class, () -> new JdbcToolExecutionRepository(source))
                .withBean(ThreadPoolTaskSchedulerBuilder.class, ThreadPoolTaskSchedulerBuilder::new);
    }

    @Test
    void requiresBothBrokerAndRetentionEnablement() {
        context().run(context -> assertThat(context).doesNotHaveBean(RuntimeRetentionJob.class)
                .doesNotHaveBean("runtimeRetentionScheduler"));
        for (String enabled : new String[] {"enabled", "retention.enabled"}) {
            context().withPropertyValues("qwen.managed-agent.runtime-broker." + enabled + "=true")
                    .run(context -> assertThat(context).doesNotHaveBean(RuntimeRetentionJob.class)
                            .doesNotHaveBean("runtimeRetentionScheduler"));
        }
        context().withPropertyValues("qwen.managed-agent.runtime-broker.enabled=true",
                        "qwen.managed-agent.runtime-broker.retention.enabled=true")
                .run(context -> assertThat(context).hasSingleBean(RuntimeRetentionJob.class)
                        .hasBean("runtimeRetentionScheduler"));
    }

    @Test
    void bindsShippedYamlDefaultsAndDocumentedEnvironmentOverrides() throws Exception {
        var yaml = new org.springframework.boot.env.YamlPropertySourceLoader().load("application.yml",
                new org.springframework.core.io.ClassPathResource("application.yml"));
        var properties = new java.util.LinkedHashMap<String, Object>();
        yaml.forEach(item -> {
            var source = (org.springframework.core.env.EnumerablePropertySource<?>) item;
            for (String name : source.getPropertyNames()) {
                if (name.startsWith("qwen.managed-agent.runtime-broker.retention.")) {
                    properties.put(name, source.getProperty(name));
                }
            }
        });
        assertThat(properties).hasSize(4).containsValue("${QWEN_MANAGED_AGENT_RUNTIME_RETENTION_ENABLED:false}")
                .containsValue("${QWEN_MANAGED_AGENT_RUNTIME_RETENTION_MAX_AGE:30d}")
                .containsValue("${QWEN_MANAGED_AGENT_RUNTIME_RETENTION_BATCH_SIZE:100}")
                .containsValue("${QWEN_MANAGED_AGENT_RUNTIME_RETENTION_SCAN_DELAY:1m}");
        var configured = context().withInitializer(ctx -> {
            var ambient = new java.util.LinkedHashMap<String, Object>(System.getenv());
            ambient.keySet().removeIf(name -> name.startsWith("QWEN_MANAGED_AGENT_RUNTIME_RETENTION_"));
            ctx.getEnvironment().getPropertySources().replace("systemEnvironment",
                    new org.springframework.core.env.MapPropertySource("systemEnvironment", ambient));
            ctx.getEnvironment().getPropertySources().addLast(
                    new org.springframework.core.env.MapPropertySource("retention-yaml", properties));
        });
        configured.run(ctx -> {
            var settings = ctx.getBean(ManagedAgentProperties.class).getRuntimeBroker().getRetention();
            assertThat(settings.isEnabled()).isFalse();
            assertThat(settings.getMaxAge()).isEqualTo(Duration.ofDays(30));
            assertThat(settings.getBatchSize()).isEqualTo(100);
            assertThat(settings.getScanDelay()).isEqualTo(Duration.ofMinutes(1));
        });
        configured.withPropertyValues("QWEN_MANAGED_AGENT_RUNTIME_RETENTION_MAX_AGE=45d",
                        "QWEN_MANAGED_AGENT_RUNTIME_RETENTION_BATCH_SIZE=23",
                        "QWEN_MANAGED_AGENT_RUNTIME_RETENTION_SCAN_DELAY=2m")
                .run(ctx -> {
                    var settings = ctx.getBean(ManagedAgentProperties.class).getRuntimeBroker().getRetention();
                    assertThat(settings.getMaxAge()).isEqualTo(Duration.ofDays(45));
                    assertThat(settings.getBatchSize()).isEqualTo(23);
                    assertThat(settings.getScanDelay()).isEqualTo(Duration.ofMinutes(2));
                });
    }

    @ParameterizedTest
    @ValueSource(strings = {"max-age=0s", "max-age=-1d", "scan-delay=0s", "scan-delay=-1s",
            "scan-delay=1ns", "batch-size=0", "batch-size=1001"})
    void rejectsInvalidRetentionSettings(String property) {
        context().withPropertyValues("qwen.managed-agent.runtime-broker.retention." + property)
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @ParameterizedTest
    @ValueSource(strings = {"custom-binding", "custom-session", "custom-execution",
            "foreign-binding", "foreign-session", "foreign-execution"})
    void rejectsCustomRepositoriesAndMixedDataSources(String mismatch) {
        var source = new JdbcDataSource();
        var other = new JdbcDataSource();
        RuntimeBindingRepository bindings = mismatch.equals("custom-binding") ? mock(RuntimeBindingRepository.class)
                : new JdbcRuntimeBindingRepository(mismatch.equals("foreign-binding") ? other : source,
                        new AesGcmSecretProtector("key", new byte[32]));
        RuntimeSessionRepository sessions = mismatch.equals("custom-session") ? mock(RuntimeSessionRepository.class)
                : new JdbcRuntimeSessionRepository(mismatch.equals("foreign-session") ? other : source);
        ToolExecutionRepository executions = mismatch.equals("custom-execution") ? mock(ToolExecutionRepository.class)
                : new JdbcToolExecutionRepository(mismatch.equals("foreign-execution") ? other : source);
        assertThatThrownBy(() -> new RuntimeRetentionConfiguration().runtimeRetentionJob(
                source, bindings, sessions, executions, new ManagedAgentProperties()))
                .hasMessage("Runtime retention requires native JDBC repositories on one DataSource");
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class Properties { }
}
