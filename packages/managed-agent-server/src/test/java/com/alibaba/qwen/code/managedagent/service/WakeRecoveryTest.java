package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.WakeRecoveryStore;
import com.alibaba.qwen.code.managedagent.store.WakeRecoveryStore.Candidate;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.junit.jupiter.api.Test;

import java.util.List;

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
            when(store.hasPendingInput(row)).thenReturn(true);
            when(store.recordPending(row, true)).thenReturn(true);
        }
        doThrow(new IllegalStateException("unavailable")).when(harness).recoverForWake("tenant", "first");
        recovery().scan();
        verify(harness).recoverForWake("tenant", "second");
        verify(store, never()).recordPending(first, false);
    }

    @Test
    void aStoppedChildDoesNotRestartItsPendingMessages() {
        var child = new Candidate("tenant", "workspace", "child", 1, 2, 0, "parent", "run");
        when(harness.isAvailable()).thenReturn(true);
        when(store.findPending("workspace", 8)).thenReturn(List.of(child));
        when(store.claim(child)).thenReturn(true);
        when(store.hasPendingInput(child)).thenReturn(true);
        when(store.recordPending(child, true)).thenReturn(true);
        when(records.childRunBody("tenant", "parent", "run"))
                .thenReturn(JsonNodeFactory.instance.objectNode().put("stopRequested", true));
        recovery().scan();
        verify(harness, never()).recoverForWake(anyString(), anyString());
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
