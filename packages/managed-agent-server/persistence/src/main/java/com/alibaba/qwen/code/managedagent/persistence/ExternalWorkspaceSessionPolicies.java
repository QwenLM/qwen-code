package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
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
     * Admission-side eligibility read. The registry predicate throws so execution
     * paths fail closed; on admission an unreadable or drifted registration is a
     * permanent record defect, so the caller answers its own 409 instead of the
     * registry's retryable 503.
     */
    static boolean externalFilesAllowedOrRefuse(JdbcManagedWorkspaceRegistry workspaces, ContextBinding binding) {
        try {
            return workspaces.externalFilesAllowed(binding);
        } catch (com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException unreadable) {
            return false;
        }
    }

    /**
     * Resolve the revision and compile the stored definition before Workspace
     * resolution. External-profile eligibility and requested approval/plan
     * options are checked after the Workspace determines the effective profile.
     * The effective pin then passes the same requested-approval selection the
     * admission path applied inline.
     */
    static AgentSessionPolicies.AgentPin creationPin(boolean external, JdbcManagedWorkspaceRegistry workspaces, ContextBinding binding,
            AgentSessionPolicies.AgentPin resolvedPin, SessionCreationCommand command) {
        AgentSessionPolicies.AgentPin effective = resolvedPin;
        if (external) {
            if (!externalFilesAllowedOrRefuse(workspaces, binding)
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

    /** The legacy v1 close refusal exempts an external-files Session on its registered EXTERNAL Workspace. */
    static boolean admitsLegacyClose(SessionRecord session, JdbcManagedWorkspaceRegistry workspaces) {
        return WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && workspaces.isExternal(session.workspace());
    }
}
