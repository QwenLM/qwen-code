package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Per-Session policy selection and management guards: model, approval,
 * MCP and extension configuration.
 */
public interface SessionPolicyStore {
    public default Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds) {
        return Map.of();
    }

    public default List<WebShellModelOption> modelOptions() { return List.of(); }

    public default Map<String, WebShellModelSelection> findModelSelections(
            String tenantId, List<String> sessionIds) { return Map.of(); }

    public default WebShellModelChangeResult changeSessionModel(String tenantId, String actorId,
            String sessionId, String key, String digest, String modelId, long expectedRevision,
            boolean supported) {
        throw new UnsupportedOperationException("Model selection is unavailable");
    }

    public default Map<String, WebShellApprovalSelection> findApprovalSelections(
            String tenantId, List<String> sessionIds) { return Map.of(); }

    public default boolean supportsPlanMode(SessionRecord session) { return false; }

    public default boolean hasMcpServers(SessionRecord session) { return false; }

    public default SessionRecord requireMcpManagement(String tenantId, String actorId, String sessionId, String operationId) {
        throw new UnsupportedOperationException("MCP management is unavailable");
    }

    public default void requireMcpSettingsCommit(String tenantId, String workspaceId, String sessionId) {
        throw new UnsupportedOperationException("MCP management is unavailable");
    }

    public default SessionRecord requireExtensionManagement(String tenantId, String actorId, String sessionId, String operationId, boolean mutation) {
        throw new UnsupportedOperationException("Extension management is unavailable");
    }

    public default void requireConfigurationCommit(String tenantId, String workspaceId, String sessionId, JsonNode body) {
        throw new UnsupportedOperationException("Extension management is unavailable");
    }

    public default Set<String> findApprovalOwners(String tenantId, String actorId,
            List<String> sessionIds) { return Set.of(); }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported) {
        throw new UnsupportedOperationException("Approval selection is unavailable");
    }

    public default WebShellApprovalSelection findTurnApprovalSelection(String tenantId, String sessionId,
            String promptId) { return null; }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean planMode, boolean planModeSupported) {
        if (planMode != null) {
            throw new UnsupportedOperationException("Plan mode is unavailable");
        }
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported);
    }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean planMode, boolean planModeSupported,
            boolean liveSupported, Map<String, List<String>> permissionRules, boolean rulesSupported,
            boolean autoSupported) {
        if (permissionRules != null || "auto".equals(mode)) {
            throw new UnsupportedOperationException("Extended approval policy is unavailable");
        }
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, planMode, planModeSupported, liveSupported);
    }

    public default WebShellModelSelection findTurnModelSelection(String tenantId, String sessionId,
            String promptId) { return null; }

    public default WebShellApprovalChangeResult changeSessionApproval(String tenantId, String actorId,
            String sessionId, String key, String digest, String mode, long expectedRevision,
            boolean supported, boolean agentDefinitionSupported, Boolean planMode, boolean planModeSupported,
            boolean liveSupported) {
        return changeSessionApproval(tenantId, actorId, sessionId, key, digest, mode, expectedRevision,
                supported, agentDefinitionSupported, planMode, planModeSupported);
    }
}
