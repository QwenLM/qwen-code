package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Options for creating a daemon session. */
public final class CreateSessionRequest {
    private final String workspaceCwd;
    private final String approvalMode;
    private final String sessionScope;

    private CreateSessionRequest(Builder builder) {
        this.workspaceCwd = builder.workspaceCwd;
        this.approvalMode = builder.approvalMode;
        this.sessionScope = builder.sessionScope;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static CreateSessionRequest defaults() {
        return builder().build();
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        if (workspaceCwd != null) {
            result.put("cwd", workspaceCwd);
        }
        if (approvalMode != null) {
            result.put("approvalMode", approvalMode);
        }
        result.put("sessionScope", sessionScope);
        return result;
    }

    public static final class Builder {
        private String workspaceCwd;
        private String approvalMode;
        private String sessionScope = "thread";

        private Builder() {
        }

        public Builder workspaceCwd(String workspaceCwd) {
            this.workspaceCwd = requireNonBlank(workspaceCwd, "workspaceCwd");
            return this;
        }

        public Builder approvalMode(DaemonApprovalMode approvalMode) {
            if (approvalMode == null) {
                throw new IllegalArgumentException("approvalMode must not be null");
            }
            this.approvalMode = approvalMode.getWireValue();
            return this;
        }

        public Builder rawApprovalMode(String approvalMode) {
            this.approvalMode = requireNonBlank(approvalMode, "approvalMode");
            return this;
        }

        public Builder sessionScope(String sessionScope) {
            if (!"thread".equals(sessionScope) && !"single".equals(sessionScope)) {
                throw new IllegalArgumentException("sessionScope must be thread or single");
            }
            this.sessionScope = sessionScope;
            return this;
        }

        public CreateSessionRequest build() {
            return new CreateSessionRequest(this);
        }

        private static String requireNonBlank(String value, String name) {
            if (value == null || value.trim().isEmpty()) {
                throw new IllegalArgumentException(name + " must not be blank");
            }
            return value;
        }
    }
}
