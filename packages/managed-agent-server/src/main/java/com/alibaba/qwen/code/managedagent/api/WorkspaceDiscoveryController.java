package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry.WorkspaceSummary;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCreationStore;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceDiscoveryService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceDiscoveryService.WorkspacePage;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Locale;

@RestController
public class WorkspaceDiscoveryController {
    private final WorkspaceDiscoveryService service;
    private final WorkspaceCreationStore creation;

    public WorkspaceDiscoveryController(WorkspaceDiscoveryService service, WorkspaceCreationStore creation) {
        this.service = service;
        this.creation = creation;
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
        return noStore(new WebShellPage(page.data().stream()
                .map(WorkspaceDiscoveryController::webShellItem).toList(),
                page.defaultWorkspace() == null ? null
                        : webShellItem(page.defaultWorkspace()), page.hasMore(),
                page.nextCursor(), new WebShellCapabilities(true, false, creation.enabled(), true,
                        creation.directorySelectionEnabled())));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/get")
    public ResponseEntity<WorkspaceSummary> webShellGet(TenantContext tenant,
            @Valid @RequestBody GetRequest request) {
        return noStore(webShellItem(service.get(tenant.tenantId(),
                tenant.requireActorId(), request.workspaceId())));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/create")
    public ResponseEntity<WorkspaceSummary> webShellCreate(TenantContext tenant,
            @Valid @RequestBody CreateRequest request) {
        return noStore(webShellItem(creation.create(tenant.tenantId(), tenant.requireActorId(),
                request.displayName(), request.idempotencyKey(), request.sourceWorkspaceId(), request.cwdRelative())));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/directories/query")
    public ResponseEntity<WorkspaceCreationStore.DirectoryPage> webShellDirectories(TenantContext tenant,
            @Valid @RequestBody DirectoryRequest request) {
        return noStore(creation.directories(tenant.tenantId(), tenant.requireActorId(),
                request.workspaceId(), request.cwdRelative()));
    }

    public record CreateRequest(@NotBlank String displayName, @NotBlank String idempotencyKey,
            String sourceWorkspaceId, String cwdRelative) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Workspace creation field");
        }
    }

    public record DirectoryRequest(@NotBlank String workspaceId, @NotBlank String cwdRelative) {}

    private static PublicItem publicItem(WorkspaceSummary item) {
        return new PublicItem(item.workspaceId(), "agent.workspace",
                item.displayName(),
                item.state().toLowerCase(Locale.ROOT),
                item.canCreateSession());
    }

    private static WorkspaceSummary webShellItem(WorkspaceSummary item) {
        return new WorkspaceSummary(item.workspaceId(), item.displayName(),
                item.state().toLowerCase(Locale.ROOT),
                item.canCreateSession(), item.defaultCwdRelative(), item.canSelectDirectory());
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
            boolean workspaceContext, boolean workspaceCreation, boolean approvalModeSelection,
            boolean workspaceDirectorySelection) {
        public WebShellCapabilities(boolean workspaceBinding,
                boolean workspaceContext, boolean workspaceCreation, boolean approvalModeSelection) {
            this(workspaceBinding, workspaceContext, workspaceCreation, approvalModeSelection, false);
        }
        public WebShellCapabilities(boolean workspaceBinding,
                boolean workspaceContext, boolean workspaceCreation) {
            this(workspaceBinding, workspaceContext, workspaceCreation, false);
        }
    }

    public record WebShellPage(List<WorkspaceSummary> data,
            WorkspaceSummary defaultWorkspace, boolean hasMore,
            String nextCursor, WebShellCapabilities capabilities) {
    }

    public record PublicCapabilities(
            @JsonProperty("workspace_binding") boolean workspaceBinding,
            @JsonProperty("workspace_context") boolean workspaceContext) {
    }

    public record PublicItem(String id, String object,
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
