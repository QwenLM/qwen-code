package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;

import java.util.Set;

/** The configured execution backends, independent of classpath discovery. */
public record RuntimeBackendSelection(Set<String> kinds) {
    public RuntimeBackendSelection {
        kinds = Set.copyOf(kinds);
    }

    public static RuntimeBackendSelection from(ManagedAgentSettings settings) {
        var broker = settings.getRuntimeBroker();
        if (!broker.isEnabled()) {
            return new RuntimeBackendSelection(Set.of());
        }
        String primary = broker.getProvisioner();
        boolean nodes = !broker.getSsh().getNodes().isEmpty();
        if (RuntimeProviderKinds.SSH_PROCESS.equals(primary)) {
            if (!nodes) {
                throw new IllegalStateException("SSH Runtime requires configured nodes");
            }
            return new RuntimeBackendSelection(Set.of(primary));
        }
        if (nodes) {
            if (!RuntimeProviderKinds.LOCAL_PROCESS.equals(primary)) {
                throw new IllegalStateException("SSH nodes require local-process or ssh-process provisioning");
            }
            return new RuntimeBackendSelection(Set.of(primary, RuntimeProviderKinds.SSH_PROCESS));
        }
        return new RuntimeBackendSelection(Set.of(primary));
    }

    public boolean includes(String kind) {
        return kinds.contains(kind);
    }
}
