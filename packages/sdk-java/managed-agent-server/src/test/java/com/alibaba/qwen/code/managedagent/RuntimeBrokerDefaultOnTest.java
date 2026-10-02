package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Boots the production-default combination (`local-process` with durable
 * registration and trusted reboot recovery at their shipped defaults) on a
 * real Linux host. This context pins neither flag: reverting the default in
 * either `application.yml` or the `ManagedAgentProperties` initializers
 * turns it red through the binding assertions or the coupling guard.
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
@EnabledOnOs(OS.LINUX)
class RuntimeBrokerDefaultOnTest {
    @Autowired
    private RuntimeWarmer runtimeWarmer;
    @Autowired
    private ManagedAgentProperties properties;

    @Test
    void defaultCombinationBootsWithTheYmlDefaultsBound() {
        assertThat(runtimeWarmer).isInstanceOf(EmbeddedRuntimeBroker.class);
        var broker = properties.getRuntimeBroker();
        assertThat(broker.isDurableLocalProcess()).isTrue();
        assertThat(broker.isTrustedLocalRebootRecovery()).isTrue();
        // No saved bindings: the scheduled scan is a no-op and must not throw.
        ((EmbeddedRuntimeBroker) runtimeWarmer).recoverSavedRuntimes();
    }
}
