package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionManagementService;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedExtensionManagementController {
    private static final String BASE = "/v1/agents/sessions/{sessionId}/extensions";
    private static final String WEB = "/api/agent/web-shell/v1/session-extensions";
    private final ManagedExtensionManagementService service;

    public ManagedExtensionManagementController(ManagedExtensionManagementService service) { this.service = service; }

    @GetMapping(BASE)
    public ResponseEntity<JsonNode> query(TenantContext tenant, @PathVariable String sessionId) {
        return noStore(service.query(tenant.tenantId(), tenant.requireActorId(), sessionId, null));
    }

    @PostMapping(BASE)
    public ResponseEntity<JsonNode> submit(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String key, @RequestBody JsonNode command) {
        return noStore(service.submit(tenant.tenantId(), tenant.requireActorId(), sessionId, key, command));
    }

    @GetMapping(BASE + "/operations/{operationId}")
    public ResponseEntity<JsonNode> operation(TenantContext tenant, @PathVariable String sessionId, @PathVariable String operationId) {
        return noStore(service.query(tenant.tenantId(), tenant.requireActorId(), sessionId, operationId));
    }

    @PostMapping(BASE + "/operations/{operationId}/continue")
    public ResponseEntity<JsonNode> resume(TenantContext tenant, @PathVariable String sessionId, @PathVariable String operationId) {
        return noStore(service.resume(tenant.tenantId(), tenant.requireActorId(), sessionId, operationId, false));
    }

    @PostMapping(BASE + "/operations/{operationId}/recover-previous")
    public ResponseEntity<JsonNode> recover(TenantContext tenant, @PathVariable String sessionId, @PathVariable String operationId) {
        return noStore(service.resume(tenant.tenantId(), tenant.requireActorId(), sessionId, operationId, true));
    }

    public record WebQuery(@NotBlank String sessionId, String operationId) { }
    public record WebSubmit(@NotBlank String sessionId, @NotBlank String idempotencyKey, @NotNull JsonNode command) { }

    @PostMapping(WEB + "/query")
    public ResponseEntity<JsonNode> webQuery(TenantContext tenant, @Valid @RequestBody WebQuery request) {
        return noStore(service.query(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.operationId()));
    }

    @PostMapping(WEB + "/submit")
    public ResponseEntity<JsonNode> webSubmit(TenantContext tenant, @Valid @RequestBody WebSubmit request) {
        return noStore(service.submit(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.idempotencyKey(), request.command()));
    }

    @PostMapping(WEB + "/continue")
    public ResponseEntity<JsonNode> webResume(TenantContext tenant, @Valid @RequestBody WebQuery request) {
        return noStore(service.resume(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.operationId(), false));
    }

    @PostMapping(WEB + "/recover-previous")
    public ResponseEntity<JsonNode> webRecover(TenantContext tenant, @Valid @RequestBody WebQuery request) {
        return noStore(service.resume(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.operationId(), true));
    }

    private static ResponseEntity<JsonNode> noStore(JsonNode value) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value); }
}
