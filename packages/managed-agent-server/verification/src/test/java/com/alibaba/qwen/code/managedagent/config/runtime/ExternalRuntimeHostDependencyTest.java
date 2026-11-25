package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.mock;

class ExternalRuntimeHostDependencyTest {
    @Test
    void hostTransportDoesNotRequireAnExternalHttpProviderConfiguration() {
        var properties = new ManagedAgentProperties();
        var broker = properties.getRuntimeBroker();
        broker.setProvisioner("external-workspace");
        broker.setIsolationClass("session");
        broker.setBoundSessionIsolationClass("workspace");
        broker.setWorkspaceId("ma-session");
        broker.setWorkspaceCwd("/root");
        broker.setExternalProviderId("host");
        broker.setSessionCreateWarm(false);
        broker.setTrustedLocalRebootRecovery(false);
        broker.setChildWorkspacesEnabled(false);
        broker.setChildSnapshotsEnabled(false);
        broker.setVerifiedWorkspaceRecoveryEnabled(false);
        broker.setOperatorRecoveryEnabled(false);
        broker.setLocalDirectoryImportEnabled(false);
        broker.setWorkspaceMounts(List.of());
        broker.setExternalProviderUrl(null);
        broker.setExternalProviderToken(null);
        broker.setExternalStartupTimeout(Duration.ofSeconds(1));
        broker.setExternalRequestTimeout(Duration.ofSeconds(1));
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(false);
        properties.getHarness().setExternalWorkspaceShellEnabled(false);
        properties.getManagedExtensions().setEnabled(false);

        ExternalRuntimeClient client = mock(ExternalRuntimeClient.class);
        var dependencies = new RuntimeProviderDependencies() {
            @Override
            public ExternalRuntimeClient externalClient() {
                return client;
            }

            @Override
            public ExternalStorageRegistry externalStorage() {
                return mock(ExternalStorageRegistry.class);
            }
        };
        try (var provisioner = new RuntimeProviderRegistry(client).create(properties, mock(RuntimeTransport.class), dependencies)) {
            assertNotNull(provisioner);
        }
    }
}
