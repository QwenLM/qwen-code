package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.AgentDefinition;
import com.alibaba.qwen.code.managedagent.api.ApiModels.AgentDefinitionRequest;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentDefinitionService;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentDefinitionService.Result;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Public AgentDefinition routes (D8a): immutable, tenant-scoped revisions. */
@RestController
@RequestMapping("/v1/agents")
public class AgentDefinitionController {
    private final ManagedAgentDefinitionService definitions;

    public AgentDefinitionController(
            ManagedAgentDefinitionService definitions) {
        this.definitions = definitions;
    }

    @PostMapping
    public ResponseEntity<AgentDefinition> create(TenantContext tenant,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody AgentDefinitionRequest request) {
        return accepted(definitions.create(tenant.tenantId(), idempotencyKey,
                request));
    }

    @GetMapping("/{agentId}")
    public AgentDefinition get(TenantContext tenant,
            @PathVariable String agentId,
            @RequestParam(required = false) String revision) {
        return definitions.get(tenant.tenantId(), agentId, revision);
    }

    @PostMapping("/{agentId}")
    public ResponseEntity<AgentDefinition> update(TenantContext tenant,
            @PathVariable String agentId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody AgentDefinitionRequest request) {
        return accepted(definitions.update(tenant.tenantId(), agentId,
                idempotencyKey, request));
    }

    private static ResponseEntity<AgentDefinition> accepted(Result result) {
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .header("X-Qwen-Idempotent-Replay",
                        Boolean.toString(result.replayed()))
                .body(result.definition());
    }
}
