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
    public ResponseEntity<String> mcp(@PathVariable String sessionId,
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody String body) {
        String token = authorization != null && authorization.startsWith(BEARER)
                ? authorization.substring(BEARER.length()).trim() : null;
        String response = service.mcpSession(sessionId, token, body);
        if (response == null) {
            return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).build();
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .contentType(MediaType.APPLICATION_JSON).body(response);
    }
}
