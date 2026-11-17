package com.alibaba.qwen.code.daemon;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;

/** Affirmative recovery evidence for one original Hosted input. */
public final class HarnessRecoveryStatus {
    private static final Set<String> STATES = Set.of("recovering", "awaiting_evidence",
            "cleanup_pending", "ready", "operator_required");
    private final String state;
    private final String reasonCode;
    private final String promptId;
    private final boolean inputSettled;
    private final boolean continuationReady;
    private final boolean nextTurnAllowed;

    HarnessRecoveryStatus(Map<String, Object> value) {
        state = JsonSupport.requiredString(value, "state", "recovery");
        if (!STATES.contains(state)) {
            throw new DaemonProtocolException("Unknown Hosted recovery state");
        }
        reasonCode = JsonSupport.optionalString(value, "reasonCode");
        promptId = JsonSupport.optionalString(value, "promptId");
        if (promptId != null && (promptId.isBlank() || promptId.indexOf('\0') >= 0
                || promptId.getBytes(StandardCharsets.UTF_8).length > 512)) {
            throw new DaemonProtocolException("Invalid recovery promptId");
        }
        inputSettled = JsonSupport.requiredBoolean(value, "inputSettled", "recovery");
        continuationReady = JsonSupport.requiredBoolean(value, "continuationReady", "recovery");
        nextTurnAllowed = JsonSupport.requiredBoolean(value, "nextTurnAllowed", "recovery");
        if ((continuationReady && !inputSettled)
                || nextTurnAllowed != "ready".equals(state)
                || (nextTurnAllowed && (!inputSettled || !continuationReady))) {
            throw new DaemonProtocolException("Inconsistent Hosted recovery evidence");
        }
    }

    public String getState() {
        return state;
    }

    public String getReasonCode() {
        return reasonCode;
    }

    public String getPromptId() {
        return promptId;
    }

    public boolean isInputSettled() {
        return inputSettled;
    }

    public boolean isContinuationReady() {
        return continuationReady;
    }

    public boolean isNextTurnAllowed() {
        return nextTurnAllowed;
    }
}
