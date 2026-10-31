package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public interface ManagedActionStore {
    public record Action(
            String id,
            String state,
            JsonNode options,
            String decisionReceiptId,
            String decisionDigest) {}

    public record Response(
            String actionId, JsonNode body, String errorCode, String decisionReceiptId) {}

    public String approvalMode(String tenantId, String sessionId);

    public Optional<Action> find(String tenantId, String sessionId, String id);

    public record ScopedAction(String sessionId, Action action) { }

    public List<ScopedAction> listWithChildren(String tenant, String parent, Long before,
            String beforeSession, String beforeId, int limit);

    public List<Action> list(
            String tenantId, String sessionId, Long before, String beforeId, int limit);

    public OperationAdmission admit(
            String tenantId,
            String sessionId,
            String actorId,
            String actorDigest,
            String key,
            String requestDigest,
            String actionId,
            JsonNode body,
            long now);

    public Optional<String> publicTurnId(String tenantId, String sessionId, String promptId);

    public Response response(String tenantId, String sessionId, String op);

    public List<OperationTarget> deliverable(long now);

    public void settleEndedResponses(long now);

    public void complete(
            OperationRecord op,
            String owner,
            String errorCode,
            String decisionReceiptId,
            boolean harnessConfirmed,
            long now);

    public static String endedCode(String state) {
        return switch (state) {
            case "expired" -> "action_expired";
            case "cancelled" -> "action_cancelled";
            default -> "action_already_resolved";
        };
    }

    public static String decisionDigest(JsonNode response) {
        Map<String, Object> decision = new LinkedHashMap<>();
        decision.put("v", 1);
        decision.put("optionId", response.path("optionId").asText());
        decision.put("inputRevision", response.path("inputRevision").asLong());
        decision.put("policyRevision", response.path("policyRevision").asText());
        try {
            return DigestUtils.sha256Hex(Codec.JSON.writeValueAsBytes(decision));
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
    final class Codec {
        private static final ObjectMapper JSON = new ObjectMapper();

        private Codec() { }
    }
}
