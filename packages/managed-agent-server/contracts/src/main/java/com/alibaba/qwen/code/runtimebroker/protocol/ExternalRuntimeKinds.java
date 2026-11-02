package com.alibaba.qwen.code.runtimebroker.protocol;

/**
 * The external Runtime kind family: the shipped {@code external-scratch} profile
 * and the {@code external-workspace} profile.
 *
 * <p>Every kind in the family speaks the same HTTP provider transport, keeps the
 * same durable handle and placement semantics and shares the same retry and
 * recovery classification. A site that names one member directly would silently
 * treat the other as a foreign provisioner — zero configuration validation, a
 * permanent recovery block for retryable provider failures, or an unknown
 * provisioner refusal — so the family is named here, once.
 */
public final class ExternalRuntimeKinds {
    private ExternalRuntimeKinds() {
    }

    public static boolean isExternal(String provisionerKind) {
        return com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH.equals(provisionerKind)
                || com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE.equals(provisionerKind);
    }

    /** Whether the kind binds registered EXTERNAL storage. */
    public static boolean isWorkspace(String provisionerKind) {
        return com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE.equals(provisionerKind);
    }

    /** The provisioner names an operator can configure today, for messages. */
    public static String supported() {
        return com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH + " or " + com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE;
    }
}
