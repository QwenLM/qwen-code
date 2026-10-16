package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.service.SshWorkspaceService;
import com.alibaba.qwen.code.managedagent.service.SshWorkspaceService.Directory;
import com.alibaba.qwen.code.managedagent.service.SshWorkspaceService.NodePage;
import com.alibaba.qwen.code.managedagent.store.SshWorkspaceStore.Operation;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/agent/web-shell/v1")
public class SshWorkspaceController {
    private final SshWorkspaceService service;

    public SshWorkspaceController(SshWorkspaceService service) {
        this.service = service;
    }

    @PostMapping("/runtime-nodes/query")
    public ResponseEntity<NodePage> nodes(TenantContext tenant) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.list(tenant.tenantId(), tenant.requireActorId()));
    }

    @PostMapping("/workspaces/check-directory")
    public ResponseEntity<Directory> check(TenantContext tenant, @Valid @RequestBody DirectoryRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.check(
                tenant.tenantId(), tenant.requireActorId(), request.nodeId(), request.path()));
    }

    @PostMapping("/workspaces/register")
    public ResponseEntity<Operation> create(TenantContext tenant, @Valid @RequestBody CreateRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).body(service.create(
                tenant.tenantId(), tenant.requireActorId(), request.nodeId(), request.path(),
                request.displayName(), request.idempotencyKey()));
    }

    @PostMapping("/workspaces/operations/get")
    public ResponseEntity<Operation> operation(TenantContext tenant, @Valid @RequestBody OperationRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.get(
                tenant.tenantId(), tenant.requireActorId(), request.operationId()));
    }

    public record DirectoryRequest(@NotBlank @Size(max = 128) String nodeId,
            @NotBlank @Size(max = 512) String path) {
    }

    public record CreateRequest(@NotBlank @Size(max = 128) String nodeId,
            @NotBlank @Size(max = 512) String path, @NotBlank @Size(max = 512) String displayName,
            @NotBlank @Size(max = 512) String idempotencyKey, @Size(max = 128) String requestId) {
    }

    public record OperationRequest(@NotBlank @Size(max = 128) String operationId) {
    }
}
