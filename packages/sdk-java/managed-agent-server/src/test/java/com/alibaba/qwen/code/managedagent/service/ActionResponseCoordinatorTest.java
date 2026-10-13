package com.alibaba.qwen.code.managedagent.service;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.verifyNoInteractions;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.ExecutorService;
import org.junit.jupiter.api.Test;

class ActionResponseCoordinatorTest {
    @Test
    void disabledHarnessLeavesApprovalResponsesForAnotherReplica() {
        AgentStateStore sessions = mock(AgentStateStore.class);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        ExecutorService executor = mock(ExecutorService.class);
        ActionResponseCoordinator coordinator = new ActionResponseCoordinator(
                sessions, actions, new UnavailableHarnessConnector(), executor,
                Clock.fixed(Instant.ofEpochMilli(100), ZoneOffset.UTC), new ManagedAgentProperties());

        coordinator.recover();
        coordinator.dispatch("tenant", "session", "operation");

        verify(actions).settleEndedResponses(100);
        verifyNoMoreInteractions(actions);
        verifyNoInteractions(sessions, executor);
    }
    @org.junit.jupiter.api.Test
    void disabledHarnessDoesNotScanRenameDeliveries() {
        var store = org.mockito.Mockito.mock(com.alibaba.qwen.code.managedagent.store.AgentStateStore.class);
        var executor = org.mockito.Mockito.mock(java.util.concurrent.ExecutorService.class);
        var coordinator = new SessionRenameCoordinator(store,
                new com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector(),
                executor, java.time.Clock.systemUTC(),
                new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties());
        coordinator.recover();
        org.mockito.Mockito.verifyNoInteractions(store, executor);
    }

}
