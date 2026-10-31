package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.session.EventProjectionStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionAdmissionStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.contracts.session.TurnExecutionStore;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pins the role composition: the composite declares nothing of its own,
 * extends exactly the six roles, and nested types resolve through
 * inheritance from their owning role. New state surface belongs on a role,
 * never on the composite.
 */
class AgentStateStoreRolesTest {
    @Test
    void theCompositeIsExactlyTheSixRoles() {
        assertThat(AgentStateStore.class.getDeclaredMethods()).isEmpty();
        assertThat(Set.of(AgentStateStore.class.getInterfaces()))
                .containsExactlyInAnyOrder(
                        SessionAdmissionStore.class,
                        SessionLifecycleStore.class,
                        SessionQueryStore.class,
                        SessionPolicyStore.class,
                        EventProjectionStore.class,
                        TurnExecutionStore.class);
    }

    @Test
    void nestedTypesResolveThroughTheOwningRole() {
        assertThat(AgentStateStore.TaskCancelOutcome.class)
                .isSameAs(SessionLifecycleStore.TaskCancelOutcome.class);
        assertThat(AgentStateStore.CwdChangeOutcome.class)
                .isSameAs(SessionLifecycleStore.CwdChangeOutcome.class);
        assertThat(AgentStateStore.ContextCompressionState.class)
                .isSameAs(SessionLifecycleStore.ContextCompressionState.class);
        assertThat(AgentStateStore.WORKFLOW_RECOVERY_BLOCKED)
                .isEqualTo(TurnExecutionStore.WORKFLOW_RECOVERY_BLOCKED);
        assertThat(AgentStateStore.RUNTIME_RECOVERY_BLOCKED)
                .isEqualTo(TurnExecutionStore.RUNTIME_RECOVERY_BLOCKED);
        assertThat(AgentStateStore.HARNESS_RECOVERY_BLOCKED)
                .isEqualTo(TurnExecutionStore.HARNESS_RECOVERY_BLOCKED);
    }
}
