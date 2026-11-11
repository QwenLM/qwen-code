package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionRecovery;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionRecoveryActions;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedAgentSessionCapabilitiesTest {
    @ParameterizedTest
    @CsvSource({"false,true", "false,false", "true,true", "true,false"})
    void publicChildRestrictionsComposeWithLifecycleOwnership(boolean child, boolean owner) {
        var store = mock(AgentStateStore.class);
        var workspaces = mock(JdbcManagedWorkspaceRegistry.class);
        var harness = mock(HarnessConnector.class);
        var warmer = mock(RuntimeWarmer.class);
        var service = new ManagedAgentService(store, new RequestDigests(),
                mock(HarnessCoordinator.class), harness, workspaces, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        service.setRuntimeWarmer(warmer);
        var workspace = new ContextBinding("tenant", "workspace", 1,
                "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var session = new SessionRecord("tenant", "session", "qwen-code", "1", "title",
                "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1, workspace, "default",
                WorkspaceToolProfiles.FILES, null, 1);
        when(store.workspaceFilesEnabled()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.supportsApprovalSelection()).thenReturn(true);
        when(harness.supportsPublicChildAgents()).thenReturn(true);
        when(harness.supportsPlanMode()).thenReturn(true);
        when(harness.supportsLifecycle(anyString())).thenReturn(true);
        when(warmer.supportsWorkspaceContextChange(workspace)).thenReturn(true);
        when(warmer.supportsWorkspaceClose(workspace)).thenReturn(true);
        when(workspaces.canRead("tenant", "actor", "workspace")).thenReturn(true);
        when(workspaces.findReadable(eq("tenant"), eq("actor"), anyCollection()))
                .thenReturn(Map.of("workspace",
                        new JdbcManagedWorkspaceRegistry.ReadableGrant("workspace", 1, "storage", true)));
        when(store.sessionsWithExecutionRegistryFacts(eq("tenant"), any())).thenReturn(Set.of("session"));
        when(store.findApprovalOwners("tenant", "actor", List.of("session")))
                .thenReturn(owner ? Set.of("session") : Set.of());
        when(store.supportsPlanMode(session)).thenReturn(true);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        when(store.listSessions("tenant", "actor", null, null, 10, "all"))
                .thenReturn(new SessionPage(List.of(session), false));
        when(store.findChildLineage("tenant", "session"))
                .thenReturn(child ? new SessionLineage("parent", "parent", "run", 1) : null);

        var views = List.of(service.getWebShellSession("tenant", "actor", "session"),
                service.listWebShellSessions("tenant", "actor", null, 10).data().getFirst());
        assertThat(views).allSatisfy(view -> {
            assertThat(view.capabilities().workspaceTurns()).isEqualTo(!child);
            assertThat(view.capabilities().cwdChange()).isFalse();
            assertThat(view.capabilities().approvalModeChange()).isEqualTo(!child && owner);
            assertThat(view.planModeSupported()).isEqualTo(!child && owner);
            assertThat(view.capabilities().sessionClose()).isEqualTo(owner);
            assertThat(view.capabilities().sessionDelete()).isEqualTo(owner);
            assertThat(view.capabilities().childAgents()).isEqualTo(!child);
        });
    }

    @Test
    void recoveryProjectionKeepsAnUnsettledLifecycleOperationOnSingleSessionReads() {
        var store = mock(AgentStateStore.class);
        var service = new ManagedAgentService(store, new RequestDigests(),
                mock(HarnessCoordinator.class), mock(HarnessConnector.class), mock(JdbcManagedWorkspaceRegistry.class), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        var session = new SessionRecord("tenant", "session", "qwen-code", "title", "CLOSING",
                null, null, 0, 0, 1, 1, null, 1);
        var operation = new WebShellLifecycleOperation("op-close", "close", "running", null);
        var recovery = new SessionRecovery("operator_required", "session_not_active", null, false,
                new SessionRecoveryActions(false, false, false), null);
        var recoveries = mock(SessionRecoveryService.class);
        var services = new StaticListableBeanFactory(Map.of("recovery", recoveries));
        service.setRecoveryServices(services.getBeanProvider(SessionRecoveryService.class));
        when(store.requireSession("tenant", "session")).thenReturn(session);
        when(store.findLatestLifecycleOperations("tenant", List.of("session")))
                .thenReturn(Map.of("session", operation));
        when(recoveries.projection(session, "actor")).thenReturn(recovery);

        var view = service.getWebShellSession("tenant", "actor", "session");

        assertThat(view.lifecycleOperation()).isEqualTo(operation);
        assertThat(view.recovery()).isEqualTo(recovery);
        assertThat(view.capabilities().workspaceTurns()).isFalse();
    }

    @Test
    void mixedPageDoesNotGrantApprovalSelectionToAnUnsupportedProfile() {
        var store = mock(AgentStateStore.class);
        var workspaces = mock(JdbcManagedWorkspaceRegistry.class);
        var harness = mock(HarnessConnector.class);
        var warmer = mock(RuntimeWarmer.class);
        var service = new ManagedAgentService(store, new RequestDigests(),
                mock(HarnessCoordinator.class), harness, workspaces, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        service.setRuntimeWarmer(warmer);
        var workspace = new ContextBinding("tenant", "workspace", 1,
                "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var supported = new SessionRecord("tenant", "supported", "qwen-code", "1", "Supported",
                "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1, workspace, "default", WorkspaceToolProfiles.FILES);
        var excluded = new SessionRecord("tenant", "excluded", "custom-agent", "1", "Excluded",
                "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1, workspace, "default", WorkspaceToolProfiles.FILES);
        when(store.workspaceFilesEnabled()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.supportsApprovalSelection()).thenReturn(true);
        when(harness.supportsPlanMode()).thenReturn(true);
        when(harness.supportsLifecycle(anyString())).thenReturn(true);
        when(warmer.supportsWorkspaceContextChange(workspace)).thenReturn(true);
        when(warmer.supportsWorkspaceClose(workspace)).thenReturn(true);
        when(workspaces.canRead("tenant", "actor", "workspace")).thenReturn(true);
        when(workspaces.findReadable(eq("tenant"), eq("actor"), anyCollection()))
                .thenReturn(Map.of("workspace",
                        new JdbcManagedWorkspaceRegistry.ReadableGrant("workspace", 1, "storage", true)));
        when(store.sessionsWithExecutionRegistryFacts(eq("tenant"), any()))
                .thenReturn(Set.of("supported", "excluded"));
        when(store.findApprovalOwners(eq("tenant"), eq("actor"), anyList()))
                .thenAnswer(call -> new HashSet<String>(call.getArgument(2)));
        when(store.supportsPlanMode(any()))
                .thenAnswer(call -> WorkspaceToolProfiles.supportsApprovalSelection(call.getArgument(0)));
        when(store.requireSession("tenant", "excluded")).thenReturn(excluded);
        when(store.listSessions("tenant", "actor", null, null, 10, "all"))
                .thenReturn(new SessionPage(List.of(supported, excluded), false));

        var views = service.listWebShellSessions("tenant", "actor", null, 10).data();
        assertThat(views.getFirst().capabilities().approvalModeChange()).isTrue();
        var view = views.getLast();
        assertThat(view.capabilities().cwdChange()).isFalse();
        assertThat(view.capabilities().sessionClose()).isTrue();
        assertThat(view.planModeSupported()).isFalse();
        assertThat(service.getWebShellSession("tenant", "actor", "excluded")
                .capabilities().approvalModeChange()).isFalse();
        assertThat(view.capabilities().approvalModeChange()).isFalse();
    }

    @ParameterizedTest
    @CsvSource({
        "csi-files-retirement/1,ACTIVE,true,true,true", "csi-files-retirement/1,CLOSED,true,true,true",
        "csi-files-retirement/2,ACTIVE,true,true,true", "csi-files-retirement/2,CLOSED,true,true,true",
        "hosted-workspace-files/1,ACTIVE,true,true,true", "hosted-workspace-files/1,CLOSED,true,true,true",
        "hosted-workspace-files/1,ACTIVE,false,true,true", "hosted-workspace-files/1,ACTIVE,true,false,true",
        "hosted-workspace-files/1,ACTIVE,true,true,false"
    })
    void publicAndWebShellViewsUseBindingCloseSupportAndKeepPrivateCsiUnavailable(String profile, String status,
            boolean globalSupport, boolean bindingSupport, boolean harnessSupport) {
        boolean csi = CsiFilesRetirementProfile.isProfile(profile);
        var store = mock(AgentStateStore.class);
        var workspaces = mock(JdbcManagedWorkspaceRegistry.class);
        var harness = mock(HarnessConnector.class);
        var warmer = mock(RuntimeWarmer.class);
        var service = new ManagedAgentService(store, new RequestDigests(),
                mock(HarnessCoordinator.class), harness, workspaces, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        service.setRuntimeWarmer(warmer);
        when(store.workspaceFilesEnabled()).thenReturn(true);
        when(warmer.supportsWorkspaceClose()).thenReturn(globalSupport);
        when(harness.supportsLifecycle(anyString())).thenReturn(harnessSupport);
        when(workspaces.canRead("tenant", "actor", "workspace")).thenReturn(true);
        var workspace = new ContextBinding("tenant", "workspace", 1,
                "storage", ".", "config", 1);
        when(warmer.supportsWorkspaceClose(workspace)).thenReturn(bindingSupport);
        var session = new SessionRecord("tenant", "session", "agent", "1", "title",
                status, null, null, 0, 0, 0, 1, 1, null, 1, workspace, "default",
                profile);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        when(store.listSessions("tenant", "actor", null, null, 10))
                .thenReturn(new SessionPage(List.of(session), false));
        when(store.listSessions("tenant", "actor", null, null, 10, "all"))
                .thenReturn(new SessionPage(List.of(session), false));
        when(store.findApprovalOwners("tenant", "actor", List.of("session")))
                .thenReturn(Set.of("session"));
        when(store.completedWorkspaceCloses("tenant", List.of("session")))
                .thenReturn("CLOSED".equals(status) ? Set.of("session") : Set.of());

        var publicViews = List.of(service.getPublicSession("tenant", "actor", "session"),
                service.listPublicSessions("tenant", "actor", null, 10).data().getFirst());
        assertThat(publicViews).allSatisfy(view -> {
            assertThat(view.capabilities().sessionClose()).isEqualTo(!csi && bindingSupport && harnessSupport);
            assertThat(view.capabilities().sessionDelete())
                    .isEqualTo(!csi && ("CLOSED".equals(status) || bindingSupport && harnessSupport));
        });
        var webShellViews = List.of(service.getWebShellSession("tenant", "actor", "session"),
                service.listWebShellSessions("tenant", "actor", null, 10).data().getFirst());
        assertThat(webShellViews).allSatisfy(view -> {
            assertThat(view.capabilities().sessionClose()).isEqualTo(!csi && bindingSupport && harnessSupport);
            assertThat(view.capabilities().sessionDelete())
                    .isEqualTo(!csi && ("CLOSED".equals(status) || bindingSupport && harnessSupport));
        });
    }

    @ParameterizedTest
    @CsvSource({
        "true,true,ACTIVE,true,true",
        "true,true,CLOSED,true,false",
        "false,true,ACTIVE,true,false",
        "true,false,ACTIVE,true,false",
        // Registration refuses a Workspace-less Session, so the capability
        // must not advertise it there even with the flag and harness on.
        "true,true,ACTIVE,false,false"
    })
    void clientFilesCapabilityRequiresTheDeploymentFlagHarnessSupportAndAnActiveSession(boolean enabled,
            boolean harnessSupports, String status, boolean hasWorkspace, boolean expected) {
        var store = mock(AgentStateStore.class);
        var harness = mock(HarnessConnector.class);
        var workspaces = mock(JdbcManagedWorkspaceRegistry.class);
        var service = new ManagedAgentService(store, new RequestDigests(),
                mock(HarnessCoordinator.class), harness, workspaces,
                new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        var workspace = new ContextBinding("tenant", "workspace", 1,
                "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var session = hasWorkspace
                ? new SessionRecord("tenant", "session", "qwen-code", "1", "title", status,
                        null, null, 0, 0, 0, 1, 1, null, 1, workspace, "default",
                        WorkspaceToolProfiles.FILES, null, 1)
                : new SessionRecord("tenant", "session", "qwen-code", "title", status,
                        null, null, 0, 0, 1, 1, null, 1);
        when(store.workspaceFilesEnabled()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(workspaces.canRead("tenant", "actor", "workspace")).thenReturn(true);
        when(workspaces.findReadable(eq("tenant"), eq("actor"), anyCollection()))
                .thenReturn(Map.of("workspace",
                        new JdbcManagedWorkspaceRegistry.ReadableGrant("workspace", 1, "storage", true)));
        when(store.sessionsWithExecutionRegistryFacts(eq("tenant"), any())).thenReturn(Set.of("session"));
        when(store.requireSession("tenant", "session")).thenReturn(session);
        assertThat(service.getWebShellSession("tenant", "actor", "session")
                .capabilities().clientFiles()).isFalse();

        var settings = mock(ManagedAgentSettings.class);
        var clientFiles = mock(ManagedAgentSettings.ClientFiles.class);
        when(settings.getClientFiles()).thenReturn(clientFiles);
        when(clientFiles.isEnabled()).thenReturn(enabled);
        when(harness.supportsClientFiles()).thenReturn(harnessSupports);
        service.configureClientFiles(settings);

        assertThat(service.getWebShellSession("tenant", "actor", "session")
                .capabilities().clientFiles()).isEqualTo(expected);
    }
}
