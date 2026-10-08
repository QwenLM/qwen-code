package com.alibaba.qwen.code.managedagent.service;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import java.time.Clock;
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
                Clock.systemUTC(), new ManagedAgentProperties());

        coordinator.recover();
        coordinator.dispatch("tenant", "session", "operation");

        verifyNoInteractions(sessions, actions, executor);
    }
}
