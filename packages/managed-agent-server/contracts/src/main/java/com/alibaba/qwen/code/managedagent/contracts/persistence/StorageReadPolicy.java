package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
@FunctionalInterface
public interface StorageReadPolicy {
    void requireReadable(int floor);
    static StorageReadPolicy inProcess() {
        return floor -> {
            if (floor > ManagedStorageVersions.SUPPORTED) {
                throw new ManagedAgentException(409, "managed_session_reader_version_unsupported",
                        "This reader cannot read the Managed Session storage version.");
            }
        };
    }
}
