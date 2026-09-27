package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.service.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import java.util.Map;
import org.junit.jupiter.api.Test;

class HarnessEventProjectorTest {
    private final HarnessEventProjector projector =
            new HarnessEventProjector();

    @Test
    void projectsTextWithoutLeakingOtherUpdateFields() {
        ProjectedEvent event = projector.project(new SourceEvent(1L,
                "session_update", Map.of("update", Map.of(
                        "sessionUpdate", "agent_message_chunk",
                        "content", Map.of("type", "text", "text", "hello"),
                        "secret", "must-not-leak")), "prompt", Map.of()),
                "turn-1");

        assertThat(event.type()).isEqualTo("item.output_text.delta");
        assertThat(event.data()).containsEntry("text", "hello")
                .containsEntry("itemId", "item_turn-1_assistant")
                .containsEntry("contentPartId",
                        "part_turn-1_output_text");
    }

    @Test
    void mapsCancellationToATerminalState() {
        ProjectedEvent event = projector.project(new SourceEvent(2L,
                "turn_complete", Map.of("stopReason", "cancelled"),
                "prompt", Map.of()), "turn-1");

        assertThat(event.type()).isEqualTo("turn.cancelled");
        assertThat(event.terminalStatus()).isEqualTo("CANCELLED");
        assertThat(event.terminal()).isTrue();
    }

    @Test
    void redactsHarnessErrorDetails() {
        ProjectedEvent event = projector.project(new SourceEvent(3L,
                "turn_error", Map.of("code", "model_failed", "message",
                        "token=secret path=/private/workspace"),
                "prompt", Map.of()), "turn-1");

        assertThat(event.errorCode()).isEqualTo("model_failed");
        assertThat(event.data().toString()).doesNotContain("secret")
                .doesNotContain("/private/workspace");
    }
}
