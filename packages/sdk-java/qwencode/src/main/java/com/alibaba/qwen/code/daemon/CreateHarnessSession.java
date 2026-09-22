package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Input for creating a Hosted Harness session with a caller-owned UUID. */
public final class CreateHarnessSession {
    private final String harnessSessionId;
    private final String approvalMode;
    private final ManagedSessionStoreConnection managedSessionStore;

    private CreateHarnessSession(Builder builder) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                builder.harnessSessionId, "harnessSessionId");
        this.approvalMode = builder.approvalMode;
        this.managedSessionStore = builder.managedSessionStore;
    }

    public static Builder builder() {
        return new Builder();
    }

    String getHarnessSessionId() {
        return harnessSessionId;
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("sessionId", harnessSessionId);
        result.put("sessionScope", "thread");
        if (approvalMode != null) {
            result.put("approvalMode", approvalMode);
        }
        if (managedSessionStore != null) {
            result.put("managedSessionStore", managedSessionStore.toJson());
        }
        return result;
    }

    public static final class Builder {
        private String harnessSessionId;
        private String approvalMode;
        private ManagedSessionStoreConnection managedSessionStore;

        private Builder() {
        }

        public Builder harnessSessionId(String harnessSessionId) {
            this.harnessSessionId = harnessSessionId;
            return this;
        }

        public Builder approvalMode(DaemonApprovalMode approvalMode) {
            if (approvalMode == null) {
                throw new IllegalArgumentException(
                        "approvalMode must not be null");
            }
            this.approvalMode = approvalMode.getWireValue();
            return this;
        }

        public Builder managedSessionStore(
                ManagedSessionStoreConnection managedSessionStore) {
            if (managedSessionStore == null) {
                throw new IllegalArgumentException(
                        "managedSessionStore must not be null");
            }
            this.managedSessionStore = managedSessionStore;
            return this;
        }

        public CreateHarnessSession build() {
            return new CreateHarnessSession(this);
        }
    }
}
