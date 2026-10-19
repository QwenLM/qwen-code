package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationStore;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent", name = {"session-store.enabled", "runtime-broker.enabled"}, havingValue = "true")
@RequestMapping("/internal/managed-session-store/v1/sessions/{sessionId}")
public class WorkspaceCsiApplicationController {
    private final WorkspaceCsiApplicationStore store;

    public WorkspaceCsiApplicationController(WorkspaceCsiApplicationStore store) {
        this.store = store;
    }

    @GetMapping("/csi-retirement")
    public WorkspaceCsiApplicationStore.Status status(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String token,
            @RequestParam String workspaceId, @RequestParam String retirementId) {
        return store.status(tenant.tenantId(), sessionId, workspaceId, retirementId, token);
    }

    @PostMapping(value = "/csi-retirement:{action:freeze|cut|finalize}", consumes = "application/json")
    public WorkspaceCsiApplicationStore.Status command(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String action, @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String token,
            @RequestBody byte[] bytes) {
        return store.command(tenant.tenantId(), sessionId, token, action, bytes);
    }

    @PostMapping(value = "/csi-retirement:worker-authority", consumes = "application/json")
    public Map<String, Object> workerAuthority(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization, @RequestBody byte[] bytes) {
        if (authorization.length() > 519 || !authorization.matches("Bearer [A-Za-z0-9._~+/-]{1,512}=*")) {
            throw new ManagedAgentException(org.springframework.http.HttpStatus.UNAUTHORIZED, "csi_application_authority_unauthorized", "Original Runtime authentication failed.");
        }
        return store.workerAuthority(tenant.tenantId(), sessionId, authorization.substring(7), bytes);
    }
}
