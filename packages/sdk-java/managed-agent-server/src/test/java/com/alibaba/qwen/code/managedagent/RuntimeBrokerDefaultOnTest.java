package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.verify;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContextInitializer;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

/**
 * Boots the production-default combination (`local-process` with durable
 * registration and trusted reboot recovery) on a real Linux host, with the
 * ambient QWEN_MANAGED_AGENT_RUNTIME_* environment scrubbed. This context
 * pins neither flag: reverting either YAML placeholder default turns it red
 * through the binding assertions (and the coupling guard for durable); a
 * silent scan-configuration regression (coordinator never reaching the
 * candidate query) turns it red through the batch-read verification; and the
 * `ManagedAgentProperties` field defaults are pinned by
 * `EmbeddedRuntimeBrokerTest#usesFetchCompatibleDefaultBrokerPort`.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:runtime-broker-default-on;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.harness.capability-digest=sha256:"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "qwen.managed-agent.runtime-broker.enabled=true",
        "qwen.managed-agent.runtime-broker.host=127.0.0.1",
        "qwen.managed-agent.runtime-broker.port=0",
        "qwen.managed-agent.runtime-broker.token=broker-token",
        "qwen.managed-agent.runtime-broker.credential-key-id=test-key",
        "qwen.managed-agent.runtime-broker.credential-key="
                + "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        "qwen.managed-agent.runtime-broker.workspace-cwd=${user.dir}",
        "qwen.managed-agent.runtime-broker.state-directory="
                + "${java.io.tmpdir}${file.separator}qwen-rb-default-on-state",
        "qwen.managed-agent.runtime-broker.node-executable=node",
        "qwen.managed-agent.runtime-broker.worker-entry=worker.js",
        "qwen.managed-agent.runtime-broker.cli-entry=cli.js"
})
@ContextConfiguration(initializers = RuntimeBrokerDefaultOnTest.ScrubRuntimeEnv.class)
@EnabledOnOs(OS.LINUX)
class RuntimeBrokerDefaultOnTest {
    @Autowired
    private RuntimeWarmer runtimeWarmer;
    @Autowired
    private ManagedAgentProperties properties;
    @MockitoSpyBean
    private RuntimeBindingRepository bindingRepository;

    @Test
    void defaultCombinationBootsWithTheYmlDefaultsBound() {
        assertThat(runtimeWarmer).isInstanceOf(EmbeddedRuntimeBroker.class);
        var broker = properties.getRuntimeBroker();
        assertThat(broker.isDurableLocalProcess()).isTrue();
        assertThat(broker.isTrustedLocalRebootRecovery()).isTrue();
        // The scan must actually reach the candidate query, not just no-op.
        ((EmbeddedRuntimeBroker) runtimeWarmer).recoverSavedRuntimes();
        verify(bindingRepository, atLeastOnce()).findRecoveryCandidates(
                eq("local-process"), isNull(), eq(8));
    }

    /** Removes the ambient copies of the two documented opt-out variables. */
    static class ScrubRuntimeEnv implements ApplicationContextInitializer<ConfigurableApplicationContext> {
        @Override
        public void initialize(ConfigurableApplicationContext context) {
            var filtered = new java.util.LinkedHashMap<String, Object>();
            System.getenv().forEach((name, value) -> {
                if (!"QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS".equals(name)
                        && !"QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY".equals(name)) {
                    filtered.put(name, value);
                }
            });
            context.getEnvironment().getPropertySources().replace(
                    "systemEnvironment", new MapPropertySource("systemEnvironment", filtered));
        }
    }
}
