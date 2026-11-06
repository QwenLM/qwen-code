package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedTaskEventStore;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * The String overloads must fail closed on a missing actor instead of
 * passing a null principal into reads that would NPE or answer an empty
 * page, and into cancels that would record an unowned operation.
 */
class ManagedTaskActorBoundaryTest {
    @Test
    void actorlessTaskReadsFailClosedBeforeAnyStoreAccess() {
        ManagedAgentService sessions = mock(ManagedAgentService.class);
        ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
        ManagedTaskEventStore events = mock(ManagedTaskEventStore.class);
        ManagedTaskService tasks = new ManagedTaskService(sessions, records, events);
        for (String actor : new String[] {null, " "}) {
            assertThatThrownBy(() -> tasks.listPublicTasks("tenant", actor, "session", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(401);
                        assertThat(error.getCode()).isEqualTo("actor_required");
                    });
            assertThatThrownBy(() -> tasks.getPublicTask("tenant", actor, "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("actor_required"));
            assertThatThrownBy(() -> tasks.queryWebShellTasks("tenant", actor, "session", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("actor_required"));
            assertThatThrownBy(() -> tasks.getWebShellTask("tenant", actor, "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("actor_required"));
            assertThatThrownBy(() -> tasks.listPublicTaskEvents("tenant", actor, "session", "task", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("actor_required"));
            assertThatThrownBy(() -> tasks.queryWebShellTaskEvents("tenant", actor, "session", "task", null, 10))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("actor_required"));
        }
        verifyNoInteractions(sessions, records, events);
    }

    @Test
    void actorlessTaskCancelsFailClosedBeforeAnyStoreAccess() {
        SessionLifecycleStore store = mock(SessionLifecycleStore.class);
        ManagedAgentService sessions = mock(ManagedAgentService.class);
        ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
        SessionLifecycleService operations = mock(SessionLifecycleService.class);
        TaskCancelCoordinator coordinator = mock(TaskCancelCoordinator.class);
        ManagedTaskCancelService cancels = new ManagedTaskCancelService(store, sessions, records,
                new RequestDigests(), operations, coordinator);
        for (String actor : new String[] {null, " "}) {
            assertThatThrownBy(() -> cancels.cancelPublic("tenant", actor, "key", "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(401);
                        assertThat(error.getCode()).isEqualTo("actor_required");
                    });
            assertThatThrownBy(() -> cancels.cancelWebShell("tenant", actor, "key", "session", "task"))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("actor_required"));
        }
        verifyNoInteractions(store, sessions, records, operations, coordinator);
    }
}
