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

    private static Map<String, Object> bundledCallerLoop() throws Exception {
        return Map.of("name", "loop", "description", "bundled",
                "body", asset("managed-loop-skill-bundled-body.json"));
    }

    @Test
    void childCatalogDropsTheServerLoopForAReadOnlyChildAndKeepsOtherSkills() {
        var serverLoop = ManagedLoopSkill.forProfile(WorkspaceToolProfiles.SHELL_V4);
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var inherited = java.util.List.of(serverLoop, other);
        // No definition loop: the inherited loop is the server variant, dropped for READ.
        var readChild = ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, false);
        assertThat(readChild).extracting(s -> s.get("name")).containsExactly("review");
    }

    @Test
    void childCatalogPreservesADefinitionAuthoredLoopForAReadOnlyChild() {
        var defLoop = Map.<String, Object>of("name", "loop", "description", "def", "body", "DEFINITION_LOOP");
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var inherited = java.util.List.of(defLoop, other);
        var readChild = ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, true);
        assertThat(readChild).extracting(s -> s.get("name")).containsExactly("loop", "review");
        assertThat((String) readChild.get(0).get("body")).isEqualTo("DEFINITION_LOOP");
    }

    @Test
    void childCatalogClassifiesAStaleServerBodyByDefinitionProvenanceNotBodyText() {
        // A row written by an earlier build: its loop body matches no current sidecar.
        var staleLoop = Map.<String, Object>of("name", "loop", "description", "old", "body", "RELEASE_N_BODY");
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var inherited = java.util.List.of(staleLoop, other);
        // No definition loop: the stale server variant is still dropped for READ.
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, false))
                .extracting(s -> s.get("name")).containsExactly("review");
        // Definition-authored: preserved even though the body matches no sidecar.
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, true))
                .extracting(s -> s.get("name")).containsExactly("loop", "review");
    }

    @Test
    void childCatalogSavesNothingWhenAResolvedChildCatalogWouldBeEmpty() {
        var serverLoop = ManagedLoopSkill.forProfile(WorkspaceToolProfiles.SHELL_V4);
        assertThat(ManagedLoopSkill.childCatalog(null, WorkspaceToolProfiles.READ, false)).isNull();
        var inherited = java.util.List.of(serverLoop);
        assertThat(ManagedLoopSkill.childCatalog(inherited, null, false)).isSameAs(inherited);
        // A read-only child of a server-loop-only parent resolves to nothing: no empty row.
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, false)).isNull();
    }

    @Test
    void mergeIntoPreservesADefinitionAuthoredLoopAndOnlyReplacesTheBundledCallerLoop() throws Exception {
        var defLoop = Map.<String, Object>of("name", "loop", "description", "def", "body", "DEFINITION_LOOP");
        // Definition owns a loop: the bundled caller import is dropped, no rival variant.
        var merged = new java.util.ArrayList<>(java.util.List.of(defLoop));
        var injected = ManagedLoopSkill.mergeInto(merged, java.util.List.of(bundledCallerLoop()),
                WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected).isNull();
        assertThat(merged).extracting(s -> s.get("name")).containsExactly("loop");
        assertThat((String) merged.get(0).get("body")).isEqualTo("DEFINITION_LOOP");
        // No definition loop: the bundled caller import is replaced by the server variant.
        var merged2 = new java.util.ArrayList<Map<String, Object>>();
        var injected2 = ManagedLoopSkill.mergeInto(merged2, java.util.List.of(bundledCallerLoop()),
                WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected2).isNotNull();
        assertThat(merged2).hasSize(1);
        assertThat((String) merged2.get(0).get("body")).contains("CronCreate");
    }

    @Test
    void mergeIntoPreservesAUserAuthoredCallerLoop() {
        var userLoop = Map.<String, Object>of("name", "loop", "description", "mine", "body", "MY_CUSTOM_LOOP");
        // Creator-bearing: the user's loop is kept and no server variant is injected.
        var merged = new java.util.ArrayList<Map<String, Object>>();
        var injected = ManagedLoopSkill.mergeInto(merged, java.util.List.of(userLoop),
                WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected).isNull();
        assertThat(merged).extracting(s -> s.get("name")).containsExactly("loop");
        assertThat((String) merged.get(0).get("body")).isEqualTo("MY_CUSTOM_LOOP");
        // Creator-less: only the bundled import is dropped; a user-authored loop stays.
        var merged2 = new java.util.ArrayList<Map<String, Object>>();
        var injected2 = ManagedLoopSkill.mergeInto(merged2, java.util.List.of(userLoop),
                WorkspaceToolProfiles.FILES, true);
        assertThat(injected2).isNull();
        assertThat((String) merged2.get(0).get("body")).isEqualTo("MY_CUSTOM_LOOP");
    }

    @Test
    void mergeIntoCarriesTheBundledCallerLoopInvocationFlagsOntoTheVariant() throws Exception {
        var callerLoop = new java.util.LinkedHashMap<String, Object>(bundledCallerLoop());
        callerLoop.put("model_invocable", false);
        var merged = new java.util.ArrayList<Map<String, Object>>();
        var injected = ManagedLoopSkill.mergeInto(merged, java.util.List.of(callerLoop),
                WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected).isNotNull();
        assertThat(injected).hasSize(1);
        assertThat(injected.get(0).get("model_invocable")).isEqualTo(false);
        assertThat((String) injected.get(0).get("body")).contains("CronCreate");
    }

    @Test
    void injectionIsSkippedWhenTheCallerCatalogIsAlreadyAtTheEntryCap() {
        var caller = new java.util.ArrayList<Map<String, Object>>();
        for (int i = 0; i < 256; i++) {
            caller.add(Map.of("name", "s" + i, "description", "d", "body", "b"));
        }
        var merged = new java.util.ArrayList<Map<String, Object>>();
        var injected = ManagedLoopSkill.mergeInto(merged, caller, WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected).isNull();
        assertThat(merged).hasSize(256);
        assertThat(merged).extracting(s -> s.get("name")).doesNotContain("loop");
    }

    @Test
    void overCapacitySkipKeepsTheCallersBundledLoop() throws Exception {
        // A definition skill plus a full caller catalog puts the merged catalog over
        // the entry cap once the variant is added; the skip must keep the caller loop.
        var defSkill = Map.<String, Object>of("name", "def", "description", "d", "body", "b");
        var caller = new java.util.ArrayList<Map<String, Object>>();
        for (int i = 0; i < 255; i++) {
            caller.add(Map.of("name", "s" + i, "description", "d", "body", "b"));
        }
        caller.add(bundledCallerLoop());
        var merged = new java.util.ArrayList<>(java.util.List.of(defSkill));
        var injected = ManagedLoopSkill.mergeInto(merged, caller, WorkspaceToolProfiles.FILES_V4, true);
        assertThat(injected).isNull();
        assertThat(merged).extracting(s -> s.get("name")).contains("loop");
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
