package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.artifact.ManagedToolDetailsService;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellToolDetails;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellToolResultRequest;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedToolDetailsController {
    private final ManagedToolDetailsService service;

    public ManagedToolDetailsController(ManagedToolDetailsService service) {
        this.service = service;
    }

    @PostMapping("/api/agent/web-shell/v1/tool-details/get")
    public ResponseEntity<WebShellToolDetails> get(TenantContext tenant,
            @Valid @RequestBody WebShellToolResultRequest request) {
        return ResponseEntity.ok().header("Cache-Control", "private, no-store")
                .body(service.get(tenant, request.sessionId(), request.itemId()));
    }
}
