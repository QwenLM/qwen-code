package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.catalog.ManagedSkillCatalogService;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicSessionOptions;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicSessionSkills;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicSkill;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionSkills;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import jakarta.validation.Valid;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WebShellSkillsController {
    private final ManagedSkillCatalogService skills;
    private final ManagedAgentService service;

    public WebShellSkillsController(ManagedSkillCatalogService skills, ManagedAgentService service) {
        this.skills = skills;
        this.service = service;
    }

    @PostMapping("/api/agent/web-shell/v1/session-skills/query")
    public ResponseEntity<WebShellSessionSkills> query(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(skills.get(tenant.tenantId(), tenant.requireActorId(), request.sessionId()));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/skills")
    public ResponseEntity<PublicSessionSkills> publicSkills(TenantContext tenant,
            @PathVariable String sessionId) {
        WebShellSessionSkills result = skills.get(tenant.tenantId(), tenant.requireActorId(), sessionId);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(new PublicSessionSkills(result.skills().stream()
                        .map(skill -> new PublicSkill(skill.name(), skill.description())).toList()));
    }

    @GetMapping("/v1/agents/session-options")
    public ResponseEntity<PublicSessionOptions> publicSessionOptions(TenantContext tenant,
            @RequestParam(name = "agent_id") String agentId) {
        String actor = tenant.requireActorId();
        if (StringUtils.isBlank(agentId) || agentId.length() > 128) {
            throw new ManagedAgentException(400, "invalid_request", "agent_id must be 1..128 characters.");
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.queryPublicSessionOptions(tenant.tenantId(), actor, agentId));
    }
}
