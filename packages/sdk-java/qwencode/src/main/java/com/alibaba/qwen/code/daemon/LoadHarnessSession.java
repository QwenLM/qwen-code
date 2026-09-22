package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Input for attaching Java to an existing Hosted Harness session. */
public final class LoadHarnessSession {
    private final String harnessSessionId;
    private final ManagedSessionStoreConnection managedSessionStore;

    public LoadHarnessSession(String harnessSessionId) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                harnessSessionId, "harnessSessionId");
        this.managedSessionStore = null;
    }

    public LoadHarnessSession(String harnessSessionId,
            ManagedSessionStoreConnection managedSessionStore) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                harnessSessionId, "harnessSessionId");
        if (managedSessionStore == null) {
            throw new IllegalArgumentException(
                    "managedSessionStore must not be null");
        }
        this.managedSessionStore = managedSessionStore;
    }

    String getHarnessSessionId() {
        return harnessSessionId;
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        if (managedSessionStore != null) {
            result.put("managedSessionStore", managedSessionStore.toJson());
        }
        return result;
    }
}
