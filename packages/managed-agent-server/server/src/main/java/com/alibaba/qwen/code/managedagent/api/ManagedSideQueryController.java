package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.model.SideQueryApiModels;
import com.alibaba.qwen.code.managedagent.model.SideQueryApiModels.PublicContext;
import com.alibaba.qwen.code.managedagent.model.SideQueryApiModels.PublicPage;
import com.alibaba.qwen.code.managedagent.model.SideQueryApiModels.PublicQuery;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ManagedSideQueryService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
public class ManagedSideQueryController {
    private final ManagedSideQueryService service;

    public ManagedSideQueryController(ManagedSideQueryService service) { this.service = service; }

    @PostMapping("/v1/agents/sessions/{sessionId}/side-queries")
    public ResponseEntity<PublicQuery> create(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String key, @Valid @RequestBody SideQueryApiModels.PublicCreate request) {
        return noStore(PublicQuery.from(service.create(tenant.tenantId(), tenant.requireActorId(), sessionId, request.command(key))));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/side-queries/context")
    public ResponseEntity<PublicContext> context(TenantContext tenant, @PathVariable String sessionId) {
        return noStore(PublicContext.from(service.context(tenant.tenantId(), tenant.requireActorId(), sessionId)));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/side-queries")
    public ResponseEntity<PublicPage> list(TenantContext tenant, @PathVariable String sessionId,
            @RequestParam(required = false) String cursor, @RequestParam(defaultValue = "20") int limit) {
        return noStore(PublicPage.from(service.list(tenant.tenantId(), tenant.requireActorId(), sessionId, cursor, limit)));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/side-queries/{queryId}")
    public ResponseEntity<PublicQuery> get(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId) {
        return noStore(PublicQuery.from(service.get(tenant.tenantId(), tenant.requireActorId(), sessionId, queryId)));
    }

    @PostMapping("/v1/agents/sessions/{sessionId}/side-queries/{queryId}/cancel")
    public ResponseEntity<PublicQuery> cancel(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId) {
        return noStore(PublicQuery.from(service.cancel(tenant.tenantId(), tenant.requireActorId(), sessionId, queryId)));
    }

    @GetMapping(value = "/v1/agents/sessions/{sessionId}/side-queries/{queryId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> events(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId) {
        return noStore(stream(tenant, sessionId, queryId, true));
    }

    @PostMapping("/api/agent/web-shell/v1/session-side-queries/create")
    public ResponseEntity<ManagedSideQueryModels.Query> createWebShell(TenantContext tenant,
            @Valid @RequestBody SideQueryApiModels.WebShellCreate request) {
        return noStore(service.create(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.command()));
    }

    @PostMapping("/api/agent/web-shell/v1/session-side-queries/context")
    public ResponseEntity<ManagedSideQueryModels.Context> contextWebShell(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        return noStore(service.context(tenant.tenantId(), tenant.requireActorId(), request.sessionId()));
    }

    @PostMapping("/api/agent/web-shell/v1/session-side-queries/list")
    public ResponseEntity<ManagedSideQueryModels.Page> listWebShell(TenantContext tenant,
            @Valid @RequestBody SideQueryApiModels.WebShellList request) {
        return noStore(service.list(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.cursor(),
                request.limit() == null ? 20 : request.limit()));
    }

    @PostMapping("/api/agent/web-shell/v1/session-side-queries/get")
    public ResponseEntity<ManagedSideQueryModels.Query> getWebShell(TenantContext tenant,
            @Valid @RequestBody SideQueryApiModels.WebShellQuery request) {
        return noStore(service.get(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.queryId()));
    }

    @PostMapping("/api/agent/web-shell/v1/session-side-queries/cancel")
    public ResponseEntity<ManagedSideQueryModels.Query> cancelWebShell(TenantContext tenant,
            @Valid @RequestBody SideQueryApiModels.WebShellQuery request) {
        return noStore(service.cancel(tenant.tenantId(), tenant.requireActorId(), request.sessionId(), request.queryId()));
    }

    @PostMapping(value = "/api/agent/web-shell/v1/session-side-queries/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> streamWebShell(TenantContext tenant,
            @Valid @RequestBody SideQueryApiModels.WebShellQuery request) {
        return noStore(stream(tenant, request.sessionId(), request.queryId(), false));
    }

    private SseEmitter stream(TenantContext tenant, String session, String query, boolean publicWire) {
        String actor = tenant.requireActorId();
        service.get(tenant.tenantId(), actor, session, query);
        var emitter = new SseEmitter(300_000L);
        var open = new AtomicBoolean(true);
        emitter.onCompletion(() -> open.set(false));
        emitter.onTimeout(() -> open.set(false));
        emitter.onError(error -> open.set(false));
        Thread.startVirtualThread(() -> {
            long revision = -1;
            try {
                while (open.get()) {
                    var snapshot = service.get(tenant.tenantId(), actor, session, query);
                    if (snapshot.resultRevision() > revision) {
                        emitter.send(SseEmitter.event().name("snapshot").id(Long.toString(snapshot.resultRevision()))
                                .data(publicWire ? PublicQuery.from(snapshot) : snapshot));
                        revision = snapshot.resultRevision();
                    }
                    if (snapshot.terminal()) {
                        emitter.complete();
                        return;
                    }
                    Thread.sleep(1000);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                emitter.complete();
            } catch (IOException | RuntimeException ended) {
                emitter.completeWithError(ended);
            }
        });
        return emitter;
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate()).body(body);
    }
}
