package com.alibaba.qwen.code.runtimebroker;

/** Immutable, preapproved private tool profile; not a Hosted model profile. */
public final class WorkspaceExecutionProfile {
    public static final String CONFIG_REF = "managed-runtime-tools/1";
    public static final String POLICY_REF = "preapproved-workspace-tools/1";
    public static final String PROFILE = "managed-workspace-execution/1";
    public static final String CONTEXT_CONFIG_REF =
            "sha256:5fa15183dcfe582ce54c28bf25aff62801d19038a9ec649e9bfc67b06f2a389f";
    public static final String CAPABILITY_DIGEST =
            "sha256:7df3981fa14b397fe09f6ba84ed0c096c71902394da667bf47f3b315866e7f91";

    private WorkspaceExecutionProfile() {
    }

    /** Whether Workspace execution may run under this Runtime isolation class. */
    public static boolean admitsIsolationClass(String isolationClass) {
        return "session".equals(isolationClass);
    }

    /**
     * Whether the scope is a bound-Session Workspace placement (the local shared
     * profile), which participates in Harness Session admission fencing.
     */
    public static boolean admitsCapabilityDigest(String digest) {
        return CAPABILITY_DIGEST.equals(digest) || ManagedExtensionExecutionProfile.admits(digest);
    }

    public static boolean isBoundWorkspaceScope(RuntimeScope scope) {
        return admitsCapabilityDigest(scope.getCapabilityDigest())
                && "workspace".equals(scope.getIsolationClass());
    }

    /**
     * Structural selection of the registered EXTERNAL Workspace profile; not
     * acquisition or execution authority. Lives here because Contracts owns the
     * admission fence and cannot see the provisioner that consumes it.
     */
    public static boolean isExternalWorkspaceRequest(RuntimeProvisionRequest request) {
        return request != null
                && com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE
                        .equals(request.getProvisionerKind())
                && request.isManagedContext()
                && CAPABILITY_DIGEST.equals(request.getScope().getCapabilityDigest())
                && ("session".equals(request.getScope().getIsolationClass())
                        && request.getIsolationKey() != null
                        && !request.getIsolationKey().trim().isEmpty()
                        || "workspace".equals(request.getScope().getIsolationClass())
                                && request.getIsolationKey() == null)
                && request.getScope().getWorkspaceId().equals(request.getStorageId());
    }
}
