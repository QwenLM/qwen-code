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

    /**
     * Registered external storage plus foreground Shell (#15512 slice C).
     * Pinned hex of sha256("managed-workspace-execution/1;external-shell/1"),
     * derived exactly as the terminal digest above; the Harness derives the
     * same value in managed-workspace-activation.ts.
     *
     * <p>This is a separate capability from {@link #CAPABILITY_DIGEST} so the
     * files placement keeps its exact four-tool admission and its handle
     * version. A binding carrying this digest is the only external placement
     * that may dispatch a Tool v3 Shell, and a files handle is never
     * reinterpreted as a Shell handle.
     */
    public static final String EXTERNAL_SHELL_PROFILE = "managed-workspace-execution/1;external-shell/1";
    public static final String EXTERNAL_SHELL_CAPABILITY_DIGEST =
            "sha256:3c5d6034815a24441f8ba119e7f6f81baa09686d4bbfd7bbf3ce75837be2f840";
    /**
     * The external Shell resource-handle version, reserved for the follow-up
     * Broker half (#17474). Nothing mints or accepts it yet: both external
     * placements currently write version 1 and are distinguished by their
     * capability digests, which every binding and attestation compares.
     */
    public static final int EXTERNAL_SHELL_HANDLE_VERSION = 2;

    public static final String PRIVATE_ROOT_CAPABILITY_DIGEST =
            "sha256:e3b6f905a8c29c601d33a2a6204d69c307aa77bbe40e5146e3e45d8c616bf85c";
    public static final String CONFINEMENT_DENIED = "managed_runtime_confinement_denied";
    public static final String CONFINEMENT_UNAVAILABLE = "managed_runtime_confinement_unavailable";

    public static boolean isConfined(String digest) {
        return PRIVATE_ROOT_CAPABILITY_DIGEST.equals(digest);
    }

    public static RuntimeBrokerException confinementDenied() {
        return new RuntimeBrokerException(409, CONFINEMENT_DENIED,
                "The selected Runtime admits only confined foreground Shell at the Workspace root.", false);
    }

    public static RuntimeBrokerException confinementUnavailable() {
        return new RuntimeBrokerException(409, CONFINEMENT_UNAVAILABLE,
                "The selected Runtime could not establish private-root confinement.", false);
    }

    public static boolean allowsConfinedShell(Object name, Object input) {
        if (!"run_shell_command".equals(name) || !(input instanceof java.util.Map<?, ?> args)
                || !java.util.Set.of("command", "description", "timeout", "is_background").containsAll(args.keySet())
                || !(args.get("command") instanceof String command) || command.isBlank() || command.indexOf(0) != -1) {
            return false;
        }
        Object timeout = args.get("timeout");
        return (!args.containsKey("is_background") || Boolean.FALSE.equals(args.get("is_background")))
                && (!args.containsKey("description") || args.get("description") instanceof String)
                && (!args.containsKey("timeout") || timeout instanceof Number number
                    && number.doubleValue() == number.longValue() && number.longValue() >= 1 && number.longValue() <= 600_000);
    }

    private WorkspaceExecutionProfile() {
    }

    /** Whether the digest is a measured result-protocol profile. */
    public static boolean isMeasured(String digest) {
        return MEASURED_CAPABILITY_DIGEST.equals(digest)
                || TERMINAL_CAPABILITY_DIGEST.equals(digest);
    }

    /** Whether the placement is the registered external foreground-Shell lane. */
    public static boolean isExternalShell(String digest) {
        return EXTERNAL_SHELL_CAPABILITY_DIGEST.equals(digest);
    }

    /** The capability digests a registered external Workspace placement admits. */
    public static boolean admitsExternalWorkspaceDigest(String digest) {
        return CAPABILITY_DIGEST.equals(digest) || isExternalShell(digest);
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
                || isExternalShell(digest)
                || isMeasured(digest) || isConfined(digest) || ManagedExtensionExecutionProfile.admits(digest);
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
                && admitsExternalWorkspaceDigest(request.getScope().getCapabilityDigest())
                && admitsIsolationClass(request.getScope().getIsolationClass())
                && request.getIsolationKey() != null && !request.getIsolationKey().trim().isEmpty()
                && request.getScope().getWorkspaceId().equals(request.getStorageId());
    }

    /**
     * The external foreground-Shell placement: registered storage, one worker
     * per Session, its own capability digest. Structural selection only;
     * acquisition and drain still require the saved-binding proof.
     */
    public static boolean isExternalShellRequest(RuntimeProvisionRequest request) {
        return isExternalWorkspaceRequest(request)
                && isExternalShell(request.getScope().getCapabilityDigest())
                && "session".equals(request.getScope().getIsolationClass());
    }
}
