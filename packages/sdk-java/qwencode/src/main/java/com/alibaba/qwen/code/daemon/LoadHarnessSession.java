package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Input for attaching Java to an existing Hosted Harness session. */
public final class LoadHarnessSession {
    private final String harnessSessionId;
    private HostedHarnessPlacement harnessPlacement;
    private final ManagedSessionStoreConnection managedSessionStore;
    private final boolean passiveManagedRuntimeRecovery;
    private final String toolProfile;
    private final boolean driveRuntimeRecovery;
    private final boolean cancellationTakeover;
    private final boolean suppressChildAgents;
    private Map<String, Object> lifecycleAuthority;
    private int lifecycleProtocolVersion = 1;
    private Map<String, Object> agentDefinition;
    private Map<String, Object> sessionSkillsRef;
    private Map<String, Object> initialSelection;
    private List<Map<String, Object>> mcpServers;
    private Map<String, Object> hookCatalog;
    private int publicChildAgentsVersion;
    private Map<String, Object> publicChildModelRoute;
    private Map<String, Object> publicChildExtensionAgent;
    private boolean stopMessages;
    private boolean foregroundOnly;
    private boolean fileRewindEnabled = true;
    private String recoveryCleanupPromptId;
    private String cancellationPromptId;

    /** Opens only the original terminal input's cleanup, without starting a Harness turn. */
    public LoadHarnessSession forRecoveryCleanup(String promptId) {
        if (passiveManagedRuntimeRecovery || driveRuntimeRecovery || cancellationTakeover || lifecycleAuthority != null
                || cancellationPromptId != null) {
            throw new IllegalArgumentException("Cleanup load cannot drive Runtime or lifecycle recovery");
        }
        recoveryCleanupPromptId = HostedHarnessClient.requireUuid(promptId, "promptId");
        return this;
    }

    /** Restricts a cancellation takeover to the original input. */
    public LoadHarnessSession withCancellationPromptId(String promptId) {
        if (!passiveManagedRuntimeRecovery || !cancellationTakeover || driveRuntimeRecovery
                || lifecycleAuthority != null || recoveryCleanupPromptId != null) {
            throw new IllegalArgumentException("Targeted cancellation requires a passive cancellation takeover");
        }
        cancellationPromptId = HostedHarnessClient.requireUuid(promptId, "promptId");
        return this;
    }

    String getCancellationPromptId() {
        return cancellationPromptId;
    }

    String getRecoveryCleanupPromptId() {
        return recoveryCleanupPromptId;
    }

    /**
     * #13753 I2: a copy that tells the Hosted side this control plane
     * serves child Workspaces (see {@link CreateHarnessSession.Builder#childWorkspaces}).
     */
    private boolean childWorkspaces;
    /** #13753 I3: with child Workspaces, the control plane serves snapshots too. */
    private boolean childSnapshots;

    public LoadHarnessSession withPublicChildExtensionAgent(Map<String, Object> value) {
        this.publicChildExtensionAgent = value == null ? null : Map.copyOf(value);
        return this;
    }

    public LoadHarnessSession withPublicChildModelRoute(Map<String, Object> value) {
        this.publicChildModelRoute = value == null ? null : Map.copyOf(value);
        return this;
    }

    public LoadHarnessSession withPublicChildAgentsVersion(int value) {
        if (value != 0 && value != 1) {
            throw new IllegalArgumentException("Invalid public child agents version");
        }
        this.publicChildAgentsVersion = value;
        return this;
    }

    public LoadHarnessSession withHarnessPlacement(HostedHarnessPlacement value) {
        this.harnessPlacement = value;
        return this;
    }

    public LoadHarnessSession withAgentDefinition(Map<String, Object> value) {
        this.agentDefinition = value == null ? null : Map.copyOf(value);
        return this;
    }

    public LoadHarnessSession withInitialSelection(Map<String, Object> value) {
        this.initialSelection = value == null ? null : Map.copyOf(value);
        return this;
    }

