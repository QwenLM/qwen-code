package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.persistence.WakeRecoveryStore;
import com.alibaba.qwen.code.managedagent.persistence.WakeRecoveryStore.Candidate;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;
import java.util.Optional;

import static org.mockito.Mockito.*;

class WakeRecoveryTest {
    private final WakeRecoveryStore store = mock(WakeRecoveryStore.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final ChildResultRelayStore records = mock(ChildResultRelayStore.class);
    private final ManagedAgentProperties properties = new ManagedAgentProperties();

    private WakeRecovery recovery() {
        properties.getSessionStore().setWorkspaceId("workspace");
        return new WakeRecovery(store, harness, records, properties);
    }

    @Test
    void aFailedLoadLeavesDurableRetryAndDoesNotStarveAnotherSession() {
        var first = new Candidate("tenant", "workspace", "first", 1, 2, 0, null, null);
        var second = new Candidate("tenant", "workspace", "second", 1, 2, 0, null, null);
        when(harness.isAvailable()).thenReturn(true);
        when(store.findPending("workspace", 8)).thenReturn(List.of(first, second));
        for (var row : List.of(first, second)) {
            when(store.claim(row)).thenReturn(true);
            when(store.hasPendingInput(row)).thenReturn(Optional.of(true));
            when(store.recordPending(row, true)).thenReturn(true);
        }
        doThrow(new IllegalStateException("unavailable")).when(harness).recoverForWake("tenant", "first");
        recovery().scan();
        verify(harness).recoverForWake("tenant", "second");
        verify(store, never()).recordPending(first, false);
    }

    @Test
    void aPartialProofNeitherStampsNorLoadsAndLetsTheNextCandidateRecover() {
        var first = new Candidate("tenant", "workspace", "first", 1000, 1000, 0, null, null);
        var second = new Candidate("tenant", "workspace", "second", 1, 1, 0, null, null);
        when(harness.isAvailable()).thenReturn(true);
        when(store.findPending("workspace", 8)).thenReturn(List.of(first, second));
        when(store.claim(first)).thenReturn(true);
        when(store.claim(second)).thenReturn(true);
        when(store.hasPendingInput(first)).thenReturn(Optional.empty());
        when(store.hasPendingInput(second)).thenReturn(Optional.of(true));
        when(store.recordPending(second, true)).thenReturn(true);
        recovery().scan();
        verify(store, never()).recordPending(eq(first), anyBoolean());
        verify(harness, never()).recoverForWake("tenant", "first");
        verify(harness).recoverForWake("tenant", "second");
    }

    @Test
    void aStoppedChildDoesNotRestartItsPendingMessages() {
        var child = new Candidate("tenant", "workspace", "child", 1, 2, 0, "parent", "run");
        when(harness.isAvailable()).thenReturn(true);
        when(store.findPending("workspace", 8)).thenReturn(List.of(child));
        when(store.claim(child)).thenReturn(true);
        when(store.hasPendingInput(child)).thenReturn(Optional.of(true));
        when(store.recordPending(child, true)).thenReturn(true);
        when(records.childRunBody("tenant", "parent", "run"))
                .thenReturn(JsonNodeFactory.instance.objectNode().put("stopRequested", true));
        recovery().scan();
        verify(store).recordPending(child, true);
        verify(store).recordPending(child, false);
        verify(records).childRunBody("tenant", "parent", "run");
        verify(harness, never()).recoverForWake(anyString(), anyString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"settled", "failed", "cancelled", "running"})
    void onlyAnActiveChildRunCanRecover(String state) {
        var child = new Candidate("tenant", "workspace", "child", 1, 2, 0, "parent", "run");
        when(harness.isAvailable()).thenReturn(true);
        when(store.findPending("workspace", 8)).thenReturn(List.of(child));
        when(store.claim(child)).thenReturn(true);
        when(store.hasPendingInput(child)).thenReturn(Optional.of(true));
        when(store.recordPending(child, true)).thenReturn(true);
        var body = JsonNodeFactory.instance.objectNode().put("stopRequested", false);
        body.putObject("run").put("state", state);
        when(records.childRunBody("tenant", "parent", "run")).thenReturn(body);
        recovery().scan();
        verify(records).childRunBody("tenant", "parent", "run");
        if ("running".equals(state)) {
            verify(harness).recoverForWake("tenant", "child");
            verify(store, never()).recordPending(child, false);
        } else {
            verify(harness, never()).recoverForWake(anyString(), anyString());
            verify(store).recordPending(child, false);
        }
    }

    @Test
    void aSettledPrefixClearsTheHintWithoutLoading() {
        var row = new Candidate("tenant", "workspace", "session", 1, 2, 0, null, null);
        when(harness.isAvailable()).thenReturn(true);
        when(store.findPending("workspace", 8)).thenReturn(List.of(row));
        when(store.claim(row)).thenReturn(true);
        when(store.hasPendingInput(row)).thenReturn(Optional.of(false));
        when(store.recordPending(row, false)).thenReturn(true);
        recovery().scan();
        verify(store).recordPending(row, false);
        verify(harness, never()).recoverForWake(anyString(), anyString());
        verifyNoInteractions(records);
    }

    @Test
    void aRefusedProofStampNeverReadsTheParentOrLoadsWork() {
        var row = new Candidate("tenant", "workspace", "child", 1, 2, 0, "parent", "run");
        when(harness.isAvailable()).thenReturn(true);
        when(store.findPending("workspace", 8)).thenReturn(List.of(row));
        when(store.claim(row)).thenReturn(true);
        when(store.hasPendingInput(row)).thenReturn(Optional.of(true));
        when(store.recordPending(row, true)).thenReturn(false);
        recovery().scan();
        verify(store).recordPending(row, true);
        verify(harness, never()).recoverForWake(anyString(), anyString());
        verifyNoInteractions(records);
    }

    @Test
    void unavailableHarnessAndLostClaimNeverReadOrLoadWork() {
        recovery().scan();
        verifyNoInteractions(store);
        when(harness.isAvailable()).thenReturn(true);
        var row = new Candidate("tenant", "workspace", "session", 1, 2, 0, null, null);
        when(store.findPending("workspace", 8)).thenReturn(List.of(row));
        recovery().scan();
        verify(store, never()).hasPendingInput(row);
        verify(harness, never()).recoverForWake(anyString(), anyString());
    }
}
