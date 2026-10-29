package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore.Descriptor;
import com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
public class SessionWorktreeController {
    private final SessionWorktreeService service;

    public SessionWorktreeController(SessionWorktreeService service) {
        this.service = service;
    }

    public record OptionsRequest(@NotBlank String workspaceId, @NotBlank String cwdRelative, String baseRef) { }
    public record QueryRequest(@NotBlank String workspaceId) { }
    public record InspectRequest(@NotBlank String workspaceId, @NotBlank String worktreeId) { }
    public record CleanupRequest(@NotBlank String workspaceId, @NotBlank String worktreeId, @NotBlank String idempotencyKey) { }
    public record Page(List<Descriptor> data) { }

    @PostMapping("/api/agent/web-shell/v1/workspaces/worktrees/options")
    public ResponseEntity<SessionWorktreeService.Options> options(TenantContext tenant, @Valid @RequestBody OptionsRequest request) {
        return noStore(service.options(tenant.tenantId(), tenant.requireActorId(),
                new WorkspaceSelection(request.workspaceId(), request.cwdRelative()), request.baseRef()));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/worktrees/query")
    public ResponseEntity<Page> query(TenantContext tenant, @Valid @RequestBody QueryRequest request) {
        return noStore(new Page(service.list(tenant.tenantId(), tenant.requireActorId(), request.workspaceId())));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/worktrees/inspect")
    public ResponseEntity<SessionWorktreeService.Inspection> inspect(TenantContext tenant, @Valid @RequestBody InspectRequest request) {
        return noStore(service.inspect(tenant.tenantId(), tenant.requireActorId(), request.workspaceId(), request.worktreeId()));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/worktrees/cleanup")
    public ResponseEntity<Descriptor> cleanup(TenantContext tenant, @Valid @RequestBody CleanupRequest request) {
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).body(service.cleanup(tenant.tenantId(),
                tenant.requireActorId(), request.workspaceId(), request.worktreeId(), request.idempotencyKey()));
    }

    @GetMapping("/v1/agents/workspaces/{workspaceId}/worktrees/options")
    public ResponseEntity<Map<String, Object>> publicOptions(TenantContext tenant, @PathVariable String workspaceId,
            @RequestParam(name = "cwd_relative", defaultValue = ".") String cwd,
            @RequestParam(name = "base_ref", required = false) String ref) {
        var options = service.options(tenant.tenantId(), tenant.requireActorId(), new WorkspaceSelection(workspaceId, cwd), ref);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("supported", options.supported());
        result.put("reason", options.reason());
        result.put("base_commit", options.baseCommit());
        result.put("branches", options.branches());
        result.put("current_branch", options.currentBranch());
        return noStore(result);
    }

    @GetMapping("/v1/agents/workspaces/{workspaceId}/worktrees")
    public ResponseEntity<Map<String, Object>> publicQuery(TenantContext tenant, @PathVariable String workspaceId) {
        return noStore(Map.of("data", service.list(tenant.tenantId(), tenant.requireActorId(), workspaceId).stream()
                .map(SessionWorktreeController::publicDescriptor).toList()));
    }

    @GetMapping("/v1/agents/workspaces/{workspaceId}/worktrees/{worktreeId}")
    public ResponseEntity<Map<String, Object>> publicInspect(TenantContext tenant, @PathVariable String workspaceId,
            @PathVariable String worktreeId) {
        var inspection = service.inspect(tenant.tenantId(), tenant.requireActorId(), workspaceId, worktreeId);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("worktree", publicDescriptor(inspection.worktree()));
        result.put("can_cleanup", inspection.canCleanup());
        result.put("cleanup_blocker", inspection.cleanupBlocker());
        return noStore(result);
    }

    @PostMapping("/v1/agents/workspaces/{workspaceId}/worktrees/{worktreeId}/cleanup")
    public ResponseEntity<Map<String, Object>> publicCleanup(TenantContext tenant, @PathVariable String workspaceId,
            @PathVariable String worktreeId, @RequestHeader("Idempotency-Key") String key) {
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).body(publicDescriptor(service.cleanup(
                tenant.tenantId(), tenant.requireActorId(), workspaceId, worktreeId, key)));
    }

    private static Map<String, Object> publicDescriptor(Descriptor descriptor) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", descriptor.id());
        result.put("session_id", descriptor.sessionId());
        result.put("workspace_id", descriptor.workspaceId());
        result.put("state", descriptor.state());
        result.put("branch", descriptor.branch());
        result.put("base_commit", descriptor.baseCommit());
        result.put("cwd_relative", descriptor.cwdRelative());
        result.put("operation_id", descriptor.operationId());
        result.put("revision", descriptor.revision());
        result.put("error_code", descriptor.errorCode());
        return result;
    }

    private static <T> ResponseEntity<T> noStore(T value) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value);
    }
}
