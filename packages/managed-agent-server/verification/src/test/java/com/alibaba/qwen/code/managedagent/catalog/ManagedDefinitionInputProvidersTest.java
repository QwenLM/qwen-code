package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Context;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedDefinitionInputProvidersTest {
    private final ManagedAgentDefinitionSource definitions = mock(ManagedAgentDefinitionSource.class);
    private final AgentBootstrapBundleSource bundles = mock(AgentBootstrapBundleSource.class);
    private final ManagedWorkspaceRegistry workspaces = mock(ManagedWorkspaceRegistry.class);

    @Test
    void preservesPreRegisteredBehaviorWithoutProviders() {
        var providers = registry("PRE_REGISTERED", List.of(), List.of());
        providers.validate();

        assertThat(providers.mode()).isEqualTo(
                com.alibaba.qwen.code.managedagent.contracts.definitions.DefinitionInputMode.PRE_REGISTERED);
        assertThatThrownBy(() -> providers.definition("catalog"))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(409));
    }

    @Test
    void refusesSpiWithoutADefinedProviderOrWithDuplicateIds() {
        when(definitions.id()).thenReturn("catalog", "catalog");

        assertThatThrownBy(() -> registry("SPI", List.of(), List.of()).validate())
                .isInstanceOfSatisfying(IllegalStateException.class,
                        error -> assertThat(error).hasMessageContaining("definition Source provider"));
        assertThatThrownBy(() -> registry("SPI", List.of(definitions, definitions), List.of()))
                .isInstanceOfSatisfying(IllegalStateException.class,
                        error -> assertThat(error).hasMessageContaining("Duplicate"));
    }

    @Test
    void rejectsAnInvalidProviderId() {
        when(definitions.id()).thenReturn("UPPER");

        assertThatThrownBy(() -> registry("SPI", List.of(definitions), List.of()))
                .isInstanceOfSatisfying(IllegalStateException.class,
                        error -> assertThat(error).hasMessageContaining("Invalid definition Source provider ID"));
    }

    @Test
    void checksWorkspaceOperatorAccessBeforeUsingAnySource() {
        when(definitions.id()).thenReturn("catalog");
        when(bundles.id()).thenReturn("catalog");
        when(workspaces.accessOf("tenant", "actor", "workspace-1"))
                .thenReturn(WorkspaceAccess.READER);
        var providers = registry("SPI", List.of(definitions), List.of(bundles));
        var context = new Context("tenant", "actor", "workspace-1", "workspace-1", "request-1",
                Instant.now().plusSeconds(60));

        assertThatThrownBy(() -> providers.requireExecutionAccess(context))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(403));

        when(workspaces.accessOf("tenant", "actor", "workspace-1"))
                .thenReturn(WorkspaceAccess.OPERATOR);
        providers.requireExecutionAccess(context);
        assertThat(providers.definition("catalog")).isSameAs(definitions);
        assertThat(providers.bundle("catalog")).isSameAs(bundles);
    }

    @SuppressWarnings("unchecked")
    private ManagedDefinitionInputProviders registry(String mode,
            List<ManagedAgentDefinitionSource> sources,
            List<AgentBootstrapBundleSource> bundleSources) {
        ObjectProvider<ManagedAgentDefinitionSource> definitionProvider = mock(ObjectProvider.class);
        ObjectProvider<AgentBootstrapBundleSource> bundleProvider = mock(ObjectProvider.class);
        when(definitionProvider.orderedStream()).thenReturn(sources.stream());
        when(bundleProvider.orderedStream()).thenReturn(bundleSources.stream());
        return new ManagedDefinitionInputProviders(mode, definitionProvider, bundleProvider, workspaces);
    }
}
