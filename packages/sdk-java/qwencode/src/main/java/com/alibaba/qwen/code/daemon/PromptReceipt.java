package com.alibaba.qwen.code.daemon;

/** The validated 202 admission watermark for one Hosted Harness turn. */
public final class PromptReceipt {
    private final String promptId;
    private final long lastEventId;
    private final String eventEpoch;

    PromptReceipt(String promptId, long lastEventId, String eventEpoch) {
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

    public String getEventEpoch() {
        return eventEpoch;
    }
}
