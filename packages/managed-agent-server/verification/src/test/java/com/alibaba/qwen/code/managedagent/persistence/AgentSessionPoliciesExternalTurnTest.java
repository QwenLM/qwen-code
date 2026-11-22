package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AgentSessionPoliciesExternalTurnTest {
    private static final String SESSION_ID = "session-a";

    private static SessionRecord externalSession() {
        return new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null, null,
                "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant-a", "workspace-a", 1, "storage-a", ".",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1),
                "default", WorkspaceToolProfiles.EXTERNAL_FILES, null, 0);
    }

    private static AgentSessionPolicies policies(JdbcManagedSessionSkills skills) {
        var workspaces = mock(JdbcManagedWorkspaceRegistry.class);
        when(workspaces.externalFilesAllowed(any())).thenReturn(true);
        when(workspaces.accessOf(anyString(), anyString(), anyString()))
                .thenReturn(WorkspaceAccess.OWNER);
        return new AgentSessionPolicies(
                mock(AgentEventJournal.class),
                mock(AgentSessionQueries.class),
                mock(AgentStoreRows.class),
                mock(WorktreeFiles.class),
                mock(HarnessRules.class),
                mock(JdbcManagedExtensionRecordStore.class),
                mock(JdbcTemplate.class),
                new ObjectMapper(),
                Clock.systemUTC(),
                "default",
                workspaces,
                "1",
                List.of(),
                List.of(),
                List.of(),
                mock(JdbcManagedAgentDefinitionStore.class),
                skills,
                true,
                false);
    }

    @Test
    void externalTurnAdmitsAPinnedSkillCatalogAndStillRefusesAnInitialSelection() {
        // The pinned catalog is content the turn serves; the admission must not
        // read it as an extension lane. Re-adding the non-empty check to the
        // refusal reddens the admitted case.
        var skills = mock(JdbcManagedSessionSkills.class);
        var pinned = List.<Map<String, Object>>of(
                Map.of("name", "review", "description", "d", "body", "b"));
        when(skills.effective(any())).thenReturn(pinned);
        when(skills.initialSelection("tenant-a", SESSION_ID)).thenReturn(null);
        var policies = policies(skills);
        var session = externalSession();
        var input = List.<Map<String, Object>>of(
                Map.of("type", "input_text", "text", "hi"));

        assertThatCode(() -> policies.requireExternalTurnAllowed(
                "tenant-a", "actor-a", SESSION_ID, session, input))
                .doesNotThrowAnyException();

        when(skills.initialSelection("tenant-a", SESSION_ID))
                .thenReturn(Map.of("skills", List.of("review")));
        assertThatThrownBy(() -> policies.requireExternalTurnAllowed(
                "tenant-a", "actor-a", SESSION_ID, session, input))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> org.assertj.core.api.Assertions.assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
    }
}
