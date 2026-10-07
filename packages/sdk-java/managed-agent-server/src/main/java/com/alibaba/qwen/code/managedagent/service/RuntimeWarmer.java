package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
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

    /**
     * The W2 settlement probe: verifies the target directory of a cwd
     * change against the administrator mount mapping, its continuity and
     * the storage guard, without claiming storage or contacting a worker.
     * A warmer without a Workspace Runtime cannot answer it; admission is
     * gated on the workspace-files deployment shape, which requires one.
     * The refusal is a terminal workspace_unavailable, never a retry.
     */
    default void verifyWorkspaceCwdTarget(ContextBinding binding,
            String targetCwdRelative) {
        throw WorkspaceExecutionStore.unavailable();
    }
}
