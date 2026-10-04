package com.alibaba.qwen.code.managedagent.harness;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.when;
import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.daemon.PromptReceipt;
import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.Map;
import org.mockito.ArgumentCaptor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.test.util.ReflectionTestUtils;

class QwenHostedHarnessConnectorTest {
    private static final String SESSION_ID =
            "33333333-3333-4333-8333-333333333333";
    private static final String BOOT_ID =
            "11111111-1111-4111-8111-111111111111";

    @ParameterizedTest
    @ValueSource(strings = {"hosted-workspace-files/1", "hosted-workspace-files/2"})
    void boundCreateConflictLoadsOriginalWorkspaceAndProfileAndRechecksCachedGrant(String profile) {
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
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), "yolo", profile);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(session);
        WorkspaceExecutionStore execution = mock(WorkspaceExecutionStore.class);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant-a", SESSION_ID)).thenReturn("default");
        when(attached.getApprovalMode()).thenReturn(null, "yolo", "default");
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, sessions, execution, actions);
        ReflectionTestUtils.setField(connector, "client", client);

        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .hasMessageContaining("did not confirm");
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .hasMessageContaining("did not confirm");
        connector.createOrLoad("tenant-a", SESSION_ID, false);

        ArgumentCaptor<CreateHarnessSession> create = ArgumentCaptor.forClass(CreateHarnessSession.class);
        ArgumentCaptor<LoadHarnessSession> load = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(client).createSession(create.capture());
        verify(client, org.mockito.Mockito.times(3)).loadSession(load.capture());
        for (Object request : new Object[] {create.getValue(), load.getValue()}) {
            assertThat(ReflectionTestUtils.<Object>invokeMethod(request, "toJson").toString())
                    .contains("toolProfile=" + profile, "workspaceId=selected-workspace", "tenantId=tenant-a")
                    .doesNotContain("workspaceId=workspace-a");
        }
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(create.getValue(), "toJson"))
                .containsEntry("approvalMode", "default")
                .containsEntry("approvalTimeoutMs", properties.getHarness().getApprovalTimeout().toMillis());
        QwenHostedHarnessConnector restarted = new QwenHostedHarnessConnector(properties, sessions, execution, actions);
        ReflectionTestUtils.setField(restarted, "client", client);
        restarted.recoverManagedRuntime("tenant-a", SESSION_ID, false);
        verify(client, times(4)).loadSession(load.capture());
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(load.getValue(), "toJson"))
                .containsEntry("toolProfile", profile);
        clearInvocations(execution);
        RuntimeBrokerException refusal = WorkspaceExecutionStore.unavailable();
        doThrow(refusal).when(execution).authorize(session);
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error).isSameAs(refusal);
                    assertThat(error.getStatusCode()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isFalse();
                });
        verify(execution).authorize(session);

        properties.getHarness().setWorkspaceFilesEnabled(false);
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .hasMessage("Hosted Workspace files are disabled");
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" "})
    void missingBoundProfileNeverLetsTheHarnessInferItsTools(String profile) {
        SessionRecord session = new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant-a", "workspace", 1, "storage", ".", "config", 1), "yolo", profile);
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(session);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant-a", SESSION_ID)).thenReturn("default");
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, sessions,
                mock(WorkspaceExecutionStore.class), actions);
        ReflectionTestUtils.setField(connector, "client", client);
        for (boolean exists : new boolean[] {false, true}) {
            assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, exists))
                    .hasMessage("Hosted Workspace Session tool profile is missing");
        }
        assertThatThrownBy(() -> connector.recoverManagedRuntime("tenant-a", SESSION_ID, true))
                .hasMessage("Hosted Workspace Session tool profile is missing");
        verify(client, never()).createSession(any());
        verify(client, never()).loadSession(any());
    }

    @Test
    void coldRefusalStopsBeforeAnyHarnessCreateOrLoad() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        SessionRecord session = new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant-a", "selected-workspace", 1, "storage", "child",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), "yolo", "hosted-workspace-files/1");
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(session);
        WorkspaceExecutionStore execution = mock(WorkspaceExecutionStore.class);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        QwenHostedHarnessConnector cold = new QwenHostedHarnessConnector(properties, sessions, execution,
                mock(ManagedActionStore.class));
        ReflectionTestUtils.setField(cold, "client", client);
        RuntimeBrokerException refusal = WorkspaceExecutionStore.unavailable();
        doThrow(refusal).when(execution).authorize(session);

        assertThatThrownBy(() -> cold.createOrLoad("tenant-a", SESSION_ID, true))
                .isSameAs(refusal);
        verifyNoInteractions(client);
    }

    @Test
    void transientAuthorizationFailurePropagatesUnchanged() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities = mock(HostedHarnessCapabilities.class);
        HarnessSessionRef attached = mock(HarnessSessionRef.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class))).thenReturn(attached);
        when(attached.getHarnessBootId()).thenReturn(BOOT_ID);
        when(attached.getApprovalMode()).thenReturn("default");
        SessionRecord session = new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant-a", "selected-workspace", 1, "storage", "child",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), "yolo", "hosted-workspace-files/1");
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(session);
        WorkspaceExecutionStore execution = mock(WorkspaceExecutionStore.class);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant-a", SESSION_ID)).thenReturn("default");
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, sessions, execution,
                actions);
        ReflectionTestUtils.setField(connector, "client", client);
        connector.createOrLoad("tenant-a", SESSION_ID, true);
        clearInvocations(execution, client);
        DataAccessResourceFailureException transientFailure =
                new DataAccessResourceFailureException("db unavailable");
        doThrow(transientFailure).when(execution).authorize(session);

        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true))
                .isSameAs(transientFailure);
        verify(execution).authorize(session);
        verifyNoInteractions(client);
    }

    @Test
    void recoverManagedRuntimeReusesAHealthyAttachment() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef attached = mock(HarnessSessionRef.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(attached);
        when(attached.getHarnessBootId()).thenReturn(BOOT_ID);
        QwenHostedHarnessConnector connector = connector(client);

        connector.recoverManagedRuntime("tenant-a", SESSION_ID, false);
        // A healthy Session attached to this very Harness is reused: the
        // second turn of the same Session must not re-load it.
        connector.recoverManagedRuntime("tenant-a", SESSION_ID, false);

        ArgumentCaptor<LoadHarnessSession> loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(client, org.mockito.Mockito.times(1))
                .loadSession(loads.capture());
        // A non-cancellation recovery drives the parked Turn: the wire flag
        // must say drive, not passive.
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(loads.getValue(), "toJson"))
                .containsEntry("driveRuntimeRecovery", true)
                .doesNotContainKey("passiveManagedRuntimeRecovery");
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.NullSource
    @ValueSource(strings = {"hosted-workspace-files/1"})
    void loadsAnExistingSessionWithoutCreatingIt(String profile) {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        AgentStateStore sessions = sessions();
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(
                new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                        null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1, null, "yolo", profile));
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties(), sessions,
                mock(WorkspaceExecutionStore.class));
        ReflectionTestUtils.setField(connector, "client", client);

        HarnessConnector.Attachment attachment = connector.createOrLoad(
                "tenant-a", SESSION_ID, true);

        assertThat(attachment.bootId()).isEqualTo(BOOT_ID);
        ArgumentCaptor<LoadHarnessSession> loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(client).loadSession(loads.capture());
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(loads.getValue(), "toJson"))
                .doesNotContainKey("toolProfile");
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
        when(session.toolProfile()).thenReturn("hosted-workspace-files/1");
        when(client.loadSession(any(LoadHarnessSession.class))).thenReturn(attached);
        when(attached.getHarnessBootId()).thenReturn(BOOT_ID);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant-a", SESSION_ID)).thenReturn("default");
        when(attached.getApprovalMode()).thenReturn("default");
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, sessions, execution, actions);
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
        ArgumentCaptor<LoadHarnessSession> loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(client, times(2)).loadSession(loads.capture());
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(loads.getAllValues().getFirst(), "toJson"))
                .doesNotContainKey("passiveManagedRuntimeRecovery");
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(loads.getValue(), "toJson"))
                .containsEntry("passiveManagedRuntimeRecovery", true);
        doThrow(new IllegalStateException("grant revoked")).when(execution).authorizePassiveAttachment(session);
        assertThatThrownBy(() -> connector.createOrLoad("tenant-a", SESSION_ID, true, true))
                .hasMessage("grant revoked");
        properties.getHarness().setWorkspaceFilesEnabled(false);
        assertThatThrownBy(() -> connector.submit("tenant-a", SESSION_ID,
                "prompt", java.util.List.of(), "digest"))
                .hasMessage("Hosted Workspace files are disabled");
    }

    @Test
    void resolvesActionsThroughAuthorizedColdAndCachedWorkspaceAttachments() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities = mock(HostedHarnessCapabilities.class);
        HarnessSessionRef attached = mock(HarnessSessionRef.class);
        when(client.capabilities()).thenReturn(capabilities);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.loadSession(any(LoadHarnessSession.class))).thenReturn(attached);
        when(attached.getHarnessBootId()).thenReturn(BOOT_ID);
        when(attached.getApprovalMode()).thenReturn("yolo", "default");
        SessionRecord session = new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant-a", "selected-workspace", 1, "storage", "child",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), "yolo", "hosted-workspace-files/1");
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(session);
        WorkspaceExecutionStore execution = mock(WorkspaceExecutionStore.class);
        when(execution.verifiedRecoveryEnabled()).thenReturn(true);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant-a", SESSION_ID)).thenReturn("default");
        ManagedAgentProperties properties = properties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, sessions, execution, actions);
        ReflectionTestUtils.setField(connector, "client", client);
        String actionId = "tool_approval_" + "a".repeat(32);
        var response = new ObjectMapper().createObjectNode().put("optionId", "allow")
                .put("inputRevision", 7L).put("policyRevision", "hosted-tool-approval/1");

        doThrow(WorkspaceExecutionStore.unavailable()).doNothing().when(execution).authorize(session);
        assertThatThrownBy(() -> connector.resolveAction("tenant-a", SESSION_ID, actionId, response))
                .hasMessageContaining("Workspace execution authority is unavailable");
        verify(client, never()).loadSession(any());
        verify(client, never()).resolveAction(any(), any(), any(), anyLong(), any());

        assertThatThrownBy(() -> connector.resolveAction("tenant-a", SESSION_ID, actionId, response))
                .hasMessageContaining("did not confirm the Session approval mode");
        verify(client, never()).resolveAction(any(), any(), any(), anyLong(), any());

        connector.resolveAction("tenant-a", SESSION_ID, actionId, response);
        verify(client).resolveAction(attached, actionId, "allow", 7L, "hosted-tool-approval/1");
        ArgumentCaptor<LoadHarnessSession> loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(client, times(2)).loadSession(loads.capture());
        for (LoadHarnessSession load : loads.getAllValues()) {
            Map<String, Object> wire = ReflectionTestUtils.invokeMethod(load, "toJson");
            assertThat(wire).containsEntry("toolProfile", "hosted-workspace-files/1")
                    .doesNotContainKey("passiveManagedRuntimeRecovery");
            assertThat(wire.get("managedSessionStore").toString())
                    .contains("tenantId=tenant-a", "workspaceId=selected-workspace")
                    .doesNotContain("workspaceId=workspace-a");
        }
        verify(execution, never()).authorizePassiveAttachment(any());
        verify(client, never()).createSession(any());

        doThrow(WorkspaceExecutionStore.unavailable()).when(execution).authorize(session);
        assertThatThrownBy(() -> connector.resolveAction("tenant-a", SESSION_ID, actionId, response))
                .hasMessageContaining("Workspace execution authority is unavailable");
        verify(client, times(1)).resolveAction(any(), any(), any(), anyLong(), any());
        verify(client, times(2)).loadSession(any(LoadHarnessSession.class));
    }

    @Test
    void takeoverSnapshotIsReportedUntilItsContinuationIsAdmitted() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        PromptReceipt receipt = mock(PromptReceipt.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(client.continueManagedRuntime(any(), any(), any(), any()))
                .thenReturn(receipt);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        when(session.getRuntimeRecovery()).thenReturn(recovery);
        QwenHostedHarnessConnector connector = connector(client);

        assertThat(connector.recoverManagedRuntime("tenant-a", SESSION_ID,
                false).runtimeRecovery()).isSameAs(recovery);
        // Re-entered before the continuation was admitted: still pending.
        assertThat(connector.recoverManagedRuntime("tenant-a", SESSION_ID,
                false).runtimeRecovery()).isSameAs(recovery);
        connector.continueManagedRuntime("tenant-a", SESSION_ID,
                "44444444-4444-4444-8444-444444444444", "checkpoint",
                "activation");
        // Re-entered after admission (stream gap, lost reply): the Turn is
        // already continuing, so it must not be retracted and continued again.
        assertThat(connector.recoverManagedRuntime("tenant-a", SESSION_ID,
                false).runtimeRecovery()).isNull();
        verify(client).loadSession(any(LoadHarnessSession.class));
    }

    @Test
    void cancellationRecoveryLoadsPassivelyWithoutDriving() {
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

        connector.recoverManagedRuntime("tenant-a", SESSION_ID, true);

        ArgumentCaptor<LoadHarnessSession> loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(client).loadSession(loads.capture());
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(loads.getValue(), "toJson"))
                .containsEntry("passiveManagedRuntimeRecovery", true)
                .doesNotContainKey("driveRuntimeRecovery");
    }

    @Test
    void submitPassesTheConfiguredTurnDeadline() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        PromptReceipt receipt = mock(PromptReceipt.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(client.submitTurn(any())).thenReturn(receipt);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        ManagedAgentProperties properties = properties();
        properties.getHarness().setTurnDeadline(Duration.ofSeconds(45));
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(
                properties, sessions(), mock(WorkspaceExecutionStore.class));
        ReflectionTestUtils.setField(connector, "client", client);
        java.util.List<Map<String, Object>> input = java.util.List.of(
                Map.of("type", "text", "text", "hello"));

        connector.submit("tenant-a", SESSION_ID,
                "44444444-4444-4444-8444-444444444444", input,
                SubmitHarnessTurn.computePayloadDigest(input));

        ArgumentCaptor<SubmitHarnessTurn> submitted =
                ArgumentCaptor.forClass(SubmitHarnessTurn.class);
        verify(client).submitTurn(submitted.capture());
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(
                submitted.getValue(), "toJson"))
                .containsEntry("deadlineMs", 45_000L);
    }

    @Test
    void submitPassesTheDefaultTurnDeadline() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        PromptReceipt receipt = mock(PromptReceipt.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(client.submitTurn(any())).thenReturn(receipt);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        QwenHostedHarnessConnector connector = connector(client);
        java.util.List<Map<String, Object>> input = java.util.List.of(
                Map.of("type", "text", "text", "hello"));

        connector.submit("tenant-a", SESSION_ID,
                "44444444-4444-4444-8444-444444444444", input,
                SubmitHarnessTurn.computePayloadDigest(input));

        ArgumentCaptor<SubmitHarnessTurn> submitted =
                ArgumentCaptor.forClass(SubmitHarnessTurn.class);
        verify(client).submitTurn(submitted.capture());
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(
                submitted.getValue(), "toJson"))
                .containsEntry("deadlineMs", Duration.ofMinutes(30).toMillis());
    }

    @Test
    void rejectsAnInvalidTurnDeadline() {
        ManagedAgentProperties zero = properties();
        zero.getHarness().setTurnDeadline(Duration.ZERO);
        assertThatThrownBy(() -> new QwenHostedHarnessConnector(zero,
                sessions(), mock(WorkspaceExecutionStore.class)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("turn deadline");
        ManagedAgentProperties negative = properties();
        negative.getHarness().setTurnDeadline(Duration.ofSeconds(-1));
        assertThatThrownBy(() -> new QwenHostedHarnessConnector(negative,
                sessions(), mock(WorkspaceExecutionStore.class)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("turn deadline");
        // A positive sub-millisecond deadline rounds to 0 ms on the wire.
        ManagedAgentProperties subMillis = properties();
        subMillis.getHarness().setTurnDeadline(Duration.ofNanos(999_999));
        assertThatThrownBy(() -> new QwenHostedHarnessConnector(subMillis,
                sessions(), mock(WorkspaceExecutionStore.class)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("turn deadline");
        ManagedAgentProperties overflowing = properties();
        overflowing.getHarness().setTurnDeadline(
                Duration.ofMillis(Integer.MAX_VALUE).plusMillis(1));
        assertThatThrownBy(() -> new QwenHostedHarnessConnector(overflowing,
                sessions(), mock(WorkspaceExecutionStore.class)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("turn deadline");
    }

    @Test
    void acceptsTheMaximumTurnDeadline() {
        ManagedAgentProperties atMax = properties();
        atMax.getHarness().setTurnDeadline(
                Duration.ofMillis(Integer.MAX_VALUE));
        assertThatCode(() -> new QwenHostedHarnessConnector(atMax,
                sessions(), mock(WorkspaceExecutionStore.class)))
                .doesNotThrowAnyException();
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
