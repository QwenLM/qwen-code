package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.ApiModels.PermissionResponse;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicActionList;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellActionGetRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellActionQueryRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellActionRespondRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ManagedActionService;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedActionController {
    private final ManagedActionService actions;

    public ManagedActionController(ManagedActionService actions) {
        this.actions = actions;
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/actions")
    public PublicActionList list(
            TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(name = "include_children", defaultValue = "false") boolean includeChildren) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? actions.listPublic(tenant.tenantId(), tenant.actorId(),
                        sessionId, cursor, limit, includeChildren)
                : actions.listPublic(principal, sessionId, cursor, limit,
                        includeChildren);
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/actions/{actionId}")
    public JsonNode get(
            TenantContext tenant, @PathVariable String sessionId, @PathVariable String actionId) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? actions.get(tenant.tenantId(), tenant.actorId(), sessionId,
                        actionId, false)
                : actions.get(principal, sessionId, actionId, false);
    }

    @PostMapping("/v1/agents/sessions/{sessionId}/actions/{actionId}/responses")
    public ResponseEntity<PublicCommandOperation> respond(
            TenantContext tenant,
            @PathVariable String sessionId,
            @PathVariable String actionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody PermissionResponse response) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        var admission = principal == null
                ? actions.respond(
                        tenant.tenantId(),
                        tenant.actorId(),
                        sessionId,
                        actionId,
                        idempotencyKey,
                        response.kind(),
                        response.inputRevision(),
                        response.policyRevision(),
                        response.optionId(), response.answers(), true)
                : actions.respond(
                        tenant.tenantId(),
                        principal,
                        sessionId,
                        actionId,
                        idempotencyKey,
                        response.kind(),
                        response.inputRevision(),
                        response.policyRevision(),
                        response.optionId(), response.answers(), true);
        return ResponseEntity.accepted()
                .header("X-Qwen-Idempotent-Replay", Boolean.toString(admission.replayed()))
                .body(actions.publicOperation(admission.operation(), admission.replayed()));
    }

    @PostMapping("/api/agent/web-shell/v1/actions/query")
    public WebShellPage<JsonNode> query(
            TenantContext tenant, @Valid @RequestBody WebShellActionQueryRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        int limit = request.limit() == null ? 20 : request.limit();
        boolean includeChildren = Boolean.TRUE.equals(request.includeChildren());
        return principal == null
                ? actions.listWebShell(tenant.tenantId(), tenant.actorId(),
                        request.sessionId(), request.cursor(), limit, includeChildren)
                : actions.listWebShell(principal, request.sessionId(),
                        request.cursor(), limit, includeChildren);
    }

    @PostMapping("/api/agent/web-shell/v1/actions/get")
    public JsonNode getWebShell(
            TenantContext tenant, @Valid @RequestBody WebShellActionGetRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? actions.get(tenant.tenantId(), tenant.actorId(),
                        request.sessionId(), request.actionId(), true)
                : actions.get(principal, request.sessionId(),
                        request.actionId(), true);
    }

    @PostMapping("/api/agent/web-shell/v1/actions/respond")
    public ResponseEntity<WebShellCommandOperation> respondWebShell(
            TenantContext tenant,
            @Valid @RequestBody WebShellActionRespondRequest request,
            HttpServletRequest httpRequest,
            HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        var response = request.response();
        SessionPrincipal principal = tenant.subjectPrincipal();
        var admission = principal == null
                ? actions.respond(
                        tenant.tenantId(),
                        tenant.actorId(),
                        request.sessionId(),
                        request.actionId(),
                        request.idempotencyKey(),
                        response.kind(),
                        response.inputRevision(),
                        response.policyRevision(),
                        response.optionId(), response.answers(), false)
                : actions.respond(
                        tenant.tenantId(),
                        principal,
                        request.sessionId(),
                        request.actionId(),
                        request.idempotencyKey(),
                        response.kind(),
                        response.inputRevision(),
                        response.policyRevision(),
                        response.optionId(), response.answers(), false);
        return ResponseEntity.accepted()
                .body(actions.webOperation(admission.operation(), admission.replayed()));
    }
}
