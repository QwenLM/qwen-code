package com.alibaba.qwen.code.runtimebroker.provisioning.external;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Duration;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class ExternalRuntimeProviderFactoryTest {
    @Test
    void embedsAHostClientWithoutExternalProviderSettings() {
        var settings = settings();
        var external = mock(ExternalRuntimeClient.class);
        var registry = mock(ExternalStorageRegistry.class);
        var dependencies = new RuntimeProviderDependencies() {
            @Override
            public Optional<ExternalRuntimeClient> externalRuntime() {
                return Optional.of(external);
            }

            @Override
            public ExternalStorageRegistry externalStorage() {
                return registry;
            }
        };
        var factory = new ExternalRuntimeProviderFactory();
        assertDoesNotThrow(() -> factory.validate(settings, dependencies));
        assertDoesNotThrow(() -> new ManagedAgentConfiguration(settings, external));
        try (var provisioner = factory.create(settings, null, dependencies)) {
            assertInstanceOf(ExternalWorkspaceProvisioner.class, provisioner);
            assertSame(external, ReflectionTestUtils.getField(provisioner, "client"));
        }
        verifyNoInteractions(external, registry);
        settings.getRuntimeBroker().setExternalProviderUrl(null);
        settings.getRuntimeBroker().setExternalProviderToken(null);
        assertThrows(IllegalStateException.class, () -> factory.validate(settings));
    }

    @Test
    void embedsAHostRuntimeTransport() {
        RuntimeTransport selected = mock(RuntimeTransport.class);
        var dependencies = new RuntimeProviderDependencies() {
            @Override
            public Optional<ExternalRuntimeClient> externalRuntime() {
                return Optional.of(mock(ExternalRuntimeClient.class));
            }

            @Override
            public java.util.Optional<RuntimeTransport> externalRuntimeTransport() {
                return Optional.of(selected);
            }

            @Override
            public ExternalStorageRegistry externalStorage() {
                return mock(ExternalStorageRegistry.class);
            }
        };
        var factory = new ExternalRuntimeProviderFactory();
        try (var provisioner = factory.create(settings(), null, dependencies)) {
            assertSame(selected, ReflectionTestUtils.getField(provisioner, "transport"));
        }
    }

    @Test
    void retainsNetworkValidationWithoutAHostClient() {
        var settings = settings();
        settings.getRuntimeBroker().setExternalProviderToken("");
        var factory = new ExternalRuntimeProviderFactory();
        assertThrows(IllegalStateException.class, () -> factory.validate(settings));
        assertThrows(IllegalStateException.class, () -> factory.create(settings, null, RuntimeProviderDependencies.NONE));
    }

    private static ManagedAgentProperties settings() {
        var settings = new ManagedAgentProperties();
        var broker = settings.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setProvisioner("external-workspace");
        broker.setExternalProviderUrl("http://provider.invalid/api");
        broker.setExternalProviderToken("provider-token-for-tests");
        broker.setExternalProviderId("placement-service");
        broker.setExternalRequestTimeout(Duration.ofSeconds(5));
        broker.setExternalStartupTimeout(Duration.ofSeconds(30));
        broker.setWorkspaceId("workspace");
        broker.setWorkspaceCwd("/worker/workspace");
        broker.setBoundSessionIsolationClass("workspace");
        broker.setTrustedLocalRebootRecovery(false);
        return settings;
    }
}
