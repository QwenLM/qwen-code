package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.session.ClientFilesRelayService;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.concurrent.CompletableFuture;

/**
 * Runtime-facing Streamable HTTP MCP endpoint of the client files relay.
 * Internal surface only: the routing filter keeps it on the internal
 * listener, and the session relay credential issued at registration is the
 * only admission. The payload is opaque JSON-RPC forwarded to the browser.
 */
@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.client-files", name = "enabled", havingValue = "true")
@RequestMapping("/internal/managed-client-files/v1/sessions/{sessionId}")
public class ClientFilesMcpController {
    private static final String BEARER = "Bearer ";
    private final ClientFilesRelayService service;

    public ClientFilesMcpController(ClientFilesRelayService service) {
        this.service = service;
    }

    @PostMapping(value = "/mcp", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public DeferredResult<ResponseEntity<String>> mcp(@PathVariable String sessionId,
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody String body) {
        String token = authorization != null && authorization.startsWith(BEARER)
                ? authorization.substring(BEARER.length()).trim() : null;
        // The wait runs on the service's shared poller, not a servlet thread;
        // validation refusals still throw synchronously into the exception
        // handler. The timeout is a safety net — the request TTL settles the
        // future first.
        CompletableFuture<String> pending = service.mcpSession(sessionId, token, body);
        DeferredResult<ResponseEntity<String>> result = new DeferredResult<>(300_000L);
        pending.whenComplete((response, failure) -> {
            if (failure != null) {
                result.setErrorResult(failure);
            } else if (response == null) {
                result.setResult(ResponseEntity.accepted().cacheControl(CacheControl.noStore()).build());
            } else {
                result.setResult(ResponseEntity.ok().cacheControl(CacheControl.noStore())
                        .contentType(MediaType.APPLICATION_JSON).body(response));
            }
        });
        result.onTimeout(() -> result.setErrorResult(ResponseEntity.status(503)
                .cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_JSON)
                .body("{\"error\":{\"code\":\"client_files_relay_unavailable\"}}")));
        return result;
    }
}
