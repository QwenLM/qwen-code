package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CompressSessionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CreateSessionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicContextCompressionOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicTask;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicTaskEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.model.ApiModels.RecoveryRecheckRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionEventRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionRecovery;
import com.alibaba.qwen.code.managedagent.model.ApiModels.UpdateSessionRequest;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ContextCompressionService;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService.SessionMutationResult;
import com.alibaba.qwen.code.managedagent.session.ManagedEventStreamService;
import com.alibaba.qwen.code.managedagent.session.ManagedTaskCancelService;
import com.alibaba.qwen.code.managedagent.session.ManagedTaskService;
import com.alibaba.qwen.code.managedagent.session.SessionLifecycleService;
import com.alibaba.qwen.code.managedagent.session.SessionRecoveryService;
import com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService;
import jakarta.validation.Valid;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/agents/sessions")
public class PublicAgentController {
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

    public PublicAgentController(ManagedAgentService service,
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

    @PostMapping
    public ResponseEntity<PublicSession> create(TenantContext tenant,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CreateSessionRequest request) {
        WorkspaceSelection selection = null;
        if (request.workspace() != null) {
            if (request.workspace().isNull()) {
                throw new ManagedAgentException(400,
                        "invalid_request", "Workspace cannot be null.");
            }
            selection = WorkspaceSelection.parse(request.workspace(), false);
            tenant.requireActorId();
        }
        if (Boolean.TRUE.equals(request.stream())) {
            throw new ManagedAgentException(400,
                    "unsupported_feature",
                    "Phase 1 streams through the Session events route.");
        }
        if (selection == null && request.skills() != null && !request.skills().isEmpty()) {
            throw new ManagedAgentException(400, "unsupported_feature",
                    "Session Skills require a bound Workspace.");
        }
        if (selection == null && request.extensionPins() != null) {
            throw new ManagedAgentException(400, "unsupported_feature", "Extension packages require a bound Workspace.");
        }
        var worktree = SessionWorktreeService.parse(request.worktree(), false);
        if (selection == null && worktree != null) {
            throw new ManagedAgentException(400, "unsupported_feature", "Session worktrees require a bound Workspace.");
        }
        // Resolve the recorded identity before the commit so a construction
        // error can never strand a Session the create just persisted; the
        // trusted boundary already rejected an unrepresentable subject.
        SessionPrincipal principal = tenant.subjectPrincipal();
        CommandAdmission admission = selection == null
                ? service.createSession(tenant.requirePrincipal(),
                        idempotencyKey, request.agentId(),
                        request.agentRevision(), null, request.metadata(),
                        request.input(), com.alibaba.qwen.code.managedagent.model.SessionModelConfig.parse(request.modelConfig()),
                        request.memoryStoreId())
                : service.createWorkspaceSession(tenant.tenantId(), tenant.requireActorId(), idempotencyKey,
                        request.agentId(), request.agentRevision(), null, request.metadata(), request.input(),
                        selection, null, null, request.skills(), null, request.extensionPins(), worktree,
                        com.alibaba.qwen.code.managedagent.model.SessionModelConfig.parse(request.modelConfig()), request.memoryStoreId());
        PublicSession session = principal == null
                ? service.getPublicSession(tenant.tenantId(),
                        tenant.actorId(), admission.sessionId())
                : service.getPublicSession(principal, admission.sessionId());
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .header("X-Qwen-Idempotent-Replay",
                        Boolean.toString(admission.replayed()))
                .body(session);
    }

    @GetMapping
    public PublicList<PublicSession> list(TenantContext tenant,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(name = "archive_state", required = false) String archiveState,
            @RequestParam(name = "title_query", required = false) String titleQuery) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.listPublicSessions(tenant.tenantId(),
                        tenant.actorId(), cursor, limit, archiveState,
                        titleQuery)
                : service.listPublicSessions(principal, cursor, limit,
                        archiveState, titleQuery);
    }

