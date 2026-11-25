package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/** Definition content shared by Agent creation and revision updates. */
public final class ManagedAgentDefinitionRequest {
    private final Map<String, Object> json;

    private ManagedAgentDefinitionRequest(Map<String, Object> fields) {
        json = JsonSupport.immutableObject(fields);
    }

    /** Starts with the deployment model and approval policy and no hosted tools. */
    public static Builder builder(String instructions) {
        return new Builder(instructions);
    }

    Map<String, Object> toJson() {
        return json;
    }

    public static final class Builder {
        private final Map<String, Object> fields = new LinkedHashMap<>();

        private Builder(String instructions) {
            fields.put("model", Map.of());
            fields.put("instructions", Objects.requireNonNull(instructions, "instructions"));
            fields.put("tools", List.of());
            fields.put("permission_policy", Map.of());
        }

        /** Selects a model that the deployment allows for AgentDefinitions. */
        public Builder model(ModelReference model) {
            fields.put("model", Map.of("id", model.id));
            return this;
        }

        /** Binds one deployment-allowlisted profile for Workspace Sessions. */
        public Builder hostedToolProfile(HostedToolProfile profile) {
            fields.put("tools", List.of(Map.of("type", "hosted_profile", "profile", profile.wire)));
            return this;
        }

        /** Overrides the deployment approval policy for Sessions that pin this definition. */
        public Builder approvalPolicy(ApprovalPolicy policy) {
            fields.put("permission_policy", Map.of("approval_mode", policy.wire));
            return this;
        }

        public Builder skills(List<StaticSkill> skills) {
            fields.put("skills", skills.stream().map(skill -> skill.json).collect(Collectors.toList()));
            return this;
        }

        public Builder mcpServers(List<ManagedMcpServerPin> servers) {
            fields.put("mcp_servers", servers.stream().map(ManagedMcpServerPin::toAgentDefinitionJson)
                    .collect(Collectors.toList()));
            return this;
        }

        public Builder hookCatalog(HookCatalogPin catalog) {
            fields.put("hook_catalog", Objects.requireNonNull(catalog, "catalog").json);
            return this;
        }

        /** Stores a template reference. Session admission currently requires this field to be omitted. */
        public Builder environmentTemplateId(String id) {
            fields.put("environment_template_id", Objects.requireNonNull(id, "id"));
            return this;
        }

        public Builder metadata(Map<String, ?> metadata) {
            fields.put("metadata", Objects.requireNonNull(metadata, "metadata"));
            return this;
        }

        public ManagedAgentDefinitionRequest build() {
            return new ManagedAgentDefinitionRequest(fields);
        }
    }

    /** A deployment model ID. */
    public static final class ModelReference {
        private final String id;

        public ModelReference(String id) {
            if (id == null || id.isBlank()) {
                throw new IllegalArgumentException("model ID must not be blank");
            }
            this.id = id;
        }
    }

    /** Versioned hosted tool profile. The deployment chooses which profiles are available. */
    public static final class HostedToolProfile {
        public static final HostedToolProfile FILES = of("hosted-workspace-files/1");
        public static final HostedToolProfile FILES_V2 = of("hosted-workspace-files/2");
        public static final HostedToolProfile FILES_V3 = of("hosted-workspace-files/3");
        public static final HostedToolProfile FILES_V4 = of("hosted-workspace-files/4");
        public static final HostedToolProfile SHELL = of("hosted-workspace-shell/1");
        public static final HostedToolProfile SHELL_V3 = of("hosted-workspace-shell/3");
        public static final HostedToolProfile SHELL_V4 = of("hosted-workspace-shell/4");
        public static final HostedToolProfile MCP = of("hosted-workspace-mcp/1");

        private final String wire;

        private HostedToolProfile(String wire) {
            this.wire = wire;
        }

        /** Names an additional profile supported and allowlisted by the deployment. */
        public static HostedToolProfile of(String profileId) {
            if (profileId == null || profileId.isBlank()) {
                throw new IllegalArgumentException("profile ID must not be blank");
            }
            return new HostedToolProfile(profileId);
        }
    }

    /** Explicit approval modes accepted by the AgentDefinition compiler. */
    public enum ApprovalPolicy {
        DEFAULT("default"),
        AUTO_EDIT("auto-edit"),
        YOLO("yolo");

        private final String wire;

        ApprovalPolicy(String wire) {
            this.wire = wire;
        }
    }

    /** An inline AgentDefinition Skill. The default base directory is the Session working directory. */
    public static final class StaticSkill {
        private final Map<String, Object> json;

        public StaticSkill(String name, String description, String body) {
            this(name, description, body, null);
        }

        public StaticSkill(String name, String description, String body, String baseDirectory) {
            json = new LinkedHashMap<>(Map.of("name", name, "description", description, "body", body));
            ManagedJson.put(json, "base_directory", baseDirectory);
        }
    }

    /** A Runtime-provisioned Hook catalog and its exact revision. */
    public static final class HookCatalogPin {
        private final Map<String, Object> json;

        public HookCatalogPin(String catalogId, long catalogRevision, String definitionDigest) {
            json = Map.of("catalog_id", catalogId, "catalog_revision", catalogRevision,
                    "definition_digest", definitionDigest);
        }
    }
}
