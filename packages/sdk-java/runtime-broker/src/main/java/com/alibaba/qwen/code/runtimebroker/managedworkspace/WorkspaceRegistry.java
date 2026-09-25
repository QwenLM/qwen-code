package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import java.util.List;
import java.util.Optional;

/**
 * Read contract for administrator-registered Workspaces. Every operation is
 * scoped to one tenant and never returns another tenant's record. There is no
 * registration operation: Workspaces come from deployment configuration or a
 * product directory, never from a caller-supplied path.
 */
public interface WorkspaceRegistry {
    /** Returns the record, or empty when this tenant has no such Workspace. */
    Optional<WorkspaceRecord> find(String tenantId, String workspaceId);

    /**
     * Returns up to {@code limit} of the tenant's records in byte order of
     * the Workspace ID, starting after {@code afterWorkspaceId}, or from the
     * first record when it is null. A result shorter than {@code limit}
     * means that no records follow. Implementations accept any limit from 1
     * to 1000.
     */
    List<WorkspaceRecord> page(String tenantId, String afterWorkspaceId,
            int limit);

    /** Returns the tenant's configured default Workspace ID, if any. */
    Optional<String> defaultWorkspaceId(String tenantId);
}
