package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.catalog.ManagedMcpCatalogService;
import com.alibaba.qwen.code.managedagent.catalog.ManagedMcpManagementService;
import com.alibaba.qwen.code.managedagent.model.ApiModels.ManagedMcpManagementCommand;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellMcpManagementOperationQuery;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellMcpManagementQuery;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellMcpManagementSubmit;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedMcpController {
    private final ManagedMcpCatalogService service;
    private final ManagedMcpManagementService management;

    public ManagedMcpController(ManagedMcpCatalogService service, ManagedMcpManagementService management) {
        this.service = service;
        this.management = management;
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/mcp-catalog")
    public ResponseEntity<JsonNode> get(TenantContext tenant, @PathVariable String sessionId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.get(tenant.tenantId(), tenant.actorId(), sessionId));
    }

    @PostMapping("/api/agent/web-shell/v1/session-mcp/query")
    public ResponseEntity<JsonNode> query(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.get(tenant.tenantId(), tenant.requireActorId(), request.sessionId()));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/mcp-management")
    public ResponseEntity<JsonNode> management(TenantContext tenant, @PathVariable String sessionId) {
        return noStore(management.get(tenant.tenantId(), tenant.requireActorId(), sessionId));
    }

    @PostMapping("/v1/agents/sessions/{sessionId}/mcp-management/commands")
    public ResponseEntity<JsonNode> submit(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody ManagedMcpManagementCommand command) {
        return noStore(management.submit(tenant.tenantId(), tenant.requireActorId(), sessionId, idempotencyKey, command));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/mcp-management/commands/{operationId}")
    public ResponseEntity<JsonNode> operation(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String operationId) {
        return noStore(management.operation(tenant.tenantId(), tenant.requireActorId(), sessionId, operationId));
    }

    @PostMapping("/api/agent/web-shell/v1/session-mcp/management/query")
    public ResponseEntity<JsonNode> managementQuery(TenantContext tenant,
            @Valid @RequestBody WebShellMcpManagementQuery request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return noStore(management.get(tenant.tenantId(), tenant.requireActorId(), request.sessionId()));
    }

    @PostMapping("/api/agent/web-shell/v1/session-mcp/management/submit")
    public ResponseEntity<JsonNode> managementSubmit(TenantContext tenant,
            @Valid @RequestBody WebShellMcpManagementSubmit request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return noStore(management.submit(tenant.tenantId(), tenant.requireActorId(), request.sessionId(),
                request.idempotencyKey(), new ManagedMcpManagementCommand(request.action(), request.serverId(),
                        request.expectedRevision(), request.server())));
    }

    @PostMapping("/api/agent/web-shell/v1/session-mcp/management/operations/query")
    public ResponseEntity<JsonNode> managementOperationQuery(TenantContext tenant,
            @Valid @RequestBody WebShellMcpManagementOperationQuery request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return noStore(management.operation(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.operationId()));
    }

    private static ResponseEntity<JsonNode> noStore(JsonNode body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
