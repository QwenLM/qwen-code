package com.alibaba.qwen.code.runtimebroker;

/** A Workspace owns its original runtime; logical Session close never retires it. */
public final class ResidentWorkspaceProfile {
    public static final String PROFILE = "resident-workspace-files/1";
    public static final String CAPABILITY_DIGEST =
            "sha256:2cbf6f3825230848a65a546ec70714fbb2a53d1862a6caba73ae4cebf307b4ad";

    private ResidentWorkspaceProfile() {
    }

    public static boolean selects(RuntimeScope scope) {
        return scope != null && "workspace".equals(scope.getIsolationClass())
                && CAPABILITY_DIGEST.equals(scope.getCapabilityDigest());
    }

    public static boolean selects(RuntimeProvisionRequest request) {
        return request != null && selects(request.getScope()) && request.getIsolationKey() == null
                && "kubernetes-workspace".equals(request.getProvisionerKind()) && request.isManagedContext();
    }
}
