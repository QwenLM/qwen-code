package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Input for attaching Java to an existing Hosted Harness session. */
public final class LoadHarnessSession {
    private final String harnessSessionId;
    private final ManagedSessionStoreConnection managedSessionStore;
    private final boolean passiveManagedRuntimeRecovery;

    public LoadHarnessSession(String harnessSessionId) {
        this(harnessSessionId, null, false);
    }

    public LoadHarnessSession(String harnessSessionId,
            ManagedSessionStoreConnection managedSessionStore) {
        this(harnessSessionId, managedSessionStore, false);
    }

    public LoadHarnessSession(String harnessSessionId,
            ManagedSessionStoreConnection managedSessionStore,
            boolean passiveManagedRuntimeRecovery) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                harnessSessionId, "harnessSessionId");
        this.managedSessionStore = managedSessionStore;
        this.passiveManagedRuntimeRecovery = passiveManagedRuntimeRecovery;
    }

    String getHarnessSessionId() {
        return harnessSessionId;
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        if (managedSessionStore != null) {
            result.put("managedSessionStore", managedSessionStore.toJson());
        }
        if (passiveManagedRuntimeRecovery) {
            result.put("passiveManagedRuntimeRecovery", true);
        }
        return result;
    }
}
