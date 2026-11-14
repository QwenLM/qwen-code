package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.RuntimeSession;

import java.util.Map;
import java.util.Set;

/**
 * Session ownership and bounded wire envelope for user-terminal maintenance
 * controls: status and terminate about one open terminal, never about a new
 * model turn. Both kinds are recovery kinds, mirroring the background Shell
 * and Monitor families. The envelope itself lives in
 * {@link ManagedHoldControlProtocol}, parameterized with the Terminal
 * family's kinds and response error code.
 */
public final class ManagedTerminalProtocol {
    public static final String PATH = "/internal/managed-runtime/v3/terminals";
    private static final ManagedHoldControlProtocol PROTOCOL = new ManagedHoldControlProtocol(
            Set.of(ManagedHoldFamily.TERMINAL.statusKind(),
                    ManagedHoldFamily.TERMINAL.stopKind()),
            "Terminal", "managed_terminal_response_invalid");

    private ManagedTerminalProtocol() {
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

    public static Map<String, Object> response(byte[] bytes, RuntimeSession session,
            Map<String, Object> request) {
        return PROTOCOL.response(bytes, session, request);
    }
}
