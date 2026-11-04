package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The provisioner factory must select the new kind, fail closed without its
 * durable registry, and leave every other kind exactly as it was (#15512 step 3a).
 */
class ExternalWorkspaceFactoryTest {
    private static final RuntimeProviderDependencies EMPTY = new RuntimeProviderDependencies() {
        @Override
        public ExternalStorageRegistry externalStorage() { return (tenant, alias) -> Optional.empty(); }
    };

    private static ManagedAgentProperties broker(String kind) {
        var properties = new ManagedAgentProperties();
        var broker = properties.getRuntimeBroker();
        broker.setWorkspaceId("fixture-workspace");
        broker.setWorkspaceCwd("/workspace");
        broker.setProvisioner(kind);
        broker.setTrustedLocalRebootRecovery(false);
        broker.setExternalProviderUrl("http://provider.invalid/api");
        broker.setExternalProviderToken("provider-token-for-tests");
        broker.setExternalProviderId("placement-service");
        broker.setExternalRequestTimeout(Duration.ofSeconds(7));
        broker.setExternalStartupTimeout(Duration.ofSeconds(90));
        if (com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds.isFiles(kind)) {
            properties.getHarness().setWorkspaceFilesEnabled(true);
        }
        if (com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds.isTools(kind)) {
            properties.getHarness().setWorkspaceShellEnabled(true);
            properties.getToolPublication().setEnabled(true);
            properties.getToolPublication().setServiceBaseUrl("https://publication.invalid");
            properties.getArtifacts().setEnabled(true);
        }
        return properties;
    }

    @Test
    void theWorkspaceKindGetsTheStorageBoundProvisioner() {
        try (RuntimeProvisioner provisioner = EmbeddedRuntimeBroker.provisioner(
                broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE), new HttpRuntimeTransport(), EMPTY)) {
            assertEquals(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE, provisioner.kind());
            assertTrue(provisioner.supportsKind(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
            assertFalse(provisioner.supportsKind(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH));
            assertFalse(provisioner.supportsDrainedStop());
        }
    }

    @Test
    void theFilesKindHasItsOwnDrainedStopCapabilityAndRequiresTheRegistry() {
        try (RuntimeProvisioner provisioner = EmbeddedRuntimeBroker.provisioner(
                broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_FILES), new HttpRuntimeTransport(), EMPTY)) {
            assertEquals(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_FILES, provisioner.kind());
            assertTrue(provisioner.supportsDrainedStop());
            assertFalse(provisioner.supportsKind(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
        }
        assertThrows(IllegalStateException.class, () -> EmbeddedRuntimeBroker.provisioner(
                broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_FILES), new HttpRuntimeTransport(), RuntimeProviderDependencies.NONE));
        var transportError = assertThrows(IllegalStateException.class, () -> EmbeddedRuntimeBroker.provisioner(
                broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_FILES), null, EMPTY));
        assertTrue(transportError.getMessage().contains("HTTP retirement transport"), transportError.getMessage());
    }

    @Test
    void theToolsKindUsesTheForegroundShellProvisioner() {
        try (RuntimeProvisioner provisioner = EmbeddedRuntimeBroker.provisioner(
                broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_TOOLS), new HttpRuntimeTransport(), EMPTY)) {
            assertEquals(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_TOOLS, provisioner.kind());
            assertTrue(provisioner.supportsDrainedStop());
            assertFalse(provisioner.supportsKind(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_FILES));
        }
    }

    @Test
    void theWorkspaceKindRefusesToStartWithoutItsRegistry() {
        var error = assertThrows(IllegalStateException.class, () -> EmbeddedRuntimeBroker
                .provisioner(broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE), new HttpRuntimeTransport(), RuntimeProviderDependencies.NONE));
        assertTrue(error.getMessage().contains("Managed Session Store"), error.getMessage());
    }

    @Test
    void theScratchKindKeepsItsOwnProvisioner() {
        try (RuntimeProvisioner provisioner = EmbeddedRuntimeBroker.provisioner(
                broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH), new HttpRuntimeTransport(), EMPTY)) {
            assertEquals(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH, provisioner.kind());
            assertFalse(provisioner.supportsKind(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
        }
    }

    @Test
    void anUnknownKindStillFailsClosedAndNamesBothKinds() {
        var error = assertThrows(IllegalStateException.class, () -> EmbeddedRuntimeBroker
                .provisioner(broker("external-workspace-typo"), new HttpRuntimeTransport(), EMPTY));
        assertTrue(error.getMessage().contains(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH), error.getMessage());
        assertTrue(error.getMessage().contains(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE), error.getMessage());
    }
}
