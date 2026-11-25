package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

import static com.alibaba.qwen.code.daemon.ManagedJson.put;

/** Request to admit a Session on a standalone Managed Agent Server. */
public final class ManagedCreateSessionRequest {
    private final Map<String, Object> json;

    private ManagedCreateSessionRequest(Map<String, Object> fields) {
        this.json = JsonSupport.immutableObject(fields);
    }

    /** Creates a builder for a registered Agent ID, such as {@code qwen-code}. */
    public static Builder builder(String agentId) {
        return new Builder(agentId);
    }

    Map<String, Object> toJson() {
        return json;
    }

    public static final class Builder {
        private final Map<String, Object> fields = new LinkedHashMap<>();

        private Builder(String agentId) {
            if (agentId == null || agentId.isBlank()) {
                throw new IllegalArgumentException("agentId must not be blank");
            }
            fields.put("agent_id", agentId);
        }

        /** Pins an Agent revision. By default the Server resolves its current revision. */
        public Builder agentRevision(String revision) {
            fields.put("agent_revision", Objects.requireNonNull(revision, "revision"));
            return this;
        }

        public Builder workspace(String workspaceId) {
            fields.put("workspace", Map.of("workspace_id", workspaceId));
            return this;
        }

        public Builder workspace(String workspaceId, String cwdRelative) {
            fields.put("workspace", Map.of("workspace_id", workspaceId, "cwd_relative", cwdRelative));
            return this;
        }

        /** Optionally admits the first Turn with the Session. */
        public Builder input(List<ManagedInput> input) {
            fields.put("input", input.stream().map(ManagedInput::toJson).collect(Collectors.toList()));
            return this;
        }

        /** Session title, sent as the Server's supported {@code metadata.title} field. */
        public Builder title(String title) {
            fields.put("metadata", Map.of("title", title));
            return this;
        }

        /** Static Skills to pin at admission. Nonempty input requires an explicit Workspace. */
        public Builder skills(List<Skill> skills) {
            fields.put("skills", skills.stream().map(skill -> skill.json).collect(Collectors.toList()));
            return this;
        }

        /** Explicit selection. An empty list suppresses the Server's default extension selection. */
        public Builder extensionPins(List<ManagedExtensionPin> pins) {
            fields.put("extensionPins", pins.stream().map(ManagedExtensionPin::json).collect(Collectors.toList()));
            return this;
        }

        /** Connection override for deployments that allow Session model configuration. */
        public Builder modelConfig(ModelConfig modelConfig) {
            fields.put("model_config", modelConfig.json);
            return this;
        }

        /** Prepares a worktree at the Workspace's HEAD at first admission. */
        public Builder worktree() {
            fields.put("worktree", Map.of());
            return this;
        }

        /** Prepares a worktree from the specified ref instead of HEAD. */
        public Builder worktree(String baseRef) {
            fields.put("worktree", Map.of("base_ref", baseRef));
            return this;
        }

        /** Binds a personal MemoryStore. */
        public Builder memoryStoreId(String memoryStoreId) {
            fields.put("memory_store_id", Objects.requireNonNull(memoryStoreId, "memoryStoreId"));
            return this;
        }

        /** Builds a request. Subscribe to events separately after creation. */
        public ManagedCreateSessionRequest build() {
            return new ManagedCreateSessionRequest(fields);
        }
    }

    /** Inline Skill instructions. Invocation defaults to enabled. */
    public static final class Skill {
        private final Map<String, Object> json;

        public Skill(String name, String description, String body) {
            this(name, description, body, null, null, null);
        }

        public Skill(String name, String description, String body, String baseDirectory,
                Boolean modelInvocable, Boolean userInvocable) {
            json = new LinkedHashMap<>(Map.of("name", name, "description", description, "body", body));
            put(json, "base_directory", baseDirectory);
            put(json, "model_invocable", modelInvocable);
            put(json, "user_invocable", userInvocable);
        }
    }

    public enum ModelProtocol {
        OPENAI("openai"),
        OPENAI_RESPONSES("openai-responses"),
        ANTHROPIC("anthropic"),
        GEMINI("gemini");

        private final String wire;

        ModelProtocol(String wire) {
            this.wire = wire;
        }
    }

    /** Session-specific connection. The API key is write-only. */
    public static final class ModelConfig {
        private final Map<String, Object> json;

        public ModelConfig(ModelProtocol protocol, String model, String baseUrl, String apiKey) {
            this(protocol, model, baseUrl, apiKey, null);
        }

        public ModelConfig(ModelProtocol protocol, String model, String baseUrl, String apiKey,
                GenerationConfig generationConfig) {
            json = new LinkedHashMap<>(Map.of("protocol", protocol.wire, "model", model,
                    "base_url", baseUrl, "api_key", apiKey));
            if (generationConfig != null) {
                json.put("generation_config", generationConfig.json);
            }
        }
    }

    /** Optional generation overrides. Unset properties use Server defaults. */
    public static final class GenerationConfig {
        private final Map<String, Object> json = new LinkedHashMap<>();

        public GenerationConfig(Double temperature, Double topP, Integer topK, Integer maxTokens,
                Double presencePenalty, Double frequencyPenalty, Integer seed) {
            put(json, "temperature", temperature);
            put(json, "top_p", topP);
            put(json, "top_k", topK);
            put(json, "max_tokens", maxTokens);
            put(json, "presence_penalty", presencePenalty);
            put(json, "frequency_penalty", frequencyPenalty);
            put(json, "seed", seed);
        }
    }
}
