package com.alibaba.qwen.code.managedagent.service;

public interface ManagedArtifactPolicy {
    String version();

    boolean publishOriginal(String tenantId, String workspaceId,
            String sessionId);

    boolean publishPreview(String tenantId, String workspaceId,
            String sessionId);

    boolean readOriginal(String tenantId, String actorId, String workspaceId,
            String sessionId);
}
