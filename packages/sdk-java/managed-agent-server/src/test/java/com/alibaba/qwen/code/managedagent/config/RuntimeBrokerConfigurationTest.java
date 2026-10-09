package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.context.annotation.Bean;

/** The real F1 rig could not be darker: the relay never ran in the real
 * Spring app because nothing registered this bean. A deletion of the
 * bean must fail this test even when every mock-injected suite stays
 * green. */
class RuntimeBrokerConfigurationTest {
    @Test
    void registersTheOwnedBrokerServiceForTheRelayAndCascade() throws Exception {
        var annotated = RuntimeBrokerConfiguration.class
                .getMethod("runtimeBrokerService", EmbeddedRuntimeBroker.class)
                .getAnnotation(Bean.class);
        assertThat(annotated).isNotNull();
        assertThat(annotated.destroyMethod()).isEmpty();
        EmbeddedRuntimeBroker embedded = Mockito.mock(
                EmbeddedRuntimeBroker.class);
        RuntimeBrokerService service = Mockito.mock(RuntimeBrokerService.class);
        Mockito.when(embedded.service()).thenReturn(service);
        assertThat(new RuntimeBrokerConfiguration()
                .runtimeBrokerService(embedded)).isSameAs(service);
        Mockito.verifyNoInteractions(service);
    }
}
