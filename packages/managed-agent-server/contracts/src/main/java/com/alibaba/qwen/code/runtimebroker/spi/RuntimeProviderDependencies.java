package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;

/** Shared application ports; providers borrow only the dependencies they need. */
public interface RuntimeProviderDependencies {
    public RuntimeProviderDependencies NONE = new RuntimeProviderDependencies() { };

    public default RuntimeBindingRepository bindings() {
        throw new IllegalStateException("Runtime binding repository is unavailable");
    }

    public default ExternalStorageRegistry externalStorage() {
        throw new IllegalStateException("External Workspace provisioning requires the Managed Session Store database");
    }

    public default SshRuntimeAccess ssh() {
        throw new IllegalStateException("SSH Workspace access is unavailable");
    }

    /** Optional Java implementation; null retains the stock HTTP provider. */
    public default ExternalRuntimeClient externalClient() {
        return null;
    }
}
