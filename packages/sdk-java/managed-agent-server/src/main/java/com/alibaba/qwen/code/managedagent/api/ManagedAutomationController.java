package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.AutomationDefinitionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicAutomation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicAutomationRun;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.service.ManagedAutomationService;
import com.alibaba.qwen.code.managedagent.service.ManagedAutomationService.Result;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * H6b: the public automation resources. Definitions are created, revised,
 * read and retired under their target Session; a manual run fires one
 * occurrence; definitions and occurrences page separately. Every mutation
 * takes an Idempotency-Key and answers 202 with the committed resource.
 */
@RestController
@RequestMapping("/v1/agent-automations")
public class ManagedAutomationController {
    private final ManagedAutomationService service;

    public ManagedAutomationController(ManagedAutomationService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<PublicAutomation> create(TenantContext tenant,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @RequestBody AutomationDefinitionRequest request) {
        return accepted(service.create(tenant.tenantId(), tenant.actorId(),
                idempotencyKey, request));
    }

    @GetMapping
    public ResponseEntity<PublicList<PublicAutomation>> list(
            TenantContext tenant,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.list(tenant.tenantId(), tenant.actorId(),
                        cursor, limit));
    }

    @GetMapping("/{automationId}")
    public ResponseEntity<PublicAutomation> get(TenantContext tenant,
            @PathVariable String automationId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.get(tenant.tenantId(), tenant.actorId(),
                        automationId));
    }

    @PostMapping("/{automationId}")
    public ResponseEntity<PublicAutomation> update(TenantContext tenant,
            @PathVariable String automationId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @RequestBody AutomationDefinitionRequest request) {
        return accepted(service.update(tenant.tenantId(), tenant.actorId(),
                automationId, idempotencyKey, request));
    }

    @DeleteMapping("/{automationId}")
    public ResponseEntity<PublicAutomation> retire(TenantContext tenant,
            @PathVariable String automationId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        return accepted(service.retire(tenant.tenantId(), tenant.actorId(),
                automationId, idempotencyKey));
    }

    @PostMapping("/{automationId}/runs")
    public ResponseEntity<PublicAutomationRun> run(TenantContext tenant,
            @PathVariable String automationId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        return accepted(service.run(tenant.tenantId(), tenant.actorId(),
                automationId, idempotencyKey));
    }

    @GetMapping("/{automationId}/runs")
    public ResponseEntity<PublicList<PublicAutomationRun>> runs(
            TenantContext tenant, @PathVariable String automationId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.listRuns(tenant.tenantId(), tenant.actorId(),
                        automationId, cursor, limit));
    }

    private static <T> ResponseEntity<T> accepted(Result<T> result) {
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .header("X-Qwen-Idempotent-Replay",
                        Boolean.toString(result.replayed()))
                .cacheControl(CacheControl.noStore())
                .body(result.body());
    }
}
