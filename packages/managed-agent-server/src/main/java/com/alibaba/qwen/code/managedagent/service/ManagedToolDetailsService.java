package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellToolDetails;
import com.alibaba.qwen.code.managedagent.api.TenantContext;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedToolDetailsStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class ManagedToolDetailsService {
    private final ManagedAgentService sessions;
    private final ManagedAgentProperties properties;
    private final ManagedToolDetailsStore details;

    public ManagedToolDetailsService(ManagedAgentService sessions,
            ManagedAgentProperties properties, ManagedToolDetailsStore details) {
        this.sessions = sessions;
        this.properties = properties;
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
            throw new ApiException(HttpStatus.NOT_FOUND, "tool_details_not_found", "Tool details are unavailable.");
        }
        if (!properties.getHarness().isToolDetailsEnabled()) {
            throw new ApiException(HttpStatus.FORBIDDEN, "tool_details_disabled",
                    "Tool detail reads are disabled.");
        }
        return session;
    }
}
