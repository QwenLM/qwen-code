package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.provisioning.ManagedContextProtocol;

import java.util.Map;
import java.util.Set;

/** Extension preprocessing retains the ordinary tool Session and its workspace mount. */
public final class ManagedExtensionCommandProtocol {
    static final String PATH = "/internal/managed-runtime/v3/extensions/commands";

    private ManagedExtensionCommandProtocol() { }

    public static boolean isOperation(Map<String, Object> operation) {
        return "extension-command".equals(operation.get("kind"));
    }

    public static boolean isRecovery(Map<String, Object> operation) {
        return isOperation(operation) && !"execute".equals(operation.get("action"));
    }

    public static void validateSession(RuntimeSession session, Map<String, Object> operation) {
        var scope = session.getScope();
        Long revision = BrokerValues.exactLong(operation.get("revision"));
        Map<String, Object> expected = Map.of("tenantId", scope.getTenantId(), "workspaceId", scope.getWorkspaceId(),
                "sessionId", session.getHarnessSessionId());
        if (!BrokerValues.isWellFormedJson(operation) || !isOperation(operation)
                || !ManagedExtensionExecutionProfile.admits(scope.getCapabilityDigest())
                || !operation.keySet().equals(Set.of("kind", "operationId", "action", "grant", "toolName", "input", "revision", "extensionId"))
                || !(operation.get("operationId") instanceof String id) || id.isBlank() || id.length() > 512
                || !Set.of("execute", "status", "cancel").contains(String.valueOf(operation.get("action")))
                || !Set.of("read_file", "shell").contains(String.valueOf(operation.get("toolName")))
                || !(operation.get("input") instanceof Map) || revision == null || revision < 1 || revision > 9_007_199_254_740_991L
                || !(operation.get("extensionId") instanceof String extensionId) || !extensionId.matches("ext_[a-f0-9-]{36}")
                || !(operation.get("grant") instanceof Map<?, ?> grant) || !expected.equals(grant.get("sessionKey"))
                || !"tool_stage".equals(grant.get("domain")) || !session.getRuntimeSessionId().equals(grant.get("ownerId"))
                || !scope.getWorkspaceGeneration().equals(grant.get("workspaceGeneration"))) {
            throw invalid();
        }
    }

    static Map<String, Object> response(byte[] bytes, RuntimeSession session, Map<String, Object> request) {
        var envelope = ManagedContextProtocol.parse(bytes);
        if (!envelope.keySet().equals(Set.of("protocolVersion", "runtimeSessionId", "result"))
                || !Integer.valueOf(1).equals(envelope.get("protocolVersion"))
                || !session.getRuntimeSessionId().equals(envelope.get("runtimeSessionId"))
                || !(envelope.get("result") instanceof Map<?, ?> result)
                || !Set.of("operationId", "state", "result", "receipt").containsAll(result.keySet())
                || !request.get("operationId").equals(result.get("operationId"))
                || !(result.get("state") instanceof String state) || !Set.of("settled", "running", "outcome_unknown").contains(state)
                || result.containsKey("result") && !(result.get("result") instanceof Map)
                || result.containsKey("receipt") && !(result.get("receipt") instanceof Map)
                || !"settled".equals(state) && result.containsKey("result")) {
            throw new RuntimeBrokerException(502, "managed_extension_command_response_invalid", "Invalid extension command response.", false);
        }
        @SuppressWarnings("unchecked")
        var value = (Map<String, Object>) envelope.get("result");
        return BrokerValues.immutableMap(value);
    }

    private static RuntimeBrokerException invalid() {
        return new RuntimeBrokerException(400, "runtime_control_operation_invalid", "Invalid extension command control.", false);
    }
}
