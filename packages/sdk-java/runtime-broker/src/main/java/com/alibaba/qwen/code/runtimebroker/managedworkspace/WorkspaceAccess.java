package com.alibaba.qwen.code.runtimebroker.managedworkspace;

/**
 * An actor's role on one Workspace. {@link #OWNER} implies {@link #OPERATOR}
 * implies {@link #READER}. {@link #NONE} is the no-grant decision only; the
 * store's CHECK keeps it out of persisted rows.
 */
public enum WorkspaceAccess {
    NONE,
    READER,
    OPERATOR,
    OWNER;

    /** Whether this access meets {@code required} or ranks above it. */
    public boolean atLeast(WorkspaceAccess required) {
        if (required == null) {
            throw new IllegalArgumentException("required access is required");
        }
        return compareTo(required) >= 0;
    }

    public boolean canRead() {
        return atLeast(READER);
    }

    public boolean canCreate() {
        return atLeast(OPERATOR);
    }
}
