package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionSkills;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSkill;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class ManagedSkillCatalogService {
    private final ManagedAgentService sessions;
    private final ManagedSessionSkills skills;

    public ManagedSkillCatalogService(ManagedAgentService sessions, ManagedSessionSkills skills) {
        this.sessions = sessions;
        this.skills = skills;
    }

    public WebShellSessionSkills get(String tenantId, String actorId, String sessionId) {
        var session = sessions.requireReadableSession(tenantId, actorId, sessionId);
        if (session.workspace() == null
                || WorkspaceToolProfiles.READ.equals(session.toolProfile())) {
            return new WebShellSessionSkills(List.of());
        }
        var catalog = skills.effective(session);
        return new WebShellSessionSkills(catalog.stream()
                .filter(skill -> !Boolean.FALSE.equals(skill.get("user_invocable")))
                .map(skill -> new WebShellSkill((String) skill.get("name"), (String) skill.get("description")))
                .toList());
    }
}
