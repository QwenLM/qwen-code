package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.file.Path;

/**
 * The Workspace provider's child Workspace capability (#13753 I1): the
 * verified root of a binding's storage and the Git steps that run inside
 * it. Only a provider whose control plane mounts the storage answers one;
 * {@link RuntimeWarmer#childWorkspaces()} is null everywhere else.
 */
public interface ChildWorkspaceProvider {
    /**
     * The canonical mount root of the binding's storage, after the same
     * continuity check an acquisition makes. Refuses with the terminal
     * workspace_unavailable when the storage has no mount here.
     */
    Path storageRoot(ContextBinding binding);

    ChildWorktreeGit git();
}
