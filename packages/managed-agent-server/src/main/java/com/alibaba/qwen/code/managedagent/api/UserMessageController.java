package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore.Command;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore.Snapshot;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserMessageController {
    private final ManagedUserMessageStore messages;

    public UserMessageController(ManagedUserMessageStore messages) { this.messages = messages; }

    public record Query(String sessionId) { }
    public record WebCommand(String sessionId, String idempotencyKey, Command command) { }

    @GetMapping("/v1/agents/sessions/{sessionId}/user-messages")
    public Snapshot query(TenantContext tenant, @PathVariable String sessionId) {
        return messages.query(tenant.tenantId(), tenant.actorId(), sessionId);
    }

    @PostMapping("/v1/agents/sessions/{sessionId}/user-messages")
    public Snapshot command(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader("Idempotency-Key") String key, @RequestBody Command command) {
        return messages.command(tenant.tenantId(), tenant.actorId(), sessionId, key, command);
    }

    @PostMapping("/api/agent/web-shell/v1/user-messages/query")
    public Snapshot webQuery(TenantContext tenant, @RequestBody Query request) {
        return query(tenant, request.sessionId());
    }

    @PostMapping("/api/agent/web-shell/v1/user-messages/command")
    public Snapshot webCommand(TenantContext tenant, @RequestBody WebCommand request) {
        return command(tenant, request.sessionId(), request.idempotencyKey(), request.command());
    }
}
