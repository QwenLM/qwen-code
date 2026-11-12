package com.alibaba.qwen.code.managedagent.contracts.automation;

import com.alibaba.qwen.code.managedagent.model.ApiModels.AutomationDefinitionRequest;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Request bodies of the internal Session-scoped automation routes. Each carries
 * the writer binding (workspaceId/writerId/writerGeneration) the store channel
 * already uses, so the route can authorize the exact Session before delegating
 * to the automation service as the Session's creator.
 */
public final class AutomationSessionModels {
    private AutomationSessionModels() {
    }

    public record Binding(
            @NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 512) String writerId,
            @Min(1) @Max(9007199254740991L) long writerGeneration) {
    }

    public record Create(
            @JsonProperty("workspace_id") @NotBlank @Size(max = 512) String workspaceId,
            @JsonProperty("writer_id") @NotBlank @Size(max = 512) String writerId,
            @JsonProperty("writer_generation") @Min(1) @Max(9007199254740991L) long writerGeneration,
            AutomationDefinitionRequest definition) {
    }

    public record ListRequest(
            @JsonProperty("workspace_id") @NotBlank @Size(max = 512) String workspaceId,
            @JsonProperty("writer_id") @NotBlank @Size(max = 512) String writerId,
            @JsonProperty("writer_generation") @Min(1) @Max(9007199254740991L) long writerGeneration,
            String cursor, Integer limit) {
    }

    public record Retire(
            @JsonProperty("workspace_id") @NotBlank @Size(max = 512) String workspaceId,
            @JsonProperty("writer_id") @NotBlank @Size(max = 512) String writerId,
            @JsonProperty("writer_generation") @Min(1) @Max(9007199254740991L) long writerGeneration,
            @JsonProperty("automation_id") @NotBlank String automationId) {
    }
}