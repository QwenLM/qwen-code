package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.external.ExternalRuntimeProviderFactory;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;

import java.net.URLClassLoader;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class RuntimeProviderRegistryTest {
    @Test
    void discoversApplicationProvidersEvenWhenTheCallingThreadCannotSeeThem() {
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(new ClassLoader(null) { });
        try {
            assertThat(new RuntimeProviderRegistry().require("external-workspace"))
                    .isInstanceOf(ExternalRuntimeProviderFactory.class);
        } finally {
            thread.setContextClassLoader(previous);
        }
    }

    @Test
    void discoversThroughItsDefiningLoaderRatherThanTheSystemLoader() throws Exception {
        try (var defining = new URLClassLoader(RuntimeProviderLoaders.testClasspath(),
                ClassLoader.getPlatformClassLoader())) {
            RuntimeProviderLoaders.withContextLoader(new ClassLoader(null) { }, () -> {
                var registry = defining.loadClass(RuntimeProviderRegistry.class.getName())
                        .getConstructor().newInstance();
                var factory = registry.getClass().getMethod("require", String.class)
                        .invoke(registry, "external-workspace");
                assertThat(factory.getClass().getClassLoader()).isSameAs(defining);
            });
        }
    }

    @Test
    void closesAProviderWhoseIdentityDiffersFromTheConfiguredKind() {
        var settings = new ManagedAgentProperties();
        settings.getRuntimeBroker().setProvisioner("expected");
        var factory = mock(RuntimeProviderFactory.class);
        var provider = mock(RuntimeProvisioner.class);
        when(factory.kinds()).thenReturn(Set.of("expected"));
        when(factory.create(settings, null, null)).thenReturn(provider);
        when(provider.kind()).thenReturn("different");
        assertThatThrownBy(() -> new RuntimeProviderRegistry(List.of(factory)).create(settings, null, null))
                .hasMessageContaining("kind differs from configured kind: expected");
        org.mockito.Mockito.verify(provider).close();
    }

    @Test
    void rejectsMissingAndDuplicateKindsWithoutCreatingProviders() {
        assertThatThrownBy(() -> new RuntimeProviderRegistry(List.of()).require("missing"))
                .hasMessageContaining("not installed: missing");
        var first = mock(RuntimeProviderFactory.class);
        var second = mock(RuntimeProviderFactory.class);
        when(first.kinds()).thenReturn(Set.of("same"));
        when(second.kinds()).thenReturn(Set.of("same"));
        assertThatThrownBy(() -> new RuntimeProviderRegistry(List.of(first, second)))
                .hasMessageContaining("Duplicate Runtime provider kind: same");
        org.mockito.Mockito.verify(first).kinds();
        org.mockito.Mockito.verify(second).kinds();
        verifyNoMoreInteractions(first, second);
    }
}
