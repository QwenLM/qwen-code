package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.Set;

/**
 * Session ownership and bounded wire envelope for Monitor watch maintenance
 * controls: status and stop about one supervised watch, never about a new
 * model turn. The mirror of {@link ManagedShellProtocol}: both kinds are
 * recovery kinds, and the answer shapes are the same bounded view. The
 * envelope itself lives in {@link ManagedHoldControlProtocol},
 * parameterized with the Monitor family's kinds and response error code
 * (#13930 R1-21).
 */
public final class ManagedMonitorProtocol {
    static final String PATH = "/internal/managed-runtime/v3/monitors";
    private static final ManagedHoldControlProtocol PROTOCOL = new ManagedHoldControlProtocol(
            Set.of(ManagedHoldFamily.MONITOR.statusKind(),
                    ManagedHoldFamily.MONITOR.stopKind()),
            "Monitor", "managed_monitor_response_invalid");

    private ManagedMonitorProtocol() {
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
