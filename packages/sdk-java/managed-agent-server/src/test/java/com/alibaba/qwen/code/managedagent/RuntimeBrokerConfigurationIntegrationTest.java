package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:runtime-broker-config;MODE=MySQL;"
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
        "qwen.managed-agent.runtime-broker.provisioner=static",
        "qwen.managed-agent.runtime-broker.workspace-id=workspace",
        "qwen.managed-agent.runtime-broker.workspace-cwd=workspace",
        "qwen.managed-agent.runtime-broker.isolation-class=workspace",
        "qwen.managed-agent.runtime-broker.static-endpoint=http://127.0.0.1:9",
        "qwen.managed-agent.runtime-broker.static-token=runtime-token"
})
class RuntimeBrokerConfigurationIntegrationTest {
    @Autowired
    private RuntimeWarmer runtimeWarmer;

    @Test
    void selectsTheEmbeddedBrokerAsTheRuntimeWarmer() {
        assertThat(runtimeWarmer).isInstanceOf(EmbeddedRuntimeBroker.class);
    }
}
