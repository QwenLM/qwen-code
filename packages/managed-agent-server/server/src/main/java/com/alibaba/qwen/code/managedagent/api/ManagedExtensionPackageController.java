package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.nio.file.Files;
import java.util.Map;

@RestController
public class ManagedExtensionPackageController {
    private static final String BASE = "/v1/agents/workspaces/{workspaceId}/extensions";
    private static final String WEB = "/api/agent/web-shell/v1/workspace-extensions";
    private final ManagedExtensionPackageService service;

    public ManagedExtensionPackageController(ManagedExtensionPackageService service) {
        this.service = service;
    }

    @GetMapping(BASE)
    public ResponseEntity<ManagedExtensionPackages.Catalog> list(TenantContext tenant,
            @PathVariable String workspaceId) {
        return noStore(service.list(tenant.tenantId(), tenant.requireActorId(), workspaceId));
    }

    @PostMapping(value = BASE, consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<ManagedExtensionPackages.Operation> create(TenantContext tenant,
            @PathVariable String workspaceId, @RequestHeader("Idempotency-Key") String key,
            @RequestParam("packageDigest") String digest,
            @RequestParam String manifest, HttpServletRequest request) throws IOException {
        return noStore(service.publish(tenant.tenantId(), tenant.requireActorId(), workspaceId, null, digest,
                key, service.decodeManifest(manifest), request.getInputStream()));
    }

    @PostMapping(value = BASE + "/imports", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<ManagedExtensionPackages.Operation> importPackage(TenantContext tenant,
            @PathVariable String workspaceId, @RequestParam String metadata,
            @RequestParam(required = false) String extensionId, @RequestHeader("Idempotency-Key") String key,
            HttpServletRequest request) throws IOException {
        service.requireExecutionAccess(tenant.tenantId(), tenant.requireActorId(), workspaceId);
        requireIdentityEncoding(request);
        return noStore(service.importPackage(tenant.tenantId(), tenant.requireActorId(), workspaceId, extensionId,
                key, metadata, request.getInputStream(), request.getContentLengthLong()));
    }

    @GetMapping(BASE + "/{extensionId}/packages/{packageRevision}/inspection")
    public ResponseEntity<com.fasterxml.jackson.databind.JsonNode> inspection(TenantContext tenant,
            @PathVariable String workspaceId, @PathVariable String extensionId, @PathVariable long packageRevision,
            @RequestParam String packageDigest) throws IOException {
        return noStore(service.inspection(tenant.tenantId(), tenant.requireActorId(), workspaceId,
                new ManagedExtensionPackages.Pin(extensionId, packageRevision, packageDigest, null)));
    }

    @PostMapping(value = BASE + "/imports/preview", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<com.fasterxml.jackson.databind.JsonNode> preview(TenantContext tenant,
            @PathVariable String workspaceId, @RequestParam String metadata, HttpServletRequest request) throws IOException {
        service.requireExecutionAccess(tenant.tenantId(), tenant.requireActorId(), workspaceId);
        requireIdentityEncoding(request);
        return noStore(service.preview(tenant.tenantId(), tenant.requireActorId(), workspaceId, metadata,
                request.getInputStream(), request.getContentLengthLong()));
    }

    @PostMapping(BASE + "/operations/lookup")
    public ResponseEntity<ManagedExtensionPackages.Operation> lookup(TenantContext tenant,
            @PathVariable String workspaceId, @Valid @RequestBody LookupRequest request) {
        return noStore(service.lookup(tenant.tenantId(), tenant.requireActorId(), workspaceId,
                request.kind(), request.idempotencyKey()));
    }

    @PutMapping(value = BASE + "/{extensionId}/packages/{packageDigest}", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<ManagedExtensionPackages.Operation> publish(TenantContext tenant,
            @PathVariable String workspaceId, @PathVariable String extensionId,
            @PathVariable String packageDigest, @RequestHeader("Idempotency-Key") String key,
            @RequestParam String manifest, HttpServletRequest request) throws IOException {
        return noStore(service.publish(tenant.tenantId(), tenant.requireActorId(), workspaceId, extensionId, packageDigest,
                key, service.decodeManifest(manifest), request.getInputStream()));
    }

    @GetMapping(BASE + "/{extensionId}/packages/{packageRevision}")
    public ResponseEntity<ManagedExtensionPackages.Package> get(TenantContext tenant,
            @PathVariable String workspaceId, @PathVariable String extensionId,
            @PathVariable long packageRevision, @RequestParam String packageDigest) {
        return noStore(service.get(tenant.tenantId(), tenant.requireActorId(), workspaceId, extensionId, packageRevision, packageDigest));
    }

    @GetMapping(BASE + "/{extensionId}/packages/{packageRevision}/archive")
    public ResponseEntity<StreamingResponseBody> archive(TenantContext tenant,
            @PathVariable String workspaceId, @PathVariable String extensionId,
            @PathVariable long packageRevision, @RequestParam String packageDigest) throws IOException {
        String actor = tenant.requireActorId();
        var saved = service.get(tenant.tenantId(), actor, workspaceId, extensionId, packageRevision, packageDigest);
        var archive = service.archive(tenant.tenantId(), actor, workspaceId, extensionId, packageRevision, packageDigest);
        StreamingResponseBody body = output -> {
            service.get(tenant.tenantId(), actor, workspaceId, extensionId, packageRevision, packageDigest);
            try (var input = Files.newInputStream(archive, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                input.transferTo(output);
            }
        };
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(saved.byteLength()).body(body);
    }

    @GetMapping(BASE + "/{extensionId}/settings")
    public ResponseEntity<ManagedExtensionPackages.Settings> settings(TenantContext tenant,
            @PathVariable String workspaceId, @PathVariable String extensionId) {
        return noStore(service.settings(tenant.tenantId(), tenant.requireActorId(), workspaceId, extensionId));
    }

    @PostMapping(BASE + "/{extensionId}/settings")
    public ResponseEntity<ManagedExtensionPackages.Operation> settings(TenantContext tenant,
            @PathVariable String workspaceId, @PathVariable String extensionId,
            @RequestHeader("Idempotency-Key") String key, @RequestBody ManagedExtensionPackages.SettingsCommand command) {
        return noStore(service.saveSettings(tenant.tenantId(), tenant.requireActorId(), workspaceId, extensionId, key, command));
    }

    @GetMapping(BASE + "/operations/{operationId}")
    public ResponseEntity<ManagedExtensionPackages.Operation> operation(TenantContext tenant,
            @PathVariable String workspaceId, @PathVariable String operationId) {
        return noStore(service.operation(tenant.tenantId(), tenant.requireActorId(), workspaceId, operationId));
    }

    @PostMapping(WEB + "/query")
    public ResponseEntity<ManagedExtensionPackages.Catalog> query(TenantContext tenant, @Valid @RequestBody WorkspaceQuery request) {
        return list(tenant, request.workspaceId());
    }

    @PostMapping(value = WEB + "/publish", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<ManagedExtensionPackages.Operation> webPublish(TenantContext tenant,
            @RequestParam String workspaceId, @RequestParam(required = false) String extensionId,
            @RequestParam String packageDigest, @RequestParam String manifest,
            @RequestHeader("Idempotency-Key") String key, HttpServletRequest request) throws IOException {
        return noStore(service.publish(tenant.tenantId(), tenant.requireActorId(), workspaceId, extensionId,
                packageDigest, key, service.decodeManifest(manifest), request.getInputStream()));
    }

    @PostMapping(value = WEB + "/imports", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<ManagedExtensionPackages.Operation> webImport(TenantContext tenant,
            @RequestParam String workspaceId, @RequestParam String metadata,
            @RequestParam(required = false) String extensionId, @RequestHeader("Idempotency-Key") String key,
            HttpServletRequest request) throws IOException {
        return importPackage(tenant, workspaceId, metadata, extensionId, key, request);
    }

    @PostMapping(WEB + "/inspection/query")
    public ResponseEntity<com.fasterxml.jackson.databind.JsonNode> inspectionQuery(TenantContext tenant,
            @Valid @RequestBody PackageQuery request) throws IOException {
        return noStore(service.inspection(tenant.tenantId(), tenant.requireActorId(), request.workspaceId(), request.pin()));
    }

    @PostMapping(value = WEB + "/imports/preview", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<com.fasterxml.jackson.databind.JsonNode> webPreview(TenantContext tenant,
            @RequestParam String workspaceId, @RequestParam String metadata, HttpServletRequest request) throws IOException {
        return preview(tenant, workspaceId, metadata, request);
    }

    @PostMapping(WEB + "/operations/lookup")
    public ResponseEntity<ManagedExtensionPackages.Operation> lookupQuery(TenantContext tenant,
            @Valid @RequestBody WebLookupRequest request) {
        return noStore(service.lookup(tenant.tenantId(), tenant.requireActorId(), request.workspaceId(),
                request.kind(), request.idempotencyKey()));
    }

    @PostMapping(WEB + "/settings/query")
    public ResponseEntity<ManagedExtensionPackages.Settings> settingsQuery(TenantContext tenant, @Valid @RequestBody ExtensionQuery request) {
        return settings(tenant, request.workspaceId(), request.extensionId());
    }

    @PostMapping(WEB + "/settings/submit")
    public ResponseEntity<ManagedExtensionPackages.Operation> settingsSubmit(TenantContext tenant,
            @Valid @RequestBody SettingsSubmit request) {
        return noStore(service.saveSettings(tenant.tenantId(), tenant.requireActorId(), request.workspaceId(),
                request.extensionId(), request.idempotencyKey(),
                new ManagedExtensionPackages.SettingsCommand(request.expectedRevision(), request.values())));
    }

    @PostMapping(WEB + "/operations/query")
    public ResponseEntity<ManagedExtensionPackages.Operation> operationQuery(TenantContext tenant, @Valid @RequestBody OperationQuery request) {
        return operation(tenant, request.workspaceId(), request.operationId());
    }

    @PostMapping(WEB + "/packages/query")
    public ResponseEntity<ManagedExtensionPackages.Package> packageQuery(TenantContext tenant, @Valid @RequestBody PackageQuery request) {
        return get(tenant, request.workspaceId(), request.pin().extensionId(), request.pin().packageRevision(), request.pin().packageDigest());
    }

    public record WorkspaceQuery(@NotBlank @Size(max = 512) String workspaceId) { }
    public record ExtensionQuery(@NotBlank @Size(max = 512) String workspaceId, @NotBlank @Size(max = 128) String extensionId) { }
    public record OperationQuery(@NotBlank @Size(max = 512) String workspaceId, @NotBlank @Size(max = 128) String operationId) { }
    public record PackageQuery(@NotBlank @Size(max = 512) String workspaceId, @NotNull ManagedExtensionPackages.Pin pin) { }
    public record LookupRequest(@NotBlank @Size(max = 16) String kind, @NotBlank @Size(max = 512) String idempotencyKey) { }
    public record WebLookupRequest(@NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 16) String kind, @NotBlank @Size(max = 512) String idempotencyKey) { }
    public record SettingsSubmit(@NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 128) String extensionId, @NotBlank @Size(max = 512) String idempotencyKey,
            long expectedRevision, Map<String, String> values) {
        @Override public String toString() { return "ExtensionSettingsSubmit[values=redacted]"; }
    }

    private static <T> ResponseEntity<T> noStore(T value) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value);
    }

    private static void requireIdentityEncoding(HttpServletRequest request) {
        String encoding = request.getHeader("Content-Encoding");
        if (encoding != null && !"identity".equalsIgnoreCase(encoding)) {
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(415,
                    "invalid_request", "Encoded package imports are unsupported.");
        }
    }
}
