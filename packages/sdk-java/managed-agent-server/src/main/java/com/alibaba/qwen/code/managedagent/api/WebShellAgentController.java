package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCancelRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCreateRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellListRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellStreamRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSubmitRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscriptRequest;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.ManagedEventStreamService;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/agent/web-shell/v1")
public class WebShellAgentController {
    private final ManagedAgentService service;
    private final ManagedEventStreamService streams;

    public WebShellAgentController(ManagedAgentService service,
            ManagedEventStreamService streams) {
        this.service = service;
        this.streams = streams;
    }

    @PostMapping("/sessions/query")
    public WebShellPage<WebShellSession> list(TenantContext tenant,
            @RequestBody WebShellListRequest request) {
        return service.listWebShellSessions(tenant.tenantId(),
                tenant.actorId(), request.cursor(), request.limit() == null ? 20
                        : request.limit());
    }

    @PostMapping("/sessions/get")
    public WebShellSession get(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        return service.getWebShellSession(tenant.tenantId(),
                tenant.actorId(),
                request.sessionId());
    }

    @PostMapping("/transcript/query")
    public WebShellTranscript transcript(TenantContext tenant,
            @Valid @RequestBody WebShellTranscriptRequest request) {
        return service.transcript(tenant.tenantId(), tenant.actorId(),
                request.sessionId(),
                request.cursor(),
                request.limit() == null ? 100 : request.limit());
    }

    @PostMapping(value = "/events/stream",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(TenantContext tenant,
            @Valid @RequestBody WebShellStreamRequest request) {
        long after = request.afterSequence() == null ? 0
                : request.afterSequence();
        return streams.webShellStream(tenant.tenantId(), tenant.actorId(),
                request.sessionId(),
                after);
    }

    @PostMapping("/sessions/create")
    public ResponseEntity<WebShellAdmission> create(TenantContext tenant,
            @Valid @RequestBody WebShellCreateRequest request) {
        WorkspaceSelection selection = null;
        if (request.workspace() != null) {
            if (request.workspace().isNull()) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "invalid_request", "Workspace cannot be null.");
            }
            selection = WorkspaceSelection.parse(request.workspace(), true);
            tenant.requireActorId();
        }
        if (request.environmentId() != null
                && !request.environmentId().isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature",
                    "Standalone Phase 1 has no environment templates.");
        }
        validateTraceMetadata(request.metadata());
        WebShellAdmission admission = webShell(selection == null
                ? service.createSession(tenant.tenantId(),
                        request.idempotencyKey(), request.agentId(),
                        request.title(), null, request.input())
                : service.createWorkspaceSession(tenant.tenantId(),
                        tenant.requireActorId(), request.idempotencyKey(),
                        request.agentId(), request.title(), null,
                        request.input(), selection));
        return ResponseEntity.accepted().body(admission);
    }

    @PostMapping("/turns/submit")
    public ResponseEntity<WebShellAdmission> submit(TenantContext tenant,
            @Valid @RequestBody WebShellSubmitRequest request) {
        validateTraceMetadata(request.metadata());
        WebShellAdmission admission = webShell(service.submitTurn(
                tenant.tenantId(), tenant.actorId(),
                request.idempotencyKey(), request.sessionId(),
                request.input()));
        return ResponseEntity.accepted().body(admission);
    }

    @PostMapping("/turns/cancel")
    public ResponseEntity<WebShellAdmission> cancel(TenantContext tenant,
            @Valid @RequestBody WebShellCancelRequest request) {
        WebShellAdmission admission = webShell(service.cancelTurn(
                tenant.tenantId(), tenant.actorId(),
                request.idempotencyKey(), request.sessionId(),
                request.turnId()));
        return ResponseEntity.accepted().body(admission);
    }

    private static void validateTraceMetadata(Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return;
        }
        Object clientId = metadata.get("clientId");
        if (metadata.size() != 1 || !(clientId instanceof String)
                || ((String) clientId).isBlank()
                || ((String) clientId).length() > 128) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature",
                    "WebShell metadata accepts clientId only.");
        }
    }

    private static WebShellAdmission webShell(CommandAdmission admission) {
        return new WebShellAdmission(admission.sessionId(),
                admission.turnId(), admission.status(),
                admission.replayed());
    }
}
