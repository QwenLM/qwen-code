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
import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
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
import java.util.List;
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
    private static final String NEW_BOOT_ID =
            "55555555-5555-4555-8555-555555555555";
    private static final String SUBMIT_PROMPT_ID =
            "66666666-6666-4666-8666-666666666666";
    private static final List<Map<String, Object>> SUBMIT_CONTENT =
            List.of(Map.of("type", "text", "text", "hi"));
    private static final String SUBMIT_DIGEST =
            SubmitHarnessTurn.computePayloadDigest(SUBMIT_CONTENT);

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
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), profile);
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
                new ContextBinding("tenant-a", "workspace", 1, "storage", ".", "config", 1), profile);
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
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), "hosted-workspace-files/1");
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
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), "hosted-workspace-files/1");
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
                        null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1, null, profile));
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
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), "hosted-workspace-files/1");
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

    // G3: a generation change adopts instead of pinning the Session. The
    // discovering call closes the pinned client and drops every cached
    // attachment, so the next call re-attaches on the rebuilt client.
    @Test
    void generationMismatchClosesClientAndAdoptsOnNextCall() {
        HostedHarnessClient oldClient = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities oldCapabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef staleRef = mock(HarnessSessionRef.class);
        when(oldCapabilities.getBootId()).thenReturn(BOOT_ID);
        when(oldClient.capabilities()).thenReturn(oldCapabilities);
        when(oldClient.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(staleRef);
        when(staleRef.getHarnessBootId()).thenReturn(BOOT_ID);
        QwenHostedHarnessConnector connector = connector(oldClient);
        connector.createOrLoad("tenant-a", SESSION_ID, true);

        HostedHarnessGenerationException mismatch =
                mock(HostedHarnessGenerationException.class);
        when(mismatch.getActualBootId()).thenReturn(NEW_BOOT_ID);
        doThrow(mismatch).when(oldClient).submitTurn(any());
        assertThatThrownBy(() -> connector.submit("tenant-a", SESSION_ID,
                SUBMIT_PROMPT_ID, SUBMIT_CONTENT, SUBMIT_DIGEST))
                .isSameAs(mismatch);
        verify(oldClient).close();
        // The adoption is witnessed, not just its side effects: the
        // pinned client is actually nulled for the next build.
        assertThat(ReflectionTestUtils.getField(connector, "client"))
                .isNull();

        // The rebuilt client (injected in place of a real renegotiation)
        // finds no cached attachment and re-loads before serving new work.
        HostedHarnessClient newClient = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities newCapabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef freshRef = mock(HarnessSessionRef.class);
        PromptReceipt receipt = mock(PromptReceipt.class);
        when(newCapabilities.getBootId()).thenReturn(NEW_BOOT_ID);
        when(newClient.capabilities()).thenReturn(newCapabilities);
        when(newClient.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(freshRef);
        when(newClient.submitTurn(any())).thenReturn(receipt);
        when(freshRef.getHarnessBootId()).thenReturn(NEW_BOOT_ID);
        ReflectionTestUtils.setField(connector, "client", newClient);

        connector.submit("tenant-a", SESSION_ID, SUBMIT_PROMPT_ID,
                SUBMIT_CONTENT, SUBMIT_DIGEST);
        verify(newClient).loadSession(any(LoadHarnessSession.class));
        verify(newClient).submitTurn(any());
    }

    // R4-13: each call site must fetch the client AFTER resolving the
    // attachment — the resolution runs a create/load round trip during
    // which an adoption can close and rebuild the client; a receiver
    // captured before that window throws on the closed instance. The
    // fixture starts the connector on a dead client whose load, run while
    // the attachment resolves, flips the field to the rebuilt one: a
    // pre-fetched receiver lands on dead, the fixed order re-fetches alive.
    private Object[] refetchFixture() {
        HostedHarnessClient dead = mock(HostedHarnessClient.class);
        HostedHarnessClient alive = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities deadCapabilities =
                mock(HostedHarnessCapabilities.class);
        HostedHarnessCapabilities aliveCapabilities =
                mock(HostedHarnessCapabilities.class);
        when(deadCapabilities.getBootId()).thenReturn(BOOT_ID);
        when(aliveCapabilities.getBootId()).thenReturn(BOOT_ID);
        when(dead.capabilities()).thenReturn(deadCapabilities);
        when(alive.capabilities()).thenReturn(aliveCapabilities);
        QwenHostedHarnessConnector connector = connector(dead);
        HarnessSessionRef ref = mock(HarnessSessionRef.class);
        when(ref.getHarnessBootId()).thenReturn(BOOT_ID);
        when(dead.loadSession(any(LoadHarnessSession.class)))
                .thenAnswer(invocation -> {
                    ReflectionTestUtils.setField(connector, "client", alive);
                    return ref;
                });
        return new Object[] {connector, dead, alive};
    }

    @Test
    void continueManagedRuntimeRefetchesTheClientAfterResolvingAttachment() {
        Object[] fixture = refetchFixture();
        QwenHostedHarnessConnector connector =
                (QwenHostedHarnessConnector) fixture[0];
        HostedHarnessClient dead = (HostedHarnessClient) fixture[1];
        HostedHarnessClient alive = (HostedHarnessClient) fixture[2];
        doThrow(new IllegalStateException("HostedHarnessClient is closed"))
                .when(dead).continueManagedRuntime(any(), any(), any(),
                        any());
        when(alive.continueManagedRuntime(any(), any(), any(), any()))
                .thenReturn(mock(PromptReceipt.class));

        connector.continueManagedRuntime("tenant-a", SESSION_ID,
                SUBMIT_PROMPT_ID, "checkpoint", "activation");

        verify(alive).continueManagedRuntime(any(), any(), any(), any());
    }

    @Test
    void cancelManagedRuntimeRefetchesTheClientAfterResolvingAttachment() {
        Object[] fixture = refetchFixture();
        QwenHostedHarnessConnector connector =
                (QwenHostedHarnessConnector) fixture[0];
        HostedHarnessClient dead = (HostedHarnessClient) fixture[1];
        HostedHarnessClient alive = (HostedHarnessClient) fixture[2];
        doThrow(new IllegalStateException("HostedHarnessClient is closed"))
                .when(dead).cancelManagedRuntime(any());
        when(alive.cancelManagedRuntime(any()))
                .thenReturn(mock(PromptReceipt.class));

        connector.cancelManagedRuntime("tenant-a", SESSION_ID,
                SUBMIT_PROMPT_ID, "checkpoint", "activation");

        verify(alive).cancelManagedRuntime(any());
    }

    @Test
    void streamRefetchesTheClientAfterResolvingAttachment() {
        Object[] fixture = refetchFixture();
        QwenHostedHarnessConnector connector =
                (QwenHostedHarnessConnector) fixture[0];
        HostedHarnessClient dead = (HostedHarnessClient) fixture[1];
        HostedHarnessClient alive = (HostedHarnessClient) fixture[2];
        doThrow(new IllegalStateException("HostedHarnessClient is closed"))
                .when(dead).streamEvents(any());
        when(alive.streamEvents(any()))
                .thenReturn(mock(HarnessEventStream.class));

        connector.stream("tenant-a", SESSION_ID, 0L, "epoch");

        verify(alive).streamEvents(any());
    }

    @Test
    void resolveActionRefetchesTheClientAfterResolvingAttachment()
            throws Exception {
        Object[] fixture = refetchFixture();
        QwenHostedHarnessConnector connector =
                (QwenHostedHarnessConnector) fixture[0];
        HostedHarnessClient dead = (HostedHarnessClient) fixture[1];
        HostedHarnessClient alive = (HostedHarnessClient) fixture[2];
        doThrow(new IllegalStateException("HostedHarnessClient is closed"))
                .when(dead).resolveAction(any(), any(), any(), anyLong(),
                        any());

        connector.resolveAction("tenant-a", SESSION_ID, "action-1",
                new ObjectMapper().readTree("{\"optionId\":\"o\","
                        + "\"inputRevision\":1,\"policyRevision\":\"p\"}"));

        verify(alive).resolveAction(any(), any(), any(), anyLong(), any());
    }

    @Test
    void cancelRefetchesTheClientAfterResolvingAttachment() {
        Object[] fixture = refetchFixture();
        QwenHostedHarnessConnector connector =
                (QwenHostedHarnessConnector) fixture[0];
        HostedHarnessClient dead = (HostedHarnessClient) fixture[1];
        HostedHarnessClient alive = (HostedHarnessClient) fixture[2];
        doThrow(new IllegalStateException("HostedHarnessClient is closed"))
                .when(dead).cancelTurn(any());

        connector.cancel("tenant-a", SESSION_ID);

        verify(alive).cancelTurn(any());
    }

    @Test
    void renameRefetchesTheClientAfterResolvingAttachment() {
        Object[] fixture = refetchFixture();
        QwenHostedHarnessConnector connector =
                (QwenHostedHarnessConnector) fixture[0];
        HostedHarnessClient dead = (HostedHarnessClient) fixture[1];
        HostedHarnessClient alive = (HostedHarnessClient) fixture[2];
        doThrow(new IllegalStateException("HostedHarnessClient is closed"))
                .when(dead).updateSessionTitle(any(), any());

        connector.rename("tenant-a", SESSION_ID, "a new title");

        verify(alive).updateSessionTitle(any(), any());
    }

    // A stale cached ref used against an already-adopted client drops only
    // the entries minted under another boot: nothing to rebuild, and the
    // Sessions the live client still heartbeats keep working.
    @Test
    void staleRefAgainstAdoptedClientDropsOnlyStaleEntries() {
        String secondSessionId = "88888888-8888-4888-8888-888888888888";
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant-a", SESSION_ID)).thenReturn(
                new SessionRecord("tenant-a", SESSION_ID, "qwen-code", null,
                        "ACTIVE", null, null, 0, 0, 1, 1, null, 1));
        when(sessions.requireSession("tenant-a", secondSessionId))
                .thenReturn(new SessionRecord("tenant-a", secondSessionId,
                        "qwen-code", null, "ACTIVE", null, null, 0, 0, 1, 1,
                        null, 1));
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef fresh = mock(HarnessSessionRef.class);
        HarnessSessionRef stale = mock(HarnessSessionRef.class);
        when(capabilities.getBootId()).thenReturn(NEW_BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(fresh.getHarnessBootId()).thenReturn(NEW_BOOT_ID);
        when(stale.getHarnessBootId()).thenReturn(BOOT_ID);
        when(fresh.getRuntimeRecovery())
                .thenReturn(mock(HarnessRuntimeRecovery.class));
        when(stale.getRuntimeRecovery())
                .thenReturn(mock(HarnessRuntimeRecovery.class));
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(fresh, stale);
        QwenHostedHarnessConnector connector =
                new QwenHostedHarnessConnector(properties(), sessions,
                        mock(WorkspaceExecutionStore.class));
        ReflectionTestUtils.setField(
                connector, "client", client);
        connector.recoverManagedRuntime("tenant-a", SESSION_ID, false);
        connector.recoverManagedRuntime("tenant-a", secondSessionId, false);

        HostedHarnessGenerationException mismatch =
                mock(HostedHarnessGenerationException.class);
        when(mismatch.getActualBootId()).thenReturn(NEW_BOOT_ID);
        doThrow(mismatch).when(client).submitTurn(any());
        assertThatThrownBy(() -> connector.submit("tenant-a", SESSION_ID,
                SUBMIT_PROMPT_ID, SUBMIT_CONTENT, SUBMIT_DIGEST))
                .isSameAs(mismatch);
        verify(client, never()).close();

        @SuppressWarnings("unchecked")
        java.util.Map<Object, HarnessSessionRef> attachments =
                (java.util.Map<Object, HarnessSessionRef>)
                        org.springframework.test.util.ReflectionTestUtils
                                .getField(connector, "attachments");
        assertThat(attachments.values())
                .noneMatch(ref -> BOOT_ID.equals(ref.getHarnessBootId()));
        assertThat(attachments.values())
                .anyMatch(ref -> NEW_BOOT_ID.equals(ref.getHarnessBootId()));
        // The equal-boot exception names the live client: its freshly
        // minted marker survives, while the evicted stale-boot entry's
        // marker follows its attachment out. Both halves are asserted —
        // retention alone would pass even if the eviction were deleted.
        @SuppressWarnings("unchecked")
        java.util.Set<Object> pendingRecovery =
                (java.util.Set<Object>)
                        org.springframework.test.util.ReflectionTestUtils
                                .getField(connector, "pendingRecovery");
        assertThat(pendingRecovery.stream().map(String::valueOf))
                .noneMatch(text -> text.contains(secondSessionId))
                .anyMatch(text -> text.contains(SESSION_ID));
    }

    // The shared bean must rebuild exactly once when two attempts surface a
    // generation change at the same time.
    @Test
    void concurrentAdoptionsCloseTheClientOnlyOnce() throws Exception {
        HostedHarnessClient oldClient = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities oldCapabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef attached = mock(HarnessSessionRef.class);
        when(oldCapabilities.getBootId()).thenReturn(BOOT_ID);
        when(oldClient.capabilities()).thenReturn(oldCapabilities);
        when(oldClient.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(attached);
        when(attached.getHarnessBootId()).thenReturn(BOOT_ID);
        HostedHarnessGenerationException mismatch =
                mock(HostedHarnessGenerationException.class);
        when(mismatch.getActualBootId()).thenReturn(NEW_BOOT_ID);
        doThrow(mismatch).when(oldClient).submitTurn(any());
        // The losing worker rebuilds after the winner's adoption: give the
        // connector a replacement factory without standing up a live
        // /capabilities call, and let its submit also surface the same
        // mismatch so the race stays deterministic.
        HostedHarnessClient replacement = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities replacementCapabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef replacementAttached = mock(HarnessSessionRef.class);
        when(replacementCapabilities.getBootId()).thenReturn(NEW_BOOT_ID);
        when(replacement.capabilities())
                .thenReturn(replacementCapabilities);
        when(replacement.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(replacementAttached);
        when(replacementAttached.getHarnessBootId()).thenReturn(NEW_BOOT_ID);
        doThrow(mismatch).when(replacement).submitTurn(any());
        // The losing worker's adoption reuses the winner's rebuild: the
        // factory must run for the whole race exactly once.
        java.util.concurrent.atomic.AtomicInteger rebuilds =
                new java.util.concurrent.atomic.AtomicInteger();
        QwenHostedHarnessConnector racingConnector =
                new QwenHostedHarnessConnector(properties(), sessions(),
                        mock(WorkspaceExecutionStore.class)) {
                    @Override
                    HostedHarnessClient createClient() {
                        rebuilds.incrementAndGet();
                        return replacement;
                    }
                };
        ReflectionTestUtils.setField(racingConnector, "client", oldClient);
        racingConnector.createOrLoad("tenant-a", SESSION_ID, true);
        java.util.concurrent.CountDownLatch start =
                new java.util.concurrent.CountDownLatch(1);
        Runnable attempt = () -> {
            try {
                start.await();
            } catch (InterruptedException error) {
                throw new RuntimeException(error);
            }
            assertThatThrownBy(() -> racingConnector.submit("tenant-a",
                    SESSION_ID, SUBMIT_PROMPT_ID, SUBMIT_CONTENT,
                    SUBMIT_DIGEST)).isSameAs(mismatch);
        };
        java.util.concurrent.ExecutorService pool =
                java.util.concurrent.Executors.newFixedThreadPool(2);
        java.util.concurrent.Future<?>[] futures;
        try {
            futures = new java.util.concurrent.Future<?>[] {
                    pool.submit(attempt), pool.submit(attempt)};
            start.countDown();
            // get() rethrows a worker's failed assertion; submit() alone
            // would swallow it into the discarded FutureTask forever.
            for (java.util.concurrent.Future<?> future : futures) {
                future.get(10, java.util.concurrent.TimeUnit.SECONDS);
            }
            pool.shutdown();
            assertThat(pool.awaitTermination(10,
                    java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        } finally {
            pool.shutdownNow();
        }
        verify(oldClient, org.mockito.Mockito.times(1)).close();
        // The replacement survives its own adoption error: only the
        // generation the exception named is closed, exactly once.
        verify(replacement, never()).close();
        // The first call after the race resolves its attachment through
        // exactly one rebuild for the whole race — not zero (the race
        // alone never forces one) and not one per worker.
        racingConnector.createOrLoad("tenant-a", SESSION_ID, true);
        assertThat(rebuilds.get()).isEqualTo(1);
    }

    // The one code-aware call site: a takeover refusal that cannot change
    // under retry surfaces as the typed terminal exception.
    @Test
    void takeoverDeclineMapsToTypedTerminalException() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        DaemonHttpException declined = mock(DaemonHttpException.class);
        when(declined.getStatusCode()).thenReturn(409);
        when(declined.getErrorCode())
                .thenReturn(HostedHarnessRecoveryDeclinedException.CODE);
        when(declined.getBodyField("reason")).thenReturn("shell_in_flight");
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenThrow(declined);
        QwenHostedHarnessConnector connector = connector(client);

        assertThatThrownBy(() -> connector.recoverManagedRuntime("tenant-a",
                SESSION_ID, false))
                .isInstanceOfSatisfying(
                        HostedHarnessRecoveryDeclinedException.class,
                        error -> assertThat(error.getReason())
                                .isEqualTo("shell_in_flight"));
        verify(client, never()).close();
    }

    @Test
    void otherTakeoverConflictsStayOpaqueToErrorCodes() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(conflict.getErrorCode())
                .thenReturn("hosted_turn_recovery_required");
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenThrow(conflict);
        QwenHostedHarnessConnector connector = connector(client);

        assertThatThrownBy(() -> connector.recoverManagedRuntime("tenant-a",
                SESSION_ID, false)).isSameAs(conflict);
        verify(client, never()).close();
    }

    private static QwenHostedHarnessConnector connector(
            HostedHarnessClient client) {
        QwenHostedHarnessConnector connector =
                new QwenHostedHarnessConnector(properties(), sessions(),
                        mock(WorkspaceExecutionStore.class));
        ReflectionTestUtils.setField(connector, "client", client);
        return connector;
    }

    // The load timeout is env-overridable, so a bad value must fail at
    // construction rather than as an endless transient retry inside client().
    @Test
    void rejectsNonPositiveLoadTimeoutAtConstruction() {
        ManagedAgentProperties properties = properties();
        properties.getHarness().setLoadTimeout(java.time.Duration.ZERO);
        assertThatThrownBy(() ->
                new QwenHostedHarnessConnector(properties,
                        mock(AgentStateStore.class),
                        mock(WorkspaceExecutionStore.class)))
                .isInstanceOf(IllegalStateException.class);
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
