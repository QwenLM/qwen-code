package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Control-plane lifecycle bridge to the configured Runtime backend. */
public interface RuntimeWarmer {
    /** Whether this host provides Runtime warm-up; this is not a readiness probe. */
    public boolean isEnabled();

    /**
     * Prepares the binding for the original Harness Session. Completion means
     * warm-up finished; callers must still acquire their execution binding.
     * A retired Session fails instead of creating a replacement Session.
     */
    public CompletionStage<Void> warm(String sessionId);

    /**
     * Retires Session admission during close/delete. Completion alone is not
     * proof that a worker stopped or Workspace storage may be released; those
     * operations use the explicit Workspace lifecycle methods below.
     */
    public CompletionStage<Void> drain(String sessionId);

    public default boolean supportsWorkspaceClose() {
        return false;
    }

    default boolean supportsWorkspaceClose(String profile) {
        return !com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.EXTERNAL_FILES.equals(profile)
                && supportsWorkspaceClose();
    }

    public default boolean supportsWorkspaceClose(ContextBinding binding) {
        return supportsWorkspaceClose();
    }

    public static boolean supportsClose(RuntimeWarmer warmer, ContextBinding binding) {
        return warmer != null && warmer.supportsWorkspaceClose(binding);
    }

    public default void requestWorkspaceClose(String tenantId, String sessionId) {
        throw new UnsupportedOperationException("Workspace close is unavailable");
    }

    public default CompletionStage<Void> closeWorkspace(String tenantId, String sessionId) {
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("Workspace close is unavailable"));
    }

    public default CompletionStage<Void> drainWorkspaceResources(String tenantId, String sessionId,
            RuntimeLifecycleAuthority authority) {
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("Workspace resource drain is unavailable"));
    }

    public default CompletionStage<Void> prepareWorkspaceResources(String tenantId, String sessionId,
            RuntimeLifecycleAuthority authority) {
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("Workspace resource preparation is unavailable"));
    }

    public default CompletionStage<Void> recoverStoppedWorkspaceResources(String tenantId, String sessionId,
            RuntimeLifecycleAuthority authority) {
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("Stopped Workspace recovery is unavailable"));
    }

    /**
     * The W2 settlement probe: verifies the target directory of a cwd
     * change against the administrator mount mapping, its continuity and
     * the storage guard, without claiming storage or contacting a worker.
     * A warmer without a Workspace Runtime cannot answer it; admission is
     * gated on the workspace-files deployment shape, which requires one.
     * The refusal is a terminal workspace_unavailable, never a retry.
     */
    public default void verifyWorkspaceCwdTarget(ContextBinding binding,
            String targetCwdRelative) {
        throw WorkspaceExecutionStore.unavailable();
    }

    public default boolean supportsWorkspaceContextChange(ContextBinding binding) {
        return true;
    }

    /**
     * The child Workspace capability of the isolation slice (#13753 I1),
     * or null when this host cannot create a child Workspace: it is off
     * by default and needs a control plane that mounts the storage.
     */
    public default ChildWorkspaceProvider childWorkspaces() {
        return null;
    }
}
