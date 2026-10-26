package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeWarmer;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionLifecycleProtocolChoiceTest {
    @ParameterizedTest
    @CsvSource({"true,true", "true,false", "false,true", "false,false"})
    void closeAdmissionUsesTheSelectedBindingInsteadOfGlobalSupport(boolean activeLifecycle, boolean supported) {
        var store = mock(AgentStateStore.class);
        var sessions = mock(ManagedAgentService.class);
        var coordinator = mock(SessionLifecycleCoordinator.class);
        var warmer = mock(RuntimeWarmer.class);
        var binding = new ContextBinding("tenant", "workspace", 1, "storage", ".", "config", 1);
        var session = new SessionRecord("tenant", "session", "agent", "1", null,
                "ACTIVE", null, null, 0, 0, 0, 0, 0, null, 0, binding, "default",
                activeLifecycle ? "hosted-workspace-files/1" : "legacy-workspace/1");
        when(store.requireSession("tenant", "session")).thenReturn(session);
        when(sessions.lifecycleDigest("session", "CLOSE_SESSION")).thenReturn("digest");
        when(warmer.supportsWorkspaceClose()).thenReturn(!supported);
        when(warmer.supportsWorkspaceClose(binding)).thenReturn(supported);
        when(coordinator.supportsWorkspaceLifecycle(session)).thenReturn(supported);
        var operation = new OperationRecord("tenant", "session", "operation", OperationKind.CLOSE,
                "digest", "COMPLETED", "ACCEPTED", "DELIVERED", "ACTIVE", "receipt", null, 0, 0);
        when(store.beginWorkspaceLifecycle(anyString(), anyString(), eq(OperationKind.CLOSE), anyString(),
                anyString(), anyString(), anyString(), anyBoolean(), anyInt()))
                .thenReturn(new OperationAdmission(operation, false));
        var service = new SessionLifecycleService(store, sessions, new RequestDigests(), coordinator);
        service.setRuntimeWarmer(warmer);

        assertThat(service.admitPublic("tenant", "actor", "key", "session", OperationKind.CLOSE).id())
                .isEqualTo("operation");
        verify(store).beginWorkspaceLifecycle(eq("tenant"), eq("session"), eq(OperationKind.CLOSE), eq("actor"),
                anyString(), eq("key"), eq("digest"), eq(supported), eq(activeLifecycle ? 1 : 0));
    }

    private static SessionRecord session(String status, String toolProfile) {
        return new SessionRecord("tenant", "session", "agent", "1", null,
                status, null, null, 0, 0, 0, 0, 0, null, 0, null, "yolo",
                toolProfile);
    }

    @Test
    void filesProfileActiveCloseAndDeleteUseTheLifecycleProtocol() {
        SessionRecord files = session("ACTIVE", "hosted-workspace-files/1");
        assertThat(SessionLifecycleService.usesLifecycleProtocol(files,
                OperationKind.CLOSE)).isTrue();
        assertThat(SessionLifecycleService.usesLifecycleProtocol(files,
                OperationKind.DELETE)).isTrue();
    }

    @Test
    void onlyExactShellAndMcpProfilesUseV2() {
        for (String profile : java.util.List.of("hosted-workspace-shell/1", "hosted-workspace-mcp/1")) {
            SessionRecord active = session("ACTIVE", profile);
            assertThat(SessionLifecycleService.usesLifecycleProtocol(active, OperationKind.CLOSE)).isTrue();
            assertThat(SessionLifecycleService.usesLifecycleProtocol(active, OperationKind.DELETE)).isTrue();
        }
        for (String profile : java.util.List.of("hosted-workspace-shell/2", "hosted-workspace-mcp/2", "hosted-workspace-team-lead/1")) {
            assertThat(SessionLifecycleService.usesLifecycleProtocol(session("ACTIVE", profile), OperationKind.CLOSE)).isFalse();
        }
    }

    @Test
    void onlyActiveCloseAndDeleteQualify() {
        assertThat(SessionLifecycleService.usesLifecycleProtocol(
                session("CLOSED", "hosted-workspace-files/1"),
                OperationKind.DELETE)).isFalse();
        assertThat(SessionLifecycleService.usesLifecycleProtocol(
                session("ACTIVE", "hosted-workspace-files/1"),
                OperationKind.ARCHIVE)).isFalse();
    }
}
