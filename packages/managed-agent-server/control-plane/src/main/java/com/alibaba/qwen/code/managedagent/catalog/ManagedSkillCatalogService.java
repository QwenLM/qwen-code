package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionSkills;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSkill;
import com.alibaba.qwen.code.managedagent.repository.ExtensionPackageRepository;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class ManagedSkillCatalogService {
    private final ManagedAgentService sessions;
    private final ManagedSessionSkills skills;
    private final ManagedSessionResourcesService resources;
    private final ExtensionPackageRepository packages;
    private final ObjectMapper json;

    public ManagedSkillCatalogService(ManagedAgentService sessions, ManagedSessionSkills skills, ManagedSessionResourcesService resources,
            ExtensionPackageRepository packages, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.sessions = sessions;
        this.skills = skills;
        this.resources = resources;
        this.packages = packages;
        this.json = json;
    }

    @Transactional(transactionManager = "managedAgentTransactionManager", readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public WebShellSessionSkills get(String tenantId, String actorId, String sessionId) {
        var session = sessions.requireReadableSession(tenantId, actorId, sessionId);
        if (session.workspace() == null
                || WorkspaceToolProfiles.READ.equals(session.toolProfile())) {
            return new WebShellSessionSkills(List.of());
        }
        var visible = new java.util.ArrayList<>(skills.effective(session).stream()
                .filter(skill -> !Boolean.FALSE.equals(skill.get("user_invocable")))
                .map(skill -> new WebShellSkill((String) skill.get("name"), (String) skill.get("description")))
                .toList());
        var installed = resources.installedSkills(session);
        if (installed.isPresent()) {
            visible.addAll(installed.get());
        } else {
            var initial = skills.initialSelection(tenantId, sessionId);
            if (initial != null) {
                List<Pin> pins = json.convertValue(initial.get("extensions"), new TypeReference<List<Pin>>() { });
                for (Pin pin : pins) {
                    var skill = packages.standaloneSkill(tenantId, session.workspace().getWorkspaceId(), pin);
                    if (skill != null && skill.userInvocable()) {
                        visible.add(new WebShellSkill(skill.name(), skill.description()));
                    }
                }
            }
        }
        if (visible.size() > 256 || visible.stream().anyMatch(skill -> skill.name().length() > 128 || skill.description().length() > 4096)) {
            throw new ManagedAgentException(409, "session_skills_unavailable", "The Skill catalog exceeds its supported limits.");
        }
        return new WebShellSessionSkills(List.copyOf(visible));
    }
}
