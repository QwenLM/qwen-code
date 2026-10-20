package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionSkills;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSkill;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class ManagedSkillCatalogService {
    private final ManagedAgentService sessions;
    private final ManagedAgentDefinitionStore definitions;

    public ManagedSkillCatalogService(ManagedAgentService sessions, ManagedAgentDefinitionStore definitions) {
        this.sessions = sessions;
        this.definitions = definitions;
    }

    public WebShellSessionSkills get(String tenantId, String actorId, String sessionId) {
        var session = sessions.requireReadableSession(tenantId, actorId, sessionId);
        if (session.workspace() == null || session.agentDefinitionDigest() == null
                || WorkspaceToolProfiles.READ.equals(session.toolProfile())) {
            return new WebShellSessionSkills(List.of());
        }
        var skills = AgentDefinitionExtensions.skills(definitions.pinnedContent(session).get("skills"), true);
        return new WebShellSessionSkills(skills.stream()
                .map(skill -> new WebShellSkill((String) skill.get("name"), (String) skill.get("description")))
                .toList());
    }
}
