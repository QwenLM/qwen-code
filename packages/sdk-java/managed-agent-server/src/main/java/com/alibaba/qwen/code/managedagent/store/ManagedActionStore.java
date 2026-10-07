package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.springframework.dao.support.DataAccessUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

@Repository
public class ManagedActionStore {
    private final JdbcTemplate jdbc;
    private final AgentStateStore sessions;

    public ManagedActionStore(JdbcTemplate jdbc, AgentStateStore sessions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
    }

    public record Action(
            String id,
            String state,
            JsonNode options,
            String decisionReceiptId,
            String decisionDigest) {}

    public record Response(
            String actionId, JsonNode body, String errorCode, String decisionReceiptId) {}

    public String approvalMode(String tenantId, String sessionId) {
        return jdbc.queryForObject(
                "SELECT approval_mode FROM managed_agent_session WHERE tenant_id = ? AND session_id"
                        + " = ?",
                String.class,
                tenantId,
                sessionId);
    }

    public void requireOwner(String tenantId, String sessionId, String actorId) {
        byte[] key;
        try {
            key = actorId == null
                    ? null : ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            throw new ApiException(HttpStatus.FORBIDDEN,
                    "actor_scope_mismatch", "Authenticated actor scope is invalid.");
        }
        byte[] creator = DataAccessUtils.nullableSingleResult(jdbc.query(
                "SELECT creator_actor_key FROM managed_agent_session WHERE"
                        + " tenant_id = ? AND session_id = ?",
                (result, row) -> result.getBytes(1), tenantId, sessionId));
        if (creator != null) {
            if (key != null && Arrays.equals(creator, key)) {
                return;
            }
            throw forbidden();
        }
        int owners = jdbc.queryForObject(
                "SELECT COUNT(*) FROM managed_workspace_create_command WHERE"
                        + " tenant_id = ? AND session_id = ?",
                Integer.class, tenantId, sessionId);
        if (owners == 0) {
            // No recorded creator: an anonymous open-mode Session is
            // tenant-owned, matching its read semantics.
            return;
        }
        if (key != null
                && jdbc.queryForObject(
                                "SELECT COUNT(*) FROM managed_workspace_create_command WHERE"
                                        + " tenant_id = ? AND session_id = ? AND actor_id = ?",
                                Integer.class,
                                tenantId,
                                sessionId,
                                key)
                        == 1) {
            return;
        }
        throw forbidden();
    }

    private static ApiException forbidden() {
        return new ApiException(
                HttpStatus.FORBIDDEN,
                "action_forbidden",
                "Only the Session's creator may answer its Actions.");
    }

