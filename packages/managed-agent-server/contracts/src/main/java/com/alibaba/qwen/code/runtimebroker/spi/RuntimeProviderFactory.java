package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;

import java.util.List;
import java.util.Set;

/** Classpath plugin. Construction and kind discovery must not allocate Runtime resources. */
public interface RuntimeProviderFactory {
    public Set<String> kinds();

    /** Configuration-only validation; no clients, workers or host probes. */
    public default void validate(ManagedAgentSettings settings) {
    }

    /** The caller owns and closes the returned provider. Clean up partial creation on failure. */
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies);

    public default List<Check> preflight(ManagedAgentSettings settings) {
        return List.of();
    }

    public default boolean usesLocalWorkspace() {
        return false;
    }

    /** Offline recovery only: this path must never acquire or launch a worker. */
    public default OperatorRuntimeRecovery createForMaintenance(ManagedAgentSettings.RuntimeBroker settings,
            RuntimeTransport transport) {
        throw new IllegalStateException("Runtime provider does not support offline operator recovery");
    }

    public record Check(String name, Status status, String detail, String remediation) {
    }

    public enum Status { PASS, WARN, FAIL, SKIP }
}
