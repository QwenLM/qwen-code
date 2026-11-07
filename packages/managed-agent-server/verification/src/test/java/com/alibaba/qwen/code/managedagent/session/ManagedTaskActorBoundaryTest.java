package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedTaskEventStore;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * The String overloads keep the tenant explicit and resolve Session
 * visibility before any actor guard. An actorless caller still reads inside
 * its own tenant, so a foreign or missing Session answers the read grant's
 * 404 — not an actor_required thrown while building a principal from a null
 * actor — and the projection stores stay untouched until visibility admits
 * the read; a cancel records nothing before the same gate.
 */
class ManagedTaskActorBoundaryTest {
    @Test
    void actorlessTaskReadsResolveVisibilityBeforeProjection() {
        ManagedAgentService sessions = mock(ManagedAgentService.class);
        ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
        ManagedTaskEventStore events = mock(ManagedTaskEventStore.class);
        when(sessions.requireReadableSession("tenant", (SessionPrincipal) null, "session"))
                .thenThrow(new ManagedAgentException(404, "session_not_found",
                        "The Session was not found."));
        ManagedTaskService tasks = new ManagedTaskService(sessions, records, events);
        for (String actor : new String[] {null, " "}) {
            assertThatThrownBy(() -> tasks.listPublicTasks("tenant", actor, "session", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(404);
                        assertThat(error.getCode()).isEqualTo("session_not_found");
                    });
            assertThatThrownBy(() -> tasks.getPublicTask("tenant", actor, "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
            assertThatThrownBy(() -> tasks.queryWebShellTasks("tenant", actor, "session", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
            assertThatThrownBy(() -> tasks.getWebShellTask("tenant", actor, "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
            assertThatThrownBy(() -> tasks.listPublicTaskEvents("tenant", actor, "session", "task", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
            assertThatThrownBy(() -> tasks.queryWebShellTaskEvents("tenant", actor, "session", "task", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
        }
        // Visibility ran with the caller's own tenant and a null principal;
        // its refusal kept the projection stores untouched.
        verify(sessions, atLeastOnce()).requireReadableSession("tenant", (SessionPrincipal) null, "session");
        verifyNoInteractions(records, events);
    }

    @Test
    void actorlessTaskCancelsResolveVisibilityBeforeRecording() {
        SessionLifecycleStore store = mock(SessionLifecycleStore.class);
        ManagedAgentService sessions = mock(ManagedAgentService.class);
        ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
        SessionLifecycleService operations = mock(SessionLifecycleService.class);
        TaskCancelCoordinator coordinator = mock(TaskCancelCoordinator.class);
        when(sessions.requireReadableSession("tenant", (SessionPrincipal) null, "session"))
                .thenThrow(new ManagedAgentException(404, "session_not_found",
                        "The Session was not found."));
        ManagedTaskCancelService cancels = new ManagedTaskCancelService(store, sessions, records,
                new RequestDigests(), operations, coordinator);
        for (String actor : new String[] {null, " "}) {
            assertThatThrownBy(() -> cancels.cancelPublic("tenant", actor, "key", "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(404);
                        assertThat(error.getCode()).isEqualTo("session_not_found");
                    });
            assertThatThrownBy(() -> cancels.cancelWebShell("tenant", actor, "key", "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
        }
        // The visibility refusal precedes any operation row or dispatch.
        verifyNoInteractions(store, records, operations, coordinator);
    }
}
