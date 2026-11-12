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
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ClientFilesRelayService;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * WebShell leg of the client files relay. The browser registers its directory
 * grant here, drains JSON-RPC requests over SSE and posts responses back; the
 * Runtime leg is the separate internal MCP endpoint.
 */
@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.client-files", name = "enabled", havingValue = "true")
@RequestMapping("/api/agent/web-shell/v1/client-files")
public class ClientFilesController {
    private final ClientFilesRelayService service;
    /** One live downlink per (tenant, actor, Session); a new stream replaces it. */
    private final java.util.concurrent.ConcurrentHashMap<String, SseEmitter> streams =
            new java.util.concurrent.ConcurrentHashMap<>();

    public ClientFilesController(ClientFilesRelayService service) {
        this.service = service;
    }

    @PostMapping("/register")
    public ResponseEntity<RegistrationAck> register(TenantContext tenant,
            @RequestBody RegisterRequest request) {
        Registration registration = service.register(tenant.tenantId(), tenant.requireActorId(),
                request.sessionId(), request.connectionId());
        // The relay token stays on the server-to-harness path; the browser ack
        // carries only the fields the bridge correlates on.
        return noStore(new RegistrationAck(registration.serverId(), registration.generation(),
                registration.expiresAt(), registration.toolCount(), registration.connectionId()));
    }

    @PostMapping("/unregister")
    public ResponseEntity<Status> unregister(TenantContext tenant,
            @RequestBody UnregisterRequest request) {
        return noStore(service.unregister(tenant.tenantId(), tenant.requireActorId(),
                request.sessionId(), request.connectionId()));
    }

    @PostMapping("/status")
    public ResponseEntity<Status> status(TenantContext tenant,
            @RequestBody StatusRequest request) {
        return noStore(service.status(tenant.tenantId(), tenant.requireActorId(),
                request.sessionId(), request.connectionId()));
    }

    @PostMapping(value = "/requests/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> stream(TenantContext tenant,
            @RequestBody StreamRequest request) {
        String actor = tenant.requireActorId();
        String session = request.sessionId();
        long generation = request.generation();
        service.requireStreamConnection(tenant.tenantId(), actor, session, generation,
                request.connectionId());
        var emitter = new SseEmitter(300_000L);
        var open = new AtomicBoolean(true);
        // Single owner per (tenant, actor, Session): a reconnect replaces the
        // previous downlink instead of running a second poll loop that would
        // deliver the same queued request twice. Completing the old emitter
        // runs its onCompletion (not onError), so it does not close the binding.
        String ownerKey = tenant.tenantId() + "|" + actor + "|" + session;
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
            service.streamClosed(tenant.tenantId(), actor, session, generation);
        });
        Thread.startVirtualThread(() -> {
            Set<String> sent = new HashSet<>();
            try {
                while (open.get()) {
                    List<QueuedRequest> rows = service.requests(tenant.tenantId(), actor, session, generation);
                    Set<String> live = new HashSet<>();
                    for (QueuedRequest row : rows) {
                        live.add(row.requestId());
                        if (sent.add(row.requestId())) {
                            emitter.send(SseEmitter.event().name("request").id(row.requestId())
                                    .data(Map.of("requestId", row.requestId(), "payloadJson", row.payloadJson())));
                        }
                    }
                    // Settled ids never reappear in the queue; keep the dedup
                    // set bounded by the live queue instead of the session.
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

    @PostMapping("/responses")
    public ResponseEntity<Map<String, Boolean>> respond(TenantContext tenant,
            @RequestBody RespondRequest request) {
        service.respond(tenant.tenantId(), tenant.requireActorId(), request.sessionId(),
                request.generation(), request.connectionId(), request.rpcRequestId(),
                request.responseJson(), request.errorCode());
        return noStore(Map.of("settled", true));
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate()).body(body);
    }
}
