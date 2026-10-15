package com.alibaba.qwen.code.managedagent.store;

public final class WorkspaceToolProfiles {
    public static final String FILES = "hosted-workspace-files/1";
    public static final String MCP = "hosted-workspace-mcp/1";
    public static final String SHELL = "hosted-workspace-shell/1";
    public static final String INTERNAL_TEAM_LEAD = "hosted-workspace-team-lead/1";

    private WorkspaceToolProfiles() {
    }

    public static boolean isPublicShell(String profile) {
        return SHELL.equals(profile) || "hosted-workspace-shell/2".equals(profile);
    }

    public static boolean isShellOrMcp(String profile) {
        return profile != null && (profile.startsWith("hosted-workspace-shell/")
                || profile.startsWith("hosted-workspace-mcp/"));
    }

    public static int lifecycleProtocol(String profile) {
        if (FILES.equals(profile)) {
            return 1;
        }
        if (SHELL.equals(profile) || MCP.equals(profile)) {
            return 2;
        }
        return 0;
    }

    public static boolean lifecycleProtocol(int version) {
        return version == 1 || version == 2;
    }

    public static boolean supportsApprovalMode(String mode) {
        return "default".equals(mode) || "auto-edit".equals(mode) || "yolo".equals(mode);
    }

    public static boolean supportsApprovalSelection(StoreModels.SessionRecord session) {
        return session.workspace() != null && "qwen-code".equals(session.agentId())
                && session.agentDefinitionDigest() == null
                && (FILES.equals(session.toolProfile()) || isPublicShell(session.toolProfile()));
    }

    public static boolean requiresApproval(String mode) {
        return "default".equals(mode) || "auto-edit".equals(mode);
    }
}
