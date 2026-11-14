package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedLoopSkillTest {
    private static String asset(String name) throws Exception {
        try (InputStream stream =
                ManagedLoopSkillTest.class.getResourceAsStream("/contracts/" + name)) {
            assertThat(stream).as("classpath asset %s", name).isNotNull();
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static Map<String, Object> skill(String profile) {
        Map<String, Object> skill = ManagedLoopSkill.forProfile(profile);
        assertThat(skill).as("profile %s receives the loop skill", profile).isNotNull();
        assertThat(skill.get("name")).isEqualTo("loop");
        assertThat((String) skill.get("description")).isNotBlank();
        assertThat((String) skill.get("body")).isNotBlank();
        return skill;
    }

    @Test
    void unionProfileNamesBothCreatorsWithManagedWording() throws Exception {
        Map<String, Object> skill = skill(WorkspaceToolProfiles.SHELL_V4);
        String body = (String) skill.get("body");
        assertThat(body).isEqualTo(asset("managed-loop-skill-union.md"));
        assertThat(body).contains("CronCreate").contains("LoopWakeup");
        assertThat(body).contains("a Managed schedule is always durable");
        assertThat(body).contains("runs until cancelled");
        assertThat(body).doesNotContain("defaults to session-only");
        assertThat(body).doesNotContain("7 days after creation");
    }

    @Test
    void cronOnlyProfilesNameTheCronCreatorsAndNeverTheWakeupCreator() throws Exception {
        for (String profile : new String[] {
                WorkspaceToolProfiles.FILES_V4, WorkspaceToolProfiles.INTERNAL_TEAM_LEAD_V2}) {
            Map<String, Object> skill = skill(profile);
            String body = (String) skill.get("body");
            assertThat(body).isEqualTo(asset("managed-loop-skill-cron.md"));
            assertThat(body).contains("CronCreate").contains("CronList").contains("CronDelete");
            assertThat(body).doesNotContain("LoopWakeup").doesNotContain("loop_wakeup");
        }
    }

    @Test
    void wakeupOnlyProfileNamesTheWakeupCreatorAndNeverCronCreate() throws Exception {
        Map<String, Object> skill = skill(WorkspaceToolProfiles.SHELL_V3);
        String body = (String) skill.get("body");
        assertThat(body).isEqualTo(asset("managed-loop-skill-wakeup.md"));
        assertThat(body).contains("LoopWakeup").contains("CronList").contains("CronDelete");
        assertThat(body).doesNotContain("CronCreate").doesNotContain("cron_create");
    }

    @Test
    void profilesWithoutALoopCreatorReceiveNoSkill() {
        assertThat(ManagedLoopSkill.forProfile(WorkspaceToolProfiles.FILES)).isNull();
        assertThat(ManagedLoopSkill.forProfile(WorkspaceToolProfiles.FILES_V3)).isNull();
        assertThat(ManagedLoopSkill.forProfile(WorkspaceToolProfiles.SHELL)).isNull();
        assertThat(ManagedLoopSkill.forProfile(WorkspaceToolProfiles.MCP)).isNull();
        assertThat(ManagedLoopSkill.forProfile(WorkspaceToolProfiles.INTERNAL_TEAM_LEAD)).isNull();
        assertThat(ManagedLoopSkill.forProfile(WorkspaceToolProfiles.READ)).isNull();
        assertThat(ManagedLoopSkill.forProfile(null)).isNull();
    }
}
