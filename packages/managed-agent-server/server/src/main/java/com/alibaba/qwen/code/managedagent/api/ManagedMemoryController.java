package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Store;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.StoreList;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryRepository;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class ManagedMemoryController {
    private final MemoryRepository repository;
    public ManagedMemoryController(MemoryRepository repository) {
        this.repository = repository;
    }

    @PostMapping("/v1/agents/memory-stores")
    public ResponseEntity<Store> create(TenantContext tenant, HttpServletRequest request,
            @RequestBody(required = false) Map<String, Object> body) {
        if (!request.getParameterMap().isEmpty() || body != null && !body.isEmpty()) {
            throw MemoryModels.invalid();
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(repository.create(tenant.tenantId(), tenant.requireActorId()));
    }

    @GetMapping("/v1/agents/memory-stores")
    public ResponseEntity<StoreList> list(TenantContext tenant, HttpServletRequest request) {
        if (!request.getParameterMap().isEmpty()) {
            throw MemoryModels.invalid();
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(new StoreList(repository.list(tenant.tenantId(), tenant.requireActorId())));
    }
}