    void apply(
            String tenantId,
            String workspaceId,
            String sessionId,
            long firstSequence,
            int eventCount,
            byte[] bytes,
            Function<String, StoredResource> resources) {
        int index = -1;
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            index++;
            JsonNode record = read(line);
            if (!"managed_session_event_v1".equals(record.path("subtype").asText())) {
                continue;
            }
            JsonNode event = record.path("managedSession");
            if (!"action.changed".equals(event.path("kind").asText())) {
                continue;
            }
            JsonNode envelope = event.deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) envelope).remove("subject");
            if (event.has("subject")) {
                JsonNode subject = event.path("subject");
                closed(subject, "type", "scopeId", "activationId", "epoch");
                require(
                        "activation".equals(subject.path("type").asText())
                                && text(subject.path("scopeId"))
                                && text(subject.path("activationId"))
                                && safeNumber(subject.path("epoch"))
                                && subject.path("epoch").asLong() >= 1);
            }
            closed(
                    envelope,
                    "v",
                    "sequence",
                    "eventId",
                    "sessionKey",
                    "kind",
                    "occurredAt",
                    "payload");
            require(text(event.path("eventId")));
            require(
                    index < eventCount
                            && safeNumber(event.path("v"))
                            && event.path("v").asLong() == 1
                            && safeNumber(event.path("sequence"))
                            && event.path("sequence").asLong() == firstSequence + index
                            && safeNumber(event.path("occurredAt")));
            JsonNode key = event.path("sessionKey");
            closed(key, "tenantId", "workspaceId", "sessionId");
            require(
                    tenantId.equals(key.path("tenantId").asText())
                            && workspaceId.equals(key.path("workspaceId").asText())
                            && sessionId.equals(key.path("sessionId").asText()));
            JsonNode payload = event.path("payload");
            closed(
                    payload,
                    "requestId",
                    "kind",
                    "source",
                    "inputRevision",
                    "optionsRef",
                    "state",
                    "decisionRef");
            require(
                    safeNumber(payload.path("inputRevision"))
                            && payload.path("inputRevision").asLong() >= 1);
            String id = payload.path("requestId").asText();
            String state = payload.path("state").asText();
            require(
                    id.matches("tool_approval_[0-9a-f]{32}")
                            && "permission".equals(payload.path("kind").asText())
                            && "tool_call".equals(payload.path("source").asText())
                            && List.of("requested", "decided", "expired", "cancelled")
                                    .contains(state));
            JsonNode ref = payload.path("optionsRef");
            StoredResource resource = resource(ref, "managed-action-options", resources);
            JsonNode options = read(new String(resource.bytes(), StandardCharsets.UTF_8));
            List<String> optionFields = new ArrayList<>(List.of(
                    "v",
                    "requestId",
                    "turnId",
                    "functionCallId",
                    "toolName",
                    "policyRevision",
                    "inputRevision",
                    "createdAt",
                    "expiresAt",
                    "options"));
            if (options.path("v").asLong() == 2) {
                optionFields.add("inputRef");
            }
            closed(options, optionFields.toArray(String[]::new));
            require(
                    safeNumber(options.path("v"))
                            && (options.path("v").asLong() == 1
                                    || options.path("v").asLong() == 2)
                            && id.equals(options.path("requestId").asText())
                            && safeNumber(options.path("inputRevision"))
                            && options.path("inputRevision").asLong()
                                    == payload.path("inputRevision").asLong()
                            && options.path("inputRevision").asLong() >= 1
                            && options.path("policyRevision")
                                    .asText()
                                    .equals("hosted-tool-approval/1")
                            && text(options.path("turnId"))
                            && text(options.path("functionCallId"))
                            && text(options.path("toolName"))
                            && safeNumber(options.path("createdAt"))
                            && safeNumber(options.path("expiresAt"))
                            && options.path("expiresAt").asLong()
                                    > options.path("createdAt").asLong()
                            && options.path("options").isArray()
                            && options.path("options").size() == 2
                            && "allow".equals(options.path("options").get(0).path("id").asText())
                            && "deny".equals(options.path("options").get(1).path("id").asText()));
            for (JsonNode option : options.path("options")) {
                closed(option, "id", "label");
                require(text(option.path("label")));
            }
            if (options.path("v").asLong() == 2) {
                resource(options.path("inputRef"), "managed-tool-input", resources);
            }
            Action previous = find(tenantId, sessionId, id).orElse(null);
            require(
                    previous == null
                            ? "requested".equals(state)
                            : previous.options().equals(options)
                                    && "requested".equals(previous.state())
                                    && !"requested".equals(state));
            JsonNode decision = payload.path("decisionRef");
            String receipt = null;
            String digest = null;
            if ("decided".equals(state)) {
                StoredResource decided = resource(decision, "managed-action-decision", resources);
                JsonNode body = read(new String(decided.bytes(), StandardCharsets.UTF_8));
                closed(body, "v", "optionId", "inputRevision", "policyRevision");
                require(
                        safeNumber(body.path("v"))
                                && body.path("v").asLong() == 1
                                && List.of("allow", "deny").contains(body.path("optionId").asText())
                                && body.path("inputRevision").equals(options.path("inputRevision"))
                                && body.path("policyRevision")
                                        .equals(options.path("policyRevision"))
                                && decided.digest().equals(decisionDigest(body)));
                receipt =
                        "decision_"
                                + ManagedExtensionProjection.recordKey(
                                        sessionId, "action_decision", id + ":" + decided.digest());
                digest = decided.digest();
            } else {
                require(decision.isNull());
            }
            if (previous == null) {
                jdbc.update(
                        "INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state,"
                                + " options_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        tenantId,
                        sessionId,
                        id,
                        state,
                        options.toString(),
                        options.path("createdAt").asLong());
            } else {
                jdbc.update(
                        "UPDATE managed_agent_action SET state = ?, decision_receipt_id = ?,"
                                + " decision_digest = ? WHERE tenant_id = ? AND session_id = ? AND"
                                + " action_id = ?",
                        state,
                        receipt,
                        digest,
                        tenantId,
                        sessionId,
                        id);
            }
            if (jdbc.queryForObject(
                            "SELECT COUNT(*) FROM managed_agent_session WHERE tenant_id = ? AND"
                                    + " session_id = ?",
                            Integer.class,
                            tenantId,
                            sessionId)
                    == 1) {
                sessions.appendPublicEventIfAbsent(
                        tenantId,
                        sessionId,
                        null,
                        "action.updated",
                        Map.of("actionId", id, "state", state),
                        false,
                        "action:" + id + ":" + event.path("sequence").asLong());
            }
        }
    }

    public Optional<Action> find(String tenantId, String sessionId, String id) {
        if (!id.matches("tool_approval_[0-9a-f]{32}")) {
            return Optional.empty();
        }
        return jdbc
                .query(
                        "SELECT * FROM managed_agent_action WHERE tenant_id = ? AND session_id = ?"
                                + " AND action_id = ?",
                        (r, row) ->
                                new Action(
                                        r.getString("action_id"),
                                        r.getString("state"),
                                        read(r.getString("options_json")),
                                        r.getString("decision_receipt_id"),
                                        r.getString("decision_digest")),
                        tenantId,
                        sessionId,
                        id)
                .stream()
                .findFirst();
    }

    public List<Action> list(
            String tenantId, String sessionId, Long before, String beforeId, int limit) {
        List<Object> args = new ArrayList<>(List.of(tenantId, sessionId));
        String cursor = "";
        if (before != null) {
            cursor = " AND (created_at < ? OR created_at = ? AND action_id < ?)";
            args.add(before);
            args.add(before);
            args.add(beforeId);
        }
        args.add(limit);
        return jdbc.query(
                "SELECT * FROM managed_agent_action WHERE tenant_id = ? AND session_id = ? AND"
                        + " state = 'requested'"
                        + cursor
                        + " ORDER BY created_at DESC, action_id DESC LIMIT ?",
                (r, row) ->
                        new Action(
                                r.getString("action_id"),
                                r.getString("state"),
                                read(r.getString("options_json")),
                                r.getString("decision_receipt_id"),
                                r.getString("decision_digest")),
                args.toArray());
    }

    @Transactional
    public OperationAdmission admit(
            String tenantId,
            String sessionId,
            String actorId,
            String actorDigest,
            String key,
            String requestDigest,
            String actionId,
            JsonNode body,
            long now) {
        // Serialize admission with journal projection and other Session commands.
        jdbc.queryForObject(
                "SELECT session_id FROM managed_agent_session WHERE tenant_id = ? AND session_id ="
                        + " ? FOR UPDATE",
                String.class,
                tenantId,
                sessionId);
        requireOwner(tenantId, sessionId, actorId);
        List<String> replay =
                jdbc.query(
                        "SELECT operation_id FROM managed_agent_operation WHERE tenant_id = ? AND"
                                + " session_id = ? AND operation_kind = 'ACTION_RESPONSE' AND"
                                + " actor_digest = ? AND idempotency_key = ?",
                        (r, row) -> r.getString(1),
                        tenantId,
                        sessionId,
                        actorDigest,
                        key);
        if (!replay.isEmpty()) {
            OperationRecord existing =
                    sessions.findOperation(tenantId, sessionId, replay.get(0)).orElseThrow();
            if (!existing.requestDigest().equals(requestDigest)) {
                throw new ApiException(
                        HttpStatus.CONFLICT,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new OperationAdmission(existing, true);
        }
        String sessionStatus = jdbc.queryForObject("SELECT status FROM managed_agent_session"
                + " WHERE tenant_id = ? AND session_id = ?", String.class, tenantId, sessionId);
        if (!"ACTIVE".equals(sessionStatus)) {
            throw new ApiException(HttpStatus.CONFLICT, "session_inactive", "The Session does not accept responses.");
        }
        Action action =
                find(tenantId, sessionId, actionId)
                        .orElseThrow(
                                () ->
                                        new ApiException(
                                                HttpStatus.NOT_FOUND,
                                                "action_not_found",
                                                "The Action was not found."));
        JsonNode o = action.options();
        if (body.size() != 3
                || !body.path("optionId").isTextual()
                || !List.of("allow", "deny").contains(body.path("optionId").asText())
                || !body.path("inputRevision").isIntegralNumber()
                || body.path("inputRevision").asLong() != o.path("inputRevision").asLong()
                || !body.path("policyRevision").equals(o.path("policyRevision"))) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_action_response",
                    "The response does not match the original Action.");
        }
        if (!"requested".equals(action.state())) {
            throw new ApiException(
                    HttpStatus.CONFLICT,
                    endedCode(action.state()),
                    "The Action has already ended.");
        }
        if (now >= o.path("expiresAt").asLong()) {
            throw new ApiException(
                    HttpStatus.CONFLICT, "action_expired", "The Action has expired.");
        }
        String op = "op_" + UUID.randomUUID().toString().replace("-", "");
        jdbc.update(
                "INSERT INTO managed_agent_operation (tenant_id, session_id, operation_id,"
                    + " operation_kind, actor_digest, idempotency_key, request_digest, state,"
                    + " admission_stage, delivery_state, session_status_before, available_at,"
                    + " created_at, updated_at, action_id, response_json) VALUES (?, ?, ?,"
                    + " 'ACTION_RESPONSE', ?, ?, ?, 'PENDING', 'JAVA_DURABLE', 'PENDING', 'ACTIVE',"
                    + " ?, ?, ?, ?, ?)",
                tenantId,
                sessionId,
                op,
                actorDigest,
                key,
                requestDigest,
                now,
                now,
                now,
                actionId,
                body.toString());
        return new OperationAdmission(
                sessions.findOperation(tenantId, sessionId, op).orElseThrow(), false);
    }

    public Optional<String> publicTurnId(String tenantId, String sessionId, String promptId) {
        return jdbc
                .query(
                        "SELECT turn_id FROM managed_agent_turn WHERE tenant_id = ? AND session_id"
                                + " = ? AND prompt_id = ?",
                        (r, row) -> r.getString(1),
                        tenantId,
                        sessionId,
                        promptId)
                .stream()
                .findFirst();
    }

    public Response response(String tenantId, String sessionId, String op) {
        return jdbc.queryForObject(
                "SELECT action_id, response_json, error_code, decision_receipt_id FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ?",
                (r, row) ->
                        new Response(
                                r.getString(1),
                                read(r.getString(2)),
                                r.getString(3),
                                r.getString(4)),
                tenantId,
                sessionId,
                op);
    }

    public List<OperationTarget> deliverable(long now) {
        return jdbc.query(
                "SELECT tenant_id, session_id, operation_id FROM managed_agent_operation WHERE"
                        + " operation_kind = 'ACTION_RESPONSE' AND ((delivery_state = 'PENDING' AND"
                        + " available_at <= ?) OR (delivery_state = 'LEASED' AND lease_until < ?))"
                        + " ORDER BY available_at LIMIT 50",
                (r, row) -> new OperationTarget(r.getString(1), r.getString(2), r.getString(3)),
                now,
                now);
    }

    @Transactional
    public void complete(
            OperationRecord op,
            String owner,
            String errorCode,
            String decisionReceiptId,
            long now) {
        jdbc.update(
                "UPDATE managed_agent_operation SET state = ?, admission_stage ="
                    + " 'HARNESS_CONFIRMED', delivery_state = 'CONFIRMED', receipt_id = ?,"
                    + " error_code = ?, decision_receipt_id = ?, lease_owner = NULL, lease_until ="
                    + " NULL, updated_at = ?, completed_at = ? WHERE tenant_id = ? AND session_id ="
                    + " ? AND operation_id = ? AND delivery_state = 'LEASED' AND lease_owner = ?"
                    + " AND claim_generation = ?",
                errorCode == null ? "COMPLETED" : "FAILED",
                "rcpt_" + UUID.randomUUID().toString().replace("-", ""),
                errorCode,
                decisionReceiptId,
                now,
                now,
                op.tenantId(),
                op.sessionId(),
                op.operationId(),
                owner,
                op.claimGeneration());
    }

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
            return HexFormat.of()
                    .formatHex(
                            MessageDigest.getInstance("SHA-256")
                                    .digest(new ObjectMapper().writeValueAsBytes(decision)));
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static StoredResource resource(
            JsonNode ref, String kind, Function<String, StoredResource> resources) {
        closed(ref, "resourceId", "kind", "schemaVersion", "byteLength", "digest");
        require(
                text(ref.path("resourceId"))
                        && kind.equals(ref.path("kind").asText())
                        && safeNumber(ref.path("schemaVersion"))
                        && ref.path("schemaVersion").asLong() == 1
                        && safeNumber(ref.path("byteLength"))
                        && ref.path("digest").asText().matches("[0-9a-f]{64}"));
        StoredResource resource = resources.apply(ref.path("resourceId").asText());
        require(
                resource != null
                        && kind.equals(resource.kind())
                        && resource.schemaVersion() == 1
                        && resource.byteLength() == ref.path("byteLength").asLong()
                        && resource.digest().equals(ref.path("digest").asText()));
        return resource;
    }

    private static void closed(JsonNode value, String... fields) {
        require(value.isObject());
        Set<String> actual = new HashSet<>();
        value.fieldNames().forEachRemaining(actual::add);
        require(actual.equals(Set.of(fields)));
    }

    private static boolean safeNumber(JsonNode value) {
        return value.isIntegralNumber()
                && value.canConvertToLong()
                && value.asLong() >= 0
                && value.asLong() <= 9007199254740991L;
    }

    private static boolean text(JsonNode value) {
        return value.isTextual() && !value.asText().isBlank();
    }

    private JsonNode read(String value) {
        JsonNode result = ManagedExtensionRecordStore.parse(value);
        require(result != null);
        return result;
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "managed_session_action_rejected",
                    "The Action journal record is invalid.");
        }
    }
}
