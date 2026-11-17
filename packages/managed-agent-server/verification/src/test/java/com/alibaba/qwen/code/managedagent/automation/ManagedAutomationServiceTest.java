package com.alibaba.qwen.code.managedagent.automation;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedAutomationServiceTest {
    // A dead writer's lease lapses on its own. A 409 would tell the caller
    // the conflict is final, so the public route crosses it as the
    // retryable 503 the channel routes already answer. The inputs are a
    // fixed list rather than the production set, so dropping a member from
    // that set fails this test.
    @ParameterizedTest
    @ValueSource(strings = {"managed_session_writer_conflict",
            "workspace_busy", "workspace_unavailable",
            "hosted_session_closing"})
    void crossesASelfHealingHarnessConflictAsRetryable(String code) {
        ManagedAgentException conflict = ManagedAutomationService
                .translate(refusal(409, code));
        assertThat(conflict.getStatus())
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE.value());
        assertThat(conflict.getCode()).isEqualTo(code);
    }

    // A refusal a retry cannot change keeps its class.
    @Test
    void keepsADeterministicHarnessConflictAsConflict() {
        ManagedAgentException conflict = ManagedAutomationService.translate(
                refusal(409, "hosted_automations_unavailable"));
        assertThat(conflict.getStatus()).isEqualTo(409);
        assertThat(conflict.getCode())
                .isEqualTo("hosted_automations_unavailable");
    }

    // A recovery block can lift, but a cleanup block may never: the route
    // does not promise a retry for this code.
    @Test
    void keepsHostedSessionBlockedAsConflict() {
        ManagedAgentException conflict = ManagedAutomationService.translate(
                refusal(409, "hosted_session_blocked"));
        assertThat(conflict.getStatus()).isEqualTo(409);
        assertThat(conflict.getCode()).isEqualTo("hosted_session_blocked");
    }

    // A 409 whose body names no code is not a self-healing conflict.
    @Test
    void keepsACodeLessHarnessConflictAsConflict() {
        HarnessHttpFailure error = mock(HarnessHttpFailure.class);
        when(error.getStatusCode()).thenReturn(409);
        when(error.getResponseBody()).thenReturn(null);
        ManagedAgentException conflict = ManagedAutomationService.translate(error);
        assertThat(conflict.getStatus()).isEqualTo(409);
        assertThat(conflict.getCode()).isEqualTo("automation_operation_failed");
    }

    private static HarnessHttpFailure refusal(int status, String code) {
        HarnessHttpFailure error = mock(HarnessHttpFailure.class);
        when(error.getStatusCode()).thenReturn(status);
        when(error.getResponseBody()).thenReturn(
                "{\"error\":\"" + code + "\",\"code\":\"" + code + "\"}");
        return error;
    }
}
