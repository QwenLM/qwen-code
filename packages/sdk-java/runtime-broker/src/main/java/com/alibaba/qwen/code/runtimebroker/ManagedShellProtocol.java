package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.Set;

/**
 * Session ownership and bounded wire envelope for background Shell
 * maintenance controls: status and terminate about one supervised process,
 * never about a new model turn. Both kinds are recovery kinds — the
 * model-facing surface is a different shape.
 */
public final class ManagedShellProtocol {
    static final String PATH = "/internal/managed-runtime/v3/shells";
    private static final Set<String> KINDS = Set.of("shell-status", "shell-terminate");
    private static final Set<String> VIEW_FIELDS = Set.of("operationId", "state", "unitName", "evidence");
    private static final Set<String> STATES = Set.of("running", "exited", "unknown");
    private static final Set<String> EVIDENCE_FIELDS = Set.of("exitCode", "exitSignal");

    private ManagedShellProtocol() {
    }

    public static boolean isOperation(Map<String, Object> operation) {
        return operation.get("kind") instanceof String kind && KINDS.contains(kind);
    }

    public static boolean isRecovery(Map<String, Object> operation) {
        return isOperation(operation);
    }

    public static void validateSession(RuntimeSession session, Map<String, Object> operation) {
        if (!BrokerValues.isWellFormedJson(operation)) {
            throw invalid("Shell operation is invalid.");
        }
        RuntimeScope scope = session.getScope();
        Map<String, Object> expected = Map.of("tenantId", scope.getTenantId(),
                "workspaceId", scope.getWorkspaceId(), "sessionId", session.getHarnessSessionId());
        if (!isOperation(operation) || !expected.equals(operation.get("sessionKey"))
                || !(operation.get("operationId") instanceof String id) || id.isBlank() || id.length() > 512
                || !(operation.get("targetOperationId") instanceof String target) || target.isBlank()
                || target.length() > 512) {
            throw invalid("Shell operation does not belong to the acquired Session.");
        }
    }

    static Map<String, Object> response(byte[] bytes, RuntimeSession session, Map<String, Object> request) {
        Map<String, Object> envelope = ManagedContextProtocol.parse(bytes);
        Object expectedId = request.get("targetOperationId");
        if (!envelope.keySet().equals(Set.of("protocolVersion", "runtimeSessionId", "operation"))
                || !Integer.valueOf(1).equals(envelope.get("protocolVersion"))
                || !session.getRuntimeSessionId().equals(envelope.get("runtimeSessionId"))
                || !(envelope.get("operation") instanceof Map<?, ?> view)
                || !VIEW_FIELDS.containsAll(view.keySet())
                || expectedId == null
                || !(view.get("operationId") instanceof String id) || id.isBlank()
                || !expectedId.equals(view.get("operationId"))
                || !(view.get("state") instanceof String state) || !STATES.contains(state)
                || "exited".equals(state) && !validEvidence(view.get("evidence"))
                || "running".equals(state) && !(view.get("unitName") instanceof String)
                || !"exited".equals(state) && view.containsKey("evidence")
                || "unknown".equals(state) && view.containsKey("unitName")) {
            throw new RuntimeBrokerException(502, "managed_shell_response_invalid",
                    "Managed Shell response is invalid.", false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) view;
        return result;
    }

    private static boolean validEvidence(Object value) {
        if (!(value instanceof Map<?, ?> evidence) || !EVIDENCE_FIELDS.containsAll(evidence.keySet())) {
            return false;
        }
        Object code = evidence.get("exitCode");
        Object signal = evidence.get("exitSignal");
        return (code == null || code instanceof Integer)
                && (signal == null || signal instanceof String)
                && !(code == null && signal == null);
    }

    private static RuntimeBrokerException invalid(String message) {
        return new RuntimeBrokerException(400, "runtime_control_operation_invalid", message, false);
    }
}
