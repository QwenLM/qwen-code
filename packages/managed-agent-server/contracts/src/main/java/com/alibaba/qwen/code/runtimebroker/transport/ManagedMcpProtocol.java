package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocol;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Session ownership and bounded wire envelope for private MCP controls. */
public final class ManagedMcpProtocol {
    public static final String PATH = "/internal/managed-runtime/v3/mcp";
    public static final String DEFINITIONS_PATH = PATH + "/definitions";
    private static final Set<String> KINDS = Set.of("mcp-configure", "mcp-discover",
            "mcp-invoke", "mcp-status", "mcp-cancel", "mcp-release");
    private static final Set<String> RECOVERY_KINDS = Set.of("mcp-status", "mcp-cancel", "mcp-release");
    private static final Set<String> VIEW_FIELDS = Set.of("operationId", "state", "catalog", "response", "error");
    private static final Set<String> STATES = Set.of("running", "settled", "outcome_unknown");

    private ManagedMcpProtocol() {
    }

    public static List<Map<String, Object>> definitions(byte[] bytes) {
        Map<String, Object> envelope = ManagedContextProtocol.parse(bytes);
        if (!envelope.keySet().equals(Set.of("protocolVersion", "servers"))
                || !Integer.valueOf(1).equals(envelope.get("protocolVersion"))
                || !(envelope.get("servers") instanceof List<?> servers)) {
            throw new RuntimeBrokerException(502, "managed_mcp_response_invalid", "Runtime MCP definitions are invalid.", false);
        }
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> identities = new HashSet<>();
        for (Object entry : servers) {
            Long revision = entry instanceof Map<?, ?> value ? BrokerValues.exactLong(value.get("serverRevision")) : null;
            if (!(entry instanceof Map<?, ?> pin)
                    || !pin.keySet().equals(Set.of("serverId", "serverRevision", "definitionDigest", "transport"))
                    || !(pin.get("serverId") instanceof String id) || !id.matches("[A-Za-z0-9._:-]{1,128}")
                    || revision == null || revision < 1 || revision > 9_007_199_254_740_991L
                    || !(pin.get("definitionDigest") instanceof String digest) || !digest.matches("[a-f0-9]{64}")
                    || !(pin.get("transport") instanceof String transport)
                    || !Set.of("stdio", "streamable-http", "sse").contains(transport)
                    || !identities.add(id + "\0" + revision.longValue())) {
                throw new RuntimeBrokerException(502, "managed_mcp_response_invalid", "Runtime MCP definitions are invalid.", false);
            }
            result.add(Map.of("serverId", id, "serverRevision", revision.longValue(),
                    "definitionDigest", digest, "transport", transport));
        }
        return List.copyOf(result);
    }

    public static boolean isOperation(Map<String, Object> operation) {
        return operation.get("kind") instanceof String kind && KINDS.contains(kind);
    }

    public static boolean isRecovery(Map<String, Object> operation) {
        return operation.get("kind") instanceof String kind && RECOVERY_KINDS.contains(kind);
    }

    public static void validateSession(RuntimeSession session, Map<String, Object> operation) {
        if (!BrokerValues.isWellFormedJson(operation)) {
            throw invalid("MCP operation is invalid.");
        }
        RuntimeScope scope = session.getScope();
        Map<String, Object> expected = Map.of("tenantId", scope.getTenantId(),
                "workspaceId", scope.getWorkspaceId(), "sessionId", session.getHarnessSessionId());
        if (!isOperation(operation) || !expected.equals(operation.get("sessionKey"))
                || !(operation.get("operationId") instanceof String id) || id.isBlank() || id.length() > 512) {
            throw invalid("MCP operation does not belong to the acquired Session.");
        }
        if ("mcp-invoke".equals(operation.get("kind"))
                && (!(operation.get("request") instanceof Map<?, ?> request)
                        || !(request.get("kind") instanceof String requestKind)
                        || !Set.of("resource_read", "prompt_get").contains(requestKind))) {
            throw invalid("MCP tool calls require the ordinary tool execution path.");
        }
    }

    public static Map<String, Object> response(byte[] bytes, RuntimeSession session, Map<String, Object> request) {
        Map<String, Object> envelope = ManagedContextProtocol.parse(bytes);
        Object expectedId = Set.of("mcp-status", "mcp-cancel").contains(request.get("kind"))
                ? request.get("targetOperationId") : request.get("operationId");
        if (!envelope.keySet().equals(Set.of("protocolVersion", "runtimeSessionId", "operation"))
                || !Integer.valueOf(1).equals(envelope.get("protocolVersion"))
                || !session.getRuntimeSessionId().equals(envelope.get("runtimeSessionId"))
                || !(envelope.get("operation") instanceof Map<?, ?> view)
                || !VIEW_FIELDS.containsAll(view.keySet())
                || expectedId == null || !expectedId.equals(view.get("operationId"))
                || !(view.get("state") instanceof String state) || !STATES.contains(state)
                || view.containsKey("response") && !(view.get("response") instanceof Map)
                || view.containsKey("catalog") && !(view.get("catalog") instanceof Map)
                || view.containsKey("error") && (!(view.get("error") instanceof Map<?, ?> error)
                        || !error.keySet().equals(Set.of("code"))
                        || !(error.get("code") instanceof String code) || !code.matches("[a-z][a-z0-9_]{0,127}"))
                || !"settled".equals(state) && (view.containsKey("response") || view.containsKey("catalog"))) {
            throw new RuntimeBrokerException(502, "managed_mcp_response_invalid",
                    "Managed MCP response is invalid.", false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) view;
        return result;
    }

    private static RuntimeBrokerException invalid(String message) {
        return new RuntimeBrokerException(400, "runtime_control_operation_invalid", message, false);
    }
}
