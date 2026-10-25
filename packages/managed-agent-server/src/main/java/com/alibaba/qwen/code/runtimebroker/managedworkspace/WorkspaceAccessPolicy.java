package com.alibaba.qwen.code.runtimebroker.managedworkspace;

/**
 * Decides an actor's access to a Workspace of the actor's own tenant. The
 * catalog asks on every call and never caches the answer, so a revoked grant
 * takes effect on the next request.
 */
@FunctionalInterface
public interface WorkspaceAccessPolicy {
    WorkspaceAccess accessFor(WorkspaceActor actor, WorkspaceRecord workspace);
}
