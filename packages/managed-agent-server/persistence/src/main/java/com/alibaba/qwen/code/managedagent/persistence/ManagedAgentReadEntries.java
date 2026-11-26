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

/**
 * The non-transactional session/turn read arm of the Managed Agent facade,
 * pure-moved out of ManagedAgentStore to keep the facade under the
 * class-size ratchet while the principal mutation overrides live on the
 * facade itself. Only unannotated read delegates belong here: a
 * {@code @Transactional} entry must stay declared on the facade, because
 * moving an annotated entry into a superclass makes javac emit an
 * annotation-less bridge on the facade (the contract interfaces declare
 * same-signature defaults) and Spring's AnnotationTransactionAttributeSource
 * then resolves no transaction attribute for it. The bodies are the ones
 * the facade declared inline.
 */
class ManagedAgentReadEntries extends ManagedAgentPrincipalEntries {
    private final AgentSessionCommands sessionCommands;
    private final AgentSessionQueries sessionQueries;

    protected ManagedAgentReadEntries(AgentSessionAdmissions sessionAdmissions,
            AgentSessionCommands sessionCommands, AgentSessionQueries sessionQueries) {
        super(sessionAdmissions, sessionCommands, sessionQueries);
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
