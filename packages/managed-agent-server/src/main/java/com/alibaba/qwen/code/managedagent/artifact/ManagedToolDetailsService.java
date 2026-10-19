package com.alibaba.qwen.code.managedagent.artifact;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellToolDetails;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.ManagedToolDetailsStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class ManagedToolDetailsService {
    private final ManagedAgentService sessions;
    private final ManagedToolDetailsStore details;

    public ManagedToolDetailsService(ManagedAgentService sessions,
            ManagedToolDetailsStore details) {
        this.sessions = sessions;
        this.details = details;
    }

    public WebShellToolDetails get(TenantContext tenant, String sessionId, String itemId) {
        SessionRecord session = authorize(tenant, sessionId);
        WebShellToolDetails result = details.read(tenant.tenantId(), session.workspace().getWorkspaceId(),
                session.sessionId(), itemId);
        authorize(tenant, sessionId);
        return result;
    }

    private SessionRecord authorize(TenantContext tenant, String sessionId) {
        tenant.requireActorId();
        SessionRecord session = sessions.requireReadableSession(tenant.tenantId(), tenant.actorId(), sessionId);
        if (session.workspace() == null || "DELETING".equals(session.status())) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND, "tool_details_not_found", "Tool details are unavailable.");
        }
        return session;
    }
}
