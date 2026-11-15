package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedLoopSkillTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sidecar(String name) throws Exception {
        try (InputStream stream =
                ManagedLoopSkillTest.class.getResourceAsStream("/contracts/" + name)) {
            assertThat(stream).as("classpath asset %s", name).isNotNull();
            return JSON.readValue(new String(stream.readAllBytes(), StandardCharsets.UTF_8), Map.class);
        }
    }

    private static String asset(String name) throws Exception {
        return (String) sidecar(name).get("body");
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
        assertThat(body).isEqualTo(asset("managed-loop-skill-union.json"));
        assertThat(skill.get("description")).isEqualTo(sidecar("managed-loop-skill-union.json").get("description"));
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
            assertThat(body).isEqualTo(asset("managed-loop-skill-cron.json"));
            assertThat(body).contains("CronCreate").contains("CronList").contains("CronDelete");
            assertThat(body).doesNotContain("LoopWakeup").doesNotContain("loop_wakeup");
        }
    }

    @Test
    void wakeupOnlyProfileNamesTheWakeupCreatorAndNeverCronCreate() throws Exception {
        Map<String, Object> skill = skill(WorkspaceToolProfiles.SHELL_V3);
        String body = (String) skill.get("body");
        assertThat(body).isEqualTo(asset("managed-loop-skill-wakeup.json"));
        assertThat(body).contains("LoopWakeup").contains("CronList").contains("CronDelete");
        assertThat(body).doesNotContain("CronCreate").doesNotContain("cron_create");
    }

    @Test
    void reselectDropsTheLoopEntryForAReadOnlyChildAndKeepsOtherSkills() {
        var loop = Map.<String, Object>of("name", "loop", "description", "d", "body", "b");
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var inherited = java.util.List.of(loop, other);
        var readChild = ManagedLoopSkill.reselectForProfile(inherited, WorkspaceToolProfiles.READ);
        assertThat(readChild).extracting(s -> s.get("name")).containsExactly("review");
        var cronChild = ManagedLoopSkill.reselectForProfile(inherited, WorkspaceToolProfiles.FILES_V4);
        assertThat(cronChild).extracting(s -> s.get("name")).containsExactly("review", "loop");
        assertThat((String) cronChild.get(1).get("body")).contains("CronCreate").doesNotContain("LoopWakeup");
    }

    @Test
    void childCatalogSavesNothingWhenAResolvedChildCatalogWouldBeEmpty() {
        var loop = Map.<String, Object>of("name", "loop", "description", "d", "body", "b");
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        assertThat(ManagedLoopSkill.childCatalog(null, WorkspaceToolProfiles.READ)).isNull();
        var inherited = java.util.List.of(loop, other);
        assertThat(ManagedLoopSkill.childCatalog(inherited, null)).isSameAs(inherited);
        // A read-only child of a loop-only parent resolves to nothing: no empty row.
        assertThat(ManagedLoopSkill.childCatalog(java.util.List.of(loop), WorkspaceToolProfiles.READ)).isNull();
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ))
                .extracting(s -> s.get("name")).containsExactly("review");
    }

    @Test
    void mergeIntoPreservesADefinitionAuthoredLoopAndOnlyReplacesTheCallerLoop() {
        var defLoop = Map.<String, Object>of("name", "loop", "description", "def", "body", "DEFINITION_LOOP");
        var callerLoop = Map.<String, Object>of("name", "loop", "description", "local", "body", "LOCAL");
        // Definition already owns a loop: the server neither replaces it nor injects a rival.
        var merged = new java.util.ArrayList<>(java.util.List.of(defLoop));
        boolean injected = ManagedLoopSkill.mergeInto(merged, java.util.List.of(callerLoop),
                WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected).isFalse();
        assertThat(merged).extracting(s -> s.get("name")).containsExactly("loop");
        assertThat((String) merged.get(0).get("body")).isEqualTo("DEFINITION_LOOP");
        // No definition loop: the caller's loop is replaced by the server variant.
        var merged2 = new java.util.ArrayList<Map<String, Object>>();
        boolean injected2 = ManagedLoopSkill.mergeInto(merged2, java.util.List.of(callerLoop),
                WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected2).isTrue();
        assertThat(merged2).hasSize(1);
        assertThat((String) merged2.get(0).get("body")).contains("CronCreate").doesNotContain("LOCAL");
    }

    @Test
    void injectionIsSkippedWhenTheCallerCatalogIsAlreadyAtTheEntryCap() {
        var caller = new java.util.ArrayList<Map<String, Object>>();
        for (int i = 0; i < 256; i++) {
            caller.add(Map.of("name", "s" + i, "description", "d", "body", "b"));
        }
        var merged = new java.util.ArrayList<Map<String, Object>>();
        boolean injected = ManagedLoopSkill.mergeInto(merged, caller, WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected).isFalse();
        assertThat(merged).hasSize(256);
        assertThat(merged).extracting(s -> s.get("name")).doesNotContain("loop");
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
