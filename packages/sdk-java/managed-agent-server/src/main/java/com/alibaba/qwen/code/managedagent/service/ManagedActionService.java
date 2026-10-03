package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicActionList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore.Action;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class ManagedActionService {
    private final ManagedAgentService sessions;
    private final ManagedActionStore actions;
    private final ActionResponseCoordinator coordinator;
    private final RequestDigests digests;
    private final Clock clock;
    private final ObjectMapper json;

    public ManagedActionService(
            ManagedAgentService sessions,
            ManagedActionStore actions,
            ActionResponseCoordinator coordinator,
            RequestDigests digests,
            Clock clock,
            ObjectMapper json) {
        this.sessions = sessions;
        this.actions = actions;
        this.coordinator = coordinator;
        this.digests = digests;
        this.clock = clock;
        this.json = json;
    }

    public PublicActionList listPublic(
            String tenant, String actor, String session, String cursor, int limit) {
        List<Action> rows = page(tenant, actor, session, cursor, limit);
        boolean more = rows.size() > limit;
        List<Action> page = rows.subList(0, Math.min(limit, rows.size()));
        return new PublicActionList(
                page.stream().map(a -> view(tenant, session, a, false)).toList(),
                more,
                more ? cursor(page.get(page.size() - 1)) : null);
    }

    public WebShellPage<JsonNode> listWebShell(
            String tenant, String actor, String session, String cursor, int limit) {
        List<Action> rows = page(tenant, actor, session, cursor, limit);
        boolean more = rows.size() > limit;
        List<Action> page = rows.subList(0, Math.min(limit, rows.size()));
        return new WebShellPage<>(
                page.stream().map(a -> view(tenant, session, a, true)).toList(),
                more ? cursor(page.get(page.size() - 1)) : null,
                more);
    }

    public JsonNode get(String tenant, String actor, String session, String id, boolean web) {
        sessions.requireReadableSession(tenant, actor, session);
        return view(
                tenant,
                session,
                actions.find(tenant, session, id)
                        .orElseThrow(
                                () ->
                                        new ApiException(
                                                HttpStatus.NOT_FOUND,
                                                "action_not_found",
                                                "The Action was not found.")),
                web);
    }

    public OperationAdmission respond(
            String tenant,
            String actor,
            String session,
            String id,
            String key,
            String kind,
            JsonNode revision,
            String policy,
            String option) {
        sessions.requireReadableSession(tenant, actor, session);
        ManagedAgentService.validateIdempotencyKey(key);
        if (!"permission".equals(kind)
                || revision == null
                || !revision.isIntegralNumber()
                || !revision.canConvertToLong()) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_action_response",
                    "Only permission responses are supported.");
        }
        ObjectNode body =
                json.createObjectNode()
                        .put("optionId", option)
                        .put("inputRevision", revision.longValue())
                        .put("policyRevision", policy);
        OperationAdmission admitted =
                actions.admit(
                        tenant,
                        session,
                        actor,
                        digests.digest(Map.of("actorId", actor == null ? "" : actor)),
                        key,
                        digests.digest(Map.of("actionId", id, "response", body)),
                        id,
                        body,
                        clock.millis());
        if (!List.of("COMPLETED", "FAILED").contains(admitted.operation().state())) {
            coordinator.dispatch(tenant, session, admitted.operation().operationId());
        }
        return admitted;
    }

    public PublicCommandOperation publicOperation(OperationRecord op, boolean replay) {
        var response = actions.response(op.tenantId(), op.sessionId(), op.operationId());
        return new PublicCommandOperation(
                op.operationId(),
                op.sessionId(),
                "action_response",
                lower(op.state()),
                lower(op.admissionStage()),
                lower(op.deliveryState()),
                op.receiptId(),
                replay,
                resolution(op, response, false),
                "FAILED".equals(op.state()) ? response.errorCode() : null);
    }

    public WebShellCommandOperation webOperation(OperationRecord op, boolean replay) {
        var response = actions.response(op.tenantId(), op.sessionId(), op.operationId());
        return new WebShellCommandOperation(
                op.operationId(),
                op.sessionId(),
                "action_response",
                lower(op.state()),
                lower(op.admissionStage()),
                lower(op.deliveryState()),
                op.receiptId(),
                replay,
                resolution(op, response, true),
                "FAILED".equals(op.state()) ? response.errorCode() : null);
    }

    private JsonNode resolution(
            OperationRecord op, ManagedActionStore.Response response, boolean web) {
        if (!"COMPLETED".equals(op.state()) || response.decisionReceiptId() == null) {
            return null;
        }
        return json.createObjectNode()
                .put(web ? "actionId" : "action_id", response.actionId())
                .put("outcome", "decided")
                .put(web ? "receiptId" : "receipt_id", op.receiptId())
                .put(
                        web ? "decisionReceiptId" : "decision_receipt_id",
                        response.decisionReceiptId());
    }

    private List<Action> page(
            String tenant, String actor, String session, String cursor, int limit) {
        sessions.requireReadableSession(tenant, actor, session);
        if (limit < 1 || limit > 100) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST, "invalid_limit", "Limit must be between 1 and 100.");
        }
        Long before = null;
        String beforeId = null;
        if (cursor != null && !cursor.isEmpty()) {
            try {
                if (cursor.length() > 512) {
                    throw new IllegalArgumentException();
                }
                String decoded =
                        new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
                if (!decoded.matches("(0|[1-9][0-9]{0,18}):tool_approval_[0-9a-f]{32}")) {
                    throw new IllegalArgumentException();
                }
                String[] parts = decoded.split(":", 2);
                before = Long.parseLong(parts[0]);
                beforeId = parts[1];
            } catch (IllegalArgumentException error) {
                throw new ApiException(
                        HttpStatus.BAD_REQUEST, "invalid_cursor", "Action cursor is invalid.");
            }
        }
        return actions.list(tenant, session, before, beforeId, limit + 1);
    }

    private String cursor(Action action) {
        return Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString(
                        (action.options().path("createdAt").asLong() + ":" + action.id())
                                .getBytes(StandardCharsets.UTF_8));
    }

    private JsonNode view(String tenant, String session, Action action, boolean web) {
        JsonNode options = action.options();
        ObjectNode result =
                json.createObjectNode()
                        .put(web ? "actionId" : "id", action.id())
                        .put(web ? "sessionId" : "session_id", session)
                        .put("kind", "permission")
                        .put("state", action.state());
        result.set(
                "source",
                json.createObjectNode()
                        .put("kind", "tool_call")
                        .put("id", options.path("functionCallId").asText()));
        for (String field :
                List.of(
                        "inputRevision",
                        "policyRevision",
                        "createdAt",
                        "expiresAt",
                        "functionCallId",
                        "toolName")) {
            String name = web ? field : field.replaceAll("([A-Z])", "_$1").toLowerCase(Locale.ROOT);
            result.set(name, options.get(field));
        }
        actions.publicTurnId(tenant, session, options.path("turnId").asText())
                .ifPresent(turn -> result.put(web ? "turnId" : "turn_id", turn));
        result.set("options", options.path("options"));
        if (action.decisionReceiptId() != null) {
            result.put(
                    web ? "decisionReceiptId" : "decision_receipt_id", action.decisionReceiptId());
        }
        return result;
    }

    private static String lower(String value) {
        return value.toLowerCase(Locale.ROOT);
    }
}
