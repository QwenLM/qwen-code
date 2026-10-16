package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

class ConstructorVisibilityTest {
    @Test
    void buildsCheckedValuesOnlyThroughTheirFactories() {
        // A public constructor would let a caller skip a check: a selection
        // with an unnormalized directory, a resolved Workspace, view or page
        // the catalog did not produce, a policy without the builder's grant
        // checks, or an error with an arbitrary status and code. The
        // directory rule is a static utility and is never instantiated.
        for (Class<?> type : List.of(WorkspaceSelection.class,
                ResolvedWorkspace.class, WorkspaceView.class,
                WorkspacePage.class, GrantedWorkspaceAccessPolicy.class,
                GrantedWorkspaceAccessPolicy.Builder.class,
                WorkspaceException.class, WorkspaceRelativePath.class)) {
            assertEquals(0, type.getConstructors().length, type.getName());
        }
    }
}
