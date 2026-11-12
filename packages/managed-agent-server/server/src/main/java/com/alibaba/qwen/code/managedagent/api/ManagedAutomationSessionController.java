package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.automation.ManagedAutomationService;
import com.alibaba.qwen.code.managedagent.automation.ManagedAutomationSessionService;
import com.alibaba.qwen.code.managedagent.contracts.automation.AutomationSessionModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicAutomation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * The internal Session-scoped automation routes (the fixed-interval /loop
 * arm's creation path). Authenticated by the writer binding, acting as the
 * bound Session's creator; the public actor-scoped automation controller is
 * unchanged. There is no user principal on this surface.
 */
@RestController
public class ManagedAutomationSessionController {
    private final ManagedAutomationSessionService service;

    public ManagedAutomationSessionController(ManagedAutomationSessionService service) {
        this.service = service;
    }

    @PostMapping("/internal/managed-session-store/v1/sessions/{sessionId}/automations:create")
    public ManagedAutomationService.Result<PublicAutomation> create(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @RequestBody AutomationSessionModels.Create request) {
        return service.create(tenant.tenantId(), sessionId, writerToken,
                idempotencyKey, request);
    }

    @PostMapping("/internal/managed-session-store/v1/sessions/{sessionId}/automations:list")
    public PublicList<PublicAutomation> list(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestBody AutomationSessionModels.ListRequest request) {
        return service.list(tenant.tenantId(), sessionId, writerToken, request);
    }

    @PostMapping("/internal/managed-session-store/v1/sessions/{sessionId}/automations:retire")
    public ManagedAutomationService.Result<PublicAutomation> retire(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @RequestBody AutomationSessionModels.Retire request) {
        return service.retire(tenant.tenantId(), sessionId, writerToken,
                idempotencyKey, request);
    }
}