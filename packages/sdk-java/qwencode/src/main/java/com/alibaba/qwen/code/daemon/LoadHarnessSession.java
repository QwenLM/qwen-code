package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Input for attaching Java to an existing Hosted Harness session. */
public final class LoadHarnessSession {
    private final String harnessSessionId;
    private final ManagedSessionStoreConnection managedSessionStore;
    private final boolean passiveManagedRuntimeRecovery;
    private final String toolProfile;
    private final boolean driveRuntimeRecovery;
    private final boolean cancellationTakeover;
    private final boolean suppressChildAgents;
    private Map<String, Object> lifecycleAuthority;
    private int lifecycleProtocolVersion = 1;
    private Map<String, Object> agentDefinition;
    private List<Map<String, Object>> mcpServers;
    private Map<String, Object> hookCatalog;
    private boolean stopMessages;

    /**
     * #13753 I2: a copy that tells the Hosted side this control plane
     * serves child Workspaces (see {@link CreateHarnessSession.Builder#childWorkspaces}).
     */
    private boolean childWorkspaces;

    public LoadHarnessSession withAgentDefinition(Map<String, Object> value) {
        this.agentDefinition = value == null ? null : Map.copyOf(value);
        return this;
    }

    public LoadHarnessSession withMcpServers(List<Map<String, Object>> value) {
        this.mcpServers = value == null ? null : value.stream().map(Map::copyOf).collect(Collectors.toUnmodifiableList());
        return this;
    }

    public LoadHarnessSession withHookCatalog(Map<String, Object> value) {
        this.hookCatalog = value == null ? null : Map.copyOf(value);
        return this;
    }

    public LoadHarnessSession withChildWorkspaces(boolean value) {
        LoadHarnessSession copy = new LoadHarnessSession(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, driveRuntimeRecovery, cancellationTakeover,
                suppressChildAgents);
        copy.agentDefinition = agentDefinition;
        copy.mcpServers = mcpServers;
        copy.hookCatalog = hookCatalog;
        copy.lifecycleAuthority = lifecycleAuthority;
        copy.lifecycleProtocolVersion = lifecycleProtocolVersion;
        copy.childWorkspaces = value;
        copy.stopMessages = stopMessages;
        return copy;
    }

    public LoadHarnessSession forLifecycle(String operationId, long claimGeneration) {
        return forLifecycle(operationId, claimGeneration, 1);
    }

    public LoadHarnessSession forLifecycle(String operationId, long claimGeneration, int protocolVersion) {
        if (protocolVersion != 1 && protocolVersion != 2) {
            throw new IllegalArgumentException("Invalid lifecycle protocol");
        }
        if (operationId == null || !operationId.matches("[A-Za-z0-9._:-]{1,128}") || claimGeneration < 1) {
            throw new IllegalArgumentException("Invalid lifecycle authority");
        }
        LoadHarnessSession copy = new LoadHarnessSession(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, driveRuntimeRecovery, cancellationTakeover,
                suppressChildAgents);
        copy.agentDefinition = agentDefinition;
        copy.mcpServers = mcpServers;
        copy.hookCatalog = hookCatalog;
        copy.lifecycleAuthority = Map.of("operationId", operationId, "claimGeneration", claimGeneration);
        copy.lifecycleProtocolVersion = protocolVersion;
        copy.childWorkspaces = childWorkspaces;
        copy.stopMessages = stopMessages;
        return copy;
    }

    /** The load of a stopped run's child (H4f): its wake pump starts none
     * of its message inputs, from before the load can kick it. */
    public LoadHarnessSession withStoppedMessages() {
        LoadHarnessSession copy = new LoadHarnessSession(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, driveRuntimeRecovery, cancellationTakeover,
                suppressChildAgents);
        copy.agentDefinition = agentDefinition;
        copy.mcpServers = mcpServers;
        copy.hookCatalog = hookCatalog;
        copy.lifecycleAuthority = lifecycleAuthority;
        copy.lifecycleProtocolVersion = lifecycleProtocolVersion;
        copy.childWorkspaces = childWorkspaces;
        copy.stopMessages = true;
        return copy;
    }

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
        this(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile,
                driveRuntimeRecovery, false);
    }

    /** The cancellation flag is deliberately carried separately from
     * {@code passiveManagedRuntimeRecovery}: a plain passive re-attach and
     * a cancellation takeover share that wire shape today, and only an
     * explicit cancellation may let the daemon settle a parked Turn whose
     * producer is proven dead — anything else would stamp a live wait. */
    public LoadHarnessSession(String harnessSessionId,
            ManagedSessionStoreConnection managedSessionStore,
            boolean passiveManagedRuntimeRecovery, String toolProfile,
            boolean driveRuntimeRecovery, boolean cancellationTakeover) {
        this(harnessSessionId, managedSessionStore, passiveManagedRuntimeRecovery,
                toolProfile, driveRuntimeRecovery, cancellationTakeover, false);
    }

    public LoadHarnessSession(String harnessSessionId,
            ManagedSessionStoreConnection managedSessionStore,
            boolean passiveManagedRuntimeRecovery, String toolProfile,
            boolean driveRuntimeRecovery, boolean cancellationTakeover,
            boolean suppressChildAgents) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                harnessSessionId, "harnessSessionId");
        this.managedSessionStore = managedSessionStore;
        this.passiveManagedRuntimeRecovery = passiveManagedRuntimeRecovery;
        this.toolProfile = toolProfile;
        this.driveRuntimeRecovery = driveRuntimeRecovery;
        this.cancellationTakeover = cancellationTakeover;
        this.suppressChildAgents = suppressChildAgents;
    }

    String getHarnessSessionId() {
        return harnessSessionId;
    }

    boolean isRuntimeRecoveryLoad() {
        return passiveManagedRuntimeRecovery || driveRuntimeRecovery;
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
        if (suppressChildAgents) {
            result.put("suppressChildAgents", true);
        }
        if (driveRuntimeRecovery) {
            result.put("driveRuntimeRecovery", true);
        }
        if (lifecycleAuthority != null) {
            result.put("lifecycleAuthority", lifecycleAuthority);
            if (lifecycleProtocolVersion == 2) {
                result.put("lifecycleProtocolVersion", 2);
            }
        }
        if (cancellationTakeover) {
            result.put("cancellationTakeover", true);
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
        if (stopMessages) {
            result.put("stopMessages", true);
        }
        if (childWorkspaces) {
            result.put("childWorkspaces", true);
        }
        return result;
    }
}
