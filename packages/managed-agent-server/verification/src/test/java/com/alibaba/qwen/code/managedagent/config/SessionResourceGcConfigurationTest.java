package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.session.SessionResourceGcWakeup;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class SessionResourceGcConfigurationTest {
    private static final String PREFIX = "qwen.managed-agent.session-resource-gc.";
    private final ApplicationContextRunner context = new ApplicationContextRunner()
            .withUserConfiguration(BindSettings.class, SessionResourceGcConfiguration.class)
            .withBean(ThreadPoolTaskSchedulerBuilder.class, ThreadPoolTaskSchedulerBuilder::new)
            .withBean("managedJdbcTemplate", JdbcTemplate.class, () -> mock(JdbcTemplate.class))
            .withBean("managedAgentTransactionManager", PlatformTransactionManager.class,
                    () -> mock(PlatformTransactionManager.class));

    @Test
    void defaultsOffAndSupportsPollingOnly() {
        context.run(app -> assertThat(app).doesNotHaveBean(SessionResourceGcWakeup.class));
        context.withPropertyValues(PREFIX + "enabled=true").run(app -> {
            assertThat(app).hasSingleBean(SessionResourceGcConfiguration.Polling.class);
            assertThat(app.getBean(SessionResourceGcConfiguration.Dispatch.class).transport()).isNull();
        });
    }

    @Test
    void apiReplicaPublishesWithoutStartingAPollingWorker() {
        context.withPropertyValues(PREFIX + "enabled=true", PREFIX + "worker-enabled=false",
                PREFIX + "endpoints=127.0.0.1:8081", PREFIX + "topic=session-gc", PREFIX + "consumer-group=gc-workers")
                .run(app -> {
                    assertThat(app).doesNotHaveBean(SessionResourceGcConfiguration.Polling.class);
                    assertThat(app.getBean(SessionResourceGcConfiguration.Dispatch.class).transport()).isNotNull();
                });
    }

    @Test
    void rejectsExternalResourcesAndIncompleteMqSettings() {
        context.withPropertyValues(PREFIX + "enabled=true", "qwen.managed-agent.session-resources.enabled=true")
                .run(app -> assertThat(app).getFailure().hasRootCauseMessage(
                        "MySQL Session resource GC requires external Session resources and tool publication to be disabled"));
        context.withPropertyValues(PREFIX + "enabled=true", PREFIX + "topic=session-gc")
                .run(app -> assertThat(app).getFailure().hasRootCauseMessage(
                        "Session resource GC MQ requires endpoints, topic and consumer-group"));
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class BindSettings {}
}
