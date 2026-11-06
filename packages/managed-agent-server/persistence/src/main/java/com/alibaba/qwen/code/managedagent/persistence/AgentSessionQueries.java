package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

final class AgentSessionQueries {
    private final AgentStoreRows storeRows;
    private final com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles;
    private final JdbcTemplate jdbc;
    private final List<WebShellModelOption> modelCatalog;

    AgentSessionQueries(AgentStoreRows storeRows,
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles,
            JdbcTemplate jdbc,
            List<WebShellModelOption> modelCatalog) {
        this.storeRows = storeRows;
        this.worktreeFiles = worktreeFiles;
        this.jdbc = jdbc;
        this.modelCatalog = modelCatalog;
    }

    static final String TURN_SUMMARY_COLUMNS = "session_id,"
            + " turn_id, status, gmt_create, completed_at, error_code";

    // findLatestTurns joins ma_public_event, so the same projection
    // must be table-qualified there.
    static final String QUALIFIED_TURN_SUMMARY_COLUMNS =
            "turn_record." + String.join(", turn_record.",
                    TURN_SUMMARY_COLUMNS.split(", "));

    SessionWorktreeStore.Descriptor findSessionWorktree(String tenantId, String sessionId) {
        return SessionWorktreeStore.descriptor(worktreeFiles, jdbc, tenantId, sessionId);
    }

    Map<String, SessionWorktreeStore.Descriptor> findSessionWorktrees(String tenantId, List<String> sessionIds) {
        return SessionWorktreeStore.descriptors(worktreeFiles, jdbc, tenantId, sessionIds);
    }

