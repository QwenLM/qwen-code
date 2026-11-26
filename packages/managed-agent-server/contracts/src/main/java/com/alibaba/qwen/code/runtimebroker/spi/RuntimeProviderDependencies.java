package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspacePhysicalTransport;

import java.util.Optional;

/** Shared application ports; providers borrow only the dependencies they need. */
public interface RuntimeProviderDependencies {
    public RuntimeProviderDependencies NONE = new RuntimeProviderDependencies() { };

    public default RuntimeBindingRepository bindings() {
        throw new IllegalStateException("Runtime binding repository is unavailable");
    }

    /** Optional transport used only by external-family providers; other providers retain their existing routing. */
    public default Optional<WorkspacePhysicalTransport> externalRuntimeTransport() {
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
