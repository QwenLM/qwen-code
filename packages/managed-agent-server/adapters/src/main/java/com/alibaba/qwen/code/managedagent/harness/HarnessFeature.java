package com.alibaba.qwen.code.managedagent.harness;

import java.util.Collection;

/**
 * The Hosted Harness feature tokens behind the connectors' capability checks,
 * each with the feature it builds on, so the single and pooled connectors read
 * one definition.
 */
enum HarnessFeature {
    APPROVAL_SELECTION("approval-selection/1", null),
    LIVE_APPROVAL_SELECTION("live-approval-selection/1", APPROVAL_SELECTION),
    AUTO_APPROVAL("auto-approval/1", APPROVAL_SELECTION),
    PERMISSION_RULES("permission-rules/1", APPROVAL_SELECTION),
    AGENT_DEFINITION_APPROVAL_SELECTION("agent-definition-approval-selection/1", APPROVAL_SELECTION),
    PUBLIC_CHILD_AGENTS("public-child-agents/1", APPROVAL_SELECTION),
    PLAN_MODE("plan-mode/1", null),
    MODEL_SELECTION("model-selection/1", null),
    MODEL_CONFIGURATION("session-model-config/1", null),
    PERSONAL_MEMORY("session-memory/1", null),
    USER_MESSAGE_QUEUE("user-message-queue/1", null),
    CONTEXT_COMPRESSION("context-compression/1", null),
    INPUT_ATTACHMENTS("input-attachments/1", null),
    SESSION_SKILLS("session-skills/2", null),
    MCP_MANAGEMENT("session-mcp-management/1", null),
    CLIENT_FILES("client-files/1", null),
    SESSION_EXTENSIONS("session-extension-packages/1", null),
    PACKAGE_PREPARATION("managed-package-preparation/1", null),
    RUNTIME_SKILL_IMPORT("managed-runtime-skill-import/1", null),
    SIDE_QUERY("side-query/1", null);

    private final String token;
    private final HarnessFeature requires;

    HarnessFeature(String token, HarnessFeature requires) {
        this.token = token;
        this.requires = requires;
    }

    boolean in(Collection<String> advertised) {
        return advertised.contains(token) && (requires == null || requires.in(advertised));
    }
}
