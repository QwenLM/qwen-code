package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;

public record TenantContext(String tenantId, String actorId) {
    public String requireActorId() {
        if (actorId == null) {
            throw new ManagedAgentException(401,
                    "actor_required", "A trusted actor is required.");
        }
        return actorId;
    }
}
