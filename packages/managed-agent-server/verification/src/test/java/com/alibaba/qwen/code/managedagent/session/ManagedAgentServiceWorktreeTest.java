package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ManagedAgentServiceWorktreeTest {
    private final AgentStateStore store = mock(AgentStateStore.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final HarnessCoordinator coordinator = mock(HarnessCoordinator.class);
    private final SessionWorktreeService worktrees = mock(SessionWorktreeService.class);
    private final WorkspaceSelection selection = new WorkspaceSelection("workspace", ".");
    private final SessionWorktreeService.Request request = new SessionWorktreeService.Request("main");
    private final ManagedAgentService service = new ManagedAgentService(store, new RequestDigests(),
            coordinator, harness, mock(ManagedWorkspaceRegistry.class), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void creationDoesNotWarmOrDispatchBeforeTheWorktreeIsReady(boolean prompted) {
        service.setSessionWorktrees(worktrees);
        var plan = mock(SessionWorktreeStore.Plan.class);
        when(worktrees.preflight("tenant", "actor", selection, request)).thenReturn(plan);
        when(harness.isAvailable()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.findSessionWorktree("tenant", "session")).thenReturn(descriptor());
        when(store.insertWorkspaceSessionCommand(argThat(command -> command != null
                && "tenant".equals(command.tenantId()) && "actor".equals(command.actorId())
                && "key".equals(command.idempotencyKey()) && "qwen-code".equals(command.agentId())
                && command.requestedRevision() == null && "title".equals(command.title())
                && selection.equals(command.selection()) && command.requestedApprovalMode() == null
                && command.requestedPlanMode() == null && command.modelId() == null
                && command.extensionPins() == null && plan.equals(command.worktree()))))
                .thenReturn(new Admission("session", prompted ? "turn" : null, false, true));

        var result = service.createWorkspaceSession("tenant", "actor", "key", "qwen-code", null,
                "title", null, prompted ? List.of(new InputBlock("text", "go")) : List.of(), selection,
                null, null, List.of(), null, null, request);

        assertThat(result.sessionId()).isEqualTo("session");
        verify(worktrees).preflight("tenant", "actor", selection, request);
        verifyNoInteractions(coordinator);
    }

    @Test
    void recordedCreationReplaysBeforeWorktreePreflightOrRuntimeAvailability() {
        service.setSessionWorktrees(worktrees);
        when(store.findWorkspaceCreateReplay(eq("tenant"), eq("actor"), eq("key"), anyString()))
                .thenReturn(Optional.of(new Admission("session", "turn", true, false)));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.findSessionWorktree("tenant", "session")).thenReturn(descriptor());

        var result = service.createWorkspaceSession("tenant", "actor", "key", "qwen-code", null,
                "title", null, List.of(new InputBlock("text", "go")), selection,
                null, null, List.of(), null, null, request);

        assertThat(result.replayed()).isTrue();
        assertThat(result.sessionId()).isEqualTo("session");
        verifyNoInteractions(worktrees, coordinator);
    }

    private static SessionWorktreeStore.Descriptor descriptor() {
        return new SessionWorktreeStore.Descriptor("worktree", "session", "workspace", "preparing",
                "qwen/session", "a".repeat(40), ".qwen-managed-worktrees/worktree", "operation", 1, null);
    }
}
