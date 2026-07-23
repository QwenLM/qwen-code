package com.alibaba.qwen.code.daemon;

/** The validated 202 admission watermark for a prompt. */
public final class PromptAcceptance {
    private final String promptId;
    private final long lastEventId;

    PromptAcceptance(String promptId, long lastEventId) {
        this.promptId = promptId;
        this.lastEventId = lastEventId;
    }

    public String getPromptId() {
        return promptId;
    }

    public long getLastEventId() {
        return lastEventId;
    }
}
