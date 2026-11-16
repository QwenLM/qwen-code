package com.alibaba.qwen.code.managedagent.contracts.session;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class HarnessConflictCodesTest {
    @Test
    void readsTheCodeFieldFromAFlatErrorBody() {
        assertThat(HarnessConflictCodes.bodyCode("{\"code\":\"hosted_turn_recovery_required\"}"))
                .isEqualTo("hosted_turn_recovery_required");
    }

    @Test
    void toleratesWhitespaceAroundTheColon() {
        assertThat(HarnessConflictCodes.bodyCode("{\"code\": \"hosted_session_closing\"}"))
                .isEqualTo("hosted_session_closing");
    }

    @Test
    void skipsAnEarlierNonCodeField() {
        assertThat(HarnessConflictCodes.bodyCode(
                "{\"error\":\"x\",\"code\":\"hosted_turn_recovery_required\"}"))
                .isEqualTo("hosted_turn_recovery_required");
    }

    @Test
    void matchesAStoredBodyTruncatedMidJson() {
        assertThat(HarnessConflictCodes.bodyCode(
                "{\"code\":\"hosted_session_closing\",\"message\":\"a long"))
                .isEqualTo("hosted_session_closing");
    }

    @Test
    void returnsNullWhenThereIsNoCodeFieldOrBody() {
        assertThat(HarnessConflictCodes.bodyCode(null)).isNull();
        assertThat(HarnessConflictCodes.bodyCode("{\"message\":\"no code\"}")).isNull();
    }
}
