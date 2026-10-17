package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.JavaDurableAdmission;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * D7-3: the java_durable admission profile exists only when the deployment
 * enables it, so a flag-off deployment is byte-identical by construction.
 */
class JavaDurableAdmissionConfigurationTest {
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(JavaDurableAdmissionConfiguration.class)
            .withBean(AgentStateStore.class, () -> mock(AgentStateStore.class));

    @Test
    void aFlagOffDeploymentGetsNoProfileBean() {
        for (String flag : new String[] {null, "false"}) {
            ApplicationContextRunner context = flag == null ? runner
                    : runner.withPropertyValues(
                            "qwen.managed-agent.java-durable-admission.enabled="
                                    + flag);
            context.run(started -> {
                assertThat(started).hasNotFailed();
                assertThat(started).doesNotHaveBean(JavaDurableAdmission.class);
                assertThat(started).doesNotHaveBean(
                        JavaDurableAdmissionConfiguration.class);
            });
        }
    }

    @Test
    void aFlagOnDeploymentWiresTheProfile() {
        runner.withPropertyValues(
                        "qwen.managed-agent.java-durable-admission.enabled=true")
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(started).hasSingleBean(JavaDurableAdmission.class);
                });
    }

    @Test
    void thePropertyBindsToItsGroup() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        assertThat(properties.getJavaDurableAdmission().isEnabled()).isFalse();
        properties.getJavaDurableAdmission().setEnabled(true);
        assertThat(properties.getJavaDurableAdmission().isEnabled()).isTrue();
    }
}
