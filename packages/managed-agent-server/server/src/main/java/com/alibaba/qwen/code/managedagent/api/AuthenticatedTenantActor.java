package com.alibaba.qwen.code.managedagent.api;

import java.security.Principal;

/** Supplied by a trusted authentication adapter, never from request headers. */
public interface AuthenticatedTenantActor extends Principal {
    String tenantId();

    String actorId();

    /**
     * Inert until a trusted adapter signs and supplies a business subject:
     * no production implementation overrides this today, so the whole
     * subject axis of the ownership contract stays test-only. A future
     * adapter must carry the subject in its signed material — never an
     * HTTP header or request body — and also wire it into the tenant
     * filter's {@code TenantContext}: {@code TenantContextFilter} forwards
     * the actor id only, so overriding this method alone changes nothing
     * on a live request.
     */
    default String actorSubjectId() {
        return null;
    }
}
