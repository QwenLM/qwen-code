package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionSkills;
import com.alibaba.qwen.code.managedagent.service.ManagedSkillCatalogService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WebShellSkillsController {
    private final ManagedSkillCatalogService skills;

    public WebShellSkillsController(ManagedSkillCatalogService skills) {
        this.skills = skills;
    }

    @PostMapping("/api/agent/web-shell/v1/session-skills/query")
    public ResponseEntity<WebShellSessionSkills> query(TenantContext tenant,
            @Valid @RequestBody WebShellSessionRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(skills.get(tenant.tenantId(), tenant.requireActorId(), request.sessionId()));
    }
}
