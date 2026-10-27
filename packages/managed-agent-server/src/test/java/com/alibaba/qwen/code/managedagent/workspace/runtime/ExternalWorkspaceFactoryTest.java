package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
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
    private static final ExternalStorageRegistry EMPTY = (tenant, alias) -> Optional.empty();

    private static ManagedAgentProperties.RuntimeBroker broker(String kind) {
        var broker = new ManagedAgentProperties.RuntimeBroker();
        broker.setProvisioner(kind);
        broker.setTrustedLocalRebootRecovery(false);
        broker.setExternalProviderUrl("http://provider.invalid/api");
        broker.setExternalProviderToken("provider-token-for-tests");
        broker.setExternalProviderId("placement-service");
        broker.setExternalRequestTimeout(Duration.ofSeconds(7));
        broker.setExternalStartupTimeout(Duration.ofSeconds(90));
        return broker;
    }

    @Test
    void theWorkspaceKindGetsTheStorageBoundProvisioner() {
        try (RuntimeProvisioner provisioner = EmbeddedRuntimeBroker.provisioner(
                broker(ExternalWorkspaceProvisioner.KIND), new HttpRuntimeTransport(), EMPTY)) {
            assertEquals(ExternalWorkspaceProvisioner.KIND, provisioner.kind());
            assertTrue(provisioner.supportsKind(ExternalWorkspaceProvisioner.KIND));
            assertFalse(provisioner.supportsKind(ExternalRuntimeProvisioner.KIND));
            assertFalse(provisioner.supportsDrainedStop());
        }
    }

    @Test
    void theWorkspaceKindRefusesToStartWithoutItsRegistry() {
        var error = assertThrows(IllegalStateException.class, () -> EmbeddedRuntimeBroker
                .provisioner(broker(ExternalWorkspaceProvisioner.KIND), new HttpRuntimeTransport(), null));
        assertTrue(error.getMessage().contains("Managed Session Store"), error.getMessage());
    }

    @Test
    void theScratchKindKeepsItsOwnProvisioner() {
        try (RuntimeProvisioner provisioner = EmbeddedRuntimeBroker.provisioner(
                broker(ExternalRuntimeProvisioner.KIND), new HttpRuntimeTransport(), EMPTY)) {
            assertEquals(ExternalRuntimeProvisioner.KIND, provisioner.kind());
            assertFalse(provisioner.supportsKind(ExternalWorkspaceProvisioner.KIND));
        }
    }

    @Test
    void anUnknownKindStillFailsClosedAndNamesBothKinds() {
        var error = assertThrows(IllegalStateException.class, () -> EmbeddedRuntimeBroker
                .provisioner(broker("external-workspace-typo"), new HttpRuntimeTransport(), EMPTY));
        assertTrue(error.getMessage().contains(ExternalRuntimeProvisioner.KIND), error.getMessage());
        assertTrue(error.getMessage().contains(ExternalWorkspaceProvisioner.KIND), error.getMessage());
    }
}
