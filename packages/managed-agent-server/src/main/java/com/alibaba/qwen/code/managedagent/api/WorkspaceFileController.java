package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceFileStore;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WorkspaceFileController {
    private final WorkspaceFileStore files;

    public WorkspaceFileController(WorkspaceFileStore files) {
        this.files = files;
    }

    public record QueryRequest(@NotBlank String workspaceId, @NotBlank String cwdRelative,
            @NotBlank @Size(max = 1024) String directory, @Size(max = 256) String query,
            @Size(max = 64) String expectedScopeRevision) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Workspace file query field");
        }
    }

    public record ReadRequest(@NotBlank String workspaceId, @NotBlank String cwdRelative,
            @NotBlank @Size(max = 1024) String path, @NotBlank @Size(max = 64) String expectedScopeRevision) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Workspace file read field");
        }
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/files/query")
    public ResponseEntity<WorkspaceFileStore.QueryResult> query(TenantContext tenant,
            @Valid @RequestBody QueryRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(files.query(tenant.tenantId(),
                tenant.requireActorId(), request.workspaceId(), request.cwdRelative(), request.directory(),
                request.query() == null ? "" : request.query(), request.expectedScopeRevision()));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/files/read")
    public ResponseEntity<WorkspaceFileStore.FileResult> read(TenantContext tenant,
            @Valid @RequestBody ReadRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(files.read(tenant.tenantId(),
                tenant.requireActorId(), request.workspaceId(), request.cwdRelative(), request.path(), request.expectedScopeRevision()));
    }
}
