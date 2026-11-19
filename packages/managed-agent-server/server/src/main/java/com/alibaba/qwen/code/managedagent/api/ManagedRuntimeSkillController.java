package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedRuntimeSkills;
import com.alibaba.qwen.code.managedagent.extensions.ManagedRuntimeSkillImportService;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;

@RestController
public class ManagedRuntimeSkillController {
    private static final String BASE = "/v1/agents/sessions/{sessionId}/extensions/skills";
    private static final String WEB = "/api/agent/web-shell/v1/session-extensions/skills";
    private final ManagedRuntimeSkillImportService service;

    public ManagedRuntimeSkillController(ManagedRuntimeSkillImportService service) { this.service = service; }

    @GetMapping(BASE + "/candidates")
    public ResponseEntity<JsonNode> candidates(TenantContext tenant, @PathVariable String sessionId) {
        return noStore(service.candidates(tenant.tenantId(), tenant.requireActorId(), sessionId));
    }

    @PostMapping(BASE + "/snapshot")
    public ResponseEntity<JsonNode> snapshot(TenantContext tenant, @PathVariable String sessionId,
            @RequestBody ManagedRuntimeSkills.SnapshotRequest request) throws IOException {
        return noStore(service.snapshot(tenant.tenantId(), tenant.requireActorId(), sessionId, request));
    }

    @PostMapping(BASE + "/imports")
    public ResponseEntity<ManagedExtensionPackages.Operation> importSnapshot(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String key, @RequestBody ManagedRuntimeSkills.ImportRequest request) throws IOException {
        return noStore(service.importSnapshot(tenant.tenantId(), tenant.requireActorId(), sessionId, key, request));
    }

    public record WebQuery(@NotBlank String sessionId) {
        @JsonAnySetter public void rejectUnknown(String name, JsonNode value) { throw new IllegalArgumentException("Unknown Runtime Skill query field"); }
    }

    public record WebSnapshot(@NotBlank String sessionId, ManagedRuntimeSkills.Owner owner, String path, String digest,
            ManagedExtensionPackages.Target target) {
        @JsonAnySetter public void rejectUnknown(String name, JsonNode value) { throw new IllegalArgumentException("Unknown Runtime Skill snapshot field"); }
    }

    public record WebImport(@NotBlank String sessionId, @NotBlank String idempotencyKey, ManagedRuntimeSkills.Owner owner,
            String operationId, String preparationId, String sourceDigest, long byteLength,
            ManagedExtensionPackages.Target target, String extensionId) {
        @JsonAnySetter public void rejectUnknown(String name, JsonNode value) { throw new IllegalArgumentException("Unknown Runtime Skill import field"); }
    }

    @PostMapping(WEB + "/candidates/query")
    public ResponseEntity<JsonNode> webCandidates(TenantContext tenant, @Valid @RequestBody WebQuery request) {
        return candidates(tenant, request.sessionId());
    }

    @PostMapping(WEB + "/snapshot")
    public ResponseEntity<JsonNode> webSnapshot(TenantContext tenant, @Valid @RequestBody WebSnapshot request) throws IOException {
        return snapshot(tenant, request.sessionId(), new ManagedRuntimeSkills.SnapshotRequest(request.owner(), request.path(), request.digest(), request.target()));
    }

    @PostMapping(WEB + "/imports")
    public ResponseEntity<ManagedExtensionPackages.Operation> webImport(TenantContext tenant, @Valid @RequestBody WebImport request) throws IOException {
        return importSnapshot(tenant, request.sessionId(), request.idempotencyKey(), new ManagedRuntimeSkills.ImportRequest(request.owner(),
                request.operationId(), request.preparationId(), request.sourceDigest(), request.byteLength(), request.target(), request.extensionId()));
    }

    private static <T> ResponseEntity<T> noStore(T result) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(result);
    }
}
