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
}
