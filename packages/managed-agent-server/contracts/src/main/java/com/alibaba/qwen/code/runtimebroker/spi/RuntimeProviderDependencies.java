package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations;
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

    public default WorkspaceCsiReservations csiReservations() {
        throw new IllegalStateException("Resident Workspace requires original JDBC authority");
    }

    public default SshRuntimeAccess ssh() {
        throw new IllegalStateException("SSH Workspace access is unavailable");
    }
}
