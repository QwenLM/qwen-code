package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/**
 * The principal-based entry arm of the Managed Agent facade, split out of
 * ManagedAgentStore so the facade stays under the class-size ratchet. The
 * bodies are the ones the facade declared inline. Since issue #16605 the
 * six annotated mutation entries are ALSO redeclared on the facade with
 * {@code @Transactional}: inheriting an annotated entry whose signature is
 * an interface default makes javac emit an annotation-less bridge on the
 * facade, and Spring then resolves no transaction attribute through the
 * interface path. The unannotated reads and ownership checks below carry
 * no such hazard. PrincipalEntryTransactionBoundaryTest is the permanent
 * witness for the boundary.
 */
class ManagedAgentPrincipalEntries {
    private final AgentSessionAdmissions sessionAdmissions;
    private final AgentSessionCommands sessionCommands;
    private final AgentSessionQueries sessionQueries;

    protected ManagedAgentPrincipalEntries(AgentSessionAdmissions sessionAdmissions,
            AgentSessionCommands sessionCommands, AgentSessionQueries sessionQueries) {
        this.sessionAdmissions = sessionAdmissions;
        this.sessionCommands = sessionCommands;
        this.sessionQueries = sessionQueries;
    }

    @Transactional
    public Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return sessionAdmissions.insertSessionCommand(tenantId, principal, operation, idempotencyKey, requestDigest, agentId, requestedRevision, title, input, payloadDigest);
    }

    @Transactional
    public Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            SessionModelConfig modelConfig) {
        return sessionAdmissions.insertSessionCommand(tenantId, principal, operation, idempotencyKey, requestDigest, agentId, requestedRevision, title, input, payloadDigest, modelConfig);
    }

    public void requireSessionOwnership(String tenantId, String sessionId,
            SessionPrincipal principal) {
        sessionAdmissions.requireSessionOwnership(tenantId, sessionId, principal);
    }

    public void requireSessionAuthority(String tenantId, String sessionId,
            SessionPrincipal principal) {
        sessionAdmissions.requireSessionAuthority(tenantId, sessionId, principal);
    }

    public void requireSessionReadAuthority(String tenantId, String sessionId,
            SessionPrincipal principal) {
        sessionAdmissions.requireSessionReadAuthority(tenantId, sessionId, principal);
    }

    public void requireSessionReadAuthority(String tenantId, String sessionId,
            String actorId) {
        sessionAdmissions.requireSessionReadAuthority(tenantId, sessionId, actorId);
    }

    public boolean ownsSession(String tenantId, String sessionId,
            SessionPrincipal principal) {
        return sessionAdmissions.ownsSession(tenantId, sessionId, principal);
    }

    @Transactional
    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            SessionPrincipal principal) {
        return sessionCommands.insertTurnCommand(tenantId, operation, idempotencyKey, requestDigest, sessionId, input, payloadDigest, principal);
    }

    @Transactional
    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, SessionPrincipal principal) {
        return sessionCommands.insertCancelCommand(tenantId, operation, idempotencyKey, requestDigest, sessionId, turnId, principal);
    }

    @Transactional
    public SessionMutationCommand beginSessionRename(String tenantId,
            String idempotencyKey, String requestDigest, String sessionId,
            String title, String actorId, SessionPrincipal principal) {
        return sessionCommands.beginSessionRename(tenantId, idempotencyKey, requestDigest, sessionId, title, actorId, principal);
    }

    @Transactional
    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId,
            SessionPrincipal principal) {
        return sessionCommands.beginSessionMutation(tenantId, operation, idempotencyKey, requestDigest, sessionId, kind, actorId, principal);
    }

    public SessionPage listSessions(String tenantId,
            SessionPrincipal principal, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState,
            String titleQuery) {
        return sessionQueries.listSessions(tenantId, principal, beforeCreatedAt, beforeSessionId, limit, archiveState, titleQuery);
    }

    public SessionPage listOwnedSessions(String tenantId,
            SessionPrincipal principal, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState,
            String titleQuery) {
        return sessionQueries.listOwnedSessions(tenantId, principal, beforeCreatedAt, beforeSessionId, limit, archiveState, titleQuery);
    }
}
