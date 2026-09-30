package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.Set;

/** Session ownership and bounded wire envelope for private Hook controls. */
public final class ManagedHookProtocol {
    static final String PATH = "/internal/managed-runtime/v3/hooks";
    private static final Set<String> KINDS = Set.of("hook-catalog", "hook-execute", "hook-status", "hook-cancel");
    private static final Set<String> RECOVERY_KINDS = Set.of("hook-status", "hook-cancel");
    private static final Set<String> VIEW_FIELDS = Set.of("operationId", "state", "catalog", "result", "error");
    private static final Set<String> STATES = Set.of("running", "settled", "outcome_unknown");

    private ManagedHookProtocol() {
    }

    public static boolean isOperation(Map<String, Object> operation) {
        return operation.get("kind") instanceof String kind && KINDS.contains(kind);
    }

    public static boolean isRecovery(Map<String, Object> operation) {
        return operation.get("kind") instanceof String kind && RECOVERY_KINDS.contains(kind);
    }

    public static void validateSession(RuntimeSession session, Map<String, Object> operation) {
        if (!BrokerValues.isWellFormedJson(operation)) {
            throw invalid("Hook operation is invalid.");
        }
        RuntimeScope scope = session.getScope();
        Map<String, Object> expected = Map.of("tenantId", scope.getTenantId(),
                "workspaceId", scope.getWorkspaceId(), "sessionId", session.getHarnessSessionId());
        if (!isOperation(operation) || !expected.equals(operation.get("sessionKey"))
                || !(operation.get("operationId") instanceof String id) || id.isBlank() || id.length() > 512) {
            throw invalid("Hook operation does not belong to the acquired Session.");
        }
    }

    static Map<String, Object> response(byte[] bytes, RuntimeSession session, Map<String, Object> request) {
        Map<String, Object> envelope = ManagedContextProtocol.parse(bytes);
        Object expectedId = Set.of("hook-status", "hook-cancel").contains(request.get("kind"))
                ? request.get("targetOperationId") : request.get("operationId");
        if (!envelope.keySet().equals(Set.of("protocolVersion", "runtimeSessionId", "operation"))
                || !Integer.valueOf(1).equals(envelope.get("protocolVersion"))
                || !session.getRuntimeSessionId().equals(envelope.get("runtimeSessionId"))
                || !(envelope.get("operation") instanceof Map<?, ?> view)
                || !VIEW_FIELDS.containsAll(view.keySet())
                || expectedId == null || !expectedId.equals(view.get("operationId"))
                || !(view.get("state") instanceof String state) || !STATES.contains(state)
                || view.containsKey("result") && !(view.get("result") instanceof Map)
                || view.containsKey("catalog") && !(view.get("catalog") instanceof Map)
                || view.containsKey("error") && (!(view.get("error") instanceof Map<?, ?> error)
                        || !error.keySet().equals(Set.of("code"))
                        || !(error.get("code") instanceof String code) || !code.matches("[a-z][a-z0-9_]{0,127}"))
                || !"settled".equals(state) && (view.containsKey("result") || view.containsKey("catalog"))) {
            throw new RuntimeBrokerException(502, "managed_hook_response_invalid",
                    "Managed Hook response is invalid.", false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) view;
        return result;
    }

    private static RuntimeBrokerException invalid(String message) {
        return new RuntimeBrokerException(400, "runtime_control_operation_invalid", message, false);
    }
}
