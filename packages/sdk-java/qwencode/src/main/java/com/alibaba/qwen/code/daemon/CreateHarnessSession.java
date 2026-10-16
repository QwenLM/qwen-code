package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Input for creating a Hosted Harness session with a caller-owned UUID. */
public final class CreateHarnessSession {
    private final String harnessSessionId;
    private final String approvalMode;
    private final ManagedSessionStoreConnection managedSessionStore;
    private final String toolProfile;
    private final Long approvalTimeoutMs;
    private final Long captureBytes;
    private final Map<String, Object> agentDefinition;
    private final List<Map<String, Object>> mcpServers;
    private final Map<String, Object> hookCatalog;
    private final Map<String, Object> lineage;
    private final boolean suppressChildAgents;
    private final boolean childWorkspaces;

    private CreateHarnessSession(Builder builder) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                builder.harnessSessionId, "harnessSessionId");
        this.approvalMode = builder.approvalMode;
        this.managedSessionStore = builder.managedSessionStore;
        this.toolProfile = builder.toolProfile;
        this.approvalTimeoutMs = builder.approvalTimeoutMs;
        this.captureBytes = builder.captureBytes;
        this.agentDefinition = builder.agentDefinition;
        this.mcpServers = builder.mcpServers;
        this.hookCatalog = builder.hookCatalog;
        this.lineage = builder.lineage;
        this.suppressChildAgents = builder.suppressChildAgents;
        this.childWorkspaces = builder.childWorkspaces;
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
        if (toolProfile != null) {
            result.put("toolProfile", toolProfile);
        }
        if (suppressChildAgents) {
            result.put("suppressChildAgents", true);
        }
        if (approvalTimeoutMs != null) {
            result.put("approvalTimeoutMs", approvalTimeoutMs);
        }
        if (captureBytes != null) {
            result.put("captureBytes", captureBytes);
        }
        if (agentDefinition != null) {
            result.put("agentDefinition", agentDefinition);
        }
        if (mcpServers != null) {
            result.put("mcpServers", mcpServers);
        }
        if (hookCatalog != null) {
            result.put("hookCatalog", hookCatalog);
        }
        if (lineage != null) {
            result.put("lineage", lineage);
        }
        if (childWorkspaces) {
            result.put("childWorkspaces", true);
        }
        return result;
    }

    public static final class Builder {
        private String harnessSessionId;
        private String approvalMode;
        private ManagedSessionStoreConnection managedSessionStore;
        private String toolProfile;
        private Long approvalTimeoutMs;
        private Long captureBytes;
        private Map<String, Object> agentDefinition;
        private List<Map<String, Object>> mcpServers;
        private Map<String, Object> hookCatalog;
        private Map<String, Object> lineage;
        private boolean suppressChildAgents;
        private boolean childWorkspaces;

        /**
         * #13753 I2: whether this control plane serves child Workspaces, so
         * the Hosted Agent tool admits {@code isolation: "worktree"}. It
         * describes the host, so it travels on every create and load and is
         * never persisted with the Session.
         */
        public Builder childWorkspaces(boolean value) {
            this.childWorkspaces = value;
            return this;
        }

        public Builder agentDefinition(Map<String, Object> value) {
            this.agentDefinition = Map.copyOf(value);
            return this;
        }

        public Builder mcpServers(List<Map<String, Object>> value) {
            this.mcpServers = value.stream().map(Map::copyOf).collect(Collectors.toUnmodifiableList());
            return this;
        }

        public Builder hookCatalog(Map<String, Object> value) {
            this.hookCatalog = Map.copyOf(value);
            return this;
        }

        public Builder approvalTimeoutMs(long value) {
            if (value < 1000 || value > 86400000) {
                throw new IllegalArgumentException("Invalid approval timeout");
            }
            this.approvalTimeoutMs = value;
            return this;
        }

        /** Raw Shell output budget for remote publication, persisted with the Session. */
        public Builder captureBytes(long value) {
            if (value < 1 || value > (1L << 41)) {
                throw new IllegalArgumentException("Invalid capture byte budget");
            }
            this.captureBytes = value;
            return this;
        }

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

        public Builder toolProfile(String toolProfile) {
            this.toolProfile = toolProfile;
            return this;
        }

        /** Public Shell admission keeps the private Shell lane's child agent tool off this Session. */
        public Builder suppressChildAgents() {
            this.suppressChildAgents = true;
            return this;
        }

        /**
         * H4b: a child Session's ancestry. The body names the parent and
         * root Sessions, the launching child run id and the tree depth; the
         * Hosted side persists it with the Session's definition, so a load
         * answers the same depth.
         */
        public Builder lineage(String parentSessionId, String rootSessionId,
                String parentChildRunId, int depth) {
            HostedHarnessClient.requireUuid(parentSessionId,
                    "lineage.parentSessionId");
            HostedHarnessClient.requireUuid(rootSessionId,
                    "lineage.rootSessionId");
            if (parentChildRunId == null || parentChildRunId.isBlank()
                    || parentChildRunId.length() > 128) {
                throw new IllegalArgumentException(
                        "Invalid lineage child run id");
            }
            if (depth < 1 || depth > 8) {
                throw new IllegalArgumentException(
                        "lineage depth must be 1..8");
            }
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("parentSessionId", parentSessionId);
            value.put("rootSessionId", rootSessionId);
            value.put("parentChildRunId", parentChildRunId);
            value.put("depth", depth);
            this.lineage = value;
            return this;
        }
    }
}
