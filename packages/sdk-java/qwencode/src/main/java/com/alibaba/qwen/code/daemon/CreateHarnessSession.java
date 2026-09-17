package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Input for creating a Hosted Harness session with a caller-owned UUID. */
public final class CreateHarnessSession {
    private final String harnessSessionId;
    private final String approvalMode;

    private CreateHarnessSession(Builder builder) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                builder.harnessSessionId, "harnessSessionId");
        this.approvalMode = builder.approvalMode;
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
        return result;
    }

    public static final class Builder {
        private String harnessSessionId;
        private String approvalMode;

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

        public CreateHarnessSession build() {
            return new CreateHarnessSession(this);
        }
    }
}
