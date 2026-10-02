package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Input for attaching Java to an existing Hosted Harness session. */
public final class LoadHarnessSession {
    private final String harnessSessionId;
    private final ManagedSessionStoreConnection managedSessionStore;
    private final boolean passiveManagedRuntimeRecovery;
    private final String toolProfile;
    private final boolean driveRuntimeRecovery;

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
        this(harnessSessionId, managedSessionStore, passiveManagedRuntimeRecovery, null);
    }

    public LoadHarnessSession(String harnessSessionId,
            ManagedSessionStoreConnection managedSessionStore,
            boolean passiveManagedRuntimeRecovery, String toolProfile) {
        this(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, false);
    }

    public LoadHarnessSession(String harnessSessionId,
            ManagedSessionStoreConnection managedSessionStore,
            boolean passiveManagedRuntimeRecovery, String toolProfile,
            boolean driveRuntimeRecovery) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                harnessSessionId, "harnessSessionId");
        this.managedSessionStore = managedSessionStore;
        this.passiveManagedRuntimeRecovery = passiveManagedRuntimeRecovery;
        this.toolProfile = toolProfile;
        this.driveRuntimeRecovery = driveRuntimeRecovery;
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
        if (toolProfile != null) {
            result.put("toolProfile", toolProfile);
        }
        if (driveRuntimeRecovery) {
            result.put("driveRuntimeRecovery", true);
        }
        return result;
    }
}
