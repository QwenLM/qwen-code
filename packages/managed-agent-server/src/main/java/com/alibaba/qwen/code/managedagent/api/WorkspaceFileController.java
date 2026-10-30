package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceFileStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceFileUploadStore;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WorkspaceFileController {
    private final WorkspaceFileStore files;
    private final WorkspaceFileUploadStore uploads;

    public WorkspaceFileController(WorkspaceFileStore files, WorkspaceFileUploadStore uploads) {
        this.files = files;
        this.uploads = uploads;
    }

    public record QueryRequest(String sessionId, String workspaceId, String cwdRelative,
            @NotBlank @Size(max = 1024) String directory, @Size(max = 256) String query,
            @Size(max = 64) String expectedScopeRevision) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Workspace file query field");
        }
    }

    public record ReadRequest(String sessionId, String workspaceId, String cwdRelative,
            @NotBlank @Size(max = 1024) String path, @NotBlank @Size(max = 64) String expectedScopeRevision) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Workspace file read field");
        }
    }

    public record UploadQueryRequest(@NotBlank @Size(max = 36) String uploadId) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown Workspace upload query field");
        }
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/files/query")
    public ResponseEntity<WorkspaceFileStore.QueryResult> query(TenantContext tenant,
            @Valid @RequestBody QueryRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(files.query(tenant.tenantId(),
                tenant.requireActorId(), new WorkspaceFileStore.Locator(request.sessionId(), request.workspaceId(), request.cwdRelative()), request.directory(),
                request.query() == null ? "" : request.query(), request.expectedScopeRevision()));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/files/read")
    public ResponseEntity<WorkspaceFileStore.FileResult> read(TenantContext tenant,
            @Valid @RequestBody ReadRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(files.read(tenant.tenantId(),
                tenant.requireActorId(), new WorkspaceFileStore.Locator(request.sessionId(), request.workspaceId(), request.cwdRelative()),
                request.path(), request.expectedScopeRevision()));
    }

    @PostMapping(value = "/api/agent/web-shell/v1/workspaces/files/upload", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<WorkspaceFileUploadStore.UploadResult> upload(TenantContext tenant,
            @RequestParam(required = false) String sessionId, @RequestParam(required = false) String workspaceId,
            @RequestParam(required = false) String cwdRelative, @RequestParam String path,
            @RequestParam String expectedScopeRevision, @RequestParam String uploadId, HttpServletRequest request) throws java.io.IOException {
        String actor = tenant.requireActorId();
        String encoding = request.getHeader("Content-Encoding");
        if (encoding != null && !"identity".equalsIgnoreCase(encoding)) {
            throw new ManagedAgentException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_request", "Encoded Workspace uploads are unsupported.");
        }
        var locator = new WorkspaceFileStore.Locator(sessionId, workspaceId, cwdRelative);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(uploads.upload(tenant.tenantId(), actor,
                locator, path, expectedScopeRevision, uploadId, request.getInputStream(), request.getContentLengthLong()));
    }

    @PostMapping("/api/agent/web-shell/v1/workspaces/files/uploads/query")
    public ResponseEntity<WorkspaceFileUploadStore.UploadStatus> queryUpload(TenantContext tenant,
            @Valid @RequestBody UploadQueryRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(uploads.query(tenant.tenantId(),
                tenant.requireActorId(), request.uploadId()));
    }
}
