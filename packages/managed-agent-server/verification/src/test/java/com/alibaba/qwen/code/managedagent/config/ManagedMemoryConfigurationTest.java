package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.adapter.memory.HoloMemoryProvider;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedMemoryConfigurationTest {
    private final ManagedMemoryConfiguration configuration = new ManagedMemoryConfiguration();
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void disabledMemoryDoesNotValidateOrUseProviderConfiguration() {
        var properties = new ManagedAgentProperties();
        properties.getMemory().setEndpoint("invalid endpoint");
        var provider = configuration.managedMemoryProvider(properties, json);
        assertThat(provider.execute("synthetic-scope", null).status()).isEqualTo("unavailable");
    }

    @Test
    void enabledMemoryRequiresSessionStore() {
        var properties = new ManagedAgentProperties();
        properties.getMemory().setEnabled(true);
        properties.getMemory().setEndpoint("https://holo.internal");
        properties.getMemory().setApiKey("synthetic-key");
        properties.getSessionStore().setEnabled(false);
        assertThatThrownBy(() -> configuration.managedMemoryProvider(properties, json))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Session Store");
    }

    @Test
    void enabledMemoryRequiresEndpoint() {
        var properties = new ManagedAgentProperties();
        properties.getMemory().setEnabled(true);
        properties.getMemory().setApiKey("synthetic-key");
        properties.getSessionStore().setEnabled(true);
        assertThatThrownBy(() -> configuration.managedMemoryProvider(properties, json))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("endpoint");
    }

    @Test
    void validEnabledConfigurationCreatesTheHoloProvider() {
        var properties = new ManagedAgentProperties();
        properties.getMemory().setEnabled(true);
        properties.getMemory().setEndpoint("https://holo.internal");
        properties.getMemory().setApiKey("synthetic-key");
        properties.getSessionStore().setEnabled(true);
        assertThat(configuration.managedMemoryProvider(properties, json)).isInstanceOf(HoloMemoryProvider.class);
    }
}
