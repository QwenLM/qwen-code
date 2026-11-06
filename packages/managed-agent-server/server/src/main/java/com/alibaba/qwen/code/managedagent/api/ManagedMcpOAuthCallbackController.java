package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.extensions.ManagedMcpOAuthService;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedMcpOAuthCallbackController {
    private final ManagedMcpOAuthService service;

    public ManagedMcpOAuthCallbackController(ManagedMcpOAuthService service) {
        this.service = service;
    }

    @GetMapping("/oauth/mcp/callback")
    public ResponseEntity<String> callback(
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String iss,
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String error) {
        boolean accepted;
        try {
            if (error == null) {
                service.callback(state, iss, code);
            } else service.callbackFailure(state);
            accepted = true;
        } catch (ManagedAgentException invalid) {
            accepted = false;
        }
        return ResponseEntity.status(accepted ? 200 : 400)
                .cacheControl(CacheControl.noStore())
                .header("Referrer-Policy", "no-referrer")
                .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
                .contentType(MediaType.TEXT_HTML)
                .body(
                        "<!doctype html><meta charset=utf-8><title>MCP"
                            + " authorization</title><p>Return to the original Managed Agent page"
                            + " to complete authorization. You may close this window.</p>");
    }
}
