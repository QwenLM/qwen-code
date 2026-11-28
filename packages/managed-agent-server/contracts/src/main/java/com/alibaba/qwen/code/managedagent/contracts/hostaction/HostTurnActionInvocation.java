package com.alibaba.qwen.code.managedagent.contracts.hostaction;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Trusted invocation context passed to {@link HostTurnActionExecutor} when a
 * model calls an authorized Turn-scoped host action.
 */
public record HostTurnActionInvocation(
        String tenantId,
        String sessionId,
        String turnId,
        String promptId,
        String callId,
        String actionName,
        String contextRef,
        Map<String, Object> arguments) {
    public HostTurnActionInvocation {
        Objects.requireNonNull(tenantId, "tenantId is required");
        Objects.requireNonNull(sessionId, "sessionId is required");
        Objects.requireNonNull(turnId, "turnId is required");
        Objects.requireNonNull(promptId, "promptId is required");
        Objects.requireNonNull(callId, "callId is required");
        Objects.requireNonNull(actionName, "actionName is required");
        arguments = arguments == null
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(arguments));
    }

    @Override
    public Map<String, Object> arguments() {
        return arguments;
    }
}
