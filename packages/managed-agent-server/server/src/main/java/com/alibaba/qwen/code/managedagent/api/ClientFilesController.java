package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.RegisterRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Registration;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.RegistrationAck;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.RespondRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Status;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.StatusRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.StreamRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.UnregisterRequest;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ClientFilesRelayService;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.apache.commons.lang3.StringUtils;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Browser-facing client filesystem relay endpoints. The browser registers its
 * grant here, drains JSON-RPC requests over SSE and posts responses back; the
 * Runtime leg is the separate internal MCP endpoint.
 */
@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.client-files", name = "enabled", havingValue = "true")
public class ClientFilesController {
    private static final String WEB_SHELL_PREFIX = "/api/agent/web-shell/v1/client-files";
    private final ClientFilesRelayService service;
    /** One live downlink per (tenant, actor, Session); a new stream replaces it. */
    private final ConcurrentHashMap<String, SseEmitter> streams = new ConcurrentHashMap<>();

    public ClientFilesController(ClientFilesRelayService service) {
        this.service = service;
    }

    @PostMapping(WEB_SHELL_PREFIX + "/register")
    public ResponseEntity<RegistrationAck> register(TenantContext tenant,
            @RequestBody RegisterRequest request) {
        Registration registration = service.register(tenant.tenantId(), tenant.requireActorId(),
                request.sessionId(), request.connectionId());
        // The relay token stays on the server-to-harness path; the browser ack
        // carries only the fields the bridge correlates on.
        return noStore(new RegistrationAck(registration.serverId(), registration.generation(),
                registration.expiresAt(), registration.toolCount(), registration.connectionId()));
    }

    @PostMapping(WEB_SHELL_PREFIX + "/unregister")
    public ResponseEntity<Status> unregister(TenantContext tenant,
            @RequestBody UnregisterRequest request) {
        return noStore(service.unregister(tenant.tenantId(), tenant.requireActorId(),
                request.sessionId(), request.connectionId()));
    }

    @PostMapping(WEB_SHELL_PREFIX + "/status")
    public ResponseEntity<Status> status(TenantContext tenant,
            @RequestBody StatusRequest request) {
        return noStore(service.status(tenant.tenantId(), tenant.requireActorId(),
                request.sessionId(), request.connectionId()));
    }

    @PostMapping(value = WEB_SHELL_PREFIX + "/requests/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> stream(TenantContext tenant,
            @RequestBody StreamRequest request) {
        String actor = tenant.requireActorId();
        return openStream(tenant.tenantId(), actor, request.sessionId(),
                request.generation(), request.connectionId(), false);
    }

    @PostMapping(WEB_SHELL_PREFIX + "/responses")
    public ResponseEntity<Map<String, Boolean>> respond(TenantContext tenant,
            @RequestBody RespondRequest request) {
        service.respond(tenant.tenantId(), tenant.requireActorId(), request.sessionId(),
                request.generation(), request.connectionId(), request.rpcRequestId(),
                request.responseJson(), request.errorCode());
        return noStore(Map.of("settled", true));
    }

    @PostMapping("/v1/agents/sessions/{sessionId}/client-files/register")
    public ResponseEntity<PublicRegistrationAck> publicRegister(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestBody(required = false) PublicConnectionRequest request) {
        Registration registration = service.register(tenant.tenantId(), tenant.requireActorId(),
                sessionId, request == null ? null : request.connectionId());
        return noStore(new PublicRegistrationAck(registration.serverId(), registration.generation(),
                registration.expiresAt(), registration.toolCount(), registration.connectionId()));
    }

