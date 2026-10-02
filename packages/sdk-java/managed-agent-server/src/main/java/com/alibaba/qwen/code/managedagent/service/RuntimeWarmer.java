package com.alibaba.qwen.code.managedagent.service;

import java.util.concurrent.CompletionStage;

public interface RuntimeWarmer {
    boolean isEnabled();

    CompletionStage<Void> warm(String sessionId);

    CompletionStage<Void> drain(String sessionId);

    default boolean supportsWorkspaceClose() {
        return false;
    }

    default void requestWorkspaceClose(String tenantId, String sessionId) {
        throw new UnsupportedOperationException("Workspace close is unavailable");
    }

    default CompletionStage<Void> closeWorkspace(String tenantId, String sessionId) {
        return java.util.concurrent.CompletableFuture.failedFuture(
                new UnsupportedOperationException("Workspace close is unavailable"));
    }
}
