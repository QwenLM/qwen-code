package com.alibaba.qwen.code.managedagent.automation;

import com.alibaba.qwen.code.managedagent.contracts.automation.AutomationSessionModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AutomationDefinitionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicAutomation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import org.springframework.stereotype.Service;

/**
 * The internal Session-scoped automation routes' service. The writer binding
 * authorizes the exact Session (no user principal exists on the internal
 * surface), the creator actor is derived from the Session row, and the
 * mutations delegate to {@link ManagedAutomationService} with the bound
 * Session forced as the target. The public actor-scoped routes are untouched.
 */
@Service
public class ManagedAutomationSessionService {
    /** Covers the per-Session capacity (32) in one page for the internal list. */
    private static final int SESSION_PAGE_LIMIT = 100;

    private final ManagedSessionStore sessions;
    private final ManagedAutomationService automations;

    public ManagedAutomationSessionService(ManagedSessionStore sessions,
            ManagedAutomationService automations) {
        this.sessions = sessions;
        this.automations = automations;
    }

    public ManagedAutomationService.Result<PublicAutomation> create(String tenantId,
            String sessionId, String writerToken, String idempotencyKey,
            AutomationSessionModels.Create request) {
        authorize(tenantId, sessionId, writerToken, request.workspaceId(),
                request.writerId(), request.writerGeneration());
        String creator = creator(tenantId, sessionId);
        AutomationDefinitionRequest definition = request.definition();
        if (definition == null) {
            throw new ManagedAgentException(400, "invalid_automation",
                    "definition is required.");
        }
        // The internal route's target is always the bound Session, never a
        // caller-chosen one.
        AutomationDefinitionRequest scoped = new AutomationDefinitionRequest(
                sessionId, definition.goal(), definition.cron(),
                definition.timezone(), definition.prompt(),
                definition.sessionMode(), definition.overlap(),
                definition.catchUp(), definition.catchUpLimit(),
                definition.enabled(), definition.gate());
        return automations.create(tenantId, creator, idempotencyKey, scoped);
    }

    public PublicList<PublicAutomation> list(String tenantId, String sessionId,
            String writerToken, AutomationSessionModels.ListRequest request) {
        authorize(tenantId, sessionId, writerToken, request.workspaceId(),
                request.writerId(), request.writerGeneration());
        int limit = request.limit() == null ? SESSION_PAGE_LIMIT : request.limit();
        return automations.listSession(tenantId, sessionId, request.cursor(), limit);
    }

    public ManagedAutomationService.Result<PublicAutomation> retire(String tenantId,
            String sessionId, String writerToken, String idempotencyKey,
            AutomationSessionModels.Retire request) {
        authorize(tenantId, sessionId, writerToken, request.workspaceId(),
                request.writerId(), request.writerGeneration());
        String creator = creator(tenantId, sessionId);
        return automations.retireSession(tenantId, sessionId, creator,
                request.automationId(), idempotencyKey);
    }

    private void authorize(String tenantId, String sessionId, String writerToken,
            String workspaceId, String writerId, long writerGeneration) {
        sessions.authorizeOrdinary(tenantId, sessionId, writerToken,
                new AuthorizeLifecycleRequest(workspaceId, writerId, writerGeneration));
    }

    private String creator(String tenantId, String sessionId) {
        String creator = sessions.creatorActor(tenantId, sessionId);
        if (creator.isEmpty()) {
            throw new ManagedAgentException(403, "session_operation_forbidden",
                    "The Session has no creator actor.");
        }
        return creator;
    }
}
