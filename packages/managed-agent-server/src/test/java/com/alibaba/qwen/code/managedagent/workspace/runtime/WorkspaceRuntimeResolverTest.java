package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry.RegisteredExternalStorage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class WorkspaceRuntimeResolverTest {
    private final AgentStateStore sessions = mock(AgentStateStore.class);
    private final WorkspaceExecutionStore authority = mock(WorkspaceExecutionStore.class);
    private final ExternalStorageRegistry registrations = mock(ExternalStorageRegistry.class);
    private final ManagedAgentProperties properties = new ManagedAgentProperties();
    private final SessionRecord session = mock(SessionRecord.class);
    private final ContextBinding binding = new ContextBinding("tenant", "workspace", 7, "workspace", ".",
            WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);

    @BeforeEach
    void setUp() {
        properties.getRuntimeBroker().setBoundSessionIsolationClass("session");
        when(sessions.findSessionById("session")).thenReturn(Optional.of(session));
        when(session.tenantId()).thenReturn("tenant");
        when(session.workspace()).thenReturn(binding);
        when(authority.isExternal(binding)).thenReturn(true);
        when(registrations.find("tenant", "workspace")).thenReturn(Optional.of(registration("workspace")));
    }

    @Test
    void externalScopeUsesRegisteredMountAndAuthorizesSavedSession() {
        var resolved = resolver().resolve("session");
        assertThat(resolved.binding()).isEqualTo(binding);
        assertThat(resolved.scope().getTenantId()).isEqualTo("tenant");
        assertThat(resolved.scope().getWorkspaceId()).isEqualTo("workspace");
        assertThat(resolved.scope().getWorkspaceGeneration()).isEqualTo("7");
        assertThat(resolved.scope().getCanonicalCwd()).isEqualTo("/worker/registered-root");
        assertThat(resolved.scope().getCapabilityDigest()).isEqualTo(WorkspaceExecutionProfile.CAPABILITY_DIGEST);
        assertThat(resolved.scope().getIsolationClass()).isEqualTo("session");
        verify(authority).authorizeExternal(session, null);
        verify(authority, never()).authorize(session);
    }

    @Test
    void externalHooksAreRefusedBeforeAuthorizationOrRegistrationLookup() {
        refused(() -> resolver().resolveHook("session", null));
        verify(authority, never()).authorizeExternal(session, null);
        verifyNoInteractions(registrations);
    }

    @Test
    void externalManagedExtensionsAreRefusedEvenWhenExtensionsAreConfigured() {
        properties.getExtensions().setEnabled(true);
        properties.getManagedExtensions().setEnabled(true);
        refused(() -> resolver().resolve("session"));
        verify(authority, never()).authorizeExternal(session, null);
        verifyNoInteractions(registrations);
    }

    @Test
    void externalRegistrationCannotResolveAnotherWorkspace() {
        when(registrations.find("tenant", "workspace")).thenReturn(Optional.of(registration("other-workspace")));
        refused(() -> resolver().resolve("session"));
        verify(authority).authorizeExternal(session, null);
    }

    private WorkspaceRuntimeResolver resolver() {
        return new WorkspaceRuntimeResolver(sessions, authority, properties, null, registrations);
    }

    private static RegisteredExternalStorage registration(String workspace) {
        return new RegisteredExternalStorage("provider", "physical", 1, workspace,
                "/aliases/registered-root", "/worker/registered-root");
    }

    private static void refused(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
            assertThat(error.getStatusCode()).isEqualTo(409);
            assertThat(error.getCode()).isEqualTo("workspace_unavailable");
            assertThat(error.isRetryable()).isFalse();
        });
    }
}
