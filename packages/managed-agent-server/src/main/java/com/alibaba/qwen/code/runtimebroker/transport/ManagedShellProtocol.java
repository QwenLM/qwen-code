package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.RuntimeSession;

import java.util.Map;
import java.util.Set;

/**
 * Session ownership and bounded wire envelope for background Shell
 * maintenance controls: status and terminate about one supervised process,
 * never about a new model turn. Both kinds are recovery kinds — the
 * model-facing surface is a different shape. The envelope itself lives in
 * {@link ManagedHoldControlProtocol}, parameterized with the Shell
 * family's kinds and response error code (#13930 R1-21).
 */
public final class ManagedShellProtocol {
    static final String PATH = "/internal/managed-runtime/v3/shells";
    private static final ManagedHoldControlProtocol PROTOCOL = new ManagedHoldControlProtocol(
            Set.of(ManagedHoldFamily.SHELL.statusKind(),
                    ManagedHoldFamily.SHELL.stopKind()),
            "Shell", "managed_shell_response_invalid");

    private ManagedShellProtocol() {
    }

    public static boolean isOperation(Map<String, Object> operation) {
        return PROTOCOL.isOperation(operation);
    }

    public static boolean isRecovery(Map<String, Object> operation) {
        return PROTOCOL.isRecovery(operation);
    }

    public static void validateSession(RuntimeSession session,
            Map<String, Object> operation) {
        PROTOCOL.validateSession(session, operation);
    }

    static Map<String, Object> response(byte[] bytes, RuntimeSession session,
            Map<String, Object> request) {
        return PROTOCOL.response(bytes, session, request);
    }
}