    String findChildWorkspaceCwd(String tenantId,
            String parentSessionId, String childRunId) {
        List<String> rows = jdbc.queryForList(
                        "SELECT child_cwd_relative FROM ma_workspace WHERE workspace_kind ="
                                + " 'CHILD_GIT' AND tenant_id = ? AND parent_session_id = ? AND"
                                + " child_run_id = ?",
                String.class, tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    StoreModels.SessionLineage findChildLineage(String tenantId,
            String sessionId) {
        // The mapper yields null for a root row, and Stream.findFirst()
        // throws on a null element — fetch and read the one row directly.
        List<StoreModels.SessionLineage> rows = jdbc.query(
                "SELECT parent_session_id, root_session_id,"
                        + " parent_child_run_id, child_depth"
                        + " FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> {
                    String parent = result.getString("parent_session_id");
                    if (parent == null) {
                        return null;
                    }
                    return new StoreModels.SessionLineage(parent,
                            result.getString("root_session_id"),
                            result.getString("parent_child_run_id"),
                            result.getInt("child_depth"));
                }, tenantId, sessionId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    boolean hasCompletedWorkspaceClose(String tenantId, String sessionId) {
        return completedWorkspaceCloses(tenantId, List.of(sessionId))
                .contains(sessionId);
    }

    /** The given Sessions with a completed workspace close, in one read. */
    Set<String> completedWorkspaceCloses(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Set.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 1);
        arguments.add(tenantId);
        sessionIds.forEach(id -> arguments.add(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, id)));
        return new HashSet<>(jdbc.queryForList("SELECT session_id FROM"
                        + " ma_operation WHERE tenant_id = ?"
                        + " AND scope_key IN (" + AgentStoreRows.placeholders(sessionIds.size())
                        + ") AND operation_kind = 'CLOSE' AND state = 'COMPLETED'"
                        + " AND receipt_id IS NOT NULL",
                String.class, arguments.toArray()));
    }

    // The Registry still backs the binding exactly, its state is ACTIVE and
    // the creation actor's grants survive — the passive-attachment subset
    // WorkspaceExecutionStore.authorizePassiveAttachment gates execution on;
    // the frozen profile and agent checks stay the next turn's
    // acquire-time gate. Admission of every family that executes under the
    // creator's authority (later Turns and the cwd change alike) re-checks
    // the same facts so a widened caller cannot be certified for a run
    // that can only fail.
    boolean hasExecutionRegistryFacts(String tenantId,
            String sessionId) {
        return sessionsWithExecutionRegistryFacts(tenantId,
                List.of(sessionId)).contains(sessionId);
    }

    /** The batch twin of {@link #hasExecutionRegistryFacts}. */
    Set<String> sessionsWithExecutionRegistryFacts(String tenantId,
            java.util.Collection<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Set.of();
        }
        Map<String, ExecutionFacts> facts = new HashMap<>();
        Set<String> pending = new HashSet<>(sessionIds);
        while (!pending.isEmpty()) {
            List<Object> arguments = new ArrayList<>();
            arguments.add(tenantId);
            arguments.addAll(pending);
            List<ExecutionFacts> rows =
                    jdbc.query(
                            "SELECT s.session_id, s.parent_session_id, s.workspace_id,"
                                + " s.workspace_generation, s.workspace_storage_id, CASE WHEN"
                                + " r.workspace_id IS NOT NULL AND a.actor_id IS NOT NULL THEN TRUE"
                                + " ELSE FALSE END AS creator_can_execute FROM ma_session s LEFT"
                                + " JOIN ma_workspace r ON r.tenant_id = s.tenant_id AND"
                                + " r.workspace_id = s.workspace_id AND r.workspace_generation ="
                                + " s.workspace_generation AND r.storage_id ="
                                + " s.workspace_storage_id AND r.state = 'ACTIVE' LEFT JOIN"
                                + " ma_workspace_access a ON a.tenant_id = r.tenant_id AND"
                                + " a.workspace_id = r.workspace_id AND a.actor_id ="
                                + " s.creator_actor_key AND a.role IN ('OPERATOR', 'OWNER') WHERE"
                                + " s.tenant_id = ? AND s.session_id IN ("
                                    + AgentStoreRows.placeholders(pending.size())
                                    + ")",
                            (row, index) ->
                                    new ExecutionFacts(
                                            row.getString("session_id"),
                                            row.getString("parent_session_id"),
                                            row.getString("workspace_id"),
                                            row.getObject("workspace_generation", Long.class),
                                            row.getString("workspace_storage_id"),
                                            row.getBoolean("creator_can_execute")),
                            arguments.toArray());
            Set<String> queried = Set.copyOf(pending);
            pending.clear();
            for (ExecutionFacts row : rows) {
                facts.put(row.sessionId(), row);
            }
            for (ExecutionFacts row : rows) {
                if (row.parentId() != null && !facts.containsKey(row.parentId())
                        && !queried.contains(row.parentId())) {
                    pending.add(row.parentId());
                }
            }
        }
        Set<String> verified = new HashSet<>();
        for (String sessionId : sessionIds) {
            ExecutionFacts initial = facts.get(sessionId);
            if (initial == null || initial.workspaceId() == null || initial.storageId() == null
                    || initial.generation() == null) {
                continue;
            }
            Set<String> visited = new HashSet<>();
            ExecutionFacts current = initial;
            while (current != null && visited.add(current.sessionId())
                    && Objects.equals(initial.workspaceId(), current.workspaceId())
                    && Objects.equals(initial.generation(), current.generation())
                    && Objects.equals(initial.storageId(), current.storageId())) {
                if (current.parentId() == null) {
                    if (current.creatorCanExecute()) {
                        verified.add(sessionId);
                    }
                    break;
                }
                current = facts.get(current.parentId());
            }
        }
        return Set.copyOf(verified);
    }

    record ExecutionFacts(String sessionId, String parentId, String workspaceId,
            Long generation, String storageId, boolean creatorCanExecute) {}

