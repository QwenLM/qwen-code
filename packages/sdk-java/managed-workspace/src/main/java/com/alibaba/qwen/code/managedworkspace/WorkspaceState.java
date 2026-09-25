package com.alibaba.qwen.code.managedworkspace;

/** Registry lifecycle state. Only {@link #ACTIVE} accepts new Sessions. */
public enum WorkspaceState {
    ACTIVE("active"),
    DRAINING("draining"),
    REMOVED("removed");

    private final String wireName;

    WorkspaceState(String wireName) {
        this.wireName = wireName;
    }

    public String wireName() {
        return wireName;
    }
}
