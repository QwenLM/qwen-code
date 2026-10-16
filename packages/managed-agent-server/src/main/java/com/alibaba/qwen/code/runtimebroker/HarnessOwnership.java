package com.alibaba.qwen.code.runtimebroker;

/**
 * Says who owns the Harness fences on a Runtime binding. A Session-isolated
 * binding belongs to the Harness Session its isolation key names; a
 * Workspace-isolated local Workspace binding is shared, so each Runtime
 * Session and execution on it answers for its own Harness Session.
 */
public final class HarnessOwnership {
    private HarnessOwnership() {
    }

    /** Whether Runtime Sessions of several Harness Sessions may share this binding. */
    public static boolean sharesRuntimeSessions(RuntimeProvisionRequest request) {
        return request != null
                && "workspace".equals(request.getScope().getIsolationClass())
                && request.isManagedContext()
                && LocalProcessRuntimeProvisioner.KIND.equals(request.getProvisionerKind())
                && WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(request.getScope().getCapabilityDigest());
    }
}
