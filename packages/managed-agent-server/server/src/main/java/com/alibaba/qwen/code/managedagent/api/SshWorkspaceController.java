package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.repository.SshWorkspaceStore.Operation;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService.Directory;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService.NodePage;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class SshWorkspaceController {
    private static final String WEB_SHELL_PREFIX = "/api/agent/web-shell/v1";
    private final SshWorkspaceService service;

    public SshWorkspaceController(SshWorkspaceService service) {
        this.service = service;
    }

    @PostMapping(WEB_SHELL_PREFIX + "/runtime-nodes/query")
    public ResponseEntity<NodePage> nodes(TenantContext tenant) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.list(tenant.tenantId(), tenant.requireActorId()));
    }

    @PostMapping(WEB_SHELL_PREFIX + "/workspaces/check-directory")
    public ResponseEntity<Directory> check(TenantContext tenant, @Valid @RequestBody DirectoryRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.check(
                tenant.tenantId(), tenant.requireActorId(), request.nodeId(), request.path()));
    }

    @PostMapping(WEB_SHELL_PREFIX + "/workspaces/register")
    public ResponseEntity<Operation> create(TenantContext tenant, @Valid @RequestBody CreateRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).body(service.create(
                tenant.tenantId(), tenant.requireActorId(), request.nodeId(), request.path(),
                request.displayName(), request.idempotencyKey()));
    }

    @PostMapping(WEB_SHELL_PREFIX + "/workspaces/operations/get")
    public ResponseEntity<Operation> operation(TenantContext tenant, @Valid @RequestBody OperationRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.get(
                tenant.tenantId(), tenant.requireActorId(), request.operationId()));
    }

    @GetMapping("/v1/agents/runtime-nodes")
    public ResponseEntity<PublicNodePage> publicNodes(TenantContext tenant) {
        NodePage page = service.list(tenant.tenantId(), tenant.requireActorId());
        List<PublicNodeSummary> items = page.data().stream()
                .map(node -> new PublicNodeSummary(node.nodeId(), node.displayName()))
                .toList();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(new PublicNodePage(page.supported(), items));
    }

    @PostMapping("/v1/agents/runtime-nodes/{nodeId}/check-directory")
    public ResponseEntity<PublicDirectory> publicCheck(TenantContext tenant,
            @PathVariable String nodeId,
            @Valid @RequestBody PublicDirectoryRequest request) {
        String actor = tenant.requireActorId();
        if (StringUtils.isBlank(nodeId) || nodeId.length() > 128) {
            throw new ManagedAgentException(400, "invalid_request", "node_id must be 1..128 characters.");
        }
        Directory dir = service.check(tenant.tenantId(), actor, nodeId, request.path());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(new PublicDirectory(dir.nodeId(), dir.canonicalPath(), dir.platform()));
    }

    @PostMapping("/v1/agents/workspaces/registrations")
    public ResponseEntity<PublicOperation> publicCreate(TenantContext tenant,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody PublicCreateRequest request) {
        String actor = tenant.requireActorId();
        if (StringUtils.isBlank(idempotencyKey) || idempotencyKey.length() > 512) {
            throw new ManagedAgentException(400, "invalid_request", "Idempotency-Key must be 1..512 characters.");
        }
        Operation op = service.create(tenant.tenantId(), actor, request.nodeId(), request.path(),
                request.displayName(), idempotencyKey);
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore())
                .body(PublicOperation.from(op));
    }

    @GetMapping("/v1/agents/workspaces/registrations/{operationId}")
    public ResponseEntity<PublicOperation> publicOperation(TenantContext tenant,
            @PathVariable String operationId) {
        String actor = tenant.requireActorId();
        if (StringUtils.isBlank(operationId) || operationId.length() > 128) {
            throw new ManagedAgentException(400, "invalid_request", "operation_id must be 1..128 characters.");
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(PublicOperation.from(service.get(tenant.tenantId(), actor, operationId)));
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

    public record PublicNodeSummary(
            @JsonProperty("node_id") String nodeId,
            @JsonProperty("display_name") String displayName) {
    }

    public record PublicNodePage(boolean supported, List<PublicNodeSummary> data) {
    }

    public record PublicDirectoryRequest(@NotBlank @Size(max = 512) String path) {
    }

    public record PublicDirectory(
            @JsonProperty("node_id") String nodeId,
            @JsonProperty("canonical_path") String canonicalPath,
            String platform) {
    }

    public record PublicCreateRequest(
            @JsonProperty("node_id") @NotBlank @Size(max = 128) String nodeId,
            @NotBlank @Size(max = 512) String path,
            @JsonProperty("display_name") @NotBlank @Size(max = 512) String displayName) {
    }

    public record PublicOperation(
            @JsonProperty("operation_id") String operationId,
            String type,
            String status,
            @JsonProperty("workspace_id") String workspaceId,
            @JsonProperty("failure_code") String failureCode,
            boolean replayed) {
        static PublicOperation from(Operation op) {
            return new PublicOperation(op.operationId(), op.type(), op.status(),
                    op.workspaceId(), op.failureCode(), op.replayed());
        }
    }
}
