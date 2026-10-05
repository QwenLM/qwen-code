package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CreateSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTask;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionEventRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.UpdateSessionRequest;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService.SessionMutationResult;
import com.alibaba.qwen.code.managedagent.service.ManagedEventStreamService;
import com.alibaba.qwen.code.managedagent.service.ManagedTaskService;
import com.alibaba.qwen.code.managedagent.service.SessionLifecycleService;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import jakarta.validation.Valid;
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

    public PublicAgentController(ManagedAgentService service,
            ManagedEventStreamService streams,
            SessionLifecycleService lifecycle, ManagedTaskService tasks) {
        this.service = service;
        this.streams = streams;
        this.lifecycle = lifecycle;
        this.tasks = tasks;
    }

    @PostMapping
    public ResponseEntity<PublicSession> create(TenantContext tenant,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CreateSessionRequest request) {
        WorkspaceSelection selection = null;
        if (request.workspace() != null) {
            if (request.workspace().isNull()) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "invalid_request", "Workspace cannot be null.");
            }
            selection = WorkspaceSelection.parse(request.workspace(), false);
            tenant.requireActorId();
        }
        if (Boolean.TRUE.equals(request.stream())) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature",
                    "Phase 1 streams through the Session events route.");
        }
        CommandAdmission admission = selection == null
                ? service.createSession(tenant.tenantId(), tenant.actorId(),
                        idempotencyKey, request.agentId(),
                        request.agentRevision(), null, request.metadata(),
                        request.input())
                : service.createWorkspaceSession(tenant.tenantId(),
                        tenant.requireActorId(), idempotencyKey,
                        request.agentId(), request.agentRevision(), null,
                        request.metadata(), request.input(), selection);
        PublicSession session = service.getPublicSession(tenant.tenantId(),
                tenant.actorId(), admission.sessionId());
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .header("X-Qwen-Idempotent-Replay",
                        Boolean.toString(admission.replayed()))
                .body(session);
    }

    @GetMapping
    public PublicList<PublicSession> list(TenantContext tenant,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return service.listPublicSessions(tenant.tenantId(), tenant.actorId(),
                cursor, limit);
    }

    @GetMapping("/{sessionId}")
    public PublicSession get(TenantContext tenant,
            @PathVariable String sessionId) {
        return service.getPublicSession(tenant.tenantId(),
                tenant.actorId(), sessionId);
    }

    @PatchMapping("/{sessionId}")
    public ResponseEntity<PublicSession> rename(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody UpdateSessionRequest request) {
        return mutation(service.renameSession(tenant.tenantId(), tenant.actorId(),
                idempotencyKey, sessionId, request.title()));
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
        return mutation(service.unarchiveSession(tenant.tenantId(), tenant.actorId(),
                idempotencyKey, sessionId));
    }

    @DeleteMapping("/{sessionId}")
    public ResponseEntity<PublicCommandOperation> delete(
            TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        return operation(tenant, idempotencyKey, sessionId,
                OperationKind.DELETE);
    }

    @GetMapping("/{sessionId}/operations/{operationId}")
    public PublicCommandOperation getOperation(TenantContext tenant,
            @PathVariable String sessionId,
            @PathVariable String operationId) {
        return lifecycle.getPublic(tenant.tenantId(), tenant.actorId(),
                sessionId, operationId);
    }

    @PostMapping("/{sessionId}/events")
    public ResponseEntity<CommandAdmission> postEvent(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody SessionEventRequest request) {
        CommandAdmission admission;
        if ("agent.session.input.message".equals(request.type())) {
            admission = service.submitTurn(tenant.tenantId(), tenant.actorId(),
                    idempotencyKey, sessionId, request.input());
        } else if ("agent.session.cancel".equals(request.type())) {
            if (request.turnId() == null || request.turnId().isBlank()) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "turn_id_required",
                        "Cancellation requires turn_id.");
            }
            admission = service.cancelTurn(tenant.tenantId(), tenant.actorId(),
                    idempotencyKey, sessionId, request.turnId());
        } else {
            throw new ApiException(HttpStatus.BAD_REQUEST,
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
        if (wantsStream) {
            return streams.publicStream(tenant.tenantId(), tenant.actorId(),
                    sessionId, cursor);
        }
        return service.publicEvents(tenant.tenantId(), tenant.actorId(),
                sessionId, cursor, limit);
    }

    @GetMapping("/{sessionId}/items")
    public PublicItemList items(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(defaultValue = "0") long after,
            @RequestParam(defaultValue = "20") int limit) {
        return service.listPublicItems(tenant.tenantId(), tenant.actorId(),
                sessionId, after, limit);
    }

    @GetMapping("/{sessionId}/turns")
    public PublicList<PublicTurn> turns(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return service.listPublicTurns(tenant.tenantId(), tenant.actorId(),
                sessionId, cursor, limit);
    }

    @GetMapping("/{sessionId}/turns/{turnId}")
    public PublicTurn turn(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String turnId) {
        return service.getPublicTurn(tenant.tenantId(), tenant.actorId(),
                sessionId, turnId);
    }

    @GetMapping("/{sessionId}/tasks")
    public PublicList<PublicTask> tasks(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return tasks.listPublicTasks(tenant.tenantId(), tenant.actorId(),
                sessionId, cursor, limit);
    }

    @GetMapping("/{sessionId}/tasks/{taskId}")
    public PublicTask task(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String taskId) {
        return tasks.getPublicTask(tenant.tenantId(), tenant.actorId(),
                sessionId, taskId);
    }

    private static long parseSequence(String header, long fallback) {
        if (header == null || header.isBlank()) {
            return fallback;
        }
        try {
            long value = Long.parseLong(header);
            if (value < 0) {
                throw new NumberFormatException();
            }
            return value;
        } catch (NumberFormatException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_event_cursor", "Last-Event-ID is invalid.");
        }
    }

    private ResponseEntity<PublicCommandOperation> operation(
            TenantContext tenant, String idempotencyKey, String sessionId,
            OperationKind kind) {
        return ResponseEntity.accepted().body(lifecycle.admitPublic(
                tenant.tenantId(), tenant.actorId(), idempotencyKey,
                sessionId, kind));
    }

    private static ResponseEntity<PublicSession> mutation(
            SessionMutationResult<PublicSession> result) {
        return ResponseEntity.ok()
                .header("X-Qwen-Idempotent-Replay",
                        Boolean.toString(result.replayed()))
                .body(result.body());
    }
}
