package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The child-Session admission arm, split out of AgentSessionAdmissions:
 * private/public child creation receipts, the child row insert and the
 * ready-child-Workspace binding check, plus the shared creation-receipt
 * command read. The SQL, lock order and verdicts are the ones the admissions
 * ran inline.
 */
final class ChildSessionAdmissions {
    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final AgentStoreRows storeRows;
    private final AgentEventJournal eventJournal;
    private final AgentSessionCommands sessionCommands;
    private final ManagedExtensionRecordStore configRecords;
    private final ManagedSessionModelConfigs modelConfigs;
    private final ManagedSessionSkills creationSkills;
    private final ResidentWorkspaces residentWorkspaces;
    private final boolean workspaceFilesEnabled;

    ChildSessionAdmissions(JdbcTemplate jdbc, Clock clock, AgentStoreRows storeRows,
            AgentEventJournal eventJournal, AgentSessionCommands sessionCommands,
            ManagedExtensionRecordStore configRecords, ManagedSessionModelConfigs modelConfigs,
            ManagedSessionSkills creationSkills, ResidentWorkspaces residentWorkspaces,
            boolean workspaceFilesEnabled) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.storeRows = storeRows;
        this.eventJournal = eventJournal;
        this.sessionCommands = sessionCommands;
        this.configRecords = configRecords;
        this.modelConfigs = modelConfigs;
        this.creationSkills = creationSkills;
        this.residentWorkspaces = residentWorkspaces;
        this.workspaceFilesEnabled = workspaceFilesEnabled;
    }

    static String childActorOf(String parentSessionId) {
        return "child:" + parentSessionId;
    }

    Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        return insertChildSession(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage, null, null);
    }

    Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        if (childCwdRelative == null) {
            throw new IllegalArgumentException("An isolated child needs its Workspace directory");
        }
        return insertChildSession(tenantId, parentSessionId, idempotencyKey,
                requestDigest, title, input, payloadDigest, lineage,
                childCwdRelative, null);
    }

    Admission insertPublicChildSessionCommand(String tenantId, String parentSessionId,
            String idempotencyKey, String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage, com.fasterxml.jackson.databind.JsonNode snapshot) {
        return insertChildSession(tenantId, parentSessionId, idempotencyKey, requestDigest,
                title, input, payloadDigest, lineage, null, snapshot);
    }

    Admission insertChildSession(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative, com.fasterxml.jackson.databind.JsonNode snapshot) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenantId);
        List<WorkspaceCommand> existing = findWorkspaceCommand(tenantId,
                childActorOf(parentSessionId), idempotencyKey);
        if (existing.isEmpty()) {
            WorkspaceMigrationAdmission.requireSessionOpen(jdbc, tenantId, parentSessionId);
        }
        SessionRecord parent = storeRows.requireSessionForUpdate(tenantId,
                parentSessionId);
        if (parent.workspace() == null || residentWorkspaces.find(parent.workspace()) != null || !"ACTIVE".equals(parent.status())
                || CsiFilesRetirementProfile.PROFILE.equals(parent.toolProfile())) {
            throw new ManagedAgentException(409,
                    "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        if (parent.publicChildAgentsVersion() == 1) {
            if (snapshot == null || !snapshot.path("version").isIntegralNumber() || !Set.of(1, 2).contains(snapshot.path("version").asInt()) || lineage.depth() != 1
                    || childCwdRelative != null || snapshot.size() != (snapshot.path("version").asInt() == 2 ? 9 : 8)
                    || !snapshot.path("sourcePromptId").isTextual() || snapshot.path("sourcePromptId").asText().isBlank()
                    || snapshot.path("sourcePromptId").asText().length() > 144
                    || !Set.of("default", "auto-edit", "yolo").contains(snapshot.path("approvalMode").asText())
                    || !snapshot.path("approvalRevision").isIntegralNumber() || snapshot.path("approvalRevision").asLong(-1) < 0
                    || !snapshot.path("approvalRevision").canConvertToLong() || snapshot.path("approvalRevision").asLong() > 9_007_199_254_740_991L
                    || !snapshot.path("modelId").isTextual() || snapshot.path("modelId").asText().isBlank()
                    || snapshot.path("modelId").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 512
                    || !snapshot.path("modelRevision").isIntegralNumber() || snapshot.path("modelRevision").asLong(-1) < 0
                    || !snapshot.path("modelRevision").canConvertToLong() || snapshot.path("modelRevision").asLong() > 9_007_199_254_740_991L
                    || !snapshot.has("skillsRef") || snapshot.path("modelRoute").size() != (snapshot.path("modelRoute").has("origin") ? 4 : 3)
                    || !snapshot.path("modelRoute").path("authType").isTextual()
                    || !snapshot.path("modelRoute").path("authType").asText().matches("[a-z][a-z0-9_-]{0,63}")
                    || !snapshot.path("modelRoute").path("endpointDigest").isTextual()
                    || !snapshot.path("modelRoute").path("endpointDigest").asText().matches("[a-f0-9]{64}")
                    || !snapshot.path("modelRoute").path("providerPin").isTextual()
                    || !snapshot.path("modelRoute").path("providerPin").asText().matches("[a-f0-9]{64}")) {
                throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "The public child launch snapshot is invalid");
            }
            if (snapshot.path("version").asInt() == 2) {
                if (configRecords == null) {
                    throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "Package agent validation is unavailable");
                }
                ManagedExtensionAgentLaunch.require(jdbc, configRecords, parent, snapshot);
            }
            if (snapshot.path("modelRoute").has("origin")) {
                var origin = snapshot.path("modelRoute").get("origin");
                if (origin.size() != 4 || !origin.path("modelId").isTextual() || origin.path("modelId").asText().isBlank()
                        || origin.path("modelId").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 512
                        || !origin.path("authType").isTextual()
                        || !origin.path("authType").asText().matches("[a-z][a-z0-9_-]{0,63}")
                        || !origin.path("endpointDigest").isTextual()
                        || !origin.path("endpointDigest").asText().matches("[a-f0-9]{64}")
                        || !origin.path("providerPin").isTextual()
                        || !origin.path("providerPin").asText().matches("[a-f0-9]{64}")) {
                    throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "The public child model origin is invalid");
                }
            }
        } else if (snapshot != null) {
            throw new ManagedAgentException(409, "child_launch_snapshot_invalid", "The parent has no public child admission");
        }
        storeRows.requireLegacyMutation(tenantId, parentSessionId);
        if (!input.isEmpty() && !workspaceFilesEnabled) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        if (!existing.isEmpty()) {
            WorkspaceCommand command = existing.getFirst();
            if (!command.requestDigest().equals(requestDigest)) {
                throw new ManagedAgentException(409,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new Admission(command.sessionId(), command.turnId(), true,
                    false);
        }
        // The terminal truth fence: the relay can give up on a stalled
        // creation and commit the run's terminal verdict (creation_failed
        // among them), then retire — while a lease-losing worker that
        // paused before this call is about to mint the Session anyway.
        // The row lock serializes that verdict against this read, so a
        // settled record refuses the mint inside its own transaction —
        // addressed by the parent's launch row's unique business key, which
        // is the same key the idempotent admission derives, so the
        // locking read never becomes a cross-tenant table scan under
        // REPEATABLE READ.
        String fenceScopeKey = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId,
                parentSessionId);
        String fenceRecordKey = ManagedExtensionProjection.recordKey(
                parentSessionId, "child_run", lineage.parentChildRunId());
        List<String> runState = jdbc.query("SELECT task_state FROM"
                + " ma_session_record"
                + " WHERE session_scope_key = ? AND record_key = ?"
                + " FOR UPDATE",
                (result, row) -> result.getString(1), fenceScopeKey,
                fenceRecordKey);
        if (!runState.isEmpty()
                && ("completed".equals(runState.getFirst())
                        || "failed".equals(runState.getFirst())
                        || "cancelled".equals(runState.getFirst()))) {
            throw new ManagedAgentException(409, "child_run_settled",
                    "The child run already settled; creation owes no more Session.");
        }
        // A child bound to a snapshot reads with the read-only profile
        // whatever its parent's is (#13753 I3): the mode comes from the row
        // this transaction locks, so no caller can bind a snapshot copy to
        // a profile that writes. Only the profile differs from the parent.
        String toolProfile = null;
        if (childCwdRelative != null
                && ChildWorkspaceStore.SNAPSHOT.equals(requireReadyChildWorkspace(
                        tenantId, parentSessionId, lineage.parentChildRunId(),
                        parent.workspace(), childCwdRelative))) {
            toolProfile = WorkspaceToolProfiles.READ;
        }
        long now = clock.millis();
        String sessionId = UUID.randomUUID().toString();
        String turnId = input.isEmpty() ? null : AgentStoreRows.publicId("turn");
        String promptId = input.isEmpty() ? null : UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, agent_revision,"
                        + " agent_definition_digest, title,"
                        + " status, gmt_create, gmt_modified, workspace_id,"
                        + " workspace_generation, workspace_storage_id,"
                        + " cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref,"
                        + " workspace_policy_ref, tool_profile,"
                        + " creator_actor_key, approval_mode,"
                        + " parent_session_id, root_session_id,"
                        + " parent_child_run_id, child_depth)"
                        + " SELECT tenant_id, ?, agent_id,"
                        + " agent_revision, agent_definition_digest,"
                        + " ?, 'ACTIVE', ?, ?,"
                        + " workspace_id, workspace_generation,"
                        + " workspace_storage_id, "
                        + (childCwdRelative == null ? "cwd_relative" : "?")
                        + ", context_config_ref, context_revision,"
                        + " workspace_config_ref, workspace_policy_ref, "
                        + (toolProfile == null ? "tool_profile" : "?")
                        + ", creator_actor_key, approval_mode,"
                        + " ?, ?, ?, ?"
                        + " FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                childInsertArgs(sessionId, title, now, childCwdRelative,
                        toolProfile, lineage, tenantId, parentSessionId));
        jdbc.update("INSERT INTO ma_event_stream"
                        + " (tenant_id, session_id, stream_kind, stream_id,"
                        + " covered_sequence, gmt_modified) VALUES"
                        + " (?, ?, 'SESSION', '', 0, ?)",
                tenantId, sessionId, now);
        if (parent.modelConfigDigest() != null) {
            if (modelConfigs == null) {
                throw new ManagedAgentException(409, "model_config_unavailable", "The Session model configuration is unavailable.");
            }
            modelConfigs.inherit(tenantId, parentSessionId, sessionId);
        }
        if (snapshot != null) {
            byte[] owner = jdbc.queryForObject("SELECT COALESCE(owner_actor_key, creator_actor_key) FROM ma_session WHERE tenant_id=? AND session_id=?", byte[].class, tenantId, parentSessionId);
            jdbc.update("UPDATE ma_session SET public_child_agents_version=1, owner_actor_key=?, approval_mode=?, selected_approval_mode=NULL, approval_revision=0, model_id=?, model_revision=1 WHERE tenant_id=? AND session_id=?",
                    owner, snapshot.path("approvalMode").asText(), snapshot.path("modelId").asText(), tenantId, sessionId);
        }
        if (turnId != null) {
            sessionCommands.insertTurn(tenantId, sessionId, turnId, promptId, input,
                    payloadDigest, now);
        }
        ManagedReceipts.insertCreation(jdbc, tenantId,
                com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, childActorOf(parentSessionId)),
                idempotencyKey, requestDigest, sessionId, turnId, now);
        var inheritedSkills = snapshot == null ? creationSkills.snapshot(tenantId, parentSessionId)
                : creationSkills.fromLaunchReference(tenantId, parentSessionId, snapshot.path("skillsRef"));
        if (inheritedSkills != null) {
            creationSkills.save(tenantId, sessionId, inheritedSkills);
        }
        eventJournal.appendEvent(tenantId, sessionId, null, "session.created",
                Map.of("sessionId", sessionId), false, null, now);
        if (turnId != null) {
            eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.accepted",
                    AgentEventJournal.acceptedData(turnId, input), false, null, now);
        }
        return new Admission(sessionId, turnId, false, true);
    }

    static Object[] childInsertArgs(String sessionId, String title,
            long now, String childCwdRelative, String toolProfile,
            StoreModels.SessionLineage lineage, String tenantId,
            String parentSessionId) {
        List<Object> args = new ArrayList<>(List.of(sessionId, title, now, now));
        if (childCwdRelative != null) {
            args.add(childCwdRelative);
        }
        if (toolProfile != null) {
            args.add(toolProfile);
        }
        args.addAll(List.of(lineage.parentSessionId(), lineage.rootSessionId(),
                lineage.parentChildRunId(), lineage.depth(), tenantId,
                parentSessionId));
        return args.toArray();
    }

    /**
     * Decision 13 of the isolation slice: an isolated child binds only to a ready, unfinished child
     * Workspace prepared from the parent's current Workspace and storage. The locking read
     * serializes the creation against a finish request, which locks the same row. Answers
     * the row's mode (#13753 I3), which its operation's request fixed when it was admitted.
     */
    String requireReadyChildWorkspace(String tenantId,
            String parentSessionId, String childRunId, ContextBinding parent,
            String childCwdRelative) {
        List<Boolean> ready =
                jdbc.query(
                        "SELECT child_state AS state, finish_request, parent_workspace_id AS"
                            + " workspace_id, workspace_generation, storage_id, child_cwd_relative"
                            + " FROM ma_workspace WHERE workspace_kind = 'CHILD_GIT' AND"
                            + " parent_session_id = ? AND child_run_id = ? AND tenant_id = ? FOR"
                            + " UPDATE",
                        (row, index) ->
                                "ready".equals(row.getString("state"))
                                        && row.getString("finish_request") == null
                                        && parent.getWorkspaceId()
                                                .equals(row.getString("workspace_id"))
                                        && parent.getWorkspaceGeneration()
                                                == row.getLong("workspace_generation")
                                        && parent.getStorageId().equals(row.getString("storage_id"))
                                        && childCwdRelative.equals(
                                                row.getString("child_cwd_relative")),
                        parentSessionId,
                        childRunId,
                        tenantId);
        if (ready.size() != 1 || !ready.getFirst()) {
            throw new ManagedAgentException(409, "child_workspace_not_ready",
                    "The child run's Workspace is not ready to bind a child Session.");
        }
        // The request is written once, when the row is admitted, so the
        // locked row's mode needs no lock of its own.
        List<String> requests = jdbc.queryForList("SELECT o.request_json FROM ma_workspace w"
                        + " JOIN ma_operation o ON o.tenant_id = w.tenant_id"
                        + " AND o.operation_id = w.child_workspace_id AND o.operation_kind = 'CHILD_WORKSPACE'"
                        + " WHERE w.workspace_kind = 'CHILD_GIT' AND w.parent_session_id = ?"
                        + " AND w.child_run_id = ? AND w.tenant_id = ?",
                String.class, parentSessionId, childRunId, tenantId);
        if (requests.size() != 1) {
            throw new ManagedAgentException(409, "child_workspace_not_ready",
                    "The child run's Workspace is not ready to bind a child Session.");
        }
        return ChildWorkspaceStore.workspaceMode(requests.getFirst());
    }

    // H2 truncates bare BINARY casts; the suffix also prevents NUL-padding aliases.
    List<WorkspaceCommand> findWorkspaceCommand(String tenantId,
            String actorId, String idempotencyKey) {
        ManagedReceipts.Receipt row = ManagedReceipts.creation(jdbc, tenantId,
                com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId), idempotencyKey);
        return row == null
                ? List.of()
                : List.of(
                        new WorkspaceCommand(
                                row.requestDigest(), row.sessionId(), row.turnId()));
    }

    record WorkspaceCommand(String requestDigest, String sessionId,
            String turnId) {
    }
}
