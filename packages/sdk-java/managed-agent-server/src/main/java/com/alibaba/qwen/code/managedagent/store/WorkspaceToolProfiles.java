package com.alibaba.qwen.code.managedagent.store;

public final class WorkspaceToolProfiles {
    public static final String FILES = "hosted-workspace-files/1";
    public static final String SHELL = "hosted-workspace-shell/1";

    private WorkspaceToolProfiles() {
    }

    public static boolean isShell(String profile) {
        return SHELL.equals(profile) || "hosted-workspace-shell/2".equals(profile);
    }

    public static boolean requiresApproval(String mode) {
        return "default".equals(mode) || "auto-edit".equals(mode);
    }
}