    @PostMapping("/v1/agents/sessions/{sessionId}/client-files/unregister")
    public ResponseEntity<PublicStatus> publicUnregister(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestBody(required = false) PublicConnectionRequest request) {
        return noStore(PublicStatus.from(service.unregister(tenant.tenantId(), tenant.requireActorId(),
                sessionId, request == null ? null : request.connectionId())));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/client-files")
    public ResponseEntity<PublicStatus> publicStatus(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(name = "connection_id", required = false) String connectionId) {
        return noStore(PublicStatus.from(service.status(tenant.tenantId(), tenant.requireActorId(),
                sessionId, connectionId)));
    }

    @GetMapping(value = "/v1/agents/sessions/{sessionId}/client-files/requests",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> publicStream(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestParam(required = false) Long generation,
            @RequestParam(name = "connection_id", required = false) String connectionId) {
        String actor = tenant.requireActorId();
        if (generation == null || StringUtils.isBlank(connectionId)) {
            throw new ManagedAgentException(400, "invalid_request",
                    "generation and connection_id are required.");
        }
        return openStream(tenant.tenantId(), actor, sessionId, generation, connectionId, true);
    }

    @PostMapping("/v1/agents/sessions/{sessionId}/client-files/responses")
    public ResponseEntity<Map<String, Boolean>> publicRespond(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestBody PublicRespondRequest request) {
        service.respond(tenant.tenantId(), tenant.requireActorId(), sessionId,
                request.generation(), request.connectionId(), request.rpcRequestId(),
                request.responseJson(), request.errorCode());
        return noStore(Map.of("settled", true));
    }

    private ResponseEntity<SseEmitter> openStream(String tenantId, String actor, String session,
            long generation, String connectionId, boolean snakeCase) {
        service.requireStreamConnection(tenantId, actor, session, generation, connectionId);
        var emitter = new SseEmitter(300_000L);
        var open = new AtomicBoolean(true);
        // Single owner per (tenant, actor, Session): a reconnect replaces the
        // previous downlink instead of running a second poll loop that would
        // deliver the same queued request twice. Completing the old emitter
        // runs its onCompletion (not onError), so it does not close the binding.
        String ownerKey = tenantId + "|" + actor + "|" + session;
        SseEmitter previous = streams.put(ownerKey, emitter);
        if (previous != null) {
            previous.complete();
        }
        emitter.onCompletion(() -> {
            open.set(false);
            streams.remove(ownerKey, emitter);
        });
        // An idle timeout is a clean end: the binding stays active and the
        // bridge reopens the stream. Only a dropped/errored connection tears
        // the registration down.
        emitter.onTimeout(() -> open.set(false));
        emitter.onError(error -> {
            open.set(false);
            service.streamClosed(tenantId, actor, session, generation);
        });
        Thread.startVirtualThread(() -> {
            Set<String> sent = new HashSet<>();
            try {
                while (open.get()) {
                    List<QueuedRequest> rows = service.requests(tenantId, actor, session, generation);
                    Set<String> live = new HashSet<>();
                    for (QueuedRequest row : rows) {
                        live.add(row.requestId());
                        if (sent.add(row.requestId())) {
                            Map<String, String> payload = snakeCase
                                    ? Map.of("request_id", row.requestId(), "payload_json", row.payloadJson())
                                    : Map.of("requestId", row.requestId(), "payloadJson", row.payloadJson());
                            emitter.send(SseEmitter.event().name("request").id(row.requestId()).data(payload));
                        }
                    }
                    // Settled ids never reappear in the queue; keep the dedup
                    // set bounded to the currently queued requests.
                    sent.retainAll(live);
                    Thread.sleep(500);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                emitter.complete();
            } catch (IOException | RuntimeException ended) {
                emitter.completeWithError(ended);
            }
        });
        return noStore(emitter);
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate()).body(body);
    }

    public record PublicConnectionRequest(@JsonProperty("connection_id") String connectionId) {}

    public record PublicRegistrationAck(
            @JsonProperty("server_id") String serverId,
            long generation,
            @JsonProperty("expires_at") long expiresAt,
            @JsonProperty("tool_count") int toolCount,
            @JsonProperty("connection_id") String connectionId) {}

    public record PublicStatus(
            @JsonProperty("server_id") String serverId,
            long generation,
            String state,
            @JsonProperty("expires_at") long expiresAt,
            @JsonProperty("connection_id") String connectionId,
            boolean owned) {
        static PublicStatus from(Status status) {
            if (status == null) {
                return null;
            }
            return new PublicStatus(status.serverId(), status.generation(), status.state(),
                    status.expiresAt(), status.connectionId(), status.owned());
        }
    }

    public record PublicRespondRequest(
            long generation,
            @JsonProperty("connection_id") String connectionId,
            @JsonProperty("rpc_request_id") String rpcRequestId,
            @JsonProperty("response_json") String responseJson,
            @JsonProperty("error_code") String errorCode) {}
}
