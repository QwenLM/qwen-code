package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Current;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Exact;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.ExtensionUse;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.InlineSkill;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.PreRegistered;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.SourceRef;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation.PreparedBundle;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinitionRequest;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.repository.ManagedDefinitionPreparationStore;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public final class ManagedDefinitionPreparationService implements ManagedAgentDefinitionPreparation {
    private final ManagedAgentDefinitionService definitions;
    private final ManagedDefinitionPreparationStore preparations;
    private final ManagedDefinitionInputProviders providers;
    private final RequestDigests digests;
    private final ObjectMapper json;
    private final ManagedAgentBootstrapPreparation bootstraps;

    public ManagedDefinitionPreparationService(ManagedAgentDefinitionService definitions,
            ManagedDefinitionPreparationStore preparations,
            ManagedDefinitionInputProviders providers, RequestDigests digests,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            ManagedAgentBootstrapPreparation bootstraps) {
        this.definitions = definitions;
        this.preparations = preparations;
        this.providers = providers;
        this.digests = digests;
        this.json = json;
        this.bootstraps = bootstraps;
    }

    @Override
    public PrepareReceipt prepare(Command command) {
        var context = new ManagedAgentDefinitionSource.Context(command.tenantId(),
                command.actorId(), command.workspaceId(), command.executionScope(),
                command.operationKey(), command.deadline());
        byte[] actor = ManagedSchemaKeys.identity(command.actorId());
        String scope = preparations.actorScope(actor);
        String commandDigest = digests.digest(Map.of(
                "tenantId", command.tenantId(), "actorId", command.actorId(),
                "workspaceId", command.workspaceId(), "executionScope", command.executionScope(),
                "selection", command.selection()));
        providers.requireExecutionAccess(context);
        var previous = preparations.begin(context.tenantId(), scope, command.operationKey(),
                commandDigest, actor, System.currentTimeMillis());
        if (previous.state() == ManagedDefinitionPreparationStore.State.PREPARED) {
            return new PrepareReceipt(new OperationRef(command.operationKey(), true),
                    previous.definition(), previous.bundles());
        }
        if (command.selection() instanceof PreRegistered registered) {
            providers.requirePreRegistered();
            requireDeadline(context);
            var result = definitions.create(command.tenantId(), command.operationKey(),
                    registered.definition());
            return complete(command, scope, previous, null, result.definition(), List.of());
        }

        ManagedAgentDefinitionSource.Definition input = previous.input();
        if (previous.state() == ManagedDefinitionPreparationStore.State.PENDING) {
            requireDeadline(context);
            var source = source(command.selection());
            input = source.resolve(context, command.selection());
            requireInput(command, input);
            try {
                preparations.resolve(context.tenantId(), scope, command.operationKey(), input,
                        json.writeValueAsString(Map.of("input", input)),
                        System.currentTimeMillis());
            } catch (JsonProcessingException error) {
                throw new IllegalArgumentException("The source definition cannot be saved", error);
            } catch (ManagedAgentException conflict) {
                var saved = saved(command, scope, commandDigest);
                if (saved.state() != ManagedDefinitionPreparationStore.State.PREPARED
                        && !input.equals(saved.input())) {
                    throw conflict;
                }
                input = saved.input();
            }
        }
        if (input == null) {
            throw new ManagedAgentException(409, "definition_projection_unresolved",
                    "An exact source projection must be saved before preparing content.");
        }
        requireInput(command, input);
        String nativeId = nativeId(context.tenantId(), input.ref());
        var result = definitions.prepare(context.tenantId(), nativeId, "source-" + nativeId,
                request(input));
        var bundles = bootstraps.prepare(context, input.bootstrapBundles());
        return complete(command, scope, previous, input, result.definition(), bundles);
    }

    private PrepareReceipt complete(Command command, String scope,
            ManagedDefinitionPreparationStore.Preparation previous,
            ManagedAgentDefinitionSource.Definition input,
            com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition definition,
            List<PreparedBundle> bundles) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (input != null) {
            result.put("input", input);
        }
        result.put("definition", definition);
        result.put("bundles", bundles);
        try {
            preparations.complete(command.tenantId(), scope, command.operationKey(), definition,
                    bundles, json.writeValueAsString(result), System.currentTimeMillis());
            return new PrepareReceipt(new OperationRef(command.operationKey(),
                    previous.state() != ManagedDefinitionPreparationStore.State.PENDING),
                    definition, bundles);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("The preparation result cannot be saved", error);
        } catch (ManagedAgentException conflict) {
            var saved = preparations.find(command.tenantId(), scope, command.operationKey(),
                    digests.digest(Map.of("tenantId", command.tenantId(),
                            "actorId", command.actorId(), "workspaceId", command.workspaceId(),
                            "executionScope", command.executionScope(), "selection", command.selection())))
                    .orElseThrow(() -> conflict);
            if (saved.state() != ManagedDefinitionPreparationStore.State.PREPARED
                    || !saved.definition().equals(definition)) {
                throw conflict;
            }
            return new PrepareReceipt(new OperationRef(command.operationKey(), true),
                    saved.definition(), saved.bundles());
        }
    }

    private ManagedAgentDefinitionSource source(ManagedAgentDefinitionSource.Selection selection) {
        if (selection instanceof Exact exact) {
            return providers.definition(exact.ref().providerId());
        }
        String agentKey = ((Current) selection).agentKey();
        return providers.definitionFor(agentKey);
    }

    private static AgentDefinitionRequest request(ManagedAgentDefinitionSource.Definition input) {
        List<Map<String, Object>> skills = input.skills().stream()
                .filter(InlineSkill.class::isInstance).map(InlineSkill.class::cast)
                .map(skill -> {
                    Map<String, Object> value = new LinkedHashMap<>();
                    value.put("name", skill.name());
                    value.put("description", skill.description());
                    value.put("body", skill.body());
                    value.put("base_directory", skill.baseDirectory());
                    return value;
                }).toList();
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sourceProjection", input.ref());
        metadata.put("extensionSkills", input.skills().stream()
                .filter(ExtensionUse.class::isInstance).toList());
        metadata.put("suites", input.suites());
        metadata.put("bootstrapBundles", input.bootstrapBundles());
        return new AgentDefinitionRequest(Map.of("id", input.modelId()), input.instructions(),
                List.of(Map.of("type", "hosted_profile", "profile", input.toolPolicy().profile())),
                skills, null, null, Map.of("approval_mode", input.toolPolicy().approvalMode()),
                null, metadata);
    }

    private static void requireInput(Command command, ManagedAgentDefinitionSource.Definition input) {
        if (input == null || !command.executionScope().equals(input.ref().executionScope())
                || (command.selection() instanceof Current current
                        && !current.agentKey().equals(input.ref().agentKey()))
                || (command.selection() instanceof Exact exact && !exact.ref().equals(input.ref()))) {
            throw new ManagedAgentException(409, "source_projection_conflict",
                    "The Source must return the requested scope and exact projection.");
        }
    }

    private ManagedDefinitionPreparationStore.Preparation saved(Command command, String scope,
            String commandDigest) {
        return preparations.find(command.tenantId(), scope, command.operationKey(), commandDigest)
                .orElseThrow(() -> new ManagedAgentException(409, "definition_preparation_conflict",
                        "The preparation has not saved its resolved projection."));
    }

    private static String nativeId(String tenantId, SourceRef ref) {
        return "agent_" + ManagedSchemaKeys.key("source-definition-v1", tenantId,
                ref.providerId(), ref.agentKey(), ref.sourceRevision(),
                ref.projectionDigest(), ref.executionScope()).substring(0, 32);
    }

    private static void requireDeadline(ManagedAgentDefinitionSource.Context context) {
        if (!Instant.now().isBefore(context.deadline()) || Thread.currentThread().isInterrupted()) {
            throw new ManagedAgentException(409, "definition_preparation_deadline_exceeded",
                    "The definition preparation deadline has passed.");
        }
    }
}
