package com.alibaba.qwen.code.managedagent.api;

import java.security.Principal;

/** Supplied by a trusted authentication adapter, never from request headers. */
public interface AuthenticatedTenantActor extends Principal {
    String tenantId();

    String actorId();
}
