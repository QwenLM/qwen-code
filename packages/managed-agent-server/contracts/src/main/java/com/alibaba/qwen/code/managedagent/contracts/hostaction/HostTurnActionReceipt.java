package com.alibaba.qwen.code.managedagent.contracts.hostaction;

import java.util.Objects;

/**
 * Durable per-(Turn, call) host action receipt used to reconcile deliveries
 * whose response was interrupted.
 */
public record HostTurnActionReceipt(
        String sessionId,
        String turnId,
        String promptId,
        String callId,
        String actionName,
        String state,
        HostTurnActionResult result,
        long createdAt,
        long updatedAt) {
    public HostTurnActionReceipt {
        Objects.requireNonNull(sessionId, "sessionId is required");
        Objects.requireNonNull(turnId, "turnId is required");
        Objects.requireNonNull(callId, "callId is required");
        Objects.requireNonNull(actionName, "actionName is required");
        Objects.requireNonNull(state, "state is required");
    }
}