    public LoadHarnessSession withSessionSkillsRef(Map<String, Object> value) {
        this.sessionSkillsRef = value == null ? null : Map.copyOf(value);
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

    /**
     * Keeps the snapshot capability this copy carries, as every other copy
     * does, so only turning child Workspaces off drops it.
     */
    public LoadHarnessSession withChildWorkspaces(boolean value) {
        return withChildWorkspaces(value, childSnapshots);
    }

    /**
     * #13753 I3: the copy also says whether the control plane serves
     * read-only snapshot children, which only a host that serves child
     * Workspaces can (see {@link CreateHarnessSession.Builder#childSnapshots}).
     */
    public LoadHarnessSession withChildWorkspaces(boolean value, boolean snapshots) {
        LoadHarnessSession copy = new LoadHarnessSession(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, driveRuntimeRecovery, cancellationTakeover,
                suppressChildAgents);
        copy.harnessPlacement = harnessPlacement;
        copy.agentDefinition = agentDefinition;
        copy.sessionSkillsRef = sessionSkillsRef;
        copy.initialSelection = initialSelection;
        copy.mcpServers = mcpServers;
        copy.hookCatalog = hookCatalog;
        copy.lifecycleAuthority = lifecycleAuthority;
        copy.lifecycleProtocolVersion = lifecycleProtocolVersion;
        copy.childWorkspaces = value;
        copy.childSnapshots = value && snapshots;
        copy.stopMessages = stopMessages;
        copy.foregroundOnly = foregroundOnly;
        copy.fileRewindEnabled = fileRewindEnabled;
        copy.recoveryCleanupPromptId = recoveryCleanupPromptId;
        copy.cancellationPromptId = cancellationPromptId;
        copy.publicChildAgentsVersion = publicChildAgentsVersion;
        copy.publicChildModelRoute = publicChildModelRoute;
        copy.publicChildExtensionAgent = publicChildExtensionAgent;
        return copy;
    }

    public LoadHarnessSession withFileRewindEnabled(boolean value) {
        this.fileRewindEnabled = value;
        return this;
    }

    /** Restates the immutable SSH Session tool restriction on every attachment. */
    public LoadHarnessSession withForegroundOnly(boolean value) {
        LoadHarnessSession copy = new LoadHarnessSession(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, driveRuntimeRecovery, cancellationTakeover,
                suppressChildAgents);
        copy.harnessPlacement = harnessPlacement;
        copy.agentDefinition = agentDefinition;
        copy.sessionSkillsRef = sessionSkillsRef;
        copy.initialSelection = initialSelection;
        copy.mcpServers = mcpServers;
        copy.hookCatalog = hookCatalog;
        copy.lifecycleAuthority = lifecycleAuthority;
        copy.lifecycleProtocolVersion = lifecycleProtocolVersion;
        copy.childWorkspaces = childWorkspaces;
        copy.childSnapshots = childSnapshots;
        copy.stopMessages = stopMessages;
        copy.foregroundOnly = value;
        copy.fileRewindEnabled = fileRewindEnabled;
        copy.recoveryCleanupPromptId = recoveryCleanupPromptId;
        copy.cancellationPromptId = cancellationPromptId;
        copy.publicChildAgentsVersion = publicChildAgentsVersion;
        copy.publicChildModelRoute = publicChildModelRoute;
        copy.publicChildExtensionAgent = publicChildExtensionAgent;
        return copy;
    }

    public LoadHarnessSession forLifecycle(String operationId, long claimGeneration) {
        return forLifecycle(operationId, claimGeneration, 1);
    }

    public LoadHarnessSession forLifecycle(String operationId, long claimGeneration, int protocolVersion) {
        if (recoveryCleanupPromptId != null || cancellationPromptId != null) {
            throw new IllegalArgumentException("Cleanup or cancellation load cannot drive lifecycle recovery");
        }
        if (protocolVersion != 1 && protocolVersion != 2) {
            throw new IllegalArgumentException("Invalid lifecycle protocol");
        }
        if (operationId == null || !operationId.matches("[A-Za-z0-9._:-]{1,128}") || claimGeneration < 1) {
            throw new IllegalArgumentException("Invalid lifecycle authority");
        }
        LoadHarnessSession copy = new LoadHarnessSession(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, driveRuntimeRecovery, cancellationTakeover,
                suppressChildAgents);
        copy.harnessPlacement = harnessPlacement;
        copy.agentDefinition = agentDefinition;
        copy.sessionSkillsRef = sessionSkillsRef;
        copy.initialSelection = initialSelection;
        copy.mcpServers = mcpServers;
        copy.hookCatalog = hookCatalog;
        copy.lifecycleAuthority = Map.of("operationId", operationId, "claimGeneration", claimGeneration);
        copy.lifecycleProtocolVersion = protocolVersion;
        copy.childWorkspaces = childWorkspaces;
        copy.childSnapshots = childSnapshots;
        copy.stopMessages = stopMessages;
        copy.foregroundOnly = foregroundOnly;
        copy.fileRewindEnabled = fileRewindEnabled;
        copy.recoveryCleanupPromptId = recoveryCleanupPromptId;
        copy.cancellationPromptId = cancellationPromptId;
        copy.publicChildAgentsVersion = publicChildAgentsVersion;
        copy.publicChildModelRoute = publicChildModelRoute;
        copy.publicChildExtensionAgent = publicChildExtensionAgent;
        return copy;
    }

    /** The load of a stopped run's child (H4f): its wake pump starts none
     * of its message inputs, from before the load can kick it. */
    public LoadHarnessSession withStoppedMessages() {
        LoadHarnessSession copy = new LoadHarnessSession(harnessSessionId, managedSessionStore,
                passiveManagedRuntimeRecovery, toolProfile, driveRuntimeRecovery, cancellationTakeover,
                suppressChildAgents);
        copy.harnessPlacement = harnessPlacement;
        copy.agentDefinition = agentDefinition;
        copy.sessionSkillsRef = sessionSkillsRef;
        copy.initialSelection = initialSelection;
        copy.mcpServers = mcpServers;
        copy.hookCatalog = hookCatalog;
        copy.lifecycleAuthority = lifecycleAuthority;
        copy.lifecycleProtocolVersion = lifecycleProtocolVersion;
        copy.childWorkspaces = childWorkspaces;
        copy.childSnapshots = childSnapshots;
        copy.stopMessages = true;
        copy.foregroundOnly = foregroundOnly;
        copy.fileRewindEnabled = fileRewindEnabled;
        copy.recoveryCleanupPromptId = recoveryCleanupPromptId;
        copy.cancellationPromptId = cancellationPromptId;
        copy.publicChildAgentsVersion = publicChildAgentsVersion;
        copy.publicChildModelRoute = publicChildModelRoute;
        copy.publicChildExtensionAgent = publicChildExtensionAgent;
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
        if (harnessPlacement != null) {
            result.put("harnessPlacement", harnessPlacement.toJson());
        }
        if (recoveryCleanupPromptId != null) {
            result.put("recoveryCleanupPromptId", recoveryCleanupPromptId);
        }
        if (cancellationPromptId != null) {
            result.put("cancellationPromptId", cancellationPromptId);
        }
        if (managedSessionStore != null) {
            result.put("managedSessionStore", managedSessionStore.toJson());
        }
        if (passiveManagedRuntimeRecovery) {
            result.put("passiveManagedRuntimeRecovery", true);
        }
        if (toolProfile != null) {
            result.put("toolProfile", toolProfile);
        }
        if (publicChildExtensionAgent != null) {
            result.put("publicChildExtensionAgent", publicChildExtensionAgent);
        }
        if (publicChildModelRoute != null) {
            result.put("publicChildModelRoute", publicChildModelRoute);
        }
        if (publicChildAgentsVersion != 0) {
            result.put("publicChildAgentsVersion", publicChildAgentsVersion);
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
        if (initialSelection != null) {
            result.put("initialSelection", initialSelection);
        }
        if (sessionSkillsRef != null) {
            result.put("sessionSkillsRef", sessionSkillsRef);
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
        if (!fileRewindEnabled) {
            result.put("fileRewindEnabled", false);
        }
        if (foregroundOnly) {
            result.put("foregroundOnly", true);
        }
        if (childSnapshots) {
            result.put("childSnapshots", true);
        }
        return result;
    }
}
