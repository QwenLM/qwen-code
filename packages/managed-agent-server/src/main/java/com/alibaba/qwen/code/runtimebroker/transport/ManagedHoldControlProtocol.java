package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.provisioning.ManagedContextProtocol;

import java.util.Map;
import java.util.Set;

/**
 * The wire envelope both hold families share for their maintenance
 * controls: the Session ownership preconditions, the bounded view the
 * transport answer must carry, and the evidence an exited end must prove.
 * Only the family label, its kinds, and its response error code differ —
 * those stay per-family parameters, and the kinds derive from {@link
 * ManagedHoldFamily} instead of being re-typed here (#13930 R1-21).
 */
final class ManagedHoldControlProtocol {
    private static final Set<String> VIEW_FIELDS = Set.of("operationId",
            "state", "unitName", "evidence");
    private static final Set<String> STATES = Set.of("running", "exited",
            "unknown");
    private static final Set<String> EVIDENCE_FIELDS = Set.of("exitCode",
            "exitSignal");

    private final Set<String> kinds;
    private final String family;
    private final String responseErrorCode;

    ManagedHoldControlProtocol(Set<String> kinds, String family,
            String responseErrorCode) {
        this.kinds = kinds;
        this.family = family;
        this.responseErrorCode = responseErrorCode;
    }

    boolean isOperation(Map<String, Object> operation) {
        return operation.get("kind") instanceof String kind
                && kinds.contains(kind);
    }

    boolean isRecovery(Map<String, Object> operation) {
        return isOperation(operation);
    }

    void validateSession(RuntimeSession session,
            Map<String, Object> operation) {
        if (!BrokerValues.isWellFormedJson(operation)) {
            throw invalid(family + " operation is invalid.");
        }
        RuntimeScope scope = session.getScope();
        Map<String, Object> expected = Map.of("tenantId", scope.getTenantId(),
                "workspaceId", scope.getWorkspaceId(), "sessionId",
                session.getHarnessSessionId());
        if (!isOperation(operation)
                || !expected.equals(operation.get("sessionKey"))
                || !(operation.get("operationId") instanceof String id)
                || id.isBlank() || id.length() > 512
                || !(operation.get("targetOperationId") instanceof String target)
                || target.isBlank() || target.length() > 512) {
            throw invalid(family
                    + " operation does not belong to the acquired Session.");
        }
    }

    Map<String, Object> response(byte[] bytes, RuntimeSession session,
            Map<String, Object> request) {
        Map<String, Object> envelope = ManagedContextProtocol.parse(bytes);
        Object expectedId = request.get("targetOperationId");
        if (!envelope.keySet().equals(Set.of("protocolVersion",
                "runtimeSessionId", "operation"))
                || !Integer.valueOf(1).equals(envelope.get("protocolVersion"))
                || !session.getRuntimeSessionId()
                        .equals(envelope.get("runtimeSessionId"))
                || !(envelope.get("operation") instanceof Map<?, ?> view)
                || !VIEW_FIELDS.containsAll(view.keySet())
                || expectedId == null
                || !(view.get("operationId") instanceof String id)
                || id.isBlank()
                || !expectedId.equals(view.get("operationId"))
                || !(view.get("state") instanceof String state)
                || !STATES.contains(state)
                || "exited".equals(state)
                        && !validEvidence(view.get("evidence"))
                || "running".equals(state)
                        && !(view.get("unitName") instanceof String)
                || !"exited".equals(state) && view.containsKey("evidence")
                || "unknown".equals(state) && view.containsKey("unitName")) {
            throw new RuntimeBrokerException(502, responseErrorCode,
                    "Managed " + family + " response is invalid.", false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) view;
        return result;
    }

    private static boolean validEvidence(Object value) {
        if (!(value instanceof Map<?, ?> evidence)
                || !EVIDENCE_FIELDS.containsAll(evidence.keySet())) {
            return false;
        }
        Object code = evidence.get("exitCode");
        Object signal = evidence.get("exitSignal");
        return (code == null || code instanceof Integer)
                && (signal == null || signal instanceof String)
                && !(code == null && signal == null);
    }

    private static RuntimeBrokerException invalid(String message) {
        return new RuntimeBrokerException(400,
                "runtime_control_operation_invalid", message, false);
    }
}
