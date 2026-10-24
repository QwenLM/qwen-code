package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.daemon.SessionCreationOutcomeUnknownException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class QwenHostedMcpManagementAttachmentTest {
    private static final String SESSION = "33333333-3333-4333-8333-333333333333";
    private static final String BOOT = "11111111-1111-4111-8111-111111111111";
    private static final String OPERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String PROMPT = "44444444-4444-4444-8444-444444444444";

    @ParameterizedTest
    @ValueSource(strings = {"query", "submit"})
    void firstManagementOperationCreatesTheEmptySessionWithoutSubmittingATurn(String operation) {
        var fixture = new Fixture(null);
        when(fixture.client.loadSession(any())).thenThrow(new AssertionError("The fresh Session has no journal"));
        when(fixture.client.loadMcpManagementSession(any())).thenThrow(new AssertionError("The fresh Session has no journal"));
        fixture.run(operation);
        var create = ArgumentCaptor.forClass(CreateHarnessSession.class);
        verify(fixture.client).createSession(create.capture());
        Map<String, Object> request = ReflectionTestUtils.invokeMethod(create.getValue(), "toJson");
        assertThat(request).containsEntry("sessionId", SESSION).containsEntry("toolProfile", "hosted-workspace-shell/1")
                .doesNotContainKey("mcpServers");
        verify(fixture.client, never()).submitTurn(any());
        verify(fixture.client, never()).loadSession(any());
        verify(fixture.client, never()).loadMcpManagementSession(any());
    }

    @ParameterizedTest
    @ValueSource(strings = {"query", "submit"})
    void anExistingSessionIsLoadedWithoutCreatingAnotherJournalOrDrivingRuntimeRecovery(String operation) {
        var fixture = new Fixture(BOOT);
        fixture.run(operation);
        var loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(fixture.client).loadMcpManagementSession(loads.capture());
        Map<String, Object> request = ReflectionTestUtils.invokeMethod(loads.getValue(), "toJson");
        assertThat(request).doesNotContainKey("driveRuntimeRecovery");
        assertThat(ReflectionTestUtils.getField(loads.getValue(), "driveRuntimeRecovery")).isEqualTo(false);
        verify(fixture.client, never()).createSession(any());
        verify(fixture.client, never()).loadSession(any());
        verify(fixture.client, never()).submitTurn(any());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void aManagementReadCannotSuppressTurnRecoveryOrCancellationTakeover(boolean cancellation) {
        var fixture = new Fixture(BOOT);
        fixture.connector.mcpManagement("tenant", SESSION);
        assertThat(fixture.connector.attachedSessions()).isEmpty();

        fixture.connector.recoverManagedRuntime("tenant", SESSION, cancellation, PROMPT);

        var loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(fixture.client).loadSession(loads.capture());
        Map<String, Object> request = ReflectionTestUtils.invokeMethod(loads.getValue(), "toJson");
        assertThat(request).containsEntry(cancellation ? "cancellationTakeover" : "driveRuntimeRecovery", true);
        if (cancellation) {
            assertThat(request).containsEntry("cancellationPromptId", PROMPT);
        }
        verify(fixture.client).loadMcpManagementSession(any());
        assertThat(fixture.connector.attachedSessions()).hasSize(1);
    }

    @Test
    void anEmptySessionInitializedForManagementStillTakesTheOrdinaryRecoveryPath() {
        var fixture = new Fixture(null);
        fixture.connector.mcpManagement("tenant", SESSION);
        fixture.connector.recoverManagedRuntime("tenant", SESSION, false);
        verify(fixture.client).createSession(any());
        verify(fixture.client).loadSession(any());
    }

    @Test
    void theFirstTurnPassivelyAttachesAnEmptySessionInitializedForManagement() {
        var fixture = new Fixture(null);
        fixture.connector.mcpManagement("tenant", SESSION);
        fixture.connector.createOrLoad("tenant", SESSION, false);
        fixture.connector.createOrLoad("tenant", SESSION, false);
        verify(fixture.client).createSession(any());
        var loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(fixture.client).loadSession(loads.capture());
        Map<String, Object> request = ReflectionTestUtils.invokeMethod(loads.getValue(), "toJson");
        assertThat(request).containsEntry("passiveManagedRuntimeRecovery", true)
                .doesNotContainKeys("driveRuntimeRecovery", "mcpManagementOnly");
        assertThat(fixture.connector.attachedSessions()).hasSize(1);
    }

    @Test
    void closingASessionEvictsItsManagementOnlyReference() {
        var fixture = new Fixture(BOOT);
        fixture.connector.mcpManagement("tenant", SESSION);
        fixture.connector.closeSession("tenant", SESSION);
        fixture.connector.mcpManagement("tenant", SESSION);
        verify(fixture.client, times(2)).loadMcpManagementSession(any());
        verify(fixture.client).closeSession(SESSION);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void operationStatusOnlyReattachesAResidentSessionEvenBeforeTheFirstTurn(boolean bootKnown) {
        var fixture = new Fixture(bootKnown ? BOOT : null);
        fixture.connector.mcpManagementOperation("tenant", SESSION, OPERATION);
        verify(fixture.client).mcpManagementOperation(any(), any());
        var loads = ArgumentCaptor.forClass(LoadHarnessSession.class);
        verify(fixture.client).loadMcpManagementSession(loads.capture());
        Map<String, Object> request = ReflectionTestUtils.invokeMethod(loads.getValue(), "toJson");
        assertThat(request).doesNotContainKey("passiveManagedRuntimeRecovery").doesNotContainKey("driveRuntimeRecovery");
        assertThat(ReflectionTestUtils.getField(loads.getValue(), "driveRuntimeRecovery")).isEqualTo(false);
        verify(fixture.client, never()).createSession(any());
        verify(fixture.client, never()).loadSession(any());
        verify(fixture.client, never()).submitTurn(any());
    }

    @ParameterizedTest
    @ValueSource(strings = {"query", "submit", "status"})
    void aColdSessionRefusalNeverFallsBackToRecoveryOrAnotherCreation(String operation) {
        var fixture = new Fixture(BOOT);
        var conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(conflict.getErrorCode()).thenReturn("hosted_mcp_session_load_required");
        when(fixture.client.loadMcpManagementSession(any())).thenThrow(conflict);
        assertThatThrownBy(() -> fixture.run(operation)).isSameAs(conflict);
        verify(fixture.client).loadMcpManagementSession(any());
        verify(fixture.client, never()).loadSession(any());
        verify(fixture.client, never()).createSession(any());
        verify(fixture.client, never()).submitTurn(any());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void conflictingAndUnknownCreateOutcomesOnlyReattachTheOriginalResident(boolean unknown) {
        var fixture = new Fixture(null);
        RuntimeException error;
        if (unknown) {
            error = mock(SessionCreationOutcomeUnknownException.class);
        } else {
            var conflict = mock(DaemonHttpException.class);
            when(conflict.getStatusCode()).thenReturn(409);
            error = conflict;
        }
        when(fixture.client.createSession(any())).thenThrow(error);
        fixture.connector.mcpManagement("tenant", SESSION);
        fixture.connector.mcpManagement("tenant", SESSION);
        verify(fixture.client).createSession(any());
        verify(fixture.client).loadMcpManagementSession(any());
        verify(fixture.client, never()).loadSession(any());
    }

    @Test
    void anUnknownOperationWithNoJournalNeverCreatesOne() {
        var fixture = new Fixture(null);
        var missing = mock(DaemonHttpException.class);
        when(missing.getStatusCode()).thenReturn(404);
        when(fixture.client.loadMcpManagementSession(any())).thenThrow(missing);
        assertThatThrownBy(() -> fixture.connector.mcpManagementOperation("tenant", SESSION, OPERATION)).isSameAs(missing);
        verify(fixture.client, never()).createSession(any());
        verify(fixture.client, never()).mcpManagementOperation(any(), any());
    }

    private static final class Fixture {
        private final HostedHarnessClient client = mock(HostedHarnessClient.class);
        private final QwenHostedHarnessConnector connector;

        private Fixture(String priorBoot) {
            var capabilities = mock(HostedHarnessCapabilities.class);
            var ref = mock(HarnessSessionRef.class);
            when(client.capabilities()).thenReturn(capabilities);
            when(capabilities.getBootId()).thenReturn(BOOT);
            when(capabilities.getFeatures()).thenReturn(List.of("session-mcp-management/1", "targeted-cancel/1"));
            when(ref.getHarnessBootId()).thenReturn(BOOT);
            when(ref.getApprovalMode()).thenReturn("default");
            when(client.createSession(any())).thenReturn(ref);
            when(client.loadSession(any())).thenReturn(ref);
            when(client.loadMcpManagementSession(any())).thenReturn(ref);
            var sessions = mock(AgentStateStore.class);
            var session = new SessionRecord("tenant", SESSION, "agent_00112233445566778899aabbccddeeff", "1", null, "ACTIVE", priorBoot,
                    null, 0, 0, 0, 1, 1, null, 1,
                    new ContextBinding("tenant", "workspace", 1, "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1),
                    "default", "hosted-workspace-shell/1", "a".repeat(64));
            when(sessions.requireSession("tenant", SESSION)).thenReturn(session);
            var definitions = mock(ManagedAgentDefinitionStore.class);
            when(definitions.pinnedContent(session)).thenReturn(Map.of());
            var actions = mock(ManagedActionStore.class);
            when(actions.approvalMode("tenant", SESSION)).thenReturn("default");
            var settings = new ManagedAgentProperties();
            settings.getHarness().setToken("test-token");
            settings.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
            settings.getHarness().setWorkspaceFilesEnabled(true);
            settings.getHarness().setWorkspaceShellEnabled(true);
            settings.getSessionStore().setEnabled(true);
            settings.getSessionStore().setBaseUrl("https://store.example");
            settings.getSessionStore().setWorkspaceId("workspace");
            connector = new QwenHostedHarnessConnector(settings, sessions, mock(WorkspaceExecutionStore.class), actions,
                    definitions, mock(ManagedSessionStore.class));
            ReflectionTestUtils.setField(connector, "client", client);
        }

        private void run(String operation) {
            if ("query".equals(operation)) {
                connector.mcpManagement("tenant", SESSION);
                verify(client).mcpManagement(any());
            } else if ("submit".equals(operation)) {
                connector.manageMcp("tenant", SESSION, Map.of("operationId", OPERATION));
                verify(client).manageMcp(any(), any());
            } else {
                connector.mcpManagementOperation("tenant", SESSION, OPERATION);
                verify(client).mcpManagementOperation(any(), any());
            }
        }
    }
}
