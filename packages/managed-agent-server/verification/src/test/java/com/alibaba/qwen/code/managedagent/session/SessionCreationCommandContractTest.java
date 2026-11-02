package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Pins the P0 convergence of the workspace-session creation chain: the
 * contract declares exactly one insertWorkspaceSessionCommand, taking the
 * named command, and the count may ratchet down, never up.
 */
class SessionCreationCommandContractTest {
    @Test
    void theContractDeclaresExactlyOneWorkspaceCreationEntry() {
        List<Method> entries = Arrays.stream(AgentStateStore.class.getMethods())
                .filter(method -> method.getName().equals("insertWorkspaceSessionCommand"))
                .toList();
        assertThat(entries).hasSize(1);
        assertThat(entries.get(0).getParameterTypes())
                .containsExactly(SessionCreationCommand.class);
    }

    @Test
    void theBuilderNamesEveryComponentAndKeepsTheFormerDefaults() {
        SessionCreationCommand command = SessionCreationCommand.builder()
                .tenantId("tenant")
                .actorId("actor")
                .idempotencyKey("key")
                .requestDigest("digest")
                .agentId("qwen-code")
                .selection(new WorkspaceSelection("ws", "."))
                .build();
        assertThat(command.tenantId()).isEqualTo("tenant");
        assertThat(command.actorId()).isEqualTo("actor");
        assertThat(command.idempotencyKey()).isEqualTo("key");
        assertThat(command.requestDigest()).isEqualTo("digest");
        assertThat(command.agentId()).isEqualTo("qwen-code");
        assertThat(command.selection()).isEqualTo(new WorkspaceSelection("ws", "."));
        assertThat(command.requestedRevision()).isNull();
        assertThat(command.title()).isNull();
        assertThat(command.input()).isEmpty();
        assertThat(command.payloadDigest()).isNull();
        assertThat(command.requestedApprovalMode()).isNull();
        assertThat(command.approvalSelectionSupported()).isFalse();
        assertThat(command.requestedPlanMode()).isNull();
        assertThat(command.planModeSupported()).isFalse();
        assertThat(command.skills()).isEmpty();
        assertThat(command.publicChildrenSupported()).isFalse();
        assertThat(command.modelId()).isNull();
        assertThat(command.extensionPins()).isNull();
        assertThat(command.extensionLifecycleProfiles()).isEqualTo(Set.of());
        assertThat(command.worktree()).isNull();
        assertThat(SessionCreationCommand.class.getRecordComponents()).hasSize(20);
    }

    @Test
    void anImplementationThatHasNotOptedInFailsClosed() {
        AgentStateStore partial = org.mockito.Mockito.mock(
                AgentStateStore.class, org.mockito.Mockito.CALLS_REAL_METHODS);
        assertThatThrownBy(() -> partial.insertWorkspaceSessionCommand(
                SessionCreationCommand.builder().tenantId("tenant").build()))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessage("Workspace session creation is unavailable");
    }
}
