package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.Set;

/** Canonical Runtime status after transport-specific response projection. */
public record RuntimeExecutionStatus(State state, Map<String, Object> result) {
    private static final Set<String> FIELDS = Set.of("state", "result");

    public RuntimeExecutionStatus {
        if (state == null || (state == State.SETTLED) != (result != null)) {
            throw invalid();
        }
        result = result == null ? null : BrokerValues.immutableMap(result);
    }

    public static RuntimeExecutionStatus from(Map<String, Object> status) {
        if (status == null) {
            throw invalid();
        }
        for (Object field : status.keySet()) {
            if (!(field instanceof String) || !FIELDS.contains(field)) {
                throw invalid();
            }
        }
        if (!(status.get("state") instanceof String name)
                || !State.supports(name)) {
            throw invalid();
        }
        State state = State.fromWireName(name);
        if ((state == State.SETTLED) != status.containsKey("result")
                || status.containsKey("result")
                        && !(status.get("result") instanceof Map<?, ?>)) {
            throw invalid();
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) status.get("result");
        return new RuntimeExecutionStatus(state, result);
    }

    public enum State {
        PREPARED("prepared"),
        EXECUTING("executing"),
        CANCEL_REQUESTED("cancel_requested"),
        SETTLED("settled"),
        UNKNOWN("unknown");

        private final String wireName;

        State(String wireName) {
            this.wireName = wireName;
        }

        public String wireName() {
            return wireName;
        }

        public static boolean supports(String value) {
            for (State state : values()) {
                if (state.wireName.equals(value)) {
                    return true;
                }
            }
            return false;
        }

        private static State fromWireName(String value) {
            for (State state : values()) {
                if (state.wireName.equals(value)) {
                    return state;
                }
            }
            throw invalid();
        }
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Runtime execution status is invalid.");
    }
}
