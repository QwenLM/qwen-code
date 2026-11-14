package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.model.StoreModels;

public final class WorkspaceToolProfiles {
    public static final String FILES = "hosted-workspace-files/1";
    public static final String EXTERNAL_FILES = "hosted-workspace-external-files/1";
    public static final String MCP = "hosted-workspace-mcp/1";
    public static final String SHELL = "hosted-workspace-shell/1";
    /**
     * Self-paced /loop revision: `shell/1` plus loop_wakeup and the cron
     * union. `shell/2` was retired by the unified Shell lifecycle (#15330)
     * and is deliberately not reused.
     */
    public static final String SHELL_V3 = "hosted-workspace-shell/3";
    /**
     * Fixed-interval /loop revision: `shell/3` plus cron_create. `shell/2`
     * stays retired (#15330) and is deliberately not reused.
     */
    public static final String SHELL_V4 = "hosted-workspace-shell/4";
    /** #15076: `files/3` adds `todo_write`; enabling it is a rollout decision. */
    public static final String FILES_V3 = "hosted-workspace-files/3";
    /** Fixed-interval /loop: `files/3` plus the cron trio, no loop_wakeup. */
    public static final String FILES_V4 = "hosted-workspace-files/4";
    public static final String INTERNAL_TEAM_LEAD = "hosted-workspace-team-lead/1";
    /** Fixed-interval /loop: `team-lead/1` plus the cron trio, no loop_wakeup. */
    public static final String INTERNAL_TEAM_LEAD_V2 = "hosted-workspace-team-lead/2";
    /**
     * The profile of a child bound to a snapshot child Workspace (#13753 I3):
     * `read_file` and `glob` only, so the child cannot write.
     */
    public static final String READ = "hosted-workspace-read/1";

    private WorkspaceToolProfiles() {
    }

    public static boolean isPublicShell(String profile) {
        return SHELL.equals(profile) || SHELL_V3.equals(profile)
                || SHELL_V4.equals(profile);
    }

    /** The internal team-lead lanes, never selectable by a public definition. */
    public static boolean isInternalTeamLead(String profile) {
        return INTERNAL_TEAM_LEAD.equals(profile) || INTERNAL_TEAM_LEAD_V2.equals(profile);
    }

    public static boolean isShellOrMcp(String profile) {
        return profile != null && (profile.startsWith("hosted-workspace-shell/")
                || profile.startsWith("hosted-workspace-mcp/"));
    }

    public static int lifecycleProtocol(String profile) {
        if (FILES.equals(profile) || EXTERNAL_FILES.equals(profile)) {
            return 1;
        }
        if (SHELL.equals(profile) || SHELL_V3.equals(profile)
                || SHELL_V4.equals(profile) || MCP.equals(profile)) {
            return 2;
        }
        return 0;
    }

    public static boolean lifecycleProtocol(int version) {
        return version == 1 || version == 2;
    }

    public static boolean supportsApprovalMode(String mode) {
        return "default".equals(mode) || "auto".equals(mode) || "auto-edit".equals(mode) || "yolo".equals(mode);
    }

    public static boolean supportsApprovalSelection(StoreModels.SessionRecord session) {
        return session.workspace() != null
                && ("qwen-code".equals(session.agentId())
                        ? session.agentDefinitionDigest() == null
                        : session.agentDefinitionDigest() != null)
                && (EXTERNAL_FILES.equals(session.toolProfile())
                        ? "qwen-code".equals(session.agentId()) && session.agentDefinitionDigest() == null
                                && session.publicChildAgentsVersion() == 0
                        : FILES.equals(session.toolProfile()) || FILES_V3.equals(session.toolProfile())
                                || FILES_V4.equals(session.toolProfile())
                        || isPublicShell(session.toolProfile()));
    }

    public static boolean requiresApproval(String mode) {
        return "default".equals(mode) || "auto".equals(mode) || "auto-edit".equals(mode);
    }
}
