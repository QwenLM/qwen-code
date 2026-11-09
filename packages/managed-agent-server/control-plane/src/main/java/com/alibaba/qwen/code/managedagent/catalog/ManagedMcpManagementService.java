package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.model.ApiModels.ManagedMcpManagementCommand;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

@Service
public class ManagedMcpManagementService {
    private static final Set<String> ACTIONS = Set.of("add", "edit", "remove", "enable", "disable", "reload", "restart");
    private final ManagedAgentService sessions;
    private final SessionPolicyStore store;
    private final HarnessConnector harness;
    private final ObjectMapper json;

    public ManagedMcpManagementService(ManagedAgentService sessions, SessionPolicyStore store,
            HarnessConnector harness, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.sessions = sessions;
        this.store = store;
        this.harness = harness;
        this.json = json;
    }

    public JsonNode get(String tenantId, String actorId, String sessionId) {
        // MCP management serves only Workspace Sessions: the raw
        // filter-admitted actor never needs a byte-bounded principal (R7-1).
        return get(tenantId, actorId, null, sessionId);
    }

    public JsonNode get(SessionPrincipal principal, String sessionId) {
        return get(principal.tenantId(), principal.userId(), principal,
                sessionId);
    }

    private JsonNode get(String tenantId, String actorId,
            SessionPrincipal principal, String sessionId) {
        SessionRecord readable = principal == null
                ? sessions.requireReadableSession(tenantId, actorId, sessionId)
                : sessions.requireReadableSession(principal, sessionId);
        if (readable.workspace() == null) {
            return unsupported(sessionId);
        }
        SessionRecord session;
        try {
            session = store.requireMcpManagement(tenantId,
                    actorId, sessionId, null);
        } catch (ManagedAgentException unsupported) {
            if (!"unsupported_feature".equals(unsupported.getCode())) {
                throw unsupported;
            }
            return unsupported(sessionId);
        }
        if (!harness.supportsMcpManagement() || !harness.supportsLifecycle(session.toolProfile())) {
            return unsupported(sessionId);
        }
        return invoke(() -> harness.mcpManagement(tenantId,
                sessionId));
    }

    public JsonNode submit(String tenantId, String actorId, String sessionId, String idempotencyKey,
            ManagedMcpManagementCommand command) {
        return submit(tenantId, actorId, null, sessionId, idempotencyKey,
                command);
    }

    public JsonNode submit(SessionPrincipal principal, String sessionId,
            String idempotencyKey, ManagedMcpManagementCommand command) {
        return submit(principal.tenantId(), principal.userId(), principal,
                sessionId, idempotencyKey, command);
    }

    private JsonNode submit(String tenantId, String actorId,
            SessionPrincipal principal, String sessionId,
            String idempotencyKey, ManagedMcpManagementCommand command) {
        SessionRecord readable = principal == null
                ? sessions.requireReadableSession(tenantId, actorId, sessionId)
                : sessions.requireReadableSession(principal, sessionId);
        if (readable.workspace() == null) {
            throw unsupportedOperation();
        }
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        if (!ACTIONS.contains(command.action()) || !command.serverId().matches("[A-Za-z0-9._:-]{1,128}")
                || command.expectedRevision() == null || command.expectedRevision() < 0
                || command.expectedRevision() >= 9_007_199_254_740_991L
                || Set.of("add", "edit").contains(command.action()) != (command.server() != null)
                || command.server() != null && !command.serverId().equals(command.server().serverId())) {
            throw new ManagedAgentException(400, "invalid_request", "Invalid MCP management command.");
        }
        Map<String, Object> request = new LinkedHashMap<>();
        try {
            // A subjectless principal keeps the pre-ownership operation
            // identity so recorded keys still replay; only an actual subject
            // joins the identity (the commandKey rule).
            java.util.List<String> identity = new java.util.ArrayList<>(java.util.List.of(
                    "managed-mcp-command", tenantId, actorId));
            if (principal != null && principal.actorPresent()) {
                identity.add(principal.actorSubjectId());
            }
            identity.add(sessionId);
            identity.add(idempotencyKey);
            request.put("operationId", UUID.nameUUIDFromBytes(
                    json.writeValueAsBytes(identity)).toString());
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException("Cannot encode MCP command identity", error);
        }
        SessionRecord session = store.requireMcpManagement(tenantId,
                actorId, sessionId, (String) request.get("operationId"));
        if (!harness.supportsMcpManagement() || !harness.supportsLifecycle(session.toolProfile())) {
            throw new ManagedAgentException(409, "unsupported_feature", "MCP management is unavailable.");
        }
        request.put("actorKey", DigestUtils.sha256Hex(actorId));
        request.put("action", command.action());
        request.put("serverId", command.serverId());
        request.put("expectedRevision", command.expectedRevision());
        if (command.server() != null) {
            request.put("server", Map.of("serverId", command.server().serverId(),
                    "serverRevision", command.server().serverRevision(), "definitionDigest", command.server().definitionDigest()));
        }
        return invoke(() -> harness.manageMcp(tenantId, sessionId,
                request));
    }

