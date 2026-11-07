package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.extensions.ManagedMcpOAuthService;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class ManagedMcpOAuthController {
    private static final String BASE = "/v1/agents/sessions/{sessionId}/mcp-oauth";
    private static final String WEB = "/api/agent/web-shell/v1/session-mcp-oauth";
    private final ManagedMcpOAuthService service;

    public ManagedMcpOAuthController(ManagedMcpOAuthService service) {
        this.service = service;
    }

    public record Query(String sessionId, List<Pin> extensions) {}

    public record Start(
            String sessionId,
            String serverId,
            Pin pin,
            String browserNonce,
            String idempotencyKey) {
        @Override
        public String toString() {
            return "McpOAuthStart[authorization=redacted]";
        }
    }

    public record Status(String sessionId, String attemptId) {}

    public record Complete(String sessionId, String attemptId, String browserNonce) {
        @Override
        public String toString() {
            return "McpOAuthComplete[authorization=redacted]";
        }
    }

    public record Revoke(String sessionId, String credentialId, long expectedGeneration) {}

    @PostMapping({BASE + "/query", WEB + "/query"})
    public ResponseEntity<JsonNode> query(
            TenantContext tenant,
            @PathVariable(required = false) String sessionId,
            @RequestBody Query request) {
        return response(
                service.query(
                        tenant.tenantId(),
                        tenant.requireActorId(),
                        session(sessionId, request.sessionId()),
                        request.extensions()));
    }

    @PostMapping({BASE + "/start", WEB + "/start"})
    public ResponseEntity<JsonNode> start(
            TenantContext tenant,
            @PathVariable(required = false) String sessionId,
            @RequestBody Start request) {
        return response(
                service.start(
                        tenant.tenantId(),
                        tenant.requireActorId(),
                        session(sessionId, request.sessionId()),
                        request.serverId(),
                        request.pin(),
                        request.browserNonce(),
                        request.idempotencyKey()));
    }

    @PostMapping({BASE + "/status", WEB + "/status"})
    public ResponseEntity<JsonNode> status(
            TenantContext tenant,
            @PathVariable(required = false) String sessionId,
            @RequestBody Status request) {
        return response(
                service.status(
                        tenant.tenantId(),
                        tenant.requireActorId(),
                        session(sessionId, request.sessionId()),
                        request.attemptId()));
    }

    @PostMapping({BASE + "/complete", WEB + "/complete"})
    public ResponseEntity<JsonNode> complete(
            TenantContext tenant,
            @PathVariable(required = false) String sessionId,
            @RequestBody Complete request) {
        return response(
                service.complete(
                        tenant.tenantId(),
                        tenant.requireActorId(),
                        session(sessionId, request.sessionId()),
                        request.attemptId(),
                        request.browserNonce()));
    }

    @PostMapping({BASE + "/revoke", WEB + "/revoke"})
    public ResponseEntity<JsonNode> revoke(
            TenantContext tenant,
            @PathVariable(required = false) String sessionId,
            @RequestBody Revoke request) {
        return response(
                service.revoke(
                        tenant.tenantId(),
                        tenant.requireActorId(),
                        session(sessionId, request.sessionId()),
                        request.credentialId(),
                        request.expectedGeneration()));
    }

    private static String session(String path, String body) {
        String value = path == null ? body : path;
        if (value == null
                || value.isBlank()
                || value.length() > 512
                || path != null && body != null && !path.equals(body)) {
            throw new ManagedAgentException(
                    400, "invalid_mcp_oauth_request", "Invalid personal MCP OAuth request.");
        }
        return value;
    }

    private static ResponseEntity<JsonNode> response(JsonNode value) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value);
    }
}
