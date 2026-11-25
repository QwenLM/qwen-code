package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;

import java.util.Optional;

/** Shared application ports; providers borrow only the dependencies they need. */
public interface RuntimeProviderDependencies {
    public RuntimeProviderDependencies NONE = new RuntimeProviderDependencies() { };

    public default RuntimeBindingRepository bindings() {
        throw new IllegalStateException("Runtime binding repository is unavailable");
    }

    /** Optional transport for the external Runtime protocol; absence retains direct HTTP. */
    public default Optional<RuntimeTransport> externalRuntimeTransport() {
        return Optional.empty();
    }

    /** Optional same-process placement port; absence retains the external HTTP transport. */
    public default Optional<ExternalRuntimeClient> externalRuntime() {
        return Optional.empty();
    }

    public default ExternalStorageRegistry externalStorage() {
        throw new IllegalStateException("External Workspace provisioning requires the Managed Session Store database");
    }

    public default SshRuntimeAccess ssh() {
        throw new IllegalStateException("SSH Workspace access is unavailable");
    }
}
