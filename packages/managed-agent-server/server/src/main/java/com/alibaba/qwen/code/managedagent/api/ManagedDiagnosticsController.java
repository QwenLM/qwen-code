package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.catalog.ManagedSessionResourcesService;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellDiagnosticTraceRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentTraceService;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedDiagnosticsController {
    private final ManagedSessionResourcesService resources;
    private final ManagedAgentTraceService traces;

    public ManagedDiagnosticsController(ManagedSessionResourcesService resources, ManagedAgentTraceService traces) {
        this.resources = resources;
        this.traces = traces;
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/resources")
    public ResponseEntity<JsonNode> resources(TenantContext tenant, @PathVariable String sessionId) {
        return noStore(resources.get(tenant.tenantId(), tenant.requireActorId(), sessionId));
    }

    @PostMapping("/api/agent/web-shell/v1/session-resources/query")
    public ResponseEntity<JsonNode> queryResources(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        tenant.requireActorId();
        return resources(tenant, request.sessionId());
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/agent-trace")
    public ResponseEntity<JsonNode> traces(TenantContext tenant, @PathVariable String sessionId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return noStore(traces.list(tenant.tenantId(), tenant.requireActorId(), sessionId, cursor, limit));
    }

    @PostMapping("/api/agent/web-shell/v1/session-agent-trace/query")
    public ResponseEntity<JsonNode> queryTraces(TenantContext tenant,
            @Valid @RequestBody WebShellDiagnosticTraceRequest request) {
        tenant.requireActorId();
        return traces(tenant, request.sessionId(), request.cursor(), request.limit() == null ? 20 : request.limit());
    }

    private static ResponseEntity<JsonNode> noStore(JsonNode body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate()).body(body);
    }
}
