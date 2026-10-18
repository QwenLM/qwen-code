package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedAgentSessionCapabilitiesTest {
    @ParameterizedTest
    @CsvSource({
        "true,ACTIVE,true,true,true", "true,CLOSED,true,true,true",
        "false,ACTIVE,true,true,true", "false,CLOSED,true,true,true",
        "false,ACTIVE,false,true,true", "false,ACTIVE,true,false,true",
        "false,ACTIVE,true,true,false"
    })
    void publicAndWebShellViewsUseBindingCloseSupportAndKeepPrivateCsiUnavailable(boolean csi, String status,
            boolean globalSupport, boolean bindingSupport, boolean harnessSupport) {
        var store = mock(AgentStateStore.class);
        var workspaces = mock(ManagedWorkspaceRegistry.class);
        var harness = mock(HarnessConnector.class);
        var warmer = mock(RuntimeWarmer.class);
        var service = new ManagedAgentService(store, new RequestDigests(),
                mock(HarnessCoordinator.class), harness, workspaces);
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
                csi ? CsiFilesRetirementProfile.PROFILE : WorkspaceToolProfiles.FILES);
        when(store.requireSession("tenant", "session")).thenReturn(session);
        when(store.listSessions("tenant", "actor", null, null, 10))
                .thenReturn(new SessionPage(List.of(session), false));
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
}
