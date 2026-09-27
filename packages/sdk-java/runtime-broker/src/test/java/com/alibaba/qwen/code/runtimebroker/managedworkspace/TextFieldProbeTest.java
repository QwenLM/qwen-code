package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.TENANT;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * Probes the text rule of display names and actor IDs with every code point
 * of the Basic Multilingual Plane and a few astral ones.
 */
class TextFieldProbeTest {
    @Test
    void acceptsExactlyWellFormedTextWithoutControls() {
        List<String> mismatches = new ArrayList<>();
        probe("displayName", mismatches, text -> new WorkspaceRecord(TENANT,
                "ws-a", 1, "storage-a", text, WorkspaceState.ACTIVE,
                "policy:a", "config:a"));
        probe("actorId", mismatches, text -> new WorkspaceActor(TENANT, text));
        probe("grant actorId", mismatches,
                text -> GrantedWorkspaceAccessPolicy.builder().grant(TENANT,
                        text, "ws-a", WorkspaceAccess.READ));

        assertEquals(List.of(), mismatches);
    }

    private static void probe(String field, List<String> mismatches,
            Consumer<String> build) {
        for (int codePoint : codePoints()) {
            boolean accepted;
            try {
                build.accept("a" + new String(Character.toChars(codePoint))
                        + "b");
                accepted = true;
            } catch (IllegalArgumentException exception) {
                accepted = false;
            }
            if (accepted != isText(codePoint)) {
                mismatches.add(field + " U+" + Integer.toHexString(codePoint));
            }
        }
    }

    // The rule restated as code point ranges: no C0 control, DEL, C1 control
    // or lone surrogate.
    private static boolean isText(int codePoint) {
        boolean control = codePoint <= 0x1F
                || (codePoint >= 0x7F && codePoint <= 0x9F);
        boolean surrogate = codePoint >= 0xD800 && codePoint <= 0xDFFF;
        return !control && !surrogate;
    }

    private static List<Integer> codePoints() {
        List<Integer> codePoints = new ArrayList<>();
        for (int codePoint = 0; codePoint <= 0xFFFF; codePoint++) {
            codePoints.add(codePoint);
        }
        codePoints.addAll(List.of(0x10000, 0x1D11E, 0x1F600, 0xE0041,
                0x10FFFF));
        return codePoints;
    }
}
