package com.alibaba.qwen.code.managedagent.api;

import org.springframework.http.HttpStatus;

public record TenantContext(String tenantId, String actorId) {
    public String requireActorId() {
        if (actorId == null) {
            throw new ApiException(HttpStatus.UNAUTHORIZED,
                    "actor_required", "A trusted actor is required.");
        }
        return actorId;
    }
}