    public JsonNode operation(String tenantId, String actorId, String sessionId, String operationId) {
        return operation(tenantId, actorId, null, sessionId, operationId);
    }

    public JsonNode operation(SessionPrincipal principal, String sessionId,
            String operationId) {
        return operation(principal.tenantId(), principal.userId(), principal,
                sessionId, operationId);
    }

    private JsonNode operation(String tenantId, String actorId,
            SessionPrincipal principal, String sessionId, String operationId) {
        SessionRecord readable = principal == null
                ? sessions.requireReadableSession(tenantId, actorId, sessionId)
                : sessions.requireReadableSession(principal, sessionId);
        if (readable.workspace() == null) {
            throw unsupportedOperation();
        }
        if (operationId == null || !operationId.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) {
            throw new ManagedAgentException(400, "invalid_request", "Invalid MCP operation identity.");
        }
        SessionRecord session = store.requireMcpManagement(tenantId,
                actorId, sessionId, null);
        if (!harness.supportsMcpManagement() || !harness.supportsLifecycle(session.toolProfile())) {
            throw new ManagedAgentException(409, "unsupported_feature", "MCP management is unavailable.");
        }
        return invoke(() -> harness.mcpManagementOperation(tenantId,
                sessionId, operationId));
    }

    private JsonNode unsupported(String sessionId) {
        var result = json.createObjectNode().put("sessionId", sessionId).put("revision", 0).put("supported", false);
        result.putArray("servers");
        result.putArray("availableServers");
        return result;
    }

    private static ManagedAgentException unsupportedOperation() {
        return new ManagedAgentException(409, "unsupported_feature",
                "MCP management is unavailable.");
    }

    private JsonNode invoke(Supplier<Map<String, Object>> request) {
        try {
            JsonNode result = json.valueToTree(request.get());
            requireSnapshot(result);
            return result;
        } catch (HarnessHttpFailure refusal) {
            org.springframework.http.HttpStatus status = org.springframework.http.HttpStatus.resolve(refusal.getStatusCode());
            String code = refusal.getErrorCode();
            if (status == null || !status.is4xxClientError() || code == null || !code.matches("[a-z][a-z0-9_]{0,127}")) {
                throw new ManagedAgentException(503, "managed_mcp_management_unavailable",
                        "The original MCP operation cannot be confirmed.");
            }
            throw new ManagedAgentException(status.value(), code, "hosted_mcp_session_load_required".equals(code)
                    ? "Continue or recover the Session before managing MCP servers." : "MCP management was refused.");
        } catch (HarnessFailure unavailable) {
            throw new ManagedAgentException(503, "managed_mcp_management_unavailable",
                    "The original MCP operation cannot be confirmed.");
        }
    }

    private static void requireSnapshot(JsonNode body) {
        if (!body.isObject() || body.size() != (body.has("operation") ? 6 : 5)
                || !body.path("sessionId").isTextual() || !body.path("supported").isBoolean()
                || !counter(body.path("revision"), 0) || !body.path("servers").isArray()
                || body.path("servers").size() > 32 || !body.path("availableServers").isArray()) {
            throw new HarnessFailure("Invalid MCP management snapshot");
        }
        for (String field : List.of("servers", "availableServers")) {
            boolean published = "availableServers".equals(field);
            for (JsonNode server : body.get(field)) {
                if (!server.isObject() || server.size() != 4 || !server.path("serverId").isTextual()
                        || !server.path("serverId").asText().matches("[A-Za-z0-9._:-]{1,128}")
                        || !counter(server.path("serverRevision"), 1) || !server.path("definitionDigest").isTextual()
                        || !server.path("definitionDigest").asText().matches("[a-f0-9]{64}")
                        || !(published ? Set.of("stdio", "streamable-http", "sse").contains(server.path("transport").asText())
                                : Set.of("enabled", "disabled", "removed").contains(server.path("state").asText()))) {
                    throw new HarnessFailure("Invalid MCP management server");
                }
            }
        }
        if (body.has("operation")) {
            JsonNode operation = body.get("operation");
            if (!operation.isObject() || operation.size() != (operation.has("error") ? 6 : 5)
                    || !operation.path("operationId").asText().matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                    || !ACTIONS.contains(operation.path("action").asText())
                    || !operation.path("serverId").isTextual() || !operation.path("serverId").asText().matches("[A-Za-z0-9._:-]{1,128}")
                    || !counter(operation.path("revision"), 1)
                    || !Set.of("pending", "settled", "failed", "recovery_required").contains(operation.path("state").asText())
                    || operation.has("error") && (!operation.path("error").isObject() || operation.path("error").size() != 1
                            || !operation.path("error").path("code").isTextual()
                            || !operation.path("error").path("code").asText().matches("[a-z][a-z0-9_]{0,127}"))) {
                throw new HarnessFailure("Invalid MCP management operation");
            }
        }
    }

    private static boolean counter(JsonNode value, long minimum) {
        return value.isIntegralNumber() && value.canConvertToLong()
                && value.longValue() >= minimum && value.longValue() <= 9_007_199_254_740_991L;
    }
}
