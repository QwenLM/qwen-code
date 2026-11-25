package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Cancellation request for a recovered Managed Runtime turn. */
public final class CancelManagedRuntime {
    private final HarnessSessionRef session;
    private final String promptId;
    private final String checkpointId;
    private final String activationId;

    public CancelManagedRuntime(HarnessSessionRef session, String promptId,
            String checkpointId, String activationId) {
        if (session == null) {
            throw new IllegalArgumentException("session must not be null");
        }
        this.session = session;
        this.promptId = HostedHarnessClient.requireUuid(promptId, "promptId");
        this.checkpointId = HostedHarnessClient.requireBoundedRecoveryText(
                checkpointId, "checkpointId");
        this.activationId = HostedHarnessClient.requireBoundedRecoveryText(
                activationId, "activationId");
    }

    HarnessSessionRef getSession() {
        return session;
    }

    String getPromptId() {
        return promptId;
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("promptId", promptId);
        result.put("checkpointId", checkpointId);
        result.put("activationId", activationId);
        return result;
    }
}
