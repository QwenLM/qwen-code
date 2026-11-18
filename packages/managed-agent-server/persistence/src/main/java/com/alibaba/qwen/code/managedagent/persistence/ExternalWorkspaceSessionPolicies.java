package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.List;
import java.util.Set;

/**
 * External-Workspace admission eligibility, split out of the session policy
 * aggregates along the external-workspace seam. Pure delegation: the predicates
 * and their order are the ones the admission paths enforced inline.
 */
final class ExternalWorkspaceSessionPolicies {
    private ExternalWorkspaceSessionPolicies() {
    }

    /** External storage never admits extension pins. Discovery reads the binding before admission takes its locks. */
    static String profileForSkillDiscovery(JdbcManagedWorkspaceRegistry workspaces, String tenantId,
            String actorId, String workspaceId, String profile) {
        if (!WorkspaceToolProfiles.isPublicShell(profile) && !WorkspaceToolProfiles.MCP.equals(profile)) {
            return profile;
        }
        var workspace = workspaces.resolveForRead(tenantId, actorId, new WorkspaceSelection(workspaceId, "."));
        return workspaces.isExternal(workspace.binding()) ? null : profile;
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
                    || command.memoryStoreId() != null
                    || command.input().stream().anyMatch(block -> !Set.of("input_text", "text").contains(block.get("type")))) {
                throw AgentSessionPolicies.workspaceExecutionUnavailable();
            }
            effective = new AgentSessionPolicies.AgentPin(resolvedPin.revision(), null, resolvedPin.approvalMode(),
                    WorkspaceToolProfiles.EXTERNAL_FILES, false, false, List.of());
        }
        return selectApprovalMode(effective, command.requestedApprovalMode(), command.approvalSelectionSupported());
    }

    /** The requested approval mode, checked against the modes this pin publishes. */
    static AgentSessionPolicies.AgentPin selectApprovalMode(AgentSessionPolicies.AgentPin pin,
            String requested, boolean supported) {
        if (requested == null) {
            return pin;
        }
        if (!AgentSessionPolicies.availableApprovalModes(pin).contains(requested)
                && !(supported && pin.digest() == null && "yolo".equals(requested)
                        && WorkspaceToolProfiles.isPublicShell(pin.toolProfile()))) {
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(400,
                    "unsupported_approval_mode",
                    "The selected approval mode is not available for this Agent.");
        }
        return new AgentSessionPolicies.AgentPin(pin.revision(), pin.digest(), requested, pin.toolProfile(),
                pin.hooks(), pin.mcp(), pin.skills());
    }

    /** The legacy v1 close refusal exempts an external-files Session on its registered EXTERNAL Workspace. */
    static boolean admitsLegacyClose(SessionRecord session, JdbcManagedWorkspaceRegistry workspaces) {
        return WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && workspaces.isExternal(session.workspace());
    }
}
