package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;

public record TenantContext(String tenantId, String actorId,
        String actorSubjectId) {
    public TenantContext(String tenantId, String actorId) {
        this(tenantId, actorId, null);
    }

    public String requireActorId() {
        if (actorId == null) {
            throw new ManagedAgentException(401,
                    "actor_required", "A trusted actor is required.");
        }
        return actorId;
    }

    /**
     * The full ownership principal, when the trusted boundary supplied an
     * authenticated, non-blank user. A subject is never inferred from the
     * actor id or from request data.
     */
    public SessionPrincipal principal() {
        if (actorId == null || actorId.isBlank()) {
            return null;
        }
        return actorSubjectId == null
                ? SessionPrincipal.ofUser(tenantId, actorId)
                : SessionPrincipal.of(tenantId, actorId, actorSubjectId);
    }

    public SessionPrincipal requirePrincipal() {
        SessionPrincipal principal = principal();
        if (principal == null) {
            throw new ManagedAgentException(401,
                    "actor_required", "A trusted actor is required.");
        }
        return principal;
    }

    /**
     * The ownership principal of a request that carries a verified business
     * actor subject, or null when it carries none. A subject-bearing
     * ownership row can only be matched by this principal, so every later
     * route of that Session must authorize with it. A subject-less request
     * keeps the raw-actor path: that matches the same actor-absent rows
     * without re-encoding an actor the principal's byte bound may reject.
     */
    public SessionPrincipal subjectPrincipal() {
        return actorSubjectId == null ? null : requirePrincipal();
    }
}
