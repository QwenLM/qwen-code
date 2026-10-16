package com.alibaba.qwen.code.managedagent.service;

public interface ManagedArtifactPolicy {
    /** A stable configuration fingerprint that changes whenever a policy decision changes. */
    String version();

    boolean publishOriginal(String tenantId, String workspaceId,
            String sessionId);

    boolean publishPreview(String tenantId, String workspaceId,
            String sessionId);

    boolean readOriginal(String tenantId, String actorId, String workspaceId,
            String sessionId);
}
