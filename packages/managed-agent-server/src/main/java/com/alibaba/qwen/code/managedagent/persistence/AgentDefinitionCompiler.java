package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;

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
final class AgentDefinitionCompiler {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> CONTENT =
            new TypeReference<>() {
            };
    private static final List<String> APPROVAL_MODES = List.of("default",
            "auto-edit", "yolo");

    record Compiled(String approvalMode, String toolProfile) {
    }

    private AgentDefinitionCompiler() {
    }

    static Compiled compile(String definitionJson, boolean workspaceBound,
            String deploymentApprovalMode, List<String> toolProfiles) {
        return compile(definitionJson, workspaceBound,
                deploymentApprovalMode, toolProfiles, List.of());
    }

    static Compiled compile(String definitionJson, boolean workspaceBound,
            String deploymentApprovalMode, List<String> toolProfiles,
            List<String> models) {
        Map<String, Object> definition;
        try {
            definition = JSON.readValue(definitionJson, CONTENT);
        } catch (Exception error) {
            throw new IllegalStateException(
                    "A stored agent definition is not valid JSON", error);
        }
        Object model = definition.get("model");
        if (model instanceof Map<?, ?> map) {
            if (!map.isEmpty() && !(map.size() == 1
                    && map.get("id") instanceof String id
                    && !id.isBlank() && models.contains(id))) {
                throw unsupported("model");
            }
        } else if (model != null) {
            throw unsupported("model");
        }
        Object instructions = definition.get("instructions");
        if (instructions != null && (!(instructions instanceof String text)
                || text.getBytes(StandardCharsets.UTF_8).length
                        > ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES)) {
            throw unsupported("instructions");
        }
        String approvalMode = deploymentApprovalMode;
        Object policy = definition.get("permission_policy");
        if (policy instanceof Map<?, ?> map) {
            if (!map.isEmpty()) {
                if (map.size() == 1
                        && map.get("approval_mode") instanceof String mode
                        && APPROVAL_MODES.contains(mode)) {
                    approvalMode = mode;
                } else {
                    throw unsupported("permission_policy");
                }
            }
        } else if (policy != null) {
            throw unsupported("permission_policy");
        }
        Object raw = definition.get("tools");
        List<?> tools = raw == null ? List.of()
                : raw instanceof List<?> list ? list : null;
        if (tools == null) {
            throw unsupported("tools");
        }
        String toolProfile = null;
        if (!workspaceBound) {
            if (!tools.isEmpty()) {
                throw unsupported("tools");
            }
        } else {
            if (tools.size() != 1 || !(tools.getFirst() instanceof Map<?, ?> entry)
                    || entry.size() != 2
                    || !"hosted_profile".equals(entry.get("type"))
                    || !(entry.get("profile") instanceof String profile)) {
                throw unsupported("tools");
            } else {
                if (WorkspaceToolProfiles.INTERNAL_TEAM_LEAD.equals(profile)
                        || !toolProfiles.contains(profile)) {
                    throw unsupported("tools");
                }
                // Shell definitions must start with an asking policy (#13271).
                // An eligible Session owner may select Full Access later.
                if (profile.startsWith("hosted-workspace-shell/")
                        && "yolo".equals(approvalMode)) {
                    throw unsupported("tools");
                }
                toolProfile = profile;
            }
        }
        AgentDefinitionExtensions.skills(definition.get("skills"), toolProfile != null);
        AgentDefinitionExtensions.mcpServers(definition.get("mcp_servers"), toolProfile);
        AgentDefinitionExtensions.hookCatalog(definition.get("hook_catalog"), toolProfile != null);
        if (definition.get("environment_template_id") != null) {
            throw unsupported("environment_template_id");
        }
        return new Compiled(approvalMode, toolProfile);
    }

    private static ManagedAgentException unsupported(String field) {
        return new ManagedAgentException(HttpStatus.CONFLICT,
                "agent_definition_unsupported",
                "The agent definition field cannot take effect yet.",
                Map.of("field", field));
    }
}
