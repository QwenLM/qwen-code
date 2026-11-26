package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.workspace.runtime.ParkedMcpReclamationJob;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class ParkedMcpReclamationConfigurationTest {
    private static final String PREFIX = "qwen.managed-agent.runtime-broker.";

    private final RuntimeBrokerService broker = mock(RuntimeBrokerService.class);
    private final JdbcWorkspaceExecutionStore store = mock(JdbcWorkspaceExecutionStore.class);

    private ApplicationContextRunner context() {
        return new ApplicationContextRunner()
                .withUserConfiguration(Properties.class, ParkedMcpReclamationConfiguration.class)
                .withBean("managedJdbcTemplate", JdbcTemplate.class, () -> mock(JdbcTemplate.class))
                .withBean(RuntimeBrokerService.class, () -> broker)
                .withBean(JdbcWorkspaceExecutionStore.class, () -> store)
                .withBean(WorktreeFiles.class, () -> mock(WorktreeFiles.class))
                .withBean(ThreadPoolTaskSchedulerBuilder.class, ThreadPoolTaskSchedulerBuilder::new);
    }

    @Test
    void parkingStaysOffUnlessBothTheBrokerAndParkingAreEnabled() {
        for (String enabled : new String[] {"enabled", "mcp-parking.enabled"}) {
            context().withPropertyValues(PREFIX + enabled + "=true")
                    .run(started -> assertThat(started).doesNotHaveBean(ParkedMcpReclamationJob.class)
                            .doesNotHaveBean("parkedMcpReclamationScheduler"));
        }
        verify(broker, never()).enableMcpParking();
    }

    @Test
    void enablingParkingStartsReclamationBeforeAdvertisingIt() {
        context().withPropertyValues(PREFIX + "enabled=true", PREFIX + "mcp-parking.enabled=true")
                .run(started -> {
                    assertThat(started).hasSingleBean(ParkedMcpReclamationJob.class)
                            .hasBean("parkedMcpReclamationScheduler");
                    verify(broker).enableMcpParking();
                    verify(store).onMaintenanceBusy(any());
                });
    }

    @Test
    void defaultsKeepParkingOff() {
        var settings = new ManagedAgentProperties().getRuntimeBroker().getMcpParking();
        assertThat(settings.isEnabled()).isFalse();
        assertThat(settings.getIdleDuration()).isEqualTo(Duration.ofMinutes(30));
        assertThat(settings.getBatchSize()).isEqualTo(100);
        assertThat(settings.getScanDelay()).isEqualTo(Duration.ofMinutes(1));
    }

    @ParameterizedTest
    @ValueSource(strings = {"idle-duration=0s", "idle-duration=-1m", "idle-duration=1ns", "scan-delay=0s",
            "scan-delay=-1s", "scan-delay=1ns", "batch-size=0", "batch-size=1001"})
    void rejectsInvalidParkingSettings(String property) {
        context().withPropertyValues(PREFIX + "mcp-parking." + property)
                .run(started -> assertThat(started).hasFailed());
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class Properties {
    }
}
