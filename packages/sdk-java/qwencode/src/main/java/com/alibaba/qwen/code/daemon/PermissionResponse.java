package com.alibaba.qwen.code.daemon;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** A selected or cancelled response to a permission request. */
public final class PermissionResponse {
    private final Map<String, Object> outcome;
    private final Map<String, String> answers;

    private PermissionResponse(Map<String, Object> outcome,
            Map<String, String> answers) {
        this.outcome = outcome;
        this.answers = answers;
    }

    public static PermissionResponse cancelled() {
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("outcome", "cancelled");
        return new PermissionResponse(outcome, Collections.emptyMap());
    }

    public static PermissionResponse selected(String optionId) {
        if (optionId == null || optionId.isEmpty()) {
            throw new IllegalArgumentException("optionId must not be empty");
        }
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("outcome", "selected");
        outcome.put("optionId", optionId);
        return new PermissionResponse(outcome, Collections.emptyMap());
    }

    public PermissionResponse withAnswers(Map<String, String> answers) {
        if (answers == null) {
            throw new IllegalArgumentException("answers must not be null");
        }
        for (Map.Entry<String, String> answer : answers.entrySet()) {
            if (answer.getKey() == null || answer.getKey().isEmpty()
                    || answer.getValue() == null) {
                throw new IllegalArgumentException(
                        "answer keys must be non-empty and values must not be null");
            }
        }
        return new PermissionResponse(outcome,
                Collections.unmodifiableMap(new LinkedHashMap<>(answers)));
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("outcome", outcome);
        if (!answers.isEmpty()) {
            result.put("answers", answers);
        }
        return result;
    }
}
