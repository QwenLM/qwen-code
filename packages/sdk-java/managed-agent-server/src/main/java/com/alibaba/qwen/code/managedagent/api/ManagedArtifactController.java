package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.ArtifactResponse;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.ToolResultResponse;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellArtifactQueryRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellArtifactRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellToolResultRequest;
import com.alibaba.qwen.code.managedagent.service.ManagedArtifactService;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import java.io.IOException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedArtifactController {
    private static final String PUBLIC = "/v1/agents/sessions/{sessionId}";
    private static final String WEB = "/api/agent/web-shell/v1";
    private final ManagedArtifactService service;

    public ManagedArtifactController(ManagedArtifactService service) {
        this.service = service;
    }

    @GetMapping(PUBLIC + "/items/{itemId}/tool-result")
    public ResponseEntity<ToolResultResponse> result(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String itemId) {
        return metadata(service.result(tenant, sessionId, itemId));
    }

    @GetMapping(PUBLIC + "/artifacts")
    public ResponseEntity<PublicList<ArtifactResponse>> artifacts(TenantContext tenant,
            @PathVariable String sessionId, @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        var page = service.page(tenant, sessionId, cursor, limit);
        return metadata(new PublicList<>("list", page.data(), page.hasMore(), page.nextCursor()));
    }

    @GetMapping(PUBLIC + "/artifacts/{artifactId}")
    public ResponseEntity<ArtifactResponse> artifact(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String artifactId) {
        return metadata(service.artifact(tenant, sessionId, artifactId));
    }

    @GetMapping(PUBLIC + "/artifacts/{artifactId}/content")
    public void content(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String artifactId, @RequestParam(required = false) String revision,
            @RequestHeader(value = "Range", required = false) String range,
            @RequestHeader(value = "If-Match", required = false) String ifMatch,
            @RequestHeader(value = "If-Range", required = false) String ifRange,
            HttpServletResponse response) throws IOException {
        response.setHeader("Cache-Control", "private, no-store, no-transform");
        service.content(tenant, sessionId, artifactId, revision, range, ifMatch, ifRange, response);
    }

    @PostMapping(WEB + "/tool-results/get")
    public ResponseEntity<ToolResultResponse> webResult(TenantContext tenant,
            @Valid @RequestBody WebShellToolResultRequest request) {
        return metadata(service.result(tenant, request.sessionId(), request.itemId()));
    }

    @PostMapping(WEB + "/artifacts/get")
    public ResponseEntity<ArtifactResponse> webArtifact(TenantContext tenant,
            @Valid @RequestBody WebShellArtifactRequest request) {
        return metadata(service.artifact(tenant, request.sessionId(), request.artifactId()));
    }

    @PostMapping(WEB + "/artifacts/query")
    public ResponseEntity<WebShellPage<ArtifactResponse>> webArtifacts(TenantContext tenant,
            @Valid @RequestBody WebShellArtifactQueryRequest request) {
        return metadata(service.page(tenant, request.sessionId(), request.cursor(),
                request.limit() == null ? 20 : request.limit()));
    }

    private static <T> ResponseEntity<T> metadata(T body) {
        return ResponseEntity.ok().header("Cache-Control", "private, no-store").body(body);
    }
}
