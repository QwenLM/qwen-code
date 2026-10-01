package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.EventIdentity.Identity;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

class EventIdentityTest {
    private static final String TURN = "turn_a";
    private static final String ASSISTANT = "item_turn_a_assistant";

    @Test
    void textDeltasContinueThePartOfTheDeltaBeforeThem() {
        Identity first = of("item.output_text.delta", 3, text("a"), null);
        Identity second = of("item.output_text.delta", 4, text("b"), first);
        Identity thought = of("item.reasoning.delta", 5, text("c"), second);
        Identity more = of("item.reasoning.delta", 6, text("d"), thought);
        Identity after = of("item.output_text.delta", 7, text("e"), more);

        assertThat(first).isEqualTo(new Identity("item.output_text.delta",
                ASSISTANT, "part_turn_a_output_text_3"));
        assertThat(second.contentPartId())
                .isEqualTo("part_turn_a_output_text_3");
        assertThat(thought.contentPartId())
                .isEqualTo("part_turn_a_reasoning_5");
        assertThat(more.contentPartId()).isEqualTo("part_turn_a_reasoning_5");
        assertThat(after.contentPartId())
                .isEqualTo("part_turn_a_output_text_7");
    }

    @Test
    void anythingButTheSameTextStreamStartsANewPart() {
        Identity text = of("item.output_text.delta", 3, text("a"), null);
        Identity tool = of("item.tool_call.updated", 4,
                Map.of("itemId", "item_tool_x"), text);
        Identity empty = of("item.output_text.delta", 5, text(""), text);
        Identity otherItem = of("item.output_text.delta", 6,
                Map.of("itemId", "item_other", "text", "b"), text);

        assertThat(tool).isEqualTo(new Identity("item.tool_call.updated",
                "item_tool_x", null));
        assertThat(of("item.output_text.delta", 5, text("b"), tool)
                .contentPartId()).isEqualTo("part_turn_a_output_text_5");
        // The projection skips empty text, so it names nothing.
        assertThat(empty).isEqualTo(new Identity("item.output_text.delta",
                null, null));
        assertThat(of("item.output_text.delta", 6, text("c"), empty)
                .contentPartId()).isEqualTo("part_turn_a_output_text_6");
        assertThat(otherItem).isEqualTo(new Identity(
                "item.output_text.delta", "item_other",
                "part_turn_a_output_text_6"));
    }

    @Test
    void inputAndToolEventsNameTheirItemWithoutAPart() {
        assertThat(of("turn.accepted", 2, Map.of(), null)).isEqualTo(
                new Identity("turn.accepted", "item_turn_a_input", null));
        assertThat(of("item.tool_call.updated", 8,
                Map.of("toolCallId", "tool-1"), null).itemId())
                .isEqualTo("item_tool_" + UUID.nameUUIDFromBytes(
                        "turn_a:tool-1".getBytes(StandardCharsets.UTF_8)));
        assertThat(of("item.tool_call.updated", 8, Map.of(), null).itemId())
                .isEqualTo("item_tool_" + UUID.nameUUIDFromBytes(
                        "turn_a:sequence:8".getBytes(StandardCharsets.UTF_8)));
        assertThat(of("turn.completed", 9, Map.of(), null))
                .isEqualTo(new Identity("turn.completed", null, null));
    }

    @Test
    void toolResultUpdatesShareToolIdentityAndSequenceFallbackWithoutAPart() {
        for (Map<String, Object> data :
                java.util.List.<Map<String, Object>>of(Map.of("toolCallId", "tool-1"), Map.of())) {
            assertThat(of("item.tool_result.updated", 8, data, null))
                    .isEqualTo(
                            new Identity(
                                    "item.tool_result.updated",
                                    of("item.tool_call.updated", 8, data, null).itemId(),
                                    null));
        }
    }

    private static Identity of(String type, long sequence,
            Map<String, Object> data, Identity previous) {
        return EventIdentity.of(type, TURN, sequence, data, previous);
    }

    private static Map<String, Object> text(String value) {
        return Map.of("text", value);
    }
}
