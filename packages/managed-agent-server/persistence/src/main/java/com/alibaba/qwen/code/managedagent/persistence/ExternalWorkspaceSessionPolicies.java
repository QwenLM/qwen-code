package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.Set;

/**
 * External-Workspace admission eligibility, split out of the session policy
 * aggregates along the external-workspace seam. Pure delegation: the predicates
 * and their order are the ones the admission paths enforced inline.
 */
final class ExternalWorkspaceSessionPolicies {
    private ExternalWorkspaceSessionPolicies() {
    }

    /**
     * Resolve the revision and compile the stored definition before Workspace
     * resolution. External-profile eligibility and requested approval/plan
     * options are checked after the Workspace determines the effective profile.
     * The effective pin then passes the same requested-approval selection the
     * admission path applied inline.
     */
    static AgentSessionPolicies.AgentPin creationPin(boolean external, ManagedWorkspaceRegistry workspaces, ContextBinding binding,
            AgentSessionPolicies.AgentPin resolvedPin, SessionCreationCommand command) {
        AgentSessionPolicies.AgentPin effective = resolvedPin;
        if (external) {
            if (!AgentSessionPolicies.externalFilesAllowedOrRefuse(workspaces, binding)
                    || !"qwen-code".equals(command.agentId())
                    || resolvedPin.digest() != null || resolvedPin.hooks() || resolvedPin.mcp()
                    || Boolean.TRUE.equals(command.requestedPlanMode()) || !command.skills().isEmpty() || command.extensionPins() != null
                    || command.input().stream().anyMatch(block -> !Set.of("input_text", "text").contains(block.get("type")))) {
                throw AgentSessionPolicies.workspaceExecutionUnavailable();
            }
            effective = new AgentSessionPolicies.AgentPin(resolvedPin.revision(), null, resolvedPin.approvalMode(),
                    WorkspaceToolProfiles.EXTERNAL_FILES, false, false);
        }
        return AgentSessionPolicies.selectApprovalMode(effective, command.requestedApprovalMode(), command.approvalSelectionSupported());
    }
}
