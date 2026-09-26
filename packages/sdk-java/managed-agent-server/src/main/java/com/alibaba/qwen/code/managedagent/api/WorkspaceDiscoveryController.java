package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.service.WorkspaceDiscoveryService;
import com.alibaba.qwen.code.managedagent.service.WorkspaceDiscoveryService.WorkspacePage;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry.WorkspaceSummary;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Locale;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WorkspaceDiscoveryController {
    private final WorkspaceDiscoveryService service;

    public WorkspaceDiscoveryController(WorkspaceDiscoveryService service) {
        this.service = service;
    }

    @GetMapping("/v1/agents/workspaces")
    public ResponseEntity<PublicPage> publicList(TenantContext tenant,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false) Integer limit) {
        WorkspacePage page = service.list(tenant.tenantId(),
                tenant.requireActorId(), cursor, limit);
        return noStore(new PublicPage("list", page.data().stream()
                .map(WorkspaceDiscoveryController::publicItem).toList(),
                page.defaultWorkspace() == null ? null
                        : publicItem(page.defaultWorkspace()),
                page.hasMore(), page.nextCursor(),
                new PublicCapabilities(true, false)));
    }

    @GetMapping("/v1/agents/workspaces/{workspaceId}")
    public ResponseEntity<PublicItem> publicGet(TenantContext tenant,
            @PathVariable String workspaceId) {
        return noStore(publicItem(service.get(tenant.tenantId(),
                tenant.requireActorId(), workspaceId)));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/query")
    public ResponseEntity<WebShellPage> webShellList(TenantContext tenant,
            @RequestBody QueryRequest request) {
        WorkspacePage page = service.list(tenant.tenantId(),
                tenant.requireActorId(), request.cursor(), request.limit());
        return noStore(new WebShellPage(page.data(),
                page.defaultWorkspace(), page.hasMore(),
                page.nextCursor(), new WebShellCapabilities(true, false)));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/get")
    public ResponseEntity<WorkspaceSummary> webShellGet(TenantContext tenant,
            @Valid @RequestBody GetRequest request) {
        return noStore(service.get(tenant.tenantId(),
                tenant.requireActorId(), request.workspaceId()));
    }

    private static PublicItem publicItem(WorkspaceSummary item) {
        return new PublicItem(item.workspaceId(), item.displayName(),
                item.state().toLowerCase(Locale.ROOT),
                item.canCreateSession());
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(body);
    }

    public record QueryRequest(String cursor, Integer limit) {
    }

    public record GetRequest(@NotBlank String workspaceId) {
    }

    public record WebShellCapabilities(boolean workspaceBinding,
            boolean workspaceContext) {
    }

    public record WebShellPage(List<WorkspaceSummary> data,
            WorkspaceSummary defaultWorkspace, boolean hasMore,
            String nextCursor, WebShellCapabilities capabilities) {
    }

    public record PublicCapabilities(
            @JsonProperty("workspace_binding") boolean workspaceBinding,
            @JsonProperty("workspace_context") boolean workspaceContext) {
    }

    public record PublicItem(@JsonProperty("workspace_id") String workspaceId,
            @JsonProperty("display_name") String displayName,
            String state,
            @JsonProperty("can_create_session") boolean canCreateSession) {
    }

    public record PublicPage(String object, List<PublicItem> data,
            @JsonProperty("default_workspace") PublicItem defaultWorkspace,
            @JsonProperty("has_more") boolean hasMore,
            @JsonProperty("next_cursor") String nextCursor,
            PublicCapabilities capabilities) {
    }
}
