package com.alibaba.qwen.code.daemon;

/** The validated 202 admission watermark for a prompt. */
public final class PromptAcceptance {
    private final String promptId;
    private final long lastEventId;
    private final String eventEpoch;

    PromptAcceptance(String promptId, long lastEventId, String eventEpoch) {
        this.promptId = promptId;
        this.lastEventId = lastEventId;
        this.eventEpoch = eventEpoch;
    }

    public String getPromptId() {
        return promptId;
    }

    public long getLastEventId() {
        return lastEventId;
    }

    /**
     * Returns the event-bus epoch paired with {@link #getLastEventId()}, or
     * {@code null} when connected to an older daemon.
     */
    public String getEventEpoch() {
        return eventEpoch;
    }
}
