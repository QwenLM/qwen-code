package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Compiles a stored AgentDefinition revision into the fields that take
 * effect at Session admission (D8c-1): the approval mode and the tool
 * profile a Session pins. Content that cannot take effect refuses
 * admission with {@code 409 agent_definition_unsupported} naming the field,
 * instead of being dropped.
 */
public final class AgentDefinitionCompiler {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> CONTENT =
            new TypeReference<>() {
            };
    private static final List<String> APPROVAL_MODES = List.of("default",
            "auto-edit", "yolo");

    public record Compiled(String modelId, String instructions,
            String approvalMode, String toolProfile,
            List<Map<String, Object>> skills,
            List<Map<String, Object>> mcpServers,
            Map<String, Object> hookCatalog, boolean hookCatalogPresent) {
    }

    private AgentDefinitionCompiler() {
    }

    public static Compiled compile(String definitionJson, boolean workspaceBound,
            String deploymentApprovalMode, List<String> toolProfiles) {
        return compile(definitionJson, workspaceBound,
                deploymentApprovalMode, toolProfiles, List.of());
    }

    public static Compiled compile(String definitionJson, boolean workspaceBound,
            String deploymentApprovalMode, List<String> toolProfiles,
            List<String> models) {
        return compile(definitionJson, workspaceBound, deploymentApprovalMode,
                toolProfiles, models, false);
    }

    /**
     * {@code stored} validates a definition this deployment already persisted.
     * Its pins were written under the bound in force at that time, so they are
     * read at the stored bound; a definition that cannot be read wedges its
     * Session out of every path, and attach is the delete precondition.
     */
    public static Compiled compile(String definitionJson, boolean workspaceBound,
            String deploymentApprovalMode, List<String> toolProfiles,
            List<String> models, boolean stored) {
        Map<String, Object> definition = definition(definitionJson);
        String modelId = model(definition.get("model"), models);
        String instructions = instructions(definition.get("instructions"));
        String approvalMode = approvalMode(definition.get("permission_policy"),
                deploymentApprovalMode);
        String toolProfile = toolProfile(definition.get("tools"), workspaceBound,
                approvalMode, toolProfiles);
        List<Map<String, Object>> skills = AgentDefinitionExtensions.skills(
                definition.get("skills"), toolProfile != null);
        List<Map<String, Object>> mcpServers = AgentDefinitionExtensions.mcpServers(
                definition.get("mcp_servers"), toolProfile, stored);
        Map<String, Object> hookCatalog = AgentDefinitionExtensions.hookCatalog(
                definition.get("hook_catalog"), toolProfile != null, stored);
        if (definition.get("environment_template_id") != null) {
            throw unsupported("environment_template_id");
        }
        return new Compiled(modelId, instructions, approvalMode, toolProfile,
                skills, mcpServers, hookCatalog,
                definition.containsKey("hook_catalog"));
    }

    /** Projects a pinned Session without reapplying current admission allowlists. */
    public static Compiled fromPinnedContent(Map<String, Object> definition,
            boolean workspaceBound, String approvalMode, String toolProfile) {
        return new Compiled(model(definition.get("model"), null),
                instructions(definition.get("instructions")), approvalMode,
                toolProfile,
                AgentDefinitionExtensions.skills(definition.get("skills"),
                        workspaceBound),
                AgentDefinitionExtensions.mcpServers(
                        definition.get("mcp_servers"), toolProfile, true),
                AgentDefinitionExtensions.hookCatalog(
                        definition.get("hook_catalog"), workspaceBound, true),
                definition.containsKey("hook_catalog"));
    }

    private static Map<String, Object> definition(String definitionJson) {
        try {
            return JSON.readValue(definitionJson, CONTENT);
        } catch (Exception error) {
            throw new IllegalStateException(
                    "A stored agent definition is not valid JSON", error);
        }
    }

    private static String model(Object value, List<String> models) {
        if (value == null) {
            return null;
        }
        if (!(value instanceof Map<?, ?> map)) {
            throw unsupported("model");
        }
        if (map.isEmpty()) {
            return null;
        }
        if (map.size() != 1 || !(map.get("id") instanceof String id)
                || id.isBlank() || models != null && !models.contains(id)) {
            throw unsupported("model");
        }
        return id;
    }

    private static String instructions(Object value) {
        if (value == null) {
            return null;
        }
        if (!(value instanceof String text)
                || text.getBytes(StandardCharsets.UTF_8).length
                        > ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES) {
            throw unsupported("instructions");
        }
        return text;
    }

    private static String approvalMode(Object value,
            String deploymentApprovalMode) {
        if (value == null) {
            return deploymentApprovalMode;
        }
        if (!(value instanceof Map<?, ?> map)) {
            throw unsupported("permission_policy");
        }
        if (map.isEmpty()) {
            return deploymentApprovalMode;
        }
        if (map.size() == 1
                && map.get("approval_mode") instanceof String mode
                && APPROVAL_MODES.contains(mode)) {
            return mode;
        }
        throw unsupported("permission_policy");
    }

    private static String toolProfile(Object value, boolean workspaceBound,
            String approvalMode, List<String> toolProfiles) {
        List<?> tools = value == null ? List.of()
                : value instanceof List<?> list ? list : null;
        if (tools == null) {
            throw unsupported("tools");
        }
        if (!workspaceBound) {
            if (!tools.isEmpty()) {
                throw unsupported("tools");
            }
            return null;
        }
        if (tools.size() != 1 || !(tools.getFirst() instanceof Map<?, ?> entry)
                || entry.size() != 2
                || !"hosted_profile".equals(entry.get("type"))
                || !(entry.get("profile") instanceof String profile)) {
            throw unsupported("tools");
        }
        if (WorkspaceToolProfiles.isInternalTeamLead(profile)
                || profile.startsWith("hosted-workspace-shell/")
                        && !WorkspaceToolProfiles.isPublicShell(profile)
                || !toolProfiles.contains(profile)) {
            throw unsupported("tools");
        }
        // Shell definitions must start with an asking policy (#13271).
        // An eligible Session owner may select Full Access later.
        if (profile.startsWith("hosted-workspace-shell/")
                && "yolo".equals(approvalMode)) {
            throw unsupported("tools");
        }
        return profile;
    }

    private static ManagedAgentException unsupported(String field) {
        return new ManagedAgentException(409,
                "agent_definition_unsupported",
                "The agent definition field cannot take effect yet.",
                Map.of("field", field));
    }
}
