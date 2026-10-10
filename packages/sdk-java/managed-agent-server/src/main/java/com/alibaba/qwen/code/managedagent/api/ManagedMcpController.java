package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.service.ManagedMcpCatalogService;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
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
}
