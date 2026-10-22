package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.catalog.ManagedMcpCatalogService;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedMcpController {
    private final ManagedMcpCatalogService service;

    public ManagedMcpController(ManagedMcpCatalogService service) {
        this.service = service;
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
}