    @GetMapping("/{sessionId}")
    public PublicSession get(TenantContext tenant,
            @PathVariable String sessionId) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.getPublicSession(tenant.tenantId(),
                        tenant.actorId(), sessionId)
                : service.getPublicSession(principal, sessionId);
    }

    @GetMapping("/{sessionId}/recovery")
    public ResponseEntity<SessionRecovery> recovery(TenantContext tenant,
            @PathVariable String sessionId) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .body(principal == null
                        ? recovery.query(tenant.tenantId(),
                                tenant.actorId(), sessionId)
                        : recovery.query(principal, sessionId));
    }

    @PostMapping("/{sessionId}/recovery/recheck")
    public ResponseEntity<SessionRecovery> recheckRecovery(TenantContext tenant,
            @PathVariable String sessionId,
            @Valid @RequestBody RecoveryRecheckRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? recovery.recheck(tenant.tenantId(), tenant.actorId(),
                        sessionId, request.turnId())
                : recovery.recheck(principal, sessionId, request.turnId()));
    }

    @PatchMapping("/{sessionId}")
    public ResponseEntity<PublicSession> rename(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody UpdateSessionRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return mutation(principal == null
                ? service.renameSession(tenant.tenantId(), tenant.actorId(),
                        idempotencyKey, sessionId, request.title())
                : service.renameSession(principal, idempotencyKey, sessionId,
                        request.title()));
    }

    @PostMapping("/{sessionId}/close")
    public ResponseEntity<PublicCommandOperation> close(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        return operation(tenant, idempotencyKey, sessionId,
                OperationKind.CLOSE);
    }

    @PostMapping("/{sessionId}/archive")
    public ResponseEntity<PublicCommandOperation> archive(
            TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        return operation(tenant, idempotencyKey, sessionId,
                OperationKind.ARCHIVE);
    }

    @PostMapping("/{sessionId}/unarchive")
    public ResponseEntity<PublicSession> unarchive(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return mutation(principal == null
                ? service.unarchiveSession(tenant.tenantId(),
                        tenant.actorId(), idempotencyKey, sessionId)
                : service.unarchiveSession(principal, idempotencyKey,
                        sessionId));
    }

    @DeleteMapping("/{sessionId}")
    public ResponseEntity<PublicCommandOperation> delete(
            TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        return operation(tenant, idempotencyKey, sessionId,
                OperationKind.DELETE);
    }

    @GetMapping("/{sessionId}/operations/{operationId}")
    public Object getOperation(TenantContext tenant,
            @PathVariable String sessionId,
            @PathVariable String operationId) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? lifecycle.getPublicOperation(tenant.tenantId(),
                        tenant.actorId(), sessionId, operationId)
                : lifecycle.getPublicOperation(principal, sessionId,
                        operationId);
    }

    @PostMapping("/{sessionId}/compress")
    public ResponseEntity<PublicContextCompressionOperation> compress(
            TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CompressSessionRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? compressions.admitPublic(tenant.tenantId(),
                        tenant.actorId(), sessionId, idempotencyKey,
                        request.expectedCompactionRevision())
                : compressions.admitPublic(principal, sessionId,
                        idempotencyKey,
                        request.expectedCompactionRevision()));
    }

    @PostMapping("/{sessionId}/events")
    public ResponseEntity<CommandAdmission> postEvent(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody SessionEventRequest request) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        CommandAdmission admission;
        if ("agent.session.input.message".equals(request.type())) {
            admission = principal == null
                    ? service.submitTurn(tenant.tenantId(), tenant.actorId(),
                            idempotencyKey, sessionId, request.input())
                    : service.submitTurn(principal, idempotencyKey, sessionId,
                            request.input());
        } else if ("agent.session.cancel".equals(request.type())) {
            if (request.turnId() == null || request.turnId().isBlank()) {
                throw new ManagedAgentException(400,
                        "turn_id_required",
                        "Cancellation requires turn_id.");
            }
            admission = principal == null
                    ? service.cancelTurn(tenant.tenantId(), tenant.actorId(),
                            idempotencyKey, sessionId, request.turnId())
                    : service.cancelTurn(principal, idempotencyKey, sessionId,
                            request.turnId());
        } else {
            throw new ManagedAgentException(400,
                    "unsupported_event",
                    "Phase 1 accepts input message and cancellation events.");
        }
        return ResponseEntity.accepted().body(admission);
    }

    @GetMapping(value = "/{sessionId}/events",
            produces = {MediaType.APPLICATION_JSON_VALUE,
                    MediaType.TEXT_EVENT_STREAM_VALUE})
    public Object events(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(defaultValue = "false") boolean stream,
            @RequestParam(defaultValue = "0") long after,
            @RequestParam(defaultValue = "100") int limit,
            @RequestHeader(value = "Last-Event-ID", required = false)
                    String lastEventId,
            @RequestHeader(value = HttpHeaders.ACCEPT, required = false)
                    String accept) {
        long cursor = parseSequence(lastEventId, after);
        boolean wantsStream = stream || (accept != null
                && accept.contains(MediaType.TEXT_EVENT_STREAM_VALUE));
        SessionPrincipal principal = tenant.subjectPrincipal();
        if (wantsStream) {
            return principal == null
                    ? streams.publicStream(tenant.tenantId(),
                            tenant.actorId(), sessionId, cursor)
                    : streams.publicStream(principal, sessionId, cursor);
        }
        return principal == null
                ? service.publicEvents(tenant.tenantId(), tenant.actorId(),
                        sessionId, cursor, limit)
                : service.publicEvents(principal, sessionId, cursor, limit);
    }

    @GetMapping("/{sessionId}/items")
    public PublicItemList items(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(defaultValue = "0") String after,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        long sequence = 0;
        if (cursor == null && after.matches("-?[0-9]+")) {
            try {
                sequence = Long.parseLong(after);
            } catch (NumberFormatException error) {
                throw new ManagedAgentException(
                        400,
                        "invalid_event_cursor",
                        "Item sequence is invalid.");
            }
        } else if (cursor == null) {
            cursor = after;
        }
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.listPublicItems(tenant.tenantId(), tenant.actorId(),
                        sessionId, cursor, sequence, limit)
                : service.listPublicItems(principal, sessionId, cursor,
                        sequence, limit);
    }

    @GetMapping("/{sessionId}/turns")
    public PublicList<PublicTurn> turns(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.listPublicTurns(tenant.tenantId(),
                        tenant.actorId(), sessionId, cursor, limit)
                : service.listPublicTurns(principal, sessionId, cursor,
                        limit);
    }

    @GetMapping("/{sessionId}/turns/{turnId}")
    public PublicTurn turn(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String turnId) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? service.getPublicTurn(tenant.tenantId(), tenant.actorId(),
                        sessionId, turnId)
                : service.getPublicTurn(principal, sessionId, turnId);
    }

    @GetMapping("/{sessionId}/tasks")
    public PublicList<PublicTask> tasks(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? tasks.listPublicTasks(tenant.tenantId(), tenant.actorId(),
                        sessionId, cursor, limit)
                : tasks.listPublicTasks(principal, sessionId, cursor, limit);
    }

    @GetMapping("/{sessionId}/tasks/{taskId}")
    public PublicTask task(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String taskId) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? tasks.getPublicTask(tenant.tenantId(), tenant.actorId(),
                        sessionId, taskId)
                : tasks.getPublicTask(principal, sessionId, taskId);
    }

    @GetMapping("/{sessionId}/tasks/{taskId}/events")
    public PublicList<PublicTaskEvent> taskEvents(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String taskId,
            @RequestParam(required = false) String after,
            @RequestParam(defaultValue = "20") int limit) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return principal == null
                ? tasks.listPublicTaskEvents(tenant.tenantId(),
                        tenant.actorId(), sessionId, taskId, after, limit)
                : tasks.listPublicTaskEvents(principal, sessionId, taskId,
                        after, limit);
    }

    @PostMapping("/{sessionId}/tasks/{taskId}/cancel")
    public ResponseEntity<PublicCommandOperation> cancelTask(
            TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String taskId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? taskCancels.cancelPublic(tenant.tenantId(),
                        tenant.actorId(), idempotencyKey, sessionId, taskId)
                : taskCancels.cancelPublic(principal, idempotencyKey,
                        sessionId, taskId));
    }

    private static long parseSequence(String header, long fallback) {
        if (StringUtils.isBlank(header)) {
            return fallback;
        }
        try {
            long value = Long.parseLong(header);
            if (value < 0) {
                throw new NumberFormatException();
            }
            return value;
        } catch (NumberFormatException error) {
            throw new ManagedAgentException(400,
                    "invalid_event_cursor", "Last-Event-ID is invalid.");
        }
    }

    private ResponseEntity<PublicCommandOperation> operation(
            TenantContext tenant, String idempotencyKey, String sessionId,
            OperationKind kind) {
        SessionPrincipal principal = tenant.subjectPrincipal();
        return ResponseEntity.accepted().body(principal == null
                ? lifecycle.admitPublic(tenant.tenantId(), tenant.actorId(),
                        idempotencyKey, sessionId, kind)
                : lifecycle.admitPublic(principal, idempotencyKey, sessionId,
                        kind));
    }

    private static ResponseEntity<PublicSession> mutation(
            SessionMutationResult<PublicSession> result) {
        return ResponseEntity.ok()
                .header("X-Qwen-Idempotent-Replay",
                        Boolean.toString(result.replayed()))
                .body(result.body());
    }
}
