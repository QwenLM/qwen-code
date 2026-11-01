package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;

import java.nio.charset.StandardCharsets;

/**
 * The immutable, verified owner of a non-Workspace Session: the tenant, the
 * user and the DataAgent business actor subject. It is always constructed at
 * a trusted boundary from the verified request context and never from a
 * client body. A null {@code actorSubjectId} means the caller provably
 * carries no business actor; an empty one is rejected.
 */
public record SessionPrincipal(String tenantId, String userId,
        String actorSubjectId) {
    // The ownership columns hold 1024 bytes each. Keep headroom for a
    // future signed encoding while bounding every principal component.
    private static final int MAX_COMPONENT_BYTES = 512;

    public SessionPrincipal {
        if (tenantId == null || tenantId.isBlank()
                || userId == null || userId.isBlank()) {
            throw actorRequired();
        }
        checkComponent("tenant", tenantId);
        checkComponent("actor", userId);
        if (actorSubjectId != null) {
            if (actorSubjectId.isBlank()) {
                throw new ManagedAgentException(400,
                        "invalid_actor",
                        "An actor subject must not be empty or blank.");
            }
            checkComponent("actor subject", actorSubjectId);
        }
    }

    /** An ownership principal with no business actor. */
    public static SessionPrincipal ofUser(String tenantId, String userId) {
        return new SessionPrincipal(tenantId, userId, null);
    }

    /** An ownership principal carrying the business actor subject. */
    public static SessionPrincipal of(String tenantId, String userId,
            String actorSubjectId) {
        return new SessionPrincipal(tenantId, userId, actorSubjectId);
    }

    /** Whether this principal carries a business actor subject. */
    public boolean actorPresent() {
        return actorSubjectId != null;
    }

    private static void checkComponent(String name, String value) {
        if (value.indexOf(0) >= 0) {
            throw new ManagedAgentException(400,
                    "invalid_actor",
                    "The " + name + " must not contain NUL.");
        }
        if (value.getBytes(StandardCharsets.UTF_8).length
                > MAX_COMPONENT_BYTES) {
            throw new ManagedAgentException(400,
                    "invalid_actor",
                    "The " + name + " is too long.");
        }
    }

    private static ManagedAgentException actorRequired() {
        return new ManagedAgentException(401,
                "actor_required", "A trusted actor is required.");
    }
}
