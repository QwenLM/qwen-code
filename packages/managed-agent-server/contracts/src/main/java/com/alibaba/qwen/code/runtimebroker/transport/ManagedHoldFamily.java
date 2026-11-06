package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;

/**
 * The two H3 hold-row families. A hold row is a ledger row admitted beside
 * a start execution — never dispatched, non-terminal for the physical
 * work's life — and the family names its maintenance protocol kinds: the
 * background Shell rides {@code shell-status}/{@code shell-terminate}, the
 * Monitor watch rides {@code monitor-status}/{@code monitor-stop}. Both
 * families hold their Runtime Session identically; only the control kinds
 * differ.
 */
public enum ManagedHoldFamily {
    SHELL("background_v3_process", "shell-status", "shell-terminate"),
    MONITOR("background_v3_monitor", "monitor-status", "monitor-stop");

    private final String dispatchMode;
    private final String statusKind;
    private final String stopKind;

    ManagedHoldFamily(String dispatchMode, String statusKind,
            String stopKind) {
        this.dispatchMode = dispatchMode;
        this.statusKind = statusKind;
        this.stopKind = stopKind;
    }

    public String dispatchMode() {
        return dispatchMode;
    }

    public String statusKind() {
        return statusKind;
    }

    public String stopKind() {
        return stopKind;
    }

    /** The family a row belongs to, or null for any other dispatch mode. */
    public static ManagedHoldFamily of(ToolExecutionRecord row) {
        return ofDispatchMode(row.getReference().get("dispatchMode"));
    }

    public static ManagedHoldFamily ofDispatchMode(Object dispatchMode) {
        for (ManagedHoldFamily family : values()) {
            if (family.dispatchMode.equals(dispatchMode)) {
                return family;
            }
        }
        return null;
    }
}
