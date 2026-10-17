package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.JavaDurableAdmission;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the opt-in java_durable admission profile (D7-3 of #14122). The only
 * bean here exists only when
 * {@code qwen.managed-agent.java-durable-admission.enabled=true}. A flag-off
 * deployment therefore has no profile: a Turn input or cancel admission
 * answers exactly as before, no Session advertises durable_operations, and a
 * request that asks for java_durable is refused before anything is read or
 * written. That byte-identical exit check is a property of this class, as
 * #14029 made it one of EventTransportConfiguration.
 */
@Configuration
@ConditionalOnProperty(prefix = "qwen.managed-agent.java-durable-admission",
        name = "enabled", havingValue = "true")
public class JavaDurableAdmissionConfiguration {
    @Bean
    public JavaDurableAdmission javaDurableAdmission(AgentStateStore store) {
        return new JavaDurableAdmission(store);
    }
}
