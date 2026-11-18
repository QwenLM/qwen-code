package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceFileStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceFileUploadStore;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

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
            throw new ManagedAgentException(415, "invalid_request", "Encoded Workspace uploads are unsupported.");
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

    @GetMapping("/v1/agents/workspace-files")
    public ResponseEntity<PublicFileQueryResult> publicQuery(TenantContext tenant,
            @RequestParam(name = "session_id", required = false) String sessionId,
            @RequestParam(name = "workspace_id", required = false) String workspaceId,
            @RequestParam(name = "cwd_relative", required = false) String cwdRelative,
            @RequestParam String directory,
            @RequestParam(required = false) String query,
            @RequestParam(name = "expected_scope_revision", required = false) String expectedScopeRevision) {
        String actor = tenant.requireActorId();
        return noStore(PublicFileQueryResult.from(files.query(tenant.tenantId(), actor,
                new WorkspaceFileStore.Locator(sessionId, workspaceId, cwdRelative), directory,
                query == null ? "" : query, expectedScopeRevision)));
    }

    @GetMapping("/v1/agents/workspace-files/content")
    public ResponseEntity<PublicFileResult> publicRead(TenantContext tenant,
            @RequestParam(name = "session_id", required = false) String sessionId,
            @RequestParam(name = "workspace_id", required = false) String workspaceId,
            @RequestParam(name = "cwd_relative", required = false) String cwdRelative,
            @RequestParam String path,
            @RequestParam(name = "expected_scope_revision") String expectedScopeRevision) {
        String actor = tenant.requireActorId();
        return noStore(PublicFileResult.from(files.read(tenant.tenantId(), actor,
                new WorkspaceFileStore.Locator(sessionId, workspaceId, cwdRelative), path, expectedScopeRevision)));
    }

    @PostMapping(value = "/v1/agents/workspace-files/uploads", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<PublicFileUploadResult> publicUpload(TenantContext tenant,
            @RequestParam(name = "session_id", required = false) String sessionId,
            @RequestParam(name = "workspace_id", required = false) String workspaceId,
            @RequestParam(name = "cwd_relative", required = false) String cwdRelative,
            @RequestParam String path,
            @RequestParam(name = "expected_scope_revision") String expectedScopeRevision,
            @RequestParam(name = "upload_id") String uploadId, HttpServletRequest request) throws java.io.IOException {
        String actor = tenant.requireActorId();
        String encoding = request.getHeader("Content-Encoding");
        if (encoding != null && !"identity".equalsIgnoreCase(encoding)) {
            throw new ManagedAgentException(415, "invalid_request", "Encoded Workspace uploads are unsupported.");
        }
        var locator = new WorkspaceFileStore.Locator(sessionId, workspaceId, cwdRelative);
        return noStore(PublicFileUploadResult.from(uploads.upload(tenant.tenantId(), actor,
                locator, path, expectedScopeRevision, uploadId, request.getInputStream(), request.getContentLengthLong())));
    }

    @GetMapping("/v1/agents/workspace-files/uploads/{uploadId}")
    public ResponseEntity<PublicFileUploadStatus> publicQueryUpload(TenantContext tenant,
            @PathVariable String uploadId) {
        return noStore(PublicFileUploadStatus.from(uploads.query(tenant.tenantId(),
                tenant.requireActorId(), uploadId)));
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }

    public record PublicFileEntry(String path, String name, String kind) {
        static PublicFileEntry from(WorkspaceFileStore.Entry entry) {
            return new PublicFileEntry(entry.path(), entry.name(), entry.kind());
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicFileQueryResult(
            @JsonProperty("scope_revision") String scopeRevision,
            String directory,
            List<PublicFileEntry> entries,
            boolean truncated,
            @JsonProperty("max_upload_bytes") Integer maxUploadBytes) {
        static PublicFileQueryResult from(WorkspaceFileStore.QueryResult result) {
            return new PublicFileQueryResult(result.scopeRevision(), result.directory(),
                    result.entries().stream().map(PublicFileEntry::from).toList(),
                    result.truncated(), result.maxUploadBytes());
        }
    }

    public record PublicFileResult(
            @JsonProperty("scope_revision") String scopeRevision,
            String path,
            String name,
            @JsonProperty("mime_type") String mimeType,
            String text,
            @JsonProperty("byte_length") int byteLength,
            String sha256) {
        static PublicFileResult from(WorkspaceFileStore.FileResult result) {
            return new PublicFileResult(result.scopeRevision(), result.path(), result.name(),
                    result.mimeType(), result.text(), result.byteLength(), result.sha256());
        }
    }

    public record PublicFileUploadResult(
            @JsonProperty("scope_revision") String scopeRevision,
            @JsonProperty("upload_id") String uploadId,
            String path,
            @JsonProperty("size_bytes") int sizeBytes,
            String sha256) {
        static PublicFileUploadResult from(WorkspaceFileUploadStore.UploadResult result) {
            return new PublicFileUploadResult(result.scopeRevision(), result.uploadId(),
                    result.path(), result.sizeBytes(), result.sha256());
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicFileUploadStatus(
            @JsonProperty("scope_revision") String scopeRevision,
            @JsonProperty("upload_id") String uploadId,
            String state,
            String path,
            @JsonProperty("size_bytes") int sizeBytes,
            String sha256,
            String code) {
        static PublicFileUploadStatus from(WorkspaceFileUploadStore.UploadStatus status) {
            return new PublicFileUploadStatus(status.scopeRevision(), status.uploadId(),
                    status.state(), status.path(), status.sizeBytes(), status.sha256(), status.code());
        }
    }
}
