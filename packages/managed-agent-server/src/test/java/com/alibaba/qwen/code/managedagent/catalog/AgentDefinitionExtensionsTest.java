package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AgentDefinitionExtensionsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, Object> SKILL = Map.of(
            "name", "评审:review", "description", "Review changes", "body", "Read the diff.");
    private static final Map<String, Object> MCP = Map.of(
            "server_id", "docs", "server_revision", 1, "definition_digest", "a".repeat(64));

    @Test
    void staticSkillsKeepTheirOriginalBytesAndNeverApplySideEffectOptions() throws Exception {
        Map<String, Object> skill = new LinkedHashMap<>(SKILL);
        skill.put("body", "  Read the diff.\n");
        skill.put("base_directory", ".qwen/skills/review");
        List<Map<String, Object>> parsed = AgentDefinitionExtensions.skills(List.of(skill), true);
        assertThat(JSON.readTree(AgentDefinitionExtensions.skillsBytes(parsed)))
                .isEqualTo(JSON.valueToTree(List.of(skill)));
        assertThat(AgentDefinitionExtensions.skills(null, false)).isEmpty();
        assertThat(AgentDefinitionExtensions.skills(List.of(), false)).isEmpty();
        assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(SKILL), false));
        for (String field : List.of("allowed_tools", "allowedTools", "hooks", "model", "extra")) {
            skill.put(field, "unsupported");
            assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(skill), true));
            skill.remove(field);
        }
    }

    @Test
    void staticSkillLimitsUseUtf8AndValidateTheWholeCatalog() {
        Map<String, Object> skill = new LinkedHashMap<>(SKILL);
        skill.put("name", "界".repeat(42));
        assertThat(AgentDefinitionExtensions.skills(List.of(skill), true)).hasSize(1);
        skill.put("name", "界".repeat(43));
        Map<String, Object> oversizedName = skill;
        assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(oversizedName), true));
        for (var limit : Map.of("description", 4096, "body", 32768).entrySet()) {
            skill = new LinkedHashMap<>(SKILL);
            skill.put(limit.getKey(), "a".repeat(limit.getValue()));
            assertThat(AgentDefinitionExtensions.skills(List.of(skill), true)).hasSize(1);
            skill.put(limit.getKey(), "a".repeat(limit.getValue()) + "界");
            Map<String, Object> oversized = skill;
            assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(oversized), true));
        }
        List<Map<String, Object>> catalog = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            catalog.add(Map.of("name", "skill-" + i, "description", "d", "body", "b"));
        }
        assertThat(AgentDefinitionExtensions.skills(catalog, true)).hasSize(16);
        catalog.add(Map.of("name", "overflow", "description", "d", "body", "b"));
        assertRefused("skills", () -> AgentDefinitionExtensions.skills(catalog, true));
        assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(SKILL, SKILL), true));
        List<Map<String, Object>> oversizedCatalog = List.of(
                Map.of("name", "a", "description", "d", "body", "x".repeat(25000)),
                Map.of("name", "b", "description", "d", "body", "x".repeat(25000)));
        assertRefused("skills", () -> AgentDefinitionExtensions.skills(oversizedCatalog, true));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", "bad name", "bad/name", "bad\nname", "\uD800"})
    void refusesInvalidSkillNames(String name) {
        Map<String, Object> skill = new LinkedHashMap<>(SKILL);
        skill.put("name", name);
        assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(skill), true));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", "\t\n", "\uD800"})
    void refusesBlankOrInvalidUnicodeSkillText(String text) {
        for (String field : List.of("description", "body")) {
            Map<String, Object> skill = new LinkedHashMap<>(SKILL);
            skill.put(field, text);
            assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(skill), true));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "/tmp", "../secret", "a/../b", "a/./b", "./a", "a//b", "a/", "a\\b",
            "C:/tmp", "file:tmp", "a\nfile", "a\u0085file", "\uD800"})
    void refusesAmbiguousOrEscapingSkillDirectories(String directory) {
        Map<String, Object> skill = new LinkedHashMap<>(SKILL);
        skill.put("base_directory", directory);
        assertRefused("skills", () -> AgentDefinitionExtensions.skills(List.of(skill), true));
    }

    @Test
    void mcpPinsRequireTheMcpProfileAndPreserveSafeIntegerRevisions() {
        assertThat(AgentDefinitionExtensions.mcpServers(List.of(MCP), WorkspaceToolProfiles.MCP))
                .containsExactly(Map.of("serverId", "docs", "serverRevision", 1L,
                        "definitionDigest", "a".repeat(64)));
        assertThat(AgentDefinitionExtensions.mcpServers(null, WorkspaceToolProfiles.FILES)).isEmpty();
        assertRefused("mcp_servers", () -> AgentDefinitionExtensions.mcpServers(null, WorkspaceToolProfiles.MCP));
        assertRefused("mcp_servers", () -> AgentDefinitionExtensions.mcpServers(List.of(MCP), WorkspaceToolProfiles.FILES));
        assertRefused("mcp_servers", () -> AgentDefinitionExtensions.mcpServers(List.of(MCP, MCP), WorkspaceToolProfiles.MCP));
        for (Object revision : List.of(0, -1, 1.5, "1", 9007199254740992L)) {
            Map<String, Object> pin = new LinkedHashMap<>(MCP);
            pin.put("server_revision", revision);
            assertRefused("mcp_servers", () -> AgentDefinitionExtensions.mcpServers(List.of(pin), WorkspaceToolProfiles.MCP));
        }
        Map<String, Object> pin = new LinkedHashMap<>(MCP);
        pin.put("server_revision", 9007199254740991L);
        assertThat(AgentDefinitionExtensions.mcpServers(List.of(pin), WorkspaceToolProfiles.MCP)
                .getFirst().get("serverRevision")).isEqualTo(9007199254740991L);
        pin.put("command", "forbidden");
        assertRefused("mcp_servers", () -> AgentDefinitionExtensions.mcpServers(List.of(pin), WorkspaceToolProfiles.MCP));
    }

    @Test
    void hookCatalogsRequireWorkspaceAndOnlyCarryTheDefinitionIdentity() {
        Map<String, Object> pin = new LinkedHashMap<>(Map.of("catalog_id", "review", "catalog_revision", 2,
                "definition_digest", "b".repeat(64)));
        assertThat(AgentDefinitionExtensions.hookCatalog(pin, true))
                .isEqualTo(Map.of("catalogId", "review", "catalogRevision", 2L, "definitionDigest", "b".repeat(64)));
        assertThat(AgentDefinitionExtensions.hookCatalog(null, false)).isNull();
        assertRefused("hook_catalog", () -> AgentDefinitionExtensions.hookCatalog(pin, false));
        pin.put("headers", Map.of("Authorization", "forbidden"));
        assertRefused("hook_catalog", () -> AgentDefinitionExtensions.hookCatalog(pin, true));
    }

    private static void assertRefused(String field, Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOfSatisfying(ManagedAgentException.class, error -> {
            assertThat(error.getStatus().value()).isEqualTo(409);
            assertThat(error.getCode()).isEqualTo("agent_definition_unsupported");
            assertThat(error.getDetails()).containsEntry("field", field);
        });
    }
}
