package com.alibaba.qwen.code.managedworkspace;

/** An actor's access to one Workspace. {@link #CREATE} implies {@link #READ}. */
public enum WorkspaceAccess {
    NONE,
    READ,
    CREATE;

    public boolean canRead() {
        return this != NONE;
    }

    public boolean canCreate() {
        return this == CREATE;
    }
}
