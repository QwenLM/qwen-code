package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.memory.ManagedMemoryService;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ManagedMemorySessionController {
    private final ManagedMemoryService service;

    public ManagedMemorySessionController(ManagedMemoryService service) { this.service = service; }

    @PostMapping("/internal/managed-session-store/v1/sessions/{sessionId}/memory:query")
    public Result query(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestBody Query query) {
        return service.query(tenant.tenantId(), sessionId, writerToken, query);
    }
}
