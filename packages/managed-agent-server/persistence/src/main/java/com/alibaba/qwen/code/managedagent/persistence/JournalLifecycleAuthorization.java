package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceLifecycleStore;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

final class JournalLifecycleAuthorization {
    private final JournalFencing fencing;
    private final JournalStoreRows storeRows;
    private final com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules harnessRules;
    private final JdbcTemplate jdbc;
    private final JdbcManagedExtensionRecordStore extensionRecords;
    private final JdbcWorkspaceExecutionStore lifecycleExecution;
    private final SessionQueryStore lifecycleSessions;

    JournalLifecycleAuthorization(JournalFencing fencing,
            JournalStoreRows storeRows,
            com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules harnessRules,
            JdbcTemplate jdbc,
            JdbcManagedExtensionRecordStore extensionRecords,
            JdbcWorkspaceExecutionStore lifecycleExecution,
            SessionQueryStore lifecycleSessions) {
        this.fencing = fencing;
        this.storeRows = storeRows;
        this.harnessRules = harnessRules;
        this.jdbc = jdbc;
        this.extensionRecords = extensionRecords;
        this.lifecycleExecution = lifecycleExecution;
        this.lifecycleSessions = lifecycleSessions;
    }

    void authorizeLifecycle(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        JournalFencing.lockBounded(() -> JdbcWorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        JournalFencing.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId,
                JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        storeRows.ensureSessionRoot(tenantId, sessionId);
        fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), false);
        jdbc.queryForList(
                "SELECT session_id FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR"
                    + " UPDATE",
                tenantId,
                sessionId);
        JdbcWorkspaceLifecycleStore.requireClaim(jdbc, tenantId, sessionId, authority, true);
        if (request.kind() != null) {
            String kind =
                    jdbc.queryForObject(
                            "SELECT operation_kind FROM ma_operation WHERE tenant_id = ?"
                                    + " AND session_id = ? AND operation_id = ?",
                            String.class,
                            tenantId,
                            sessionId,
                            authority.operationId());
            if (!kind.toLowerCase(java.util.Locale.ROOT).equals(request.kind())) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_operation_conflict");
            }
        } else if (!"DRAINING"
                .equals(
                        jdbc.queryForObject(
                                "SELECT phase FROM ma_session_head WHERE tenant_key = ? AND"
                                    + " harness_key = ? AND tenant_id = ? AND harness_session_id ="
                                    + " ?",
                                String.class,
                                RuntimeAdmissionFences.harnessDrainKey(tenantId),
                                RuntimeAdmissionFences.harnessDrainKey(sessionId),
                                tenantId,
                                sessionId))) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_hooks_unsettled");
        }
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (request.kind() != null) {
            fencing.requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, storeRows.databaseNow(), true);
        } else if (!List.of("ACTIVE", "SEALED").contains(head.state())
                || request.writerGeneration() != head.writerGeneration()
                || !request.writerId().equals(head.writerId())
                || !JournalFencing.secureEquals(JournalFencing.tokenHash(writerToken), head.leaseTokenHash())) {
            throw JournalFencing.writerConflict();
        }
    }

    void authorizeOrdinary(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        // Ordinary authorisation fences per Session (drain + head): the
        // tenant-wide guard rows stay with lifecycle/publication paths, or
        // any long holder of them wedges unrelated Sessions (#13800). The
        // Session root is locked before the drain admission reads the head
        // row, keeping the root-then-head order of every other writer.
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), false);
        if (!"legacy-close".equals(request.kind()) || !JdbcWorkspaceLifecycleStore.legacyClose(jdbc, tenantId, sessionId)) {
            fencing.requireOrdinaryAdmission(tenantId, sessionId);
        }
        if (request.kind() != null && request.kind().startsWith("configuration:")) {
            String operation = request.kind().substring("configuration:".length());
            JsonNode current = ManagedMcpSettings.find(jdbc, tenantId, sessionId);
            if (!ManagedConfigInstall.uuid(operation) || ManagedConfigStore.blocked(jdbc, tenantId, sessionId)
                    && (!ManagedConfigInstall.isPackageConfig(current) || !operation.equals(current.path("operationId").asText()))) {
                throw JournalStoreRows.conflict("session_config_recovery_required", "Only the original configuration operation may continue.");
            }
        } else {
            ManagedConfigStore.requireOpen(jdbc, tenantId, sessionId);
        }
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, storeRows.databaseNow(), true);
    }

    java.util.Map<String, Object> approvalSelection(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        if (request.kind() != null) {
            throw JournalStoreRows.invalid("Approval queries do not accept lifecycle authority.");
        }
        authorizeOrdinary(tenantId, sessionId, writerToken, request);
        var rows = jdbc.queryForList("SELECT agent_id, agent_definition_digest, tool_profile, workspace_id,"
                + " parent_session_id, public_child_agents_version, approval_mode, selected_approval_mode, approval_revision, permission_rules_json FROM ma_session"
                + " WHERE tenant_id=? AND session_id=? FOR UPDATE", tenantId, sessionId);
        if (rows.size() != 1) {
            throw JournalStoreRows.conflict("managed_session_scope_conflict", "The Managed Session is missing.");
        }
        var row = rows.getFirst();
        String profile = (String) row.get("tool_profile");
        if (row.get("workspace_id") == null
                || ("qwen-code".equals(row.get("agent_id"))
                        ? row.get("agent_definition_digest") != null : row.get("agent_definition_digest") == null)
                || !(com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.EXTERNAL_FILES.equals(profile)
                        ? "qwen-code".equals(row.get("agent_id")) && row.get("agent_definition_digest") == null
                                && row.get("parent_session_id") == null && ((Number) row.get("public_child_agents_version")).intValue() == 0
                        : com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.FILES.equals(profile)
                        || com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.FILES_V3.equals(profile)
                        || com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.FILES_V4.equals(profile)
                        || com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.isPublicShell(profile))) {
            return null;
        }
        String mode = (String) row.get("selected_approval_mode");
        if (mode == null) {
            mode = (String) row.get("approval_mode");
        }
        long revision = ((Number) row.get("approval_revision")).longValue();
        if (!com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles.supportsApprovalMode(mode)
                || revision < 0 || revision > 9_007_199_254_740_991L) {
            throw JournalStoreRows.conflict("approval_selection_conflict", "The approval selection is invalid.");
        }
        java.util.Map<String, Object> result = new java.util.LinkedHashMap<>(java.util.Map.of("mode", mode, "revision", revision));
        if (row.get("permission_rules_json") != null) {
            try {
                var rules = harnessRules.nonEmptyPermissionRules(harnessRules.permissionRules(
                        JournalStoreRows.CSI_JSON.readValue((String) row.get("permission_rules_json"), java.util.Map.class)));
                if (rules != null) {
                    result.put("permissionRules", rules);
                }
            } catch (java.io.IOException | IllegalArgumentException invalid) {
                throw JournalStoreRows.conflict("approval_selection_conflict", "The permission rules are invalid.");
            }
        }
        return result;
    }

    void authorizeNewLifecycleDispatch(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority,
            byte[] recordBytes, java.util.function.Function<String, StoredResource> reader) {
        boolean v2 = authority != null && jdbc.queryForObject(
                                        "SELECT lifecycle_protocol_version FROM ma_operation WHERE"
                                            + " operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')"
                                            + " AND tenant_id = ? AND session_id = ? AND"
                                            + " operation_id = ?", Integer.class,
                tenantId, sessionId, authority.operationId()) == 2;
        boolean resourcePhase = v2 && JdbcWorkspaceLifecycleStore.resourceClaim(jdbc, tenantId, sessionId, authority);
        if (authority != null && extensionRecords.hasNewLifecycleDispatch(tenantId, sessionId, recordBytes,
                reader, v2, resourcePhase)) {
            if (lifecycleExecution == null || lifecycleSessions == null) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_protocol_unavailable");
            }
            try {
                lifecycleExecution.authorizeLifecycle(lifecycleSessions.requireSession(tenantId, sessionId), authority);
            } catch (com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException refusal) {
                if (refusal.getStatusCode() == 409 && "workspace_unavailable".equals(refusal.getCode())) {
                    throw WorkspaceLifecycleStore.blocked(
                            "workspace_lifecycle_authorization_revoked");
                }
                if (refusal.getStatusCode() == 409) {
                    throw new ManagedAgentException(409, refusal.getCode(), refusal.getMessage());
                }
                throw refusal;
            }
        }
    }
}
