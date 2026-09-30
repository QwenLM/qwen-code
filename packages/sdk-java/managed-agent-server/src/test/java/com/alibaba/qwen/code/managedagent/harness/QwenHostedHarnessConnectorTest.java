package com.alibaba.qwen.code.managedagent.harness;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import java.time.Duration;
import org.mockito.ArgumentCaptor;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class QwenHostedHarnessConnectorTest {
    private static final String SESSION_ID =
            "33333333-3333-4333-8333-333333333333";
    private static final String BOOT_ID =
            "11111111-1111-4111-8111-111111111111";

    @Test
    void boundCreateConflictLoadsOriginalWorkspaceAndProfileAndRechecksCachedGrant() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities = mock(HostedHarnessCapabilities.class);
        HarnessSessionRef attached = mock(HarnessSessionRef.class);
        when(client.capabilities()).thenReturn(capabilities);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(attached.getHarnessBootId()).thenReturn(BOOT_ID);
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(client.createSession(any())).thenThrow(conflict);
        when(client.loadSession(any())).thenReturn(attached);
        AgentStateStore sessions = mock(AgentStateStore.class);
        SessionRecord session = new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant-a", "selected-workspace", 1, "storage", "child",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1));
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(session);
        WorkspaceExecutionStore execution = mock(WorkspaceExecutionStore.class);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, sessions, execution);
        ReflectionTestUtils.setField(connector, "client", client);

        connector.createOrLoad("tenant-a", SESSION_ID, false);

        ArgumentCaptor<CreateHarnessSession> create = ArgumentCaptor.forClass(CreateHarnessSession.class);
        ArgumentCaptor<LoadHarnessSession> load = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(client).createSession(create.capture());
        verify(client).loadSession(load.capture());
        for (Object request : new Object[] {create.getValue(), load.getValue()}) {
            assertThat(ReflectionTestUtils.<Object>invokeMethod(request, "toJson").toString())
                    .contains("toolProfile=hosted-workspace-files/1", "workspaceId=selected-workspace", "tenantId=tenant-a")
                    .doesNotContain("workspaceId=workspace-a");
        }
        doThrow(new IllegalStateException("grant revoked")).when(execution).authorize(session);
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .hasMessage("grant revoked");
        properties.getHarness().setWorkspaceFilesEnabled(false);
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .hasMessage("Hosted Workspace files are disabled");
    }

    @Test
    void loadsAnExistingSessionWithoutCreatingIt() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        QwenHostedHarnessConnector connector = connector(client);

        HarnessConnector.Attachment attachment = connector.createOrLoad(
                "tenant-a", SESSION_ID, true);

        assertThat(attachment.bootId()).isEqualTo(BOOT_ID);
        verify(client).loadSession(any(LoadHarnessSession.class));
        verify(client, never()).createSession(any(CreateHarnessSession.class));
    }

    @Test
    void loadsAnExistingAuthorityAfterCreateConflicts() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(client.createSession(any(CreateHarnessSession.class)))
                .thenThrow(conflict);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        QwenHostedHarnessConnector connector = connector(client);

        HarnessConnector.Attachment attachment = connector.createOrLoad(
                "tenant-a", SESSION_ID, false);

        assertThat(attachment.bootId()).isEqualTo(BOOT_ID);
        verify(client).loadSession(any(LoadHarnessSession.class));
        verify(client).createSession(any(CreateHarnessSession.class));
    }

    @Test
    void rechecksWorkspaceAuthorityOnCachedAttachmentAndKeepsPassiveRecoveryAuthorized() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities = mock(HostedHarnessCapabilities.class);
        HarnessSessionRef attached = mock(HarnessSessionRef.class);
        SessionRecord session = mock(SessionRecord.class);
        AgentStateStore sessions = mock(AgentStateStore.class);
        WorkspaceExecutionStore execution = mock(WorkspaceExecutionStore.class);
        when(execution.verifiedRecoveryEnabled()).thenReturn(true);
        when(client.capabilities()).thenReturn(capabilities);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(session);
        when(session.tenantId()).thenReturn("tenant-a");
        when(session.sessionId()).thenReturn(SESSION_ID);
        when(session.workspace()).thenReturn(new ContextBinding("tenant-a", "workspace", 1,
                "storage", ".", "config", 1));
        when(client.loadSession(any(LoadHarnessSession.class))).thenReturn(attached);
        when(attached.getHarnessBootId()).thenReturn(BOOT_ID);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, sessions, execution);
        ReflectionTestUtils.setField(connector, "client", client);
        connector.createOrLoad("tenant-a", SESSION_ID, true);
        verify(execution).authorize(session);

        doThrow(WorkspaceExecutionStore.unavailable()).when(execution).authorize(session);
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .hasMessageContaining("Workspace execution authority is unavailable");
        assertThatThrownBy(() -> connector.submit("tenant-a", SESSION_ID,
                "prompt", java.util.List.of(), "digest"))
                .hasMessageContaining("Workspace execution authority is unavailable");
        assertThatThrownBy(() -> connector.continueManagedRuntime("tenant-a", SESSION_ID,
                "prompt", "checkpoint", "activation"))
                .hasMessageContaining("Workspace execution authority is unavailable");
        verify(client, times(1)).loadSession(any(LoadHarnessSession.class));
        connector.createOrLoad("tenant-a", SESSION_ID, true, true);
        verify(execution).authorizePassiveAttachment(session);
        verify(client, times(2)).loadSession(any(LoadHarnessSession.class));
        doThrow(new IllegalStateException("grant revoked")).when(execution).authorizePassiveAttachment(session);
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true, true))
                .hasMessage("grant revoked");
        properties.getHarness().setWorkspaceFilesEnabled(false);
        assertThatThrownBy(() -> connector.submit("tenant-a", SESSION_ID,
                "prompt", java.util.List.of(), "digest"))
                .hasMessage("Hosted Workspace files are disabled");
    }

    private static QwenHostedHarnessConnector connector(
            HostedHarnessClient client) {
        QwenHostedHarnessConnector connector =
                new QwenHostedHarnessConnector(properties(), sessions(),
                        mock(WorkspaceExecutionStore.class));
        ReflectionTestUtils.setField(connector, "client", client);
        return connector;
    }

    private static ManagedAgentProperties properties() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setToken("token");
        properties.getHarness().setCapabilityDigest("sha256:"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore().setBaseUrl("https://store.example");
        properties.getSessionStore().setWorkspaceId("workspace-a");
        properties.getSessionStore().setWriterLeaseDuration(
                Duration.ofSeconds(60));
        return properties;
    }

    private static AgentStateStore sessions() {
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(
                new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                        "ACTIVE", null, null, 0, 0, 1, 1, null, 1));
        return sessions;
    }
}
