package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** A response to one revision of a permission or question action. */
public final class ManagedActionResponse {
    private final Map<String, Object> json;

    private ManagedActionResponse(String kind, long inputRevision, String policyRevision, String key, Object value) {
        json = Map.of("kind", kind, "input_revision", inputRevision, "policy_revision", policyRevision, key, value);
    }

    /** Selects an option on a permission action. Use the revisions from the action. */
    public static ManagedActionResponse permission(long inputRevision, String policyRevision, String optionId) {
        return new ManagedActionResponse("permission", inputRevision, policyRevision, "option_id", optionId);
    }

    /** Answers a question action. Use the revisions from the action. */
    public static ManagedActionResponse question(long inputRevision, String policyRevision,
            List<ManagedAction.Answer> answers) {
        return new ManagedActionResponse("question", inputRevision, policyRevision, "answers",
                answers.stream().map(ManagedAction.Answer::toJson).collect(Collectors.toList()));
    }

    Map<String, Object> toJson() {
        return json;
    }
}
