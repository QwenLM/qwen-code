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
    public static final String MEASURED_PROFILE = "managed-workspace-execution/2";
    public static final String MEASURED_CAPABILITY_DIGEST =
            "sha256:b2ab403f278282eb8f2ca06c926be96bd3d85877714f64dc926eab535f544580";
    /**
     * The measured Workspace profile plus the user-terminal surface. Pinned
     * hex of sha256("managed-workspace-execution/2;web-terminal/1"); the
     * Harness derives the same digest in managed-workspace-activation.ts.
     */
    public static final String TERMINAL_CAPABILITY_DIGEST =
            "sha256:9baac28c39d400da6ae0a754af655a2754b03ff74b583649d6080acca60f4a76";

    private WorkspaceExecutionProfile() {
    }

    /** Whether the digest is a measured result-protocol profile. */
    public static boolean isMeasured(String digest) {
        return MEASURED_CAPABILITY_DIGEST.equals(digest)
                || TERMINAL_CAPABILITY_DIGEST.equals(digest);
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
        return CAPABILITY_DIGEST.equals(digest)
                || isMeasured(digest) || ManagedExtensionExecutionProfile.admits(digest);
    }

    public static boolean isBoundWorkspaceScope(RuntimeScope scope) {
        return admitsCapabilityDigest(scope.getCapabilityDigest())
                && "workspace".equals(scope.getIsolationClass());
    }
}