    Optional<SessionRecord> findSessionById(String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                AgentStoreRows.SESSION_WITH_STREAM + " WHERE ma_session.session_kind = 'PUBLIC' AND"
                        + " ma_session.session_id = ?",
                storeRows.sessionMapper, sessionId);
        return rows.stream().findFirst();
    }

    SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit, String archiveState, String titleQuery) {
        return listSessions(tenantId, actorId == null ? null
                : SessionPrincipal.ofUser(tenantId, actorId),
                beforeCreatedAt, beforeSessionId, limit, archiveState,
                titleQuery);
    }

    /**
     * Bound Sessions keep Workspace read grants. Unbound Sessions require
     * the immutable ownership row to match tenant, user and actor presence
     * plus subject exactly; legacy rows without an ownership record remain
     * invisible.
     */
    SessionPage listSessions(String tenantId,
            SessionPrincipal principal, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState,
            String titleQuery) {
        return listSessionPage(tenantId, principal, beforeCreatedAt,
                beforeSessionId, limit, archiveState, titleQuery, false);
    }

    SessionPage listOwnedSessions(String tenantId,
            SessionPrincipal principal, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState,
            String titleQuery) {
        return listSessionPage(tenantId, principal, beforeCreatedAt,
                beforeSessionId, limit, archiveState, titleQuery, true);
    }

    private SessionPage listSessionPage(String tenantId,
            SessionPrincipal principal, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState,
            String titleQuery, boolean ownerOnly) {
        if (principal != null) {
            ManagedSessionPrincipal.requireTenant(tenantId, principal);
        }
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        arguments.add(principal == null ? null
                : com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(
                        tenantId, principal.userId()));
        String ownershipClause = "";
        if (principal != null) {
            ownershipClause = " OR EXISTS (SELECT 1 FROM"
                    + " ma_session_principal sp WHERE"
                    + " ma_session.workspace_id IS NULL AND sp.tenant_id ="
                    + " ma_session.tenant_id AND sp.session_id ="
                    + " ma_session.session_id AND sp.version = "
                    + ManagedSessionPrincipal.VERSION
                    + " AND sp.user_id = ? AND sp.actor_present = ? AND"
                    + " (sp.actor_subject_id = ? OR"
                    + " (sp.actor_subject_id IS NULL AND ? IS NULL)))";
            arguments.add(principal.userId());
            arguments.add(principal.actorPresent());
            arguments.add(principal.actorSubjectId());
            arguments.add(principal.actorSubjectId());
        }
        String ownerClause = "";
        if (ownerOnly) {
            ownerClause = " AND (ma_session.workspace_id IS NULL OR"
                    + " (? = FALSE AND COALESCE(ma_session.owner_actor_key,"
                    + " ma_session.creator_actor_key) = ?))";
            arguments.add(principal == null || principal.actorPresent());
            arguments.add(principal == null ? null
                    : com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(
                            tenantId, principal.userId()));
        }
        String archiveClause = switch (archiveState) {
            case "archived" -> " AND ma_session.status = 'ARCHIVED'";
            case "unarchived" -> " AND ma_session.status <> 'ARCHIVED'";
            default -> "";
        };
        String titleClause = "";
        if (!StringUtils.isEmpty(titleQuery)) {
            titleClause = " AND LOCATE(LOWER(?), LOWER(COALESCE(ma_session.title, ''))) > 0";
            arguments.add(titleQuery);
        }
        // Keyset on the immutable gmt_create: gmt_modified moves on every
        // event append, so a row can slide backwards into already-visited
        // pages and silently vanish from a paged listing.
        String cursorClause = "";
        if (beforeCreatedAt != null && beforeSessionId != null) {
            cursorClause = " AND (ma_session.gmt_create < ? OR (ma_session.gmt_create = ?"
                    + " AND ma_session.session_id < ?))";
            arguments.add(beforeCreatedAt);
            arguments.add(beforeCreatedAt);
            arguments.add(beforeSessionId);
        }
        arguments.add(limit + 1);
        Map<String, SessionWorktreeStore.Row> worktrees = new LinkedHashMap<>();
        List<SessionRecord> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION.columns("ma_session") + ", COALESCE(es.last_sequence, 0) AS list_last_sequence,"
                            + " COALESCE(es.replay_floor_sequence, 0) AS list_floor_sequence,"
                            + " w.tenant_id AS worktree_tenant_id, w.session_id AS worktree_session_id,"
                            + " w.workspace_id AS worktree_workspace_id, w.worktree_id AS worktree_worktree_id,"
                            + " w.state AS worktree_state, w.plan_json AS worktree_plan_json,"
                            + " w.identity_json AS worktree_identity_json, w.operation_id AS worktree_operation_id,"
                            + " w.revision AS worktree_revision, w.failure_code AS worktree_failure_code,"
                            + " w.owner_actor_key AS worktree_owner_actor_key, o.claim_owner AS worktree_claim_owner,"
                            + " o.claim_generation AS worktree_claim_generation, o.claim_until AS worktree_claim_until,"
                            + " o.phase AS worktree_phase, o.attempt_count AS worktree_attempt_count FROM"
                            + " ma_session LEFT JOIN ma_event_stream es ON es.tenant_id ="
                            + " ma_session.tenant_id AND es.session_id = ma_session.session_id AND"
                            + " es.stream_kind = 'SESSION' AND es.stream_id = X''"
                            + " LEFT JOIN ma_session_worktree w ON w.tenant_id = ma_session.tenant_id"
                            + " AND w.session_id = ma_session.session_id LEFT JOIN ma_operation o"
                            + " ON o.operation_kind = 'SESSION_WORKTREE' AND o.tenant_id = w.tenant_id"
                            + " AND o.operation_id = w.operation_id WHERE"
                            + " ma_session.session_kind = 'PUBLIC' AND ma_session.tenant_id = ? AND"
                            + " ma_session.status <> 'DELETED' AND (EXISTS (SELECT 1"
                            + " FROM ma_workspace_access wa WHERE wa.tenant_id ="
                            + " ma_session.tenant_id AND wa.workspace_id = ma_session.workspace_id"
                            + " AND wa.actor_id = ? AND wa.role IN ('READER', 'OPERATOR',"
                            + " 'OWNER'))"
                                + ownershipClause + ")"
                                + ownerClause
                                + archiveClause + titleClause + cursorClause
                                + " ORDER BY ma_session.gmt_create DESC, ma_session.session_id DESC"
                                + " LIMIT ?",
                        (result, index) -> {
                            SessionRecord session = storeRows.sessionListMapper.mapRow(result, index);
                            if (result.getString("worktree_worktree_id") != null) {
                                worktrees.put(session.sessionId(), SessionWorktreeStore.readRow(result, "worktree_"));
                            }
                            return session;
                        },
                        arguments.toArray());
        boolean hasMore = rows.size() > limit;
        if (hasMore) {
            rows = new ArrayList<>(rows.subList(0, limit));
        }
        var selectedWorktrees = rows.stream().map(row -> worktrees.get(row.sessionId()))
                .filter(java.util.Objects::nonNull).toList();
        return new SessionPage(List.copyOf(rows), hasMore, SessionWorktreeStore.descriptors(worktreeFiles, jdbc, selectedWorktrees));
    }

    Map<String, WebShellLifecycleOperation>
            findLatestLifecycleOperations(String tenantId, List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        Map<String, WebShellLifecycleOperation> result = new HashMap<>();
        jdbc.query("SELECT * FROM (SELECT o.session_id, o.operation_id, o.operation_kind, o.state, o.failure_code,"
                        + " ROW_NUMBER() OVER (PARTITION BY o.session_id ORDER BY CASE WHEN o.state IN"
                        + " ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED') THEN 0 ELSE 1 END,"
                        + " o.gmt_modified DESC, o.gmt_create DESC, o.operation_id DESC) AS lifecycle_rank FROM ma_operation o"
                        + " JOIN ma_session s ON s.tenant_id = o.tenant_id AND s.session_id = o.session_id"
                        + " WHERE o.tenant_id = ? AND o.session_id IN (" + AgentStoreRows.placeholders(sessionIds.size()) + ")"
                        + " AND ((s.status = 'CLOSING' AND o.operation_kind = 'CLOSE')"
                        + " OR (s.status = 'DELETING' AND o.operation_kind = 'DELETE')"
                        + " OR (s.status = 'ARCHIVING' AND o.operation_kind = 'ARCHIVE'))) lifecycle WHERE lifecycle_rank = 1",
                (RowCallbackHandler) row -> result.put(row.getString("session_id"),
                        new WebShellLifecycleOperation(
                                row.getString("operation_id"), row.getString("operation_kind").toLowerCase(Locale.ROOT),
                                row.getString("state").toLowerCase(Locale.ROOT), row.getString("failure_code"))),
                arguments.toArray());
        return result;
    }

    /** The active Turn of each given Session, in one round trip. */
    Map<String, TurnSummary> findActiveTurns(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 1);
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        List<TurnSummary> rows = jdbc.query("SELECT " + TURN_SUMMARY_COLUMNS
                        + " FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id IN ("
                        + AgentStoreRows.placeholders(sessionIds.size()) + ") AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING') ORDER BY"
                        + " gmt_create DESC",
                storeRows.turnSummaryMapper, arguments.toArray());
        Map<String, TurnSummary> result = new HashMap<>(
                sessionIds.size() * 2);
        for (TurnSummary row : rows) {
            result.putIfAbsent(row.sessionId(), row);
        }
        return result;
    }

    /** The latest Turn of each given Session, in one round trip. */
    Map<String, TurnSummary> findLatestTurns(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>(sessionIds.size() + 3);
        arguments.add(tenantId);
        arguments.addAll(sessionIds);
        arguments.add(tenantId);
        arguments.add(tenantId);
        List<TurnSummary> rows =
                jdbc.query(
                        "SELECT "
                                + QUALIFIED_TURN_SUMMARY_COLUMNS
                                + " FROM ma_turn turn_record JOIN (SELECT event.session_id,"
                                + " event.turn_id FROM ma_public_event event JOIN (SELECT"
                                + " accepted.session_id, MAX(accepted.sequence_id) AS max_sequence FROM"
                                + " ma_public_event accepted WHERE accepted.stream_kind = 'SESSION' AND accepted.stream_id ="
                                + " X'' AND accepted.tenant_id = ? AND accepted.session_id IN ("
                                + AgentStoreRows.placeholders(sessionIds.size())
                                + ") AND accepted.event_type = 'turn.accepted' GROUP BY"
                                + " accepted.session_id) latest ON latest.session_id ="
                                + " event.session_id AND latest.max_sequence ="
                                + " event.sequence_id WHERE event.tenant_id = ?)"
                                + " latest_turn ON latest_turn.session_id ="
                                + " turn_record.session_id AND latest_turn.turn_id ="
                                + " turn_record.turn_id WHERE turn_record.tenant_id ="
                                + " ?",
                        storeRows.turnSummaryMapper,
                        arguments.toArray());
        Map<String, TurnSummary> result = new HashMap<>(
                sessionIds.size() * 2);
        for (TurnSummary row : rows) {
            result.put(row.sessionId(), row);
        }
        return result;
    }

    Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds) {
        return ManagedExtensionRecordStore.findModelContexts(jdbc, tenantId, sessionIds);
    }

    List<WebShellModelOption> modelOptions() { return modelCatalog; }

    Map<String, WebShellModelSelection> findModelSelections(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        args.addAll(sessionIds);
        Map<String, WebShellModelSelection> result = new HashMap<>();
        jdbc.query("SELECT session_id, model_id, model_revision FROM ma_session WHERE tenant_id = ?"
                + " AND session_id IN (" + AgentStoreRows.placeholders(sessionIds.size())
                + ") AND session_kind = 'PUBLIC' AND workspace_id IS NOT NULL AND model_id IS NOT NULL",
                row -> {
                    result.put(row.getString("session_id"), new WebShellModelSelection(
                            row.getString("model_id"), row.getLong("model_revision")));
                }, args.toArray());
        return result;
    }

    WebShellModelSelection findTurnModelSelection(String tenantId, String sessionId,
            String promptId) {
        var rows = jdbc.query("SELECT model_id, model_revision FROM ma_turn WHERE tenant_id = ?"
                + " AND session_id = ? AND prompt_id = ?", (row, index) -> row.getString("model_id") == null
                        ? null : new WebShellModelSelection(row.getString("model_id"),
                                row.getLong("model_revision")), tenantId, sessionId, promptId);
        if (rows.size() != 1) {
            throw new ManagedAgentException(409, "turn_not_found", "The model snapshot Turn was not found");
        }
        return rows.getFirst();
    }

    Map<String, WebShellApprovalSelection> findApprovalSelections(String tenantId,
            List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        args.addAll(sessionIds);
        Map<String, WebShellApprovalSelection> result = new HashMap<>();
        jdbc.query("SELECT session_id, COALESCE(selected_approval_mode, approval_mode) AS mode,"
                        + " approval_revision, is_plan_enabled, permission_rules_json FROM ma_session WHERE tenant_id=? AND session_id IN ("
                        + AgentStoreRows.placeholders(sessionIds.size()) + ") AND session_kind='PUBLIC'",
                row -> { result.put(row.getString("session_id"), new WebShellApprovalSelection(
                        row.getString("mode"), row.getLong("approval_revision"), row.getBoolean("is_plan_enabled"),
                        storeRows.readPermissionRules(row.getString("permission_rules_json")))); }, args.toArray());
        return result;
    }

    Set<String> findApprovalOwners(String tenantId, String actorId, List<String> sessionIds) {
        if (sessionIds.isEmpty() || actorId == null || actorId.isEmpty()) {
            return Set.of();
        }
        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        args.add(com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId));
        args.addAll(sessionIds);
        return new HashSet<>(jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id=?"
                        + " AND COALESCE(owner_actor_key, creator_actor_key)=? AND session_id IN ("
                        + AgentStoreRows.placeholders(sessionIds.size()) + ")", String.class, args.toArray()));
    }

    WebShellApprovalSelection findTurnApprovalSelection(String tenantId, String sessionId,
            String promptId) {
        var rows = jdbc.query("SELECT t.approval_mode, t.approval_revision, t.is_plan_enabled, t.permission_rules_json,"
                        + " s.approval_revision AS selected_revision, s.agent_id, s.agent_definition_digest,"
                        + " s.workspace_id, s.tool_profile, s.parent_session_id, s.public_child_agents_version FROM ma_turn t JOIN ma_session s"
                        + " ON s.tenant_id=t.tenant_id AND s.session_id=t.session_id"
                        + " WHERE t.tenant_id=? AND t.session_id=? AND t.prompt_id=?", (row, index) -> {
                    if (("qwen-code".equals(row.getString("agent_id"))
                            ? row.getString("agent_definition_digest") != null
                            : row.getString("agent_definition_digest") == null) || row.getString("workspace_id") == null
                            || !(WorkspaceToolProfiles.EXTERNAL_FILES.equals(row.getString("tool_profile"))
                                    ? "qwen-code".equals(row.getString("agent_id")) && row.getString("agent_definition_digest") == null
                                            && row.getString("parent_session_id") == null && row.getInt("public_child_agents_version") == 0
                                    : WorkspaceToolProfiles.FILES.equals(row.getString("tool_profile"))
                            || WorkspaceToolProfiles.FILES_V3.equals(row.getString("tool_profile"))
                            || WorkspaceToolProfiles.isPublicShell(row.getString("tool_profile")))) {
                        return null;
                    }
                    String mode = row.getString("approval_mode");
                    if (mode == null && row.getLong("selected_revision") != 0) {
                        throw new ManagedAgentException(409, "approval_snapshot_missing", "The Turn has no approval snapshot");
                    }
                    // Legacy prompt replays must preserve the original absence of a selection.
                    return mode == null ? null : new WebShellApprovalSelection(mode, row.getLong("approval_revision"),
                            row.getBoolean("is_plan_enabled"), storeRows.readPermissionRules(row.getString("permission_rules_json")));
                }, tenantId, sessionId, promptId);
        if (rows.size() != 1) {
            throw new ManagedAgentException(409, "turn_not_found", "The Turn was not found");
        }
        return rows.getFirst();
    }

    // Reads leave the Turn's input out; the public view never shows it.
    TurnPage listTurns(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTurnId, int limit) {
        List<Object> arguments = new ArrayList<>(List.of(tenantId,
                sessionId));
        String before = "";
        if (beforeCreatedAt != null) {
            before = " AND (gmt_create < ? OR (gmt_create = ? AND"
                    + " turn_id < ?))";
            arguments.add(beforeCreatedAt);
            arguments.add(beforeCreatedAt);
            arguments.add(beforeTurnId);
        }
        arguments.add(limit + 1);
        List<TurnSummary> rows = jdbc.query("SELECT " + TURN_SUMMARY_COLUMNS
                        + " FROM ma_turn WHERE tenant_id = ? AND"
                        + " session_id = ?" + before + " ORDER BY gmt_create"
                        + " DESC, turn_id DESC LIMIT ?",
                storeRows.turnSummaryMapper, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new TurnPage(hasMore ? List.copyOf(rows.subList(0, limit))
                : rows, hasMore);
    }

    Optional<TurnSummary> findTurnSummary(String tenantId,
            String sessionId, String turnId) {
        return jdbc.query("SELECT " + TURN_SUMMARY_COLUMNS + " FROM"
                        + " ma_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ?",
                storeRows.turnSummaryMapper, tenantId, sessionId, turnId).stream()
                // The binary collation ignores trailing spaces, so the
                // database also matches an ID that adds some.
                .filter(turn -> turn.turnId().equals(turnId))
                .findFirst();
    }

    Optional<String> findLastVisibleStatusBeforeDelete(String tenantId,
            String sessionId) {
        return jdbc.query("SELECT session_status_before FROM ma_operation"
                        + " WHERE scope_key = ? AND operation_kind = 'DELETE'"
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND session_status_before IS NOT NULL"
                        + " ORDER BY gmt_create DESC LIMIT 1",
                (rows, row) -> rows.getString(1),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                AgentStoreRows.sessionOperationTarget(sessionId), tenantId, sessionId)
                .stream().findFirst();
    }

    Optional<SessionRecord> findSession(String tenantId,
            String sessionId) {
        return storeRows.findSession(tenantId, sessionId);
    }

    Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId) {
        return storeRows.findTurn(tenantId, sessionId, turnId);
    }

    SessionRecord requireSession(String tenantId, String sessionId) {
        return storeRows.requireSession(tenantId, sessionId);
    }
}
