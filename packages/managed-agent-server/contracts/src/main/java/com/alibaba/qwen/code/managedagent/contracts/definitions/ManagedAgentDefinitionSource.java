package com.alibaba.qwen.code.managedagent.contracts.definitions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.BundleRef;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinitionRequest;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

import java.time.Instant;
import java.util.List;

public interface ManagedAgentDefinitionSource {
    String id();

    Definition resolve(Context context, Selection selection);

    record Context(String tenantId, String actorId, String workspaceId,
            String executionScope, String requestId, Instant deadline) {
        public Context {
            SourceModelChecks.requireId("tenantId", tenantId);
            SourceModelChecks.requireId("actorId", actorId);
            SourceModelChecks.requireId("workspaceId", workspaceId);
            SourceModelChecks.requireId("executionScope", executionScope);
            SourceModelChecks.requireText("requestId", requestId);
            SourceModelChecks.requireDeadline(deadline);
        }
    }

    sealed interface Selection permits Current, Exact, PreRegistered {
    }

    record PreRegistered(AgentDefinitionRequest definition) implements Selection {
        public PreRegistered {
            if (definition == null) {
                throw new IllegalArgumentException("definition is required");
            }
        }
    }

    record Current(String agentKey) implements Selection {
        public Current {
            SourceModelChecks.requireId("agentKey", agentKey);
        }
    }

    record Exact(SourceRef ref) implements Selection {
        public Exact {
            if (ref == null) {
                throw new IllegalArgumentException("ref is required");
            }
        }
    }

    record SourceRef(String providerId, String agentKey, String sourceRevision,
            String projectionDigest, String executionScope) {
        public SourceRef {
            SourceModelChecks.requireProviderId(providerId);
            SourceModelChecks.requireId("agentKey", agentKey);
            SourceModelChecks.requireRevision(sourceRevision);
            SourceModelChecks.requireDigest(projectionDigest);
            SourceModelChecks.requireId("executionScope", executionScope);
        }
    }

    record ToolPolicy(String profile, String approvalMode) {
        public ToolPolicy {
            SourceModelChecks.requireText("profile", profile);
            SourceModelChecks.requireText("approvalMode", approvalMode);
        }
    }

    record Definition(SourceRef ref, String modelId, String instructions,
            ToolPolicy toolPolicy, List<SkillInput> skills,
            List<ExtensionUse> suites, List<BundleRef> bootstrapBundles) {
        public Definition {
            if (ref == null || toolPolicy == null || instructions == null) {
                throw new IllegalArgumentException("Definition content is incomplete");
            }
            skills = skills == null ? List.of() : List.copyOf(skills);
            suites = suites == null ? List.of() : List.copyOf(suites);
            bootstrapBundles = bootstrapBundles == null ? List.of() : List.copyOf(bootstrapBundles);
        }
    }

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
    @JsonSubTypes({
            @JsonSubTypes.Type(value = InlineSkill.class, name = "inline"),
            @JsonSubTypes.Type(value = ExtensionUse.class, name = "extension")
    })
    sealed interface SkillInput permits InlineSkill, ExtensionUse {
    }

    record ExtensionUse(ManagedExtensionSource.Reference source,
            ManagedExtensionPackages.Target target) implements SkillInput {
        public ExtensionUse {
            if (source == null || target == null) {
                throw new IllegalArgumentException("Extension source and target are required");
            }
        }
    }

    record InlineSkill(String name, String description, String body,
            String baseDirectory) implements SkillInput {
        public InlineSkill {
            SourceModelChecks.requireText("name", name);
            SourceModelChecks.requireText("description", description);
            SourceModelChecks.requireText("body", body);
            SourceModelChecks.requireText("baseDirectory", baseDirectory);
        }
    }
}
