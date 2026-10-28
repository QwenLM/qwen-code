package com.alibaba.qwen.code.managedagent.workspace;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionWorktreeServiceTest {
    private final SessionWorktreeStore store = mock(SessionWorktreeStore.class);
    private final WorkspaceExecutionStore execution = mock(WorkspaceExecutionStore.class);
    private final ManagedAgentStore sessions = mock(ManagedAgentStore.class);
    private final SessionWorktreeService service = new SessionWorktreeService(store, execution, new ManagedAgentProperties(),
            sessions, mock(HarnessCoordinator.class));

    @AfterEach
    void stop() {
        service.stop();
    }

    @Test
    void storageBusyDefersWithoutFailingOrConsumingAnAttempt() {
        var row = preparing();
        when(execution.holdForMaintenance(any(), anyString(), anyLong())).thenThrow(
                new RuntimeBrokerException(409, "workspace_busy", "busy", true));
        service.drive(row);
        verify(store).defer(eq(row), anyString(), eq("workspace_busy"));
        verify(store, never()).retry(any(), anyString(), anyString());
        verify(store, never()).complete(any(), anyString(), anyString(), any(), any());
        verify(sessions, never()).failWorktreeInitialTurns(anyString(), anyString(), anyString());
    }

    @Test
    void retryableMountFailureKeepsTheSamePreparation() {
        var row = preparing();
        when(execution.holdForMaintenance(any(), anyString(), anyLong())).thenThrow(
                new RuntimeBrokerException(409, "workspace_unavailable", "temporary", true));
        service.drive(row);
        verify(store).retry(eq(row), anyString(), eq("workspace_unavailable"));
        verify(store, never()).complete(any(), anyString(), anyString(), any(), any());
    }

    @Test
    void unknownOriginalGitExecutionStaysBlocked() {
        var row = preparing();
        when(execution.holdForMaintenance(any(), anyString(), anyLong())).thenThrow(
                new RuntimeBrokerException(409, "maintenance_stop_unverified", "unknown", false));
        when(store.maintenanceHeld(row)).thenReturn(true);
        service.drive(row);
        verify(store).complete(eq(row), anyString(), eq("BLOCKED"), eq(null), eq("maintenance_stop_unverified"));
        verify(execution, never()).releaseMaintenance(any(), anyString(), anyLong(), anyString());
    }

    @Test
    void cleanupRechecksWritersAndPermissionAfterTakingMaintenance() {
        var row = operation("REMOVING");
        when(store.cleanupBlocker(row)).thenReturn(null, "worktree_forbidden");
        when(execution.holdForMaintenance(any(), anyString(), anyLong())).thenReturn("step");
        service.drive(row);
        verify(execution).releaseMaintenance(any(), eq(row.operationId()), eq(row.generation()), eq("step"));
        verify(store).complete(eq(row), anyString(), eq("READY"), eq(null), eq("worktree_forbidden"));
    }

    @Test
    void scanSettlesTheInitialTurnAfterAFailureCommitWasInterrupted() {
        when(store.failedInitialSessions()).thenReturn(java.util.Collections.singletonList(new String[] {"tenant", "session", "worktree_git_failed"}));
        when(store.due()).thenReturn(List.of());
        service.scan();
        verify(sessions).failWorktreeInitialTurns("tenant", "session", "worktree_git_failed");
    }

    private SessionWorktreeStore.Row preparing() {
        return operation("PREPARING");
    }

    private SessionWorktreeStore.Row operation(String state) {
        String id = "a".repeat(32);
        var plan = new SessionWorktreeStore.Plan("tenant", "workspace", 1, "storage", "project", "config", 1,
                "/storage", "root", "project", ".", "/storage/project/.git", "git", null, "a".repeat(40),
                id, ".qwen-managed-worktrees/" + id, ".qwen-managed-worktrees/" + id, "worktree-managed-" + id);
        var row = new SessionWorktreeStore.Row("tenant", "session", "workspace", id, state, plan, null, id,
                null, 1, null, state, 0, 1, null, "actor");
        when(store.claim(eq(row), anyString(), anyLong())).thenReturn(row);
        when(store.active(row)).thenReturn(true);
        return row;
    }
}
