package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
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
                broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE), new HttpRuntimeTransport(), EMPTY)) {
            assertEquals(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE, provisioner.kind());
            assertTrue(provisioner.supportsKind(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
            assertFalse(provisioner.supportsKind(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH));
            assertFalse(provisioner.supportsDrainedStop());
            assertTrue(provisioner.supportsDrainedStopKind("external-workspace"));
            assertFalse(provisioner.supportsDrainedStopKind("external-scratch"));
            assertFalse(provisioner.supportsDrainedStop((com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord) null));
        }
    }

    @Test
    void theWorkspaceKindRefusesToStartWithoutItsRegistry() {
        var error = assertThrows(IllegalStateException.class, () -> EmbeddedRuntimeBroker
                .provisioner(broker(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE), new HttpRuntimeTransport(), null));
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
