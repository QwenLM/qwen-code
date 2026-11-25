package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.definitions.DefinitionInputMode;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

@Component
public final class ManagedDefinitionInputProviders {
    private final DefinitionInputMode mode;
    private final Map<String, ManagedAgentDefinitionSource> definitions;
    private final Map<String, AgentBootstrapBundleSource> bootstrapBundles;
    private final ManagedWorkspaceRegistry workspaces;

    public ManagedDefinitionInputProviders(
            @Value("${qwen.managed-agent.definition-input.mode:PRE_REGISTERED}") String mode,
            ObjectProvider<ManagedAgentDefinitionSource> definitions,
            ObjectProvider<AgentBootstrapBundleSource> bootstrapBundles,
            ManagedWorkspaceRegistry workspaces) {
        this.mode = DefinitionInputMode.parse(mode);
        this.definitions = index(definitions.orderedStream().toList(), ManagedAgentDefinitionSource::id);
        this.bootstrapBundles = index(bootstrapBundles.orderedStream().toList(), AgentBootstrapBundleSource::id);
        this.workspaces = workspaces;
    }

    @PostConstruct
    void validate() {
        if (mode == DefinitionInputMode.SPI && definitions.isEmpty()) {
            throw new IllegalStateException("definition-input.mode=SPI requires a definition Source provider");
        }
    }

    public ManagedAgentDefinitionSource definition(String providerId) {
        return requireProvider(definitions, providerId);
    }

    public ManagedAgentDefinitionSource definitionFor(String agentKey) {
        if (definitions.size() != 1) {
            throw new ManagedAgentException(400, "definition_provider_required",
                    "Select a provider before resolving the current definition of " + agentKey);
        }
        return requireProvider(definitions, definitions.keySet().iterator().next());
    }

    public AgentBootstrapBundleSource bundle(String providerId) {
        return requireProvider(bootstrapBundles, providerId);
    }

    public void requireExecutionAccess(ManagedAgentDefinitionSource.Context context) {
        var access = workspaces.accessOf(context.tenantId(), context.actorId(), context.workspaceId());
        if (!access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(403, "definition_scope_forbidden",
                    "The caller cannot prepare a definition in this Workspace.");
        }
    }

    public void requirePreRegistered() {
        if (mode != DefinitionInputMode.PRE_REGISTERED) {
            throw new ManagedAgentException(409, "definition_input_mode_conflict",
                    "Pre-registered input is unavailable in SPI mode.");
        }
    }

    public DefinitionInputMode mode() {
        return mode;
    }

    private <T> T requireProvider(Map<String, T> providers, String providerId) {
        if (mode != DefinitionInputMode.SPI) {
            throw new ManagedAgentException(409, "unsupported_feature",
                    "Definition input through SPI is not enabled.");
        }
        T provider = providers.get(providerId);
        if (provider == null) {
            throw new ManagedAgentException(503, "definition_source_unavailable",
                    "The configured definition Source provider is unavailable.");
        }
        return provider;
    }

    private static <T> Map<String, T> index(Iterable<T> providers, Function<T, String> id) {
        Map<String, T> indexed = new LinkedHashMap<>();
        for (T provider : providers) {
            String providerId = id.apply(provider);
            if (providerId == null || !providerId.matches("[a-z][a-z0-9-]{0,63}")) {
                throw new IllegalStateException("Invalid definition Source provider ID");
            }
            if (indexed.putIfAbsent(providerId, provider) != null) {
                throw new IllegalStateException("Duplicate definition Source provider: " + providerId);
            }
        }
        return Map.copyOf(indexed);
    }
}
