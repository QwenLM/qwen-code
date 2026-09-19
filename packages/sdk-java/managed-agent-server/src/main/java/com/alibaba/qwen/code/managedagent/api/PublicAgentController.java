package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CreateSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionEventRequest;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.ManagedEventStreamService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
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

    public PublicAgentController(ManagedAgentService service,
            ManagedEventStreamService streams) {
        this.service = service;
        this.streams = streams;
    }

    @PostMapping
    public ResponseEntity<PublicSession> create(TenantContext tenant,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CreateSessionRequest request) {
        if (Boolean.TRUE.equals(request.stream())) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "unsupported_feature",
                    "Phase 1 streams through the Session events route.");
        }
        CommandAdmission admission = service.createSession(
                tenant.tenantId(), idempotencyKey, request.agentId(), null,
                request.metadata(), request.input());
        PublicSession session = service.getPublicSession(tenant.tenantId(),
                admission.sessionId());
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .header("X-Qwen-Idempotent-Replay",
                        Boolean.toString(admission.replayed()))
                .body(session);
    }

    @GetMapping
    public PublicList<PublicSession> list(TenantContext tenant,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return service.listPublicSessions(tenant.tenantId(), cursor, limit);
    }

    @GetMapping("/{sessionId}")
    public PublicSession get(TenantContext tenant,
            @PathVariable String sessionId) {
        return service.getPublicSession(tenant.tenantId(), sessionId);
    }

    @PostMapping("/{sessionId}/events")
    public ResponseEntity<CommandAdmission> postEvent(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody SessionEventRequest request) {
        CommandAdmission admission;
        if ("agent.session.input.message".equals(request.type())) {
            admission = service.submitTurn(tenant.tenantId(),
                    idempotencyKey, sessionId, request.input());
        } else if ("agent.session.cancel".equals(request.type())) {
            if (request.turnId() == null || request.turnId().isBlank()) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "turn_id_required",
                        "Cancellation requires turn_id.");
            }
            admission = service.cancelTurn(tenant.tenantId(),
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
            return streams.publicStream(tenant.tenantId(), sessionId,
                    cursor);
        }
        List<PublicEvent> events = service.publicEvents(tenant.tenantId(),
                sessionId, cursor, limit);
        return new PublicList<>("list", events, false, null);
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
}
