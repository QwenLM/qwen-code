package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** A reliable terminal event correlated to an admitted prompt. */
public final class PromptTerminal {
    public enum Kind {
        COMPLETE,
        ERROR
    }

    private final Kind kind;
    private final String promptId;
    private final String stopReason;
    private final String code;
    private final String message;
    private final DaemonEvent event;

    PromptTerminal(Kind kind, String promptId, String stopReason,
            String code, String message, DaemonEvent event) {
        this.kind = kind;
        this.promptId = promptId;
        this.stopReason = stopReason;
        this.code = code;
        this.message = message;
        this.event = event;
    }

    static PromptTerminal from(DaemonEvent event, String promptId,
            String sessionId) {
        Map<String, Object> data = event.requireDataObject(
                event.getType() + ".data");
        event.requireSessionId(sessionId, event.getType());
        if ("turn_complete".equals(event.getType())) {
            return new PromptTerminal(Kind.COMPLETE, promptId,
                    JsonSupport.requiredString(data, "stopReason",
                            "turn_complete.data"), null, null, event);
        }
        return new PromptTerminal(Kind.ERROR, promptId, null,
                JsonSupport.optionalString(data, "code"),
                JsonSupport.requiredString(data, "message", "turn_error.data"),
                event);
    }

    public Kind getKind() {
        return kind;
    }

    public String getPromptId() {
        return promptId;
    }

    public String getStopReason() {
        return stopReason;
    }

    public String getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }

    public DaemonEvent getEvent() {
        return event;
    }
}
