package com.alibaba.qwen.code.managedagent.persistence;

/**
 * The Session-column projection a Turn inherits, split out of the session
 * commands along the projection seam. A profile the projection does not name
 * keeps NULL policy columns, and the external profiles project no policy at all
 * unless the Session is the built-in qwen-code root Agent.
 */
final class AgentTurnProjectionGuard {
    private static final String EXTERNAL_PROFILES_SQL =
            "'hosted-workspace-external-files/1','hosted-workspace-external-shell/1'";

    static final String SESSION_GUARD = " CASE WHEN ((agent_id=? AND agent_definition_digest IS NULL)"
            + " OR (agent_id<>? AND agent_definition_digest IS NOT NULL))"
            + " AND workspace_id IS NOT NULL AND tool_profile IN ('hosted-workspace-files/1',"
            + " 'hosted-workspace-shell/1','hosted-workspace-shell/3','hosted-workspace-shell/4','hosted-workspace-files/3','hosted-workspace-files/4',"
            + " " + EXTERNAL_PROFILES_SQL + ")"
            + " AND (tool_profile NOT IN (" + EXTERNAL_PROFILES_SQL + ") OR"
            + " (agent_id = 'qwen-code' AND agent_definition_digest IS NULL AND parent_session_id IS NULL))";

    /** The external profiles project no plan flag of their own. */
    static final String PLAN_ENABLED = " CASE WHEN tool_profile IN (" + EXTERNAL_PROFILES_SQL + ")"
            + " THEN FALSE ELSE is_plan_enabled END";

    private AgentTurnProjectionGuard() {
    }
}
