package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedAgentSubmissionRecoveryTest {
    private final AgentStateStore store = mock(AgentStateStore.class);
    private final ManagedWorkspaceRegistry workspaces = mock(ManagedWorkspaceRegistry.class);
    private final SessionPrincipal principal = SessionPrincipal.ofUser("tenant", "user");
    private ManagedAgentService service;

    @BeforeEach
    void setUp() {
        service = new ManagedAgentService(store, mock(RequestDigests.class), mock(HarnessCoordinator.class),
                mock(HarnessConnector.class), workspaces, mock(HarnessRules.class));
        StoreModels.SessionRecord session = mock(StoreModels.SessionRecord.class);
        when(session.tenantId()).thenReturn("tenant");
        when(session.sessionId()).thenReturn("native");
        when(session.status()).thenReturn("ACTIVE");
        when(store.requireSession("tenant", "native")).thenReturn(session);
        when(store.findSessionById("native")).thenReturn(Optional.of(session));
        when(store.requireSession("tenant", "another-session"))
                .thenThrow(new ManagedAgentException(404, "session_not_found", "The Session was not found."));
        StoreModels.CommandRecord command = new StoreModels.CommandRecord("tenant", "SUBMIT_TURN", "key", "digest", "native",
                "turn", "accepted", null, principal.receiptActorKey(), 1, 1);
        when(store.findCommand("tenant", "SUBMIT_TURN", "key")).thenReturn(Optional.of(command));
        when(store.replayCommand("tenant", "SUBMIT_TURN", "key", "digest"))
                .thenReturn(new StoreModels.Admission("native", "turn", true, false, "operation"));
        when(store.findOperation("tenant", "native", "operation"))
                .thenReturn(Optional.of(new StoreModels.OperationRecord("tenant", "native", "operation", null, "digest", "accepted",
                        "accepted", "ready", "active", null, null, 1, 1)));
    }

    @Test
    void replaysOnlyTheAuthorizedOriginalSubmissionWithoutSubmittingAgain() {
        var receipt = service.findSubmission(principal, "key", "native");

        assertEquals("native", receipt.sessionId());
        assertEquals("turn", receipt.turnId());
        assertEquals("operation", receipt.operationId());
        verify(store).requireSessionReadAuthority("tenant", "native", principal);
        verify(store, never()).insertTurnCommand(anyString(), anyString(), anyString(), anyString(), anyString(), any(), anyString());
    }

    @Test
    void differentActorAndSessionCannotRecoverOriginalAdmission() {
        assertThrows(ManagedAgentException.class, () -> service.findSubmission(SessionPrincipal.ofUser("tenant", "another"), "key", "native"));
        assertThrows(ManagedAgentException.class, () -> service.findSubmission(principal, "key", "another-session"));
        verify(store, never()).replayCommand(anyString(), anyString(), anyString(), anyString());
    }

}
