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
        // containsEntry cannot prove absence: the raw update map must never
        // bleed through into the projected, persisted and re-streamed data.
        // The secret is nested two levels down, so absence is asserted on
        // the serialized form, which holds at any nesting depth.
        assertThat(event.data().toString()).doesNotContain("secret")
                .doesNotContain("must-not-leak");
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

    @Test
    void projectsToolCallsWithoutLeakingOtherUpdateFields() {
        ProjectedEvent event = projector.project(new SourceEvent(7L,
                "session_update", Map.of("update", Map.of(
                        "sessionUpdate", "tool_call",
                        "toolCallId", "tool-1",
                        "name", "read_file",
                        "title", "Read file",
                        "status", "completed",
                        "rawInput", Map.of("path", "/private/workspace"),
                        "secret", "must-not-leak")), "prompt", Map.of()),
                "turn-1");

        assertThat(event.type()).isEqualTo("item.tool_call.updated");
        assertThat(event.data()).containsEntry("toolCallId", "tool-1")
                .containsEntry("name", "read_file")
                .containsEntry("title", "Read file")
                .containsEntry("status", "completed");
        // The same allowlist guards the tool path: the raw update map must
        // never bleed through, at any nesting depth.
        assertThat(event.data().toString()).doesNotContain("secret")
                .doesNotContain("must-not-leak")
                .doesNotContain("/private/workspace")
                .doesNotContain("rawInput");
    }

    @Test
    void substitutesTheSafeFallbackCodeForAnOutOfAlphabetErrorCode() {
        ProjectedEvent event = projector.project(new SourceEvent(4L,
                "turn_error", Map.of("code", "sql=1; DROP TABLE users --",
                        "message", "tagged"), "prompt", Map.of()), "turn-1");

        assertThat(event.errorCode()).isEqualTo("hosted_harness_error");
        assertThat(event.type()).isEqualTo("turn.failed");
        assertThat(event.data().toString()).doesNotContain("DROP TABLE");
    }

    @Test
    void substitutesTheSafeFallbackCodeForAnOversizeErrorCode() {
        ProjectedEvent oversize = projector.project(new SourceEvent(5L,
                "turn_error", Map.of("code", "a".repeat(129), "message",
                        "tagged"), "prompt", Map.of()), "turn-1");
        ProjectedEvent atBound = projector.project(new SourceEvent(6L,
                "turn_error", Map.of("code", "b".repeat(128), "message",
                        "tagged"), "prompt", Map.of()), "turn-2");

        assertThat(oversize.errorCode()).isEqualTo("hosted_harness_error");
        assertThat(oversize.type()).isEqualTo("turn.failed");
        assertThat(atBound.errorCode()).isEqualTo("b".repeat(128));
    }

    @Test
    void projectsDeadlineExpiryAsAClassifiedFailure() {
        ProjectedEvent event = projector.project(new SourceEvent(4L,
                "turn_error", Map.of("code", "hosted_turn_deadline_exceeded",
                        "message",
                        "The Hosted Harness Turn exceeded its deadline."),
                "prompt", Map.of()), "turn-1");

        assertThat(event.type()).isEqualTo("turn.failed");
        assertThat(event.terminal()).isTrue();
        assertThat(event.terminalStatus()).isEqualTo("FAILED");
        assertThat(event.errorCode())
                .isEqualTo("hosted_turn_deadline_exceeded");
    }
}
