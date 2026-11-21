package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionRecovery;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCancelRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellChangeModelRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCreateRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellExportPage;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellExportRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellListRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellOperationRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellRecoveryRecheckRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellRenameRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellRenameResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionModelsRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionOptionsRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellStreamRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSubmitRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTask;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskCancelRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskEventQueryRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskGetRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskPage;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskQueryRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTranscriptRequest;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ContextCompressionService;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.session.ManagedEventStreamService;
import com.alibaba.qwen.code.managedagent.session.ManagedTaskCancelService;
import com.alibaba.qwen.code.managedagent.session.ManagedTaskService;
import com.alibaba.qwen.code.managedagent.session.SessionLifecycleService;
import com.alibaba.qwen.code.managedagent.session.SessionRecoveryService;
import com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
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
    private final SessionLifecycleService lifecycle;
    private final ManagedTaskService tasks;
    private final ManagedTaskCancelService taskCancels;
    private final SessionRecoveryService recovery;
    private ContextCompressionService compressions;

    @org.springframework.beans.factory.annotation.Autowired
    void setCompressions(ContextCompressionService compressions) {
        this.compressions = compressions;
    }

    public WebShellAgentController(ManagedAgentService service,
            ManagedEventStreamService streams,
            SessionLifecycleService lifecycle, ManagedTaskService tasks,
            ManagedTaskCancelService taskCancels, SessionRecoveryService recovery) {
        this.service = service;
        this.streams = streams;
        this.lifecycle = lifecycle;
        this.tasks = tasks;
        this.taskCancels = taskCancels;
        this.recovery = recovery;
    }

    @PostMapping("/tasks/query")
    public WebShellTaskPage tasks(TenantContext tenant,
            @Valid @RequestBody WebShellTaskQueryRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? tasks.queryWebShellTasks(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(),
                        request.cursor(), request.limit() == null ? 20
                                : request.limit())
                : tasks.queryWebShellTasks(principal, request.sessionId(),
                        request.cursor(), request.limit() == null ? 20
                                : request.limit());
    }

    @PostMapping("/tasks/get")
    public WebShellTask task(TenantContext tenant,
            @Valid @RequestBody WebShellTaskGetRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? tasks.getWebShellTask(tenant.tenantId(), tenant.actorId(),
                        request.sessionId(), request.taskId())
                : tasks.getWebShellTask(principal, request.sessionId(),
                        request.taskId());
    }

    @PostMapping("/tasks/events/query")
    public WebShellPage<WebShellTaskEvent> taskEvents(TenantContext tenant,
            @Valid @RequestBody WebShellTaskEventQueryRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? tasks.queryWebShellTaskEvents(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(),
                        request.taskId(), request.after(),
                        request.limit() == null ? 20 : request.limit())
                : tasks.queryWebShellTaskEvents(principal,
                        request.sessionId(), request.taskId(),
                        request.after(),
                        request.limit() == null ? 20 : request.limit());
    }

    @PostMapping("/tasks/cancel")
    public ResponseEntity<WebShellCommandOperation> cancelTask(
            TenantContext tenant,
            @Valid @RequestBody WebShellTaskCancelRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse,
                request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? taskCancels.cancelWebShell(tenant.tenantId(),
                        tenant.actorId(), request.idempotencyKey(),
                        request.sessionId(), request.taskId())
                : taskCancels.cancelWebShell(principal,
                        request.idempotencyKey(), request.sessionId(),
                        request.taskId()));
    }

    @PostMapping("/sessions/query")
    public WebShellPage<WebShellSession> list(TenantContext tenant,
            @RequestBody WebShellListRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        int limit = request.limit() == null ? 20 : request.limit();
        return principal == null
                ? service.listWebShellSessions(tenant.tenantId(),
                        tenant.actorId(), request.cursor(), limit,
                        request.archiveState(), request.titleQuery())
                : service.listWebShellSessions(principal, request.cursor(),
                        limit, request.archiveState(),
                        request.titleQuery());
    }

    @PostMapping("/sessions/export/query")
    public ApiModels.WebShellExportPage export(TenantContext tenant,
            @Valid @RequestBody ApiModels.WebShellExportRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        int limit = request.limit() == null ? 100 : request.limit();
        return principal == null
                ? service.exportPage(tenant.tenantId(), tenant.actorId(),
                        request.sessionId(), request.cursor(), limit)
                : service.exportPage(principal, request.sessionId(),
                        request.cursor(), limit);
    }

    @PostMapping("/sessions/get")
    public WebShellSession get(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.getWebShellSession(tenant.tenantId(),
                        tenant.actorId(), request.sessionId())
                : service.getWebShellSession(principal,
                        request.sessionId());
    }

    @PostMapping("/session-recovery/query")
    public ResponseEntity<SessionRecovery> recovery(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .body(principal == null
                        ? recovery.query(tenant.tenantId(),
                                tenant.actorId(), request.sessionId())
                        : recovery.query(principal, request.sessionId()));
    }

    @PostMapping("/session-recovery/recheck")
    public ResponseEntity<SessionRecovery> recheckRecovery(TenantContext tenant,
            @Valid @RequestBody WebShellRecoveryRecheckRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? recovery.recheck(tenant.tenantId(), tenant.actorId(),
                        request.sessionId(), request.turnId())
                : recovery.recheck(principal, request.sessionId(),
                        request.turnId()));
    }

    @PostMapping("/sessions/rename")
    public ResponseEntity<WebShellRenameResult> rename(TenantContext tenant,
            @Valid @RequestBody WebShellRenameRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        var result = principal == null
                ? service.renameSession(tenant.tenantId(), tenant.actorId(),
                        request.idempotencyKey(), request.sessionId(),
                        request.title())
                : service.renameSession(principal, request.idempotencyKey(),
                        request.sessionId(), request.title());
        return ResponseEntity.ok().header("X-Qwen-Idempotent-Replay", Boolean.toString(result.replayed()))
                .body(new WebShellRenameResult(result.body().id(),
                        (String) result.body().metadata().get("title"), result.replayed()));
    }

    @PostMapping("/transcript/query")
    public WebShellTranscript transcript(TenantContext tenant,
            @Valid @RequestBody WebShellTranscriptRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        int limit = request.limit() == null ? 100 : request.limit();
        return principal == null
                ? service.transcript(tenant.tenantId(), tenant.actorId(),
                        request.sessionId(), request.cursor(), limit)
                : service.transcript(principal, request.sessionId(),
                        request.cursor(), limit);
    }

    @PostMapping("/transcript/items/query")
    public WebShellExportPage recentTranscriptItems(TenantContext tenant,
            @Valid @RequestBody WebShellExportRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        int limit = request.limit() == null ? 100 : request.limit();
        return principal == null
                ? service.recentTranscriptItems(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(),
                        request.cursor(), limit)
                : service.recentTranscriptItems(principal,
                        request.sessionId(), request.cursor(), limit);
    }

    @PostMapping(value = "/events/stream",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(TenantContext tenant,
            @Valid @RequestBody WebShellStreamRequest request) {
        long after = request.afterSequence() == null ? 0
                : request.afterSequence();
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? streams.webShellStream(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(), after)
                : streams.webShellStream(principal, request.sessionId(),
                        after);
    }

    @PostMapping("/sessions/compress")
    public ResponseEntity<ApiModels.WebShellContextCompressionOperation> compress(TenantContext tenant,
            @Valid @RequestBody ApiModels.WebShellContextCompressionRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? compressions.admitWebShell(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(),
                        request.idempotencyKey(),
                        request.expectedCompactionRevision())
                : compressions.admitWebShell(principal, request.sessionId(),
                        request.idempotencyKey(),
                        request.expectedCompactionRevision()));
    }

    @PostMapping("/sessions/create")
    public ResponseEntity<WebShellAdmission> create(TenantContext tenant,
            @Valid @RequestBody WebShellCreateRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse,
                request.requestId());
        WorkspaceSelection selection = null;
        if (request.workspace() != null) {
            if (request.workspace().isNull()) {
                throw new ManagedAgentException(400,
                        "invalid_request", "Workspace cannot be null.");
            }
            selection = WorkspaceSelection.parse(request.workspace(), true);
            tenant.requireActorId();
        }
        if (selection == null && (request.approvalMode() != null || request.planMode() != null)) {
            throw new ManagedAgentException(400,
                    "unsupported_approval_mode",
                    "Approval mode selection requires a bound Workspace.");
        }
        if (selection == null && request.modelId() != null) {
            throw new ManagedAgentException(400, "unsupported_feature",
                    "Model selection requires a bound Workspace.");
        }
        if (selection == null && request.skills() != null && !request.skills().isEmpty()) {
            throw new ManagedAgentException(400, "unsupported_feature",
                    "Session Skills require a bound Workspace.");
        }
        if (selection == null && request.extensionPins() != null) {
            throw new ManagedAgentException(400, "unsupported_feature", "Extension packages require a bound Workspace.");
        }
        var worktree = SessionWorktreeService.parse(request.worktree(), true);
        if (selection == null && worktree != null) {
            throw new ManagedAgentException(400, "unsupported_feature", "Session worktrees require a bound Workspace.");
        }
        // The WebShell handlers forward no metadata at all (null in its
        // slot): whatever the client sends is accepted and ignored, so no
        // clientId-only contract is asserted here and immediately
        // discarded. The Session title travels in the title field.
        WebShellAdmission admission = webShell(selection == null
                ? service.createSession(tenant.requirePrincipal(),
                        request.idempotencyKey(), request.agentId(), null,
                        request.title(), null, request.input(),
                        com.alibaba.qwen.code.managedagent.model.SessionModelConfig.parse(request.modelConfig()), request.memoryStoreId())
                : service.createWorkspaceSession(tenant.tenantId(), tenant.requireActorId(), request.idempotencyKey(),
                        request.agentId(), null, request.title(), null, request.input(), selection,
                        request.approvalMode(), request.planMode(), request.skills(), request.modelId(), request.extensionPins(), worktree,
                        com.alibaba.qwen.code.managedagent.model.SessionModelConfig.parse(request.modelConfig()), request.memoryStoreId()));
        return ResponseEntity.accepted().body(admission);
    }

    @PostMapping("/session-options/query")
    public ResponseEntity<WebShellSessionOptions> sessionOptions(TenantContext tenant,
            @Valid @RequestBody WebShellSessionOptionsRequest request) {
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .body(service.queryWebShellSessionOptions(tenant.tenantId(),
                        tenant.requireActorId(), request.agentId()));
    }

    @PostMapping("/turns/submit")
    public ResponseEntity<WebShellAdmission> submit(TenantContext tenant,
            @Valid @RequestBody WebShellSubmitRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse,
                request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        WebShellAdmission admission = webShell(principal == null
                ? service.submitTurn(tenant.tenantId(), tenant.actorId(),
                        request.idempotencyKey(), request.sessionId(),
                        request.input())
                : service.submitTurn(principal, request.idempotencyKey(),
                        request.sessionId(), request.input()));
        return ResponseEntity.accepted().body(admission);
    }

    @PostMapping("/turns/cancel")
    public ResponseEntity<WebShellAdmission> cancel(TenantContext tenant,
            @Valid @RequestBody WebShellCancelRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse,
                request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        WebShellAdmission admission = webShell(principal == null
                ? service.cancelTurn(tenant.tenantId(), tenant.actorId(),
                        request.idempotencyKey(), request.sessionId(),
                        request.turnId())
                : service.cancelTurn(principal, request.idempotencyKey(),
                        request.sessionId(), request.turnId()));
        return ResponseEntity.accepted().body(admission);
    }

    @PostMapping("/sessions/close")
    public ResponseEntity<WebShellCommandOperation> close(
            TenantContext tenant,
            @Valid @RequestBody WebShellLifecycleRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return operation(tenant, request, OperationKind.CLOSE);
    }

    @PostMapping("/sessions/archive")
    public ResponseEntity<WebShellCommandOperation> archive(
            TenantContext tenant,
            @Valid @RequestBody WebShellLifecycleRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return operation(tenant, request, OperationKind.ARCHIVE);
    }

    @PostMapping("/sessions/delete")
    public ResponseEntity<WebShellCommandOperation> delete(
            TenantContext tenant,
            @Valid @RequestBody WebShellLifecycleRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        return operation(tenant, request, OperationKind.DELETE);
    }

    @PostMapping("/sessions/unarchive")
    public ResponseEntity<WebShellSession> unarchive(TenantContext tenant,
            @Valid @RequestBody WebShellLifecycleRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        var result = principal == null
                ? service.unarchiveWebShellSession(tenant.tenantId(),
                        tenant.actorId(), request.idempotencyKey(),
                        request.sessionId())
                : service.unarchiveWebShellSession(principal,
                        request.idempotencyKey(), request.sessionId());
        return ResponseEntity.ok().header("X-Qwen-Idempotent-Replay", Boolean.toString(result.replayed()))
                .body(result.body());
    }

    @PostMapping("/operations/query")
    public Object queryOperation(TenantContext tenant,
            @Valid @RequestBody WebShellOperationRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? lifecycle.getWebShellOperation(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(),
                        request.operationId())
                : lifecycle.getWebShellOperation(principal,
                        request.sessionId(), request.operationId());
    }

    @PostMapping("/session-approval/query")
    public ApiModels.WebShellSessionApproval querySessionApproval(TenantContext tenant,
            @Valid @RequestBody ApiModels.WebShellSessionApprovalRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.queryWebShellSessionApproval(tenant.tenantId(),
                        tenant.actorId(), request.sessionId())
                : service.queryWebShellSessionApproval(principal,
                        request.sessionId());
    }

    @PostMapping("/session-approval/change")
    public ApiModels.WebShellApprovalChangeResult changeSessionApproval(TenantContext tenant,
            @Valid @RequestBody ApiModels.WebShellChangeApprovalRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.changeWebShellSessionApproval(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(),
                        request.idempotencyKey(), request.approvalMode(),
                        request.expectedRevision(), request.planMode(),
                        request.permissionRules())
                : service.changeWebShellSessionApproval(principal,
                        request.sessionId(), request.idempotencyKey(),
                        request.approvalMode(), request.expectedRevision(),
                        request.planMode(), request.permissionRules());
    }

    @PostMapping("/session-models/query")
    public WebShellSessionModels querySessionModels(TenantContext tenant,
            @Valid @RequestBody WebShellSessionModelsRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.queryWebShellSessionModels(tenant.tenantId(),
                        tenant.actorId(), request.sessionId())
                : service.queryWebShellSessionModels(principal,
                        request.sessionId());
    }

    @PostMapping("/session-models/change")
    public WebShellModelChangeResult changeSessionModel(TenantContext tenant,
            @Valid @RequestBody WebShellChangeModelRequest request,
            HttpServletRequest httpRequest, HttpServletResponse httpResponse) {
        RequestIdFilter.useClientId(httpRequest, httpResponse, request.requestId());
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.changeWebShellSessionModel(tenant.tenantId(),
                        tenant.actorId(), request.sessionId(),
                        request.idempotencyKey(), request.modelId(),
                        request.expectedRevision())
                : service.changeWebShellSessionModel(principal,
                        request.sessionId(), request.idempotencyKey(),
                        request.modelId(), request.expectedRevision());
    }

    private ResponseEntity<WebShellCommandOperation> operation(
            TenantContext tenant, WebShellLifecycleRequest request,
            OperationKind kind) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? lifecycle.admitWebShell(tenant.tenantId(),
                        tenant.actorId(), request.idempotencyKey(),
                        request.sessionId(), kind)
                : lifecycle.admitWebShell(principal, request.idempotencyKey(),
                        request.sessionId(), kind));
    }

    private static WebShellAdmission webShell(CommandAdmission admission) {
        return new WebShellAdmission(admission.sessionId(),
                admission.turnId(), admission.status(),
                admission.replayed(), admission.operationId(),
                admission.admissionStage(), admission.deliveryState());
    }
}
