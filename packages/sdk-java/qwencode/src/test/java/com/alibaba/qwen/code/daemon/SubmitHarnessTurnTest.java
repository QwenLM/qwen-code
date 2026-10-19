package com.alibaba.qwen.code.daemon;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SubmitHarnessTurnTest {
    private SubmitHarnessTurn.Builder turn() {
        return SubmitHarnessTurn.builder().session(new HarnessSessionRef("22222222-2222-4222-8222-222222222222",
                "client", "11111111-1111-4111-8111-111111111111", "/control", null, null, null))
                .promptId("33333333-3333-4333-8333-333333333333").addText("plan this")
                .payloadDigest(SubmitHarnessTurn.computePayloadDigest(List.of(Map.of("type", "text", "text", "plan this"))));
    }

    @Test
    void preservesLegacyWireShapeAndExplicitlyCarriesOnlyEnabledPlanSnapshots() {
        assertEquals(Map.of("mode", "yolo", "revision", 1L), turn().approvalSelection("yolo", 1).build().getApprovalSelection());
        assertEquals(Map.of("mode", "yolo", "revision", 1L), turn().approvalSelection("yolo", 1, false).build().getApprovalSelection());
        assertEquals(Map.of("mode", "yolo", "revision", 1L, "planMode", true),
                turn().approvalSelection("yolo", 1, true).build().getApprovalSelection());
        assertThrows(IllegalArgumentException.class, () -> turn().approvalSelection("yolo", 0, true));
    }

    @Test
    void hashesEveryInlineAttachmentByteRatherThanOnlyThePromptText() {
        var first = List.<Map<String, Object>>of(Map.of("type", "resource", "resource",
                Map.of("uri", "managed-input:///a.txt", "mimeType", "text/plain", "text", "first")));
        var next = List.<Map<String, Object>>of(Map.of("type", "resource", "resource",
                Map.of("uri", "managed-input:///a.txt", "mimeType", "text/plain", "text", "second")));
        assertNotEquals(SubmitHarnessTurn.computePayloadDigest(first), SubmitHarnessTurn.computePayloadDigest(next));
    }
}
