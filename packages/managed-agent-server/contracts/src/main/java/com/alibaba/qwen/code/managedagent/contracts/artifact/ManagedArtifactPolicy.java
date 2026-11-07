package com.alibaba.qwen.code.managedagent.contracts.artifact;

public interface ManagedArtifactPolicy {
    /** A stable configuration fingerprint that changes whenever a policy decision changes. */
    public String version();

    public boolean publishOriginal(String tenantId, String workspaceId,
            String sessionId);

    public boolean publishPreview(String tenantId, String workspaceId,
            String sessionId);

    public boolean readOriginal(String tenantId, String actorId, String workspaceId,
            String sessionId);
}
