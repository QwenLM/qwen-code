package com.alibaba.qwen.code.managedagent.contracts.hostaction;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Structured outcome of a Turn-scoped host action execution, persisted in the
 * call's receipt and returned to the originating model Turn.
 */
public record HostTurnActionResult(
        boolean isError,
        String text,
        Map<String, Object> output) {
    public static final int MAX_RESULT_BYTES = 48 * 1024;

    public HostTurnActionResult {
        output = output == null
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(output));
        if (isError && (text == null || text.isBlank())) {
            throw new IllegalArgumentException("An error HostTurnActionResult requires a non-blank text message");
        }
    }

    @Override
    public Map<String, Object> output() {
        return output;
    }

    public static HostTurnActionResult success(Map<String, Object> output) {
        return new HostTurnActionResult(false, null, output);
    }

    public static HostTurnActionResult success(String text, Map<String, Object> output) {
        return new HostTurnActionResult(false, text, output);
    }

    public static HostTurnActionResult error(String message) {
        return new HostTurnActionResult(true, message, Map.of());
    }

    public static HostTurnActionResult error(String message, Map<String, Object> output) {
        return new HostTurnActionResult(true, message, output);
    }
}
