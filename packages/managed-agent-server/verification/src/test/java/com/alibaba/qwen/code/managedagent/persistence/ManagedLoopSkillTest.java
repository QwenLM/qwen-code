package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.StandaloneSkill;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
        var readChild = ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, false, true);
        assertThat(readChild).extracting(s -> s.get("name")).containsExactly("review");
    }

    @Test
    void childCatalogPreservesADefinitionAuthoredLoopForAReadOnlyChild() {
        var defLoop = Map.<String, Object>of("name", "loop", "description", "def", "body", "DEFINITION_LOOP");
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var inherited = java.util.List.of(defLoop, other);
        var readChild = ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, true, false);
        assertThat(readChild).extracting(s -> s.get("name")).containsExactly("loop", "review");
        assertThat((String) readChild.get(0).get("body")).isEqualTo("DEFINITION_LOOP");
    }

    @Test
    void childCatalogDropsByServerProvenanceMarkerNotBodyText() {
        // R3-1: a superseded sidecar body (written by an earlier build, matching no
        // current sidecar) is still dropped for a READ child when the snapshot's
        // server-loop marker says the server injected it. Provenance comes from the
        // marker, not body text, so regeneration cannot leak the variant to the child.
        var supersededLoop = Map.<String, Object>of("name", "loop", "description", "old", "body", "RELEASE_N_BODY");
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var inherited = java.util.List.of(supersededLoop, other);
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, false, true))
                .extracting(s -> s.get("name")).containsExactly("review");
        // R7-1: the same unidentifiable body WITHOUT the marker is a user-authored
        // loop and is preserved, not assumed to be the server's.
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, false, false))
                .extracting(s -> s.get("name")).containsExactly("loop", "review");
        // Definition-authored: preserved by the definition-provenance carve-out
        // regardless of the marker.
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, true, false))
                .extracting(s -> s.get("name")).containsExactly("loop", "review");
        // A current server sidecar body is recognized as a fallback even without the marker.
        var serverLoop = ManagedLoopSkill.forProfile(WorkspaceToolProfiles.SHELL_V4);
        assertThat(ManagedLoopSkill.childCatalog(java.util.List.of(serverLoop, other), WorkspaceToolProfiles.READ, false, false))
                .extracting(s -> s.get("name")).containsExactly("review");
    }

    @Test
    void childCatalogKeepsAUserAuthoredCallerLoopForAReadOnlyChild() {
        // R7-1: a user-authored caller loop saved on the parent (definition owns
        // no loop, no server injection) must survive into the READ snapshot child,
        // not be deleted by name. Reverting to removeIf(name==loop) reddens this case.
        var userLoop = Map.<String, Object>of("name", "loop", "description", "mine", "body", "MY_CUSTOM_LOOP_BODY");
        var other = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var readChild = ManagedLoopSkill.childCatalog(java.util.List.of(userLoop, other), WorkspaceToolProfiles.READ, false, false);
        assertThat(readChild).extracting(s -> s.get("name")).containsExactly("loop", "review");
        assertThat((String) readChild.get(0).get("body")).isEqualTo("MY_CUSTOM_LOOP_BODY");
    }

    @Test
    void childCatalogSavesNothingWhenAResolvedChildCatalogWouldBeEmpty() {
        var serverLoop = ManagedLoopSkill.forProfile(WorkspaceToolProfiles.SHELL_V4);
        assertThat(ManagedLoopSkill.childCatalog(null, WorkspaceToolProfiles.READ, false, true)).isNull();
        var inherited = java.util.List.of(serverLoop);
        assertThat(ManagedLoopSkill.childCatalog(inherited, null, false, true)).isSameAs(inherited);
        // A read-only child of a server-loop-only parent resolves to nothing: no empty row.
        assertThat(ManagedLoopSkill.childCatalog(inherited, WorkspaceToolProfiles.READ, false, true)).isNull();
    }

    @Test
    void mergeIntoPreservesADefinitionAuthoredLoopAndOnlyReplacesTheBundledCallerLoop() throws Exception {
        var defLoop = Map.<String, Object>of("name", "loop", "description", "def", "body", "DEFINITION_LOOP");
        // Definition owns a loop: the bundled caller import is dropped, no rival variant.
        var merged = new java.util.ArrayList<>(java.util.List.of(defLoop));
        var injected = ManagedLoopSkill.mergeInto(merged, java.util.List.of(bundledCallerLoop()),
                WorkspaceToolProfiles.FILES_V4, true, List.of());
        assertThat(injected).isNull();
        assertThat(merged).extracting(s -> s.get("name")).containsExactly("loop");
        assertThat((String) merged.get(0).get("body")).isEqualTo("DEFINITION_LOOP");
        // No definition loop: the bundled caller import is replaced by the server variant.
        var merged2 = new java.util.ArrayList<Map<String, Object>>();
        var injected2 = ManagedLoopSkill.mergeInto(merged2, java.util.List.of(bundledCallerLoop()),
                WorkspaceToolProfiles.FILES_V4, true, List.of());
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
                WorkspaceToolProfiles.FILES_V4, true, List.of());
        assertThat(injected).isNull();
        assertThat(merged).extracting(s -> s.get("name")).containsExactly("loop");
        assertThat((String) merged.get(0).get("body")).isEqualTo("MY_CUSTOM_LOOP");
        // Creator-less: only the bundled import is dropped; a user-authored loop stays.
        var merged2 = new java.util.ArrayList<Map<String, Object>>();
        var injected2 = ManagedLoopSkill.mergeInto(merged2, java.util.List.of(userLoop),
                WorkspaceToolProfiles.FILES, true, List.of());
        assertThat(injected2).isNull();
        assertThat((String) merged2.get(0).get("body")).isEqualTo("MY_CUSTOM_LOOP");
    }

    @Test
    void mergeIntoReplacesTheTrimmedBundledImportTheDaemonPublishes() throws Exception {
        // The daemon publishes the bundled body trimmed (skill-manager / parseSkillContent
        // `body.trim()`); the reference sidecar must equal that wire value, so a caller
        // loop carrying the trimmed body is still recognized as the bundled import. An
        // untrimmed reference would fail this exact comparison and keep the local body.
        var trimmed = Map.<String, Object>of("name", "loop", "description", "bundled",
                "body", ((String) bundledCallerLoop().get("body")).trim());
        var merged = new java.util.ArrayList<Map<String, Object>>();
        var injected = ManagedLoopSkill.mergeInto(merged, java.util.List.of(trimmed),
                WorkspaceToolProfiles.FILES_V4, true, List.of());
        assertThat(injected).isNotNull();
        assertThat((String) merged.get(0).get("body")).contains("CronCreate");
    }

    @Test
    void mergeIntoPreservesAUserAuthoredLoopAlongsideTheBundledImport() throws Exception {
        // A bundled import plus a user-authored loop: provenance classifies the whole
        // caller set, so the user's loop is preserved (no silent delete-by-name) and no
        // rival variant is injected; caller validation reports the duplicate name.
        var userLoop = Map.<String, Object>of("name", "loop", "description", "mine", "body", "MY_CUSTOM_LOOP");
        var merged = new java.util.ArrayList<Map<String, Object>>();
        var injected = ManagedLoopSkill.mergeInto(merged,
                java.util.List.of(bundledCallerLoop(), userLoop), WorkspaceToolProfiles.FILES_V4, true, List.of());
        assertThat(injected).isNull();
        assertThat(merged).extracting(s -> s.get("body")).contains("MY_CUSTOM_LOOP");
        // Order-independent: the user-authored loop survives regardless of position.
        var merged2 = new java.util.ArrayList<Map<String, Object>>();
        var injected2 = ManagedLoopSkill.mergeInto(merged2,
                java.util.List.of(userLoop, bundledCallerLoop()), WorkspaceToolProfiles.FILES_V4, true, List.of());
        assertThat(injected2).isNull();
        assertThat(merged2).extracting(s -> s.get("body")).contains("MY_CUSTOM_LOOP");
    }

    @Test
    void selectApprovalModeCarriesTheDefinitionSkillsThroughApprovalSelection() {
        // A requested approval mode rebuilds the pin; the definition's Skills must
        // survive that rebuild or a creator-bearing definition loses its catalog and
        // the server variant takes the definition loop's place. Dropping pin.skills()
        // here (List.of()) reddens this case.
        var defSkill = Map.<String, Object>of("name", "default", "description", "d", "body", "DEFAULT");
        var pin = new AgentSessionPolicies.AgentPin("1", null, "default",
                WorkspaceToolProfiles.FILES, false, false, java.util.List.of(defSkill));
        var selected = ExternalWorkspaceSessionPolicies.selectApprovalMode(pin, "auto-edit", true);
        assertThat(selected.approvalMode()).isEqualTo("auto-edit");
        assertThat(selected.skills()).containsExactly(defSkill);
    }

    @Test
    void mergeIntoDoesNotDoubleAppendCallerSkillsAlreadyCarriedByTheExternalPin() {
        // External creationPin carries the caller skills into the pin, so merged
        // already holds them. Appending callerSkills again duplicates every name
        // and the catalog validation refuses the whole creation.
        var callerSkill = Map.<String, Object>of("name", "review", "description", "d", "body", "b");
        var merged = new ArrayList<>(List.of(callerSkill));
        var injected = ManagedLoopSkill.mergeInto(merged, List.of(callerSkill),
                WorkspaceToolProfiles.EXTERNAL_FILES, true, List.of());
        assertThat(injected).isNull();
        assertThat(merged).containsExactly(callerSkill);
        assertThat(AgentDefinitionExtensions.sessionSkills(merged)).hasSize(1);
    }

    @Test
    void mergeIntoCarriesTheBundledCallerLoopInvocationFlagsOntoTheVariant() throws Exception {
        var callerLoop = new java.util.LinkedHashMap<String, Object>(bundledCallerLoop());
        callerLoop.put("model_invocable", false);
        var merged = new java.util.ArrayList<Map<String, Object>>();
        var injected = ManagedLoopSkill.mergeInto(merged, java.util.List.of(callerLoop),
                WorkspaceToolProfiles.FILES_V4, true, List.of());
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
        var injected = ManagedLoopSkill.mergeInto(merged, caller, WorkspaceToolProfiles.FILES_V4, true, List.of());
        assertThat(injected).isNull();
        assertThat(merged).hasSize(256);
        assertThat(merged).extracting(s -> s.get("name")).doesNotContain("loop");
    }

    @Test
    void injectionReservesTheSelectedPackageEntry() {
        var caller = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < 255; i++) {
            caller.add(Map.of("name", "s" + i, "description", "d", "body", "b"));
        }
        var packages = List.of(new StandaloneSkill("pkg:review", "Review", true, 200));
        var merged = new ArrayList<Map<String, Object>>();
        assertThat(ManagedLoopSkill.mergeInto(merged, caller, WorkspaceToolProfiles.SHELL_V4, true, packages)).isNull();
        assertThat(AgentDefinitionExtensions.sessionSkills(merged, packages)).isEqualTo(caller);

        merged.clear();
        caller.removeLast();
        assertThat(ManagedLoopSkill.mergeInto(merged, caller, WorkspaceToolProfiles.SHELL_V4, true, packages))
                .extracting(skill -> skill.get("name")).contains("loop");
    }

    @Test
    void injectionReservesTheSelectedPackagesCombinedBytes() {
        // Four JSON entries, three commas and two brackets exactly fill the catalog.
        int available = ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES - 5;
        var packages = new ArrayList<StandaloneSkill>();
        for (int i = 0; i < 4; i++) {
            packages.add(new StandaloneSkill("pkg:s" + i, "Skill", true, available / 4 + (i == 0 ? available % 4 : 0)));
        }
        var merged = new ArrayList<Map<String, Object>>();
        assertThat(ManagedLoopSkill.mergeInto(merged, List.of(), WorkspaceToolProfiles.SHELL_V4, true, packages)).isNull();
        assertThat(AgentDefinitionExtensions.sessionSkills(merged, packages)).isEmpty();
    }

    @Test
    void overCapacitySkipDropsTheBundledLoopSoTheCreationStillSucceeds() throws Exception {
        // A definition skill plus a full caller catalog puts the merged catalog over
        // the entry cap once the variant is added. The skip must leave the bundled
        // import dropped, not restore it: restoring would push merged back over the
        // cap and the admission validation below would refuse the creation.
        var defSkill = Map.<String, Object>of("name", "def", "description", "d", "body", "b");
        var caller = new java.util.ArrayList<Map<String, Object>>();
        for (int i = 0; i < 255; i++) {
            caller.add(Map.of("name", "s" + i, "description", "d", "body", "b"));
        }
        caller.add(bundledCallerLoop());
        var merged = new java.util.ArrayList<>(java.util.List.of(defSkill));
        var injected = ManagedLoopSkill.mergeInto(merged, caller, WorkspaceToolProfiles.FILES_V4, true, List.of());
        assertThat(injected).isNull();
        assertThat(merged).hasSize(256);
        assertThat(merged).extracting(s -> s.get("name")).doesNotContain("loop");
        // The admission validates the merged catalog when no variant was injected;
        // it must accept the within-cap catalog rather than refuse the creation.
        var validated = AgentDefinitionExtensions.sessionSkills(merged);
        assertThat(validated).hasSize(256);
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
