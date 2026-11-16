package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ConstructorVisibilityTest {
    @Test
    void buildsCheckedValuesOnlyThroughTheirFactories() {
        // A public constructor would let a caller skip a check: a selection
        // with an unnormalized directory, a view or page assembled without
        // its checks, or an error with an arbitrary status and code. The
        // directory rule is a static utility and is never instantiated.
        for (Class<?> type : List.of(WorkspaceSelection.class,
                WorkspaceView.class, WorkspacePage.class,
                WorkspaceException.class, WorkspaceRelativePath.class)) {
            assertEquals(0, type.getConstructors().length, type.getName());
        }
    }
}
