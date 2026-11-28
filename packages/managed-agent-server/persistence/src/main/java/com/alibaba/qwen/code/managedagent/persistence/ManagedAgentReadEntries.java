package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Read-only Session and Turn delegates. Transactional entries stay on the facade. */
class ManagedAgentReadEntries {
    private final AgentSessionCommands sessionCommands;
    private final AgentSessionQueries sessionQueries;

    ManagedAgentReadEntries(AgentSessionCommands sessionCommands, AgentSessionQueries sessionQueries) {
        this.sessionCommands = sessionCommands;
        this.sessionQueries = sessionQueries;
    }

    public Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        return sessionCommands.replayCommand(tenantId, operation, idempotencyKey, requestDigest);
    }

    public Optional<CommandRecord> findCommand(String tenantId,
            String operation, String idempotencyKey) {
        return sessionCommands.findCommand(tenantId, operation, idempotencyKey);
    }

    public Optional<SessionRecord> findSession(String tenantId, String sessionId) {
        return sessionQueries.findSession(tenantId, sessionId);
    }

    public Optional<SessionRecord> findSessionById(String sessionId) {
        return sessionQueries.findSessionById(sessionId);
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit) {
        return sessionQueries.listSessions(tenantId, actorId, beforeCreatedAt, beforeSessionId, limit, "all", "");
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit, String archiveState) {
        return sessionQueries.listSessions(tenantId, actorId, beforeCreatedAt, beforeSessionId,
                limit, archiveState, "");
    }

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt, String beforeSessionId, int limit, String archiveState, String titleQuery) {
        return sessionQueries.listSessions(tenantId, actorId, beforeCreatedAt, beforeSessionId, limit, archiveState, titleQuery);
    }

    public Map<String, WebShellLifecycleOperation>
            findLatestLifecycleOperations(String tenantId, List<String> sessionIds) {
        return sessionQueries.findLatestLifecycleOperations(tenantId, sessionIds);
    }

    public Optional<TurnRecord> findTurn(String tenantId, String sessionId, String turnId) {
        return sessionQueries.findTurn(tenantId, sessionId, turnId);
    }

    public Map<String, TurnSummary> findActiveTurns(String tenantId, List<String> sessionIds) {
        return sessionQueries.findActiveTurns(tenantId, sessionIds);
    }

    public Map<String, TurnSummary> findLatestTurns(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.findLatestTurns(tenantId, sessionIds);
    }

    public Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds) {
        return sessionQueries.findModelContexts(tenantId, sessionIds);
    }

    public List<WebShellModelOption> modelOptions() {
        return sessionQueries.modelOptions();
    }

    public Map<String, WebShellModelSelection> findModelSelections(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.findModelSelections(tenantId, sessionIds);
    }

    public WebShellModelSelection findTurnModelSelection(String tenantId, String sessionId,
            String promptId) {
        return sessionQueries.findTurnModelSelection(tenantId, sessionId, promptId);
    }

    public Map<String, WebShellApprovalSelection> findApprovalSelections(String tenantId,
            List<String> sessionIds) {
        return sessionQueries.findApprovalSelections(tenantId, sessionIds);
    }

    public Set<String> findApprovalOwners(String tenantId, String actorId, List<String> sessionIds) {
        return sessionQueries.findApprovalOwners(tenantId, actorId, sessionIds);
    }

    public WebShellApprovalSelection findTurnApprovalSelection(String tenantId, String sessionId,
            String promptId) {
        return sessionQueries.findTurnApprovalSelection(tenantId, sessionId, promptId);
    }
}
